import { Env } from "./types";
import { User, clearSessionCookie, currentUser, loginEnabled, sameOrigin } from "./auth";
import { deleteListStatements, recordPublishAudit } from "./lists";
import { purgeListArtifacts } from "./viewSnapshot";
import { badRequest, json, notFound, readJsonObject } from "./util";

// ログイン中ユーザ向けの API（/api/me*）。ログインは任意で、ここに無い機能は匿名でも使える。
//   GET    /api/me        … ログイン状態（ログイン機能が無効なら enabled:false）
//   DELETE /api/me        … 退会（アカウント・セッション・下書きを消す。紐付いたリストは選択で削除か切り離し）
//   GET    /api/me/lists  … 自分のアカウントに紐付いた公開リスト（編集用に edit_token も返す）
//   POST   /api/me/claim  … この端末の編集リンク {slug, token} のうちユーザが選んだものをアカウントに紐付ける
//   GET/PUT/DELETE /api/me/draft … 作成中のリスト（1 アカウント 1 件）
//   GET    /api/me/data   … このアカウントについて当サイトが持っている保有個人データ全部
//                            （/account の「当サイトが保存している情報」。個人情報保護法33条の
//                            開示請求を待たずに本人がいつでも見られるようにするためのもの）
// edit_token は持ち主本人にだけ返す。公開データ API（GET /api/lists/:slug）は従来どおり漏らさない。

const MAX_DRAFT_ITEMS = 1000; // public/app.js MAX_ITEMS と揃える
const MAX_CLAIM = 200;
const MAX_SESSIONS = 50; // /api/me/data が出すログイン記録の上限
const MAX_AUDIT = 200; // /api/me/data が出す公開・更新の記録の上限
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

/** GET /api/me/data — このアカウントについて当サイトの D1 が持っているものを全部返す。
 *
 *  個人情報保護法33条の開示請求に、請求を待たずに本人が自分で応えられるようにするための
 *  もの（/privacy の「保有個人データの開示・訂正・利用停止・削除等の請求」と対になる）。
 *  出すのは users / sessions / user_drafts / lists / publish_audit の 5 つで、これが
 *  ログインしている人について当サイトが持っている全部。
 *
 *  出さないもの:
 *    - sessions.id_hash … ログイン中のセッションの鍵そのもの（持ち主にも返す意味がなく、
 *      画面に出すと肩越しに見られるだけ損）。作成日時と期限だけ出す。
 *    - lists.edit_token … 編集用の鍵。編集に使う /api/me/lists では返すが、
 *      「保存されている情報の一覧」に混ぜない。
 *  リストと下書きの中身（どの本を選んだか・コメント）は、本人が編集画面でそのまま見られる
 *  ので、ここでは件数と更新日時だけにする（この応答を無駄に重くしない）。
 *
 *  publish_audit は slug が鍵で user_id を持たないので、このアカウントのリストの slug で引く
 *  （匿名で公開したあとにアカウントへ紐付けたリストの記録も、紐付いた時点で本人のものとして
 *  出る）。件数は MAX_AUDIT で頭打ちにする。 */
