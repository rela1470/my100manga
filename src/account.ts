import { Env } from "./types";
import { User, currentUser, loginEnabled, sameOrigin } from "./auth";
import { badRequest, json, notFound, readJsonObject } from "./util";

// ログイン中ユーザ向けの API（/api/me*）。ログインは任意で、ここに無い機能は匿名でも使える。
//   GET    /api/me        … ログイン状態（ログイン機能が無効なら enabled:false）
//   GET    /api/me/lists  … 自分のアカウントに紐付いた公開リスト（編集用に edit_token も返す）
//   POST   /api/me/claim  … この端末の編集リンク {slug, token} のうちユーザが選んだものをアカウントに紐付ける
//   GET/PUT/DELETE /api/me/draft … 作成中のリスト（1 アカウント 1 件）
// edit_token は持ち主本人にだけ返す。公開データ API（GET /api/lists/:slug）は従来どおり漏らさない。

const MAX_DRAFT_ITEMS = 1000; // public/app.js MAX_ITEMS と揃える
const MAX_CLAIM = 200;
const NO_STORE = { "cache-control": "no-store" };

function unauthorized(): Response {
  return json({ error: "ログインしてください" }, 401, NO_STORE);
}

export async function getMe(request: Request, env: Env): Promise<Response> {
  const user = await currentUser(request, env);
  return json(
    { enabled: loginEnabled(env), user: user && { name: user.name, email: user.email, picture: user.picture } },
    200,
    NO_STORE
  );
}

export async function getMyLists(env: Env, user: User): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT slug, edit_token, owner_name, created_at, updated_at
       FROM lists WHERE user_id = ? ORDER BY updated_at DESC`
  )
    .bind(user.id)
    .all<{ slug: string; edit_token: string; owner_name: string | null; created_at: number; updated_at: number }>();
  return json({ lists: results.map((r) => ({ ...r, owner_name: r.owner_name ?? "" })) }, 200, NO_STORE);
}

/** 匿名公開したリストを、edit_token を知っていることを証明にアカウントへ紐付ける。
 *  ユーザがログイン時のダイアログで選んだものだけが送られてくる（public/account.js）。
 *  結果は slug ごとに返す: claimed（今回紐付けた）/ mine（既に自分のもの）/ not_found（削除済み）/
 *  mismatch（編集リンクが今のものと違う）/ other（別アカウントのもの）。other は token が
 *  合っている時だけ返し、token を知らない相手にリストの持ち主の有無を明かさない。 */
export async function claimLists(request: Request, env: Env, user: User): Promise<Response> {
  const body = await readJsonObject(request);
  const raw = Array.isArray(body.lists) ? body.lists.slice(0, MAX_CLAIM) : [];
  const pairs = raw
    .map((r) => r as Record<string, unknown>)
    .filter((r) => r && typeof r.slug === "string" && typeof r.token === "string" && r.slug && r.token)
    .map((r) => ({ slug: r.slug as string, token: r.token as string }));
  if (pairs.length === 0) return json({ results: {} }, 200, NO_STORE);
  const stmt = env.DB.prepare(
    `UPDATE lists SET user_id = ? WHERE slug = ? AND edit_token = ? AND user_id IS NULL`
  );
  const res = await env.DB.batch(pairs.map((p) => stmt.bind(user.id, p.slug, p.token)));
  const results: Record<string, string> = {};
  const rest = pairs.filter((p, i) => {
    if ((res[i].meta?.changes ?? 0) > 0) results[p.slug] = "claimed";
    return !results[p.slug];
  });
  if (rest.length) {
    const lookup = env.DB.prepare(`SELECT edit_token, user_id FROM lists WHERE slug = ?`);
    const rows = await env.DB.batch<{ edit_token: string; user_id: string | null }>(
      rest.map((p) => lookup.bind(p.slug))
    );
    rest.forEach((p, i) => {
      const row = rows[i].results[0];
      if (!row) results[p.slug] = "not_found";
      else if (row.edit_token !== p.token) results[p.slug] = "mismatch";
      else results[p.slug] = row.user_id === user.id ? "mine" : "other";
    });
  }
  return json({ results }, 200, NO_STORE);
}

function str(v: unknown, max: number): string {
  return String(v ?? "").slice(0, max);
}

/** 下書きは本人しか見ないが、描画される値なので型と長さだけは揃える。表紙は
 *  https の画像か自サイトの相対パス（/cover?u=…）に限る。 */
function sanitizeDraftItems(raw: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_DRAFT_ITEMS) return null;
  const items: Record<string, unknown>[] = [];
  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    const it = v as Record<string, unknown>;
    const cover = str(it.cover_url, 1000);
    items.push({
      isbn: str(it.isbn, 20),
      title: str(it.title, 200),
      author: str(it.author, 200),
      cover_url: /^https:\/\//.test(cover) || /^\/(?!\/)/.test(cover) ? cover : "",
      comment: str(it.comment, 200),
      spoiler: Boolean(it.spoiler),
    });
  }
  return items;
}

export async function getDraft(env: Env, user: User): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT owner_name, bio, items_json, updated_at FROM user_drafts WHERE user_id = ?`
  )
    .bind(user.id)
    .first<{ owner_name: string; bio: string; items_json: string; updated_at: number }>();
  if (!row) return json({ draft: null }, 200, NO_STORE);
  let items: unknown[] = [];
  try {
    items = JSON.parse(row.items_json) as unknown[];
  } catch {}
  return json(
    { draft: { owner: row.owner_name, bio: row.bio, items, savedAt: row.updated_at } },
    200,
    NO_STORE
  );
}

