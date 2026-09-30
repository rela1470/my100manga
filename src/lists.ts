import { Env, ListItem, MangaList } from "./types";
import {
  badRequest,
  json,
  MAX_CUSTOM_SLUG,
  normalizeCustomSlug,
  notFound,
  randomSlug,
  randomToken,
} from "./util";
import { checkListContent } from "./ngwords";

const REQUIRED_ITEMS = 100;
const MAX_COMMENT = 200;
const MAX_NAME = 40;

function sanitizeItems(raw: unknown): ListItem[] | null {
  if (!Array.isArray(raw)) return null;
  const items: ListItem[] = [];
  for (let i = 0; i < raw.length; i++) {
    const it = raw[i] as Record<string, unknown>;
    if (!it || typeof it !== "object") return null;
    const title = String(it.title ?? "").slice(0, 200);
    if (!title) continue; // skip empty slots
    items.push({
      position: items.length + 1,
      isbn: String(it.isbn ?? "").slice(0, 20),
      title,
      author: String(it.author ?? "").slice(0, 120),
      cover_url: normalizeCover(String(it.cover_url ?? "")),
      comment: stripUrls(String(it.comment ?? "")).slice(0, MAX_COMMENT),
      spoiler: Boolean(it.spoiler),
    });
  }
  return items;
}