export async function getMyData(env: Env, user: User): Promise<Response> {
  const [accountRes, sessionRes, draftRes, listRes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT id, google_sub, email, name, picture, created_at, last_login_at FROM users WHERE id = ?`
    ).bind(user.id),
    env.DB.prepare(
      `SELECT created_at, expires_at FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`
    ).bind(user.id, MAX_SESSIONS),
    env.DB.prepare(`SELECT owner_name, bio, items_json, updated_at FROM user_drafts WHERE user_id = ?`).bind(
      user.id
    ),
    env.DB.prepare(
      `SELECT slug, owner_name, bio, items_json, unlisted, created_at, updated_at
         FROM lists WHERE user_id = ? ORDER BY updated_at DESC`
    ).bind(user.id),
  ]);

  const account = (accountRes.results?.[0] ?? null) as AccountRow | null;
  const sessions = (sessionRes.results ?? []) as { created_at: number; expires_at: number }[];
  const draftRow = (draftRes.results?.[0] ?? null) as DraftRow | null;
  const listRows = (listRes.results ?? []) as ListRow[];

  const lists = listRows.map((r) => ({
    slug: r.slug,
    owner_name: r.owner_name ?? "",
    bio: r.bio ?? "",
    item_count: itemCount(r.items_json),
    unlisted: r.unlisted === 1,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));

  // 公開・更新の記録（接続元 IP / User-Agent / 国）。slug 単位なので自分のリストのぶんを引く。
  let publish_audit: PublishAuditRow[] = [];
  if (lists.length) {
    const marks = lists.map(() => "?").join(",");
    const { results } = await env.DB.prepare(
      `SELECT slug, action, owner_name, ip, user_agent, country, created_at
         FROM publish_audit WHERE slug IN (${marks}) ORDER BY created_at DESC LIMIT ?`
    )
      .bind(...lists.map((l) => l.slug), MAX_AUDIT)
      .all<PublishAuditRow>();
    publish_audit = results ?? [];
  }

  return json(
    {
      account: account && {
        id: account.id,
        google_sub: account.google_sub,
        email: account.email,
        name: account.name,
        picture: account.picture,
        created_at: account.created_at,
        last_login_at: account.last_login_at,
      },
      sessions,
      draft: draftRow && {
        owner_name: draftRow.owner_name,
        bio: draftRow.bio,
        item_count: itemCount(draftRow.items_json),
        updated_at: draftRow.updated_at,
      },
      lists,
      publish_audit,
      audit_truncated: publish_audit.length >= MAX_AUDIT,
    },
    200,
    NO_STORE
  );
}

interface AccountRow {
  id: string;
  google_sub: string;
  email: string;
  name: string;
  picture: string;
  created_at: number;
  last_login_at: number;
}
interface DraftRow {
  owner_name: string;
  bio: string;
  items_json: string;
  updated_at: number;
}
interface ListRow {
  slug: string;
  owner_name: string | null;
  bio: string | null;
  items_json: string;
  unlisted: number;
  created_at: number;
  updated_at: number;
}
interface PublishAuditRow {
  slug: string;
  action: string;
  owner_name: string | null;
  ip: string | null;
  user_agent: string | null;
  country: string | null;
  created_at: number;
}

/** items_json の件数。壊れていても 0 を返して開示そのものを止めない。 */
function itemCount(itemsJson: string): number {
  try {
    const v = JSON.parse(itemsJson);
    return Array.isArray(v) ? v.length : 0;
  } catch {
    return 0;
  }
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

/** 退会。users / sessions / user_drafts から本人の行を消し、セッション Cookie も破棄する。
 *  紐付いた公開リストは body.delete_lists が true なら付随データごと削除し、そうでなければ
 *  user_id を外して匿名公開に戻す（edit_token で今までどおり編集でき、端末の編集リンクは
 *  public/account.js が残す）。同じ Google アカウントで再ログインすると新しいアカウントになる。 */
export async function deleteAccount(request: Request, env: Env, user: User): Promise<Response> {
  const body = await readJsonObject(request);
  const listStmts: D1PreparedStatement[] = [];
  let deletedLists = 0;
  const purgeSlugs: string[] = []; // DB から消せたら R2 の閲覧スナップショット・共有画像も消す
  const deleteLists = body.delete_lists === true;
  // 監査ログ（publish_audit）に、退会で消えた／匿名に戻ったリストを 1 件ずつ残す。
  const { results: owned } = await env.DB.prepare(`SELECT slug, owner_name FROM lists WHERE user_id = ?`)
    .bind(user.id)
    .all<{ slug: string; owner_name: string | null }>();
  if (deleteLists) {
    deletedLists = owned.length;
    purgeSlugs.push(...owned.map((r) => r.slug));
    for (const r of owned) listStmts.push(...deleteListStatements(env, r.slug));
  } else {
    listStmts.push(env.DB.prepare(`UPDATE lists SET user_id = NULL WHERE user_id = ?`).bind(user.id));
  }
  await env.DB.batch([
    ...listStmts,
    env.DB.prepare(`DELETE FROM user_drafts WHERE user_id = ?`).bind(user.id),
    env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(user.id),
    env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(user.id),
  ]);
  // batch はトランザクションなので、ここまで来れば purgeSlugs は全部 DB から消えている。
  const action = deleteLists ? "account_delete" : "account_unlink";
  await Promise.all(owned.map((r) => recordPublishAudit(request, env, r.slug, action, r.owner_name ?? "")));
  const origin = new URL(request.url).origin;
  await Promise.all(purgeSlugs.map((slug) => purgeListArtifacts(env, slug, origin)));
  return json({ ok: true, deleted_lists: deletedLists }, 200, {
    ...NO_STORE,
    "set-cookie": clearSessionCookie(request),
  });
}

/** /api/me 配下のルーティング。/api/me 自体は未ログインでも 200（状態を返す）。 */
export async function handleAccountApi(request: Request, env: Env, path: string): Promise<Response> {
  const method = request.method;
  if (path === "/api/me" && method === "GET") return await getMe(request, env);
  if (method !== "GET" && !sameOrigin(request)) return json({ error: "不正なリクエストです" }, 403, NO_STORE);
  const user = await currentUser(request, env);
  if (!user) return unauthorized();
  if (path === "/api/me" && method === "DELETE") return await deleteAccount(request, env, user);
  if (path === "/api/me/lists" && method === "GET") return await getMyLists(env, user);
  if (path === "/api/me/data" && method === "GET") return await getMyData(env, user);
  if (path === "/api/me/claim" && method === "POST") return await claimLists(request, env, user);
  if (path === "/api/me/draft") {
    if (method === "GET") return await getDraft(env, user);
    if (method === "PUT") return await putDraft(request, env, user);
    if (method === "DELETE") return await deleteDraft(env, user);
  }
  return notFound();
}