/** 作成中のリストを保存する。端末ごとの保存時刻 savedAt で新旧を決め、サーバ側の方が
 *  新しければ上書きしない（別端末の後の編集を古い端末が潰さないように）。 */
export async function putDraft(request: Request, env: Env, user: User): Promise<Response> {
  const body = await readJsonObject(request);
  const items = sanitizeDraftItems(body.items);
  if (!items) return badRequest("下書きが不正です");
  const savedAt = Number(body.savedAt);
  if (!Number.isFinite(savedAt) || savedAt <= 0) return badRequest("下書きが不正です");
  await env.DB.prepare(
    `INSERT INTO user_drafts (user_id, owner_name, bio, items_json, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET
       owner_name = excluded.owner_name, bio = excluded.bio,
       items_json = excluded.items_json, updated_at = excluded.updated_at
     WHERE excluded.updated_at >= user_drafts.updated_at`
  )
    .bind(user.id, str(body.owner, 40), str(body.bio, 100), JSON.stringify(items), Math.floor(savedAt))
    .run();
  return json({ ok: true }, 200, NO_STORE);
}

export async function deleteDraft(env: Env, user: User): Promise<Response> {
  await env.DB.prepare(`DELETE FROM user_drafts WHERE user_id = ?`).bind(user.id).run();
  return json({ ok: true }, 200, NO_STORE);
}

/** /api/me 配下のルーティング。/api/me 自体は未ログインでも 200（状態を返す）。 */
export async function handleAccountApi(request: Request, env: Env, path: string): Promise<Response> {
  const method = request.method;
  if (path === "/api/me" && method === "GET") return await getMe(request, env);
  if (method !== "GET" && !sameOrigin(request)) return json({ error: "不正なリクエストです" }, 403, NO_STORE);
  const user = await currentUser(request, env);
  if (!user) return unauthorized();
  if (path === "/api/me/lists" && method === "GET") return await getMyLists(env, user);
  if (path === "/api/me/claim" && method === "POST") return await claimLists(request, env, user);
  if (path === "/api/me/draft") {
    if (method === "GET") return await getDraft(env, user);
    if (method === "PUT") return await putDraft(request, env, user);
    if (method === "DELETE") return await deleteDraft(env, user);
  }
  return notFound();
}