/** Only allow http(s) cover URLs to avoid javascript:/data: injection in <img src>. */
function normalizeCover(url: string): string {
  if (/^https?:\/\//i.test(url)) return url.slice(0, 500);
  return "";
}

/** コメントはアカウント無しの匿名公開なので URL を書けないようにする（スパム・誘導リンク
 *  対策）。http(s):// や www. で始まるトークンを除去する。クライアントでも入力時に弾くが、
 *  バイパスされうるのでサーバ側を最終防衛線にする。 */
function stripUrls(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/www\.\S+/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** リストに新しく加わった巻を list_item_events へ追記する。ランキング (src/ranking.ts) の
 *  元データ。新規公開では全 item、更新公開では旧→新の差分で新しく現れた isbn のみを渡す。
 *  isbn 空の item は集計対象外なので記録しない。監査と同じく公開処理を失敗させないため握り潰す。 */
async function recordItemAddEvents(
  env: Env,
  slug: string,
  items: ListItem[],
  addedAt: number
): Promise<void> {
  const rows = items.filter((it) => it.isbn);
  if (rows.length === 0) return;
  try {
    const stmt = env.DB.prepare(
      `INSERT INTO list_item_events (slug, isbn, title, author, cover_url, added_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    await env.DB.batch(
      rows.map((it) => stmt.bind(slug, it.isbn, it.title, it.author, it.cover_url, addedAt))
    );
  } catch (err) {
    console.error("item add events failed", err);
  }
}

/** 公開の監査証跡を 1 行追記する。アカウントの無い匿名公開なので「誰が」は接続元 IP /
 *  User-Agent / CF 由来の国で残す。監査自体が公開処理を失敗させないよう握りつぶす。 */
async function recordPublishAudit(
  request: Request,
  env: Env,
  slug: string,
  action: "create" | "update",
  owner_name: string
): Promise<void> {
  const ip =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "";
  const user_agent = (request.headers.get("user-agent") ?? "").slice(0, 512);
  const country = (request as { cf?: { country?: string } }).cf?.country ?? "";
  try {
    await env.DB.prepare(
      `INSERT INTO publish_audit (slug, action, owner_name, ip, user_agent, country, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(slug, action, owner_name, ip, user_agent, country, Date.now())
      .run();
  } catch (err) {
    console.error("publish audit failed", err);
  }
}

export async function createList(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return badRequest("不正なリクエストです");

  const items = sanitizeItems(body.items);
  if (items === null) return badRequest("作品リストが不正です");
  if (items.length !== REQUIRED_ITEMS) return badRequest(`作品はちょうど${REQUIRED_ITEMS}件にしてください`);

  const owner_name = stripUrls(String(body.owner_name ?? "")).slice(0, MAX_NAME);
  const ngError = checkListContent(owner_name, items.map((it) => it.comment));
  if (ngError) return badRequest(ngError);

  const edit_token = randomToken(24);
  const items_json = JSON.stringify(items);
  const now = Date.now();

  const insert = env.DB.prepare(
    `INSERT INTO lists (slug, edit_token, owner_name, items_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  // slug 未指定ならランダム、指定ありならユーザ指定を検証して使う。
  const hasCustomSlug = body.slug !== undefined && body.slug !== null && String(body.slug).trim() !== "";
  if (hasCustomSlug) {
    const slug = normalizeCustomSlug(body.slug);
    if (slug === null) {
      return badRequest(`URLは英数字・ハイフン・アンダースコアのみ、${MAX_CUSTOM_SLUG}文字以内で指定してください`);
    }
    const existing = await env.DB.prepare(`SELECT 1 FROM lists WHERE slug = ?`).bind(slug).first();
    if (existing) return json({ error: "このURLはすでに使われています" }, 409);
    try {
      await insert.bind(slug, edit_token, owner_name, items_json, now, now).run();
    } catch (err) {
      // UNIQUE 制約に引っかかった場合（並行作成での競合）も衝突として返す。
      return json({ error: "このURLはすでに使われています" }, 409);
    }
    await recordPublishAudit(request, env, slug, "create", owner_name);
    await recordItemAddEvents(env, slug, items, now);
    return json({ slug, edit_token }, 201);
  }

  // Retry on the (astronomically unlikely) slug collision instead of 500ing.
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = randomSlug(10);
    try {
      await insert.bind(slug, edit_token, owner_name, items_json, now, now).run();
      await recordPublishAudit(request, env, slug, "create", owner_name);
      await recordItemAddEvents(env, slug, items, now);
      return json({ slug, edit_token }, 201);
    } catch (err) {
      if (attempt === 4) throw err;
    }
  }
  return json({ error: "slugの生成に失敗しました" }, 500);
}

async function loadList(env: Env, slug: string): Promise<(MangaList & { edit_token: string }) | null> {
  const row = await env.DB.prepare(
    `SELECT slug, edit_token, owner_name, items_json, created_at, updated_at FROM lists WHERE slug = ?`
  )
    .bind(slug)
    .first<{
      slug: string;
      edit_token: string;
      owner_name: string;
      items_json: string;
      created_at: number;
      updated_at: number;
    }>();
  if (!row) return null;
  let items: ListItem[] = [];
  try {
    items = JSON.parse(row.items_json) as ListItem[];
  } catch {
    items = [];
  }
  return {
    slug: row.slug,
    edit_token: row.edit_token,
    owner_name: row.owner_name,
    items,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function getListData(env: Env, slug: string): Promise<MangaList | null> {
  const list = await loadList(env, slug);
  if (!list) return null;
  const { edit_token, ...pub } = list;
  return pub;
}

export async function getList(env: Env, slug: string): Promise<Response> {
  const data = await getListData(env, slug);
  if (!data) return notFound("リストが見つかりません");
  return json(data);
}

export async function updateList(request: Request, env: Env, slug: string): Promise<Response> {
  const list = await loadList(env, slug);
  if (!list) return notFound("リストが見つかりません");

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return badRequest("不正なリクエストです");

  const token = String(body.edit_token ?? request.headers.get("x-edit-token") ?? "");
  if (token !== list.edit_token) return json({ error: "編集権限がありません" }, 403);

  const items = sanitizeItems(body.items);
  if (items === null) return badRequest("作品リストが不正です");
  if (items.length !== REQUIRED_ITEMS) return badRequest(`作品はちょうど${REQUIRED_ITEMS}件にしてください`);

  const owner_name = stripUrls(String(body.owner_name ?? list.owner_name)).slice(0, MAX_NAME);
  const ngError = checkListContent(owner_name, items.map((it) => it.comment));
  if (ngError) return badRequest(ngError);

  const now = Date.now();

  await env.DB.prepare(
    `UPDATE lists SET owner_name = ?, items_json = ?, updated_at = ? WHERE slug = ?`
  )
    .bind(owner_name, JSON.stringify(items), now, slug)
    .run();

  await recordPublishAudit(request, env, slug, "update", owner_name);

  // 更新公開では、旧内容に無かった isbn だけを「新しく追加された巻」として記録する。
  const oldIsbns = new Set(list.items.map((it) => it.isbn).filter(Boolean));
  const added = items.filter((it) => it.isbn && !oldIsbns.has(it.isbn));
  await recordItemAddEvents(env, slug, added, now);

  return json({ slug, ok: true });
}
