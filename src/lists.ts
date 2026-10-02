import { Env, MangaList, StoredListItem } from "./types";
import {
  badRequest,
  json,
  MAX_CUSTOM_SLUG,
  normalizeCustomSlug,
  notFound,
  randomSlug,
  randomToken,
  toIsbn13,
} from "./util";
import { checkListContent } from "./ngwords";
import { resolveListItems } from "./listItems";

const REQUIRED_ITEMS = 100;
const MAX_COMMENT = 200;
const MAX_NAME = 40;
const MAX_BIO = 100;

/** Keep only what the owner actually authored per book: the ISBN (normalized to
 *  ISBN13) plus comment/spoiler. Title, author and cover are site-wide data resolved
 *  by ISBN on read (src/listItems.ts), so anything the client sends for them is
 *  ignored and never stored. Every book needs an ISBN — it's the only key we have. */
function sanitizeItems(raw: unknown): { items: StoredListItem[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: "作品リストが不正です" };
  const items: StoredListItem[] = [];
  for (let i = 0; i < raw.length; i++) {
    const it = raw[i] as Record<string, unknown>;
    if (!it || typeof it !== "object") return { error: "作品リストが不正です" };
    const isbn = toIsbn13(String(it.isbn ?? ""));
    if (!isbn) return { error: `${i + 1}番目の作品に ISBN がありません` };
    items.push({
      position: items.length + 1,
      isbn,
      comment: stripUrls(String(it.comment ?? "")).slice(0, MAX_COMMENT),
      spoiler: Boolean(it.spoiler),
    });
  }
  return { items };
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

/** 作者のひとこと。公開ページ上部に 1 行で出すので改行は空白に潰す。URL 不可は他の自由入力と同じ。 */
function sanitizeBio(raw: unknown): string {
  return stripUrls(String(raw ?? "").replace(/\s*[\r\n]+\s*/g, " ")).slice(0, MAX_BIO);
}

/** リストに新しく加わった巻を list_item_events へ追記する。ランキング (src/ranking.ts) の
 *  元データ。新規公開では全 item、更新公開では旧→新の差分で新しく現れた isbn のみを渡す。
 *  isbn 空の item は集計対象外なので記録しない。監査と同じく公開処理を失敗させないため握り潰す。 */
async function recordItemAddEvents(
  env: Env,
  slug: string,
  items: StoredListItem[],
  addedAt: number
): Promise<void> {
  const rows = items.filter((it) => it.isbn);
  if (rows.length === 0) return;
  try {
    const stmt = env.DB.prepare(`INSERT INTO list_item_events (slug, isbn, added_at) VALUES (?, ?, ?)`);
    await env.DB.batch(rows.map((it) => stmt.bind(slug, it.isbn, addedAt)));
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

  const sanitized = sanitizeItems(body.items);
  if ("error" in sanitized) return badRequest(sanitized.error);
  const items = sanitized.items;
  if (items.length !== REQUIRED_ITEMS) return badRequest(`作品はちょうど${REQUIRED_ITEMS}件にしてください`);

  const owner_name = stripUrls(String(body.owner_name ?? "")).slice(0, MAX_NAME);
  const bio = sanitizeBio(body.bio);
  const ngError = checkListContent(owner_name, bio, items.map((it) => it.comment));
  if (ngError) return badRequest(ngError);

  const edit_token = randomToken(24);
  const items_json = JSON.stringify(items);
  const now = Date.now();

  const insert = env.DB.prepare(
    `INSERT INTO lists (slug, edit_token, owner_name, bio, items_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
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
      await insert.bind(slug, edit_token, owner_name, bio, items_json, now, now).run();
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
      await insert.bind(slug, edit_token, owner_name, bio, items_json, now, now).run();
      await recordPublishAudit(request, env, slug, "create", owner_name);
      await recordItemAddEvents(env, slug, items, now);
      return json({ slug, edit_token }, 201);
    } catch (err) {
      if (attempt === 4) throw err;
    }
  }
  return json({ error: "slugの生成に失敗しました" }, 500);
}

interface StoredList {
  slug: string;
  edit_token: string;
  owner_name: string;
  bio: string;
  items: StoredListItem[];
  created_at: number;
  updated_at: number;
}

async function loadList(env: Env, slug: string): Promise<StoredList | null> {
  const row = await env.DB.prepare(
    `SELECT slug, edit_token, owner_name, bio, items_json, created_at, updated_at FROM lists WHERE slug = ?`
  )
    .bind(slug)
    .first<{
      slug: string;
      edit_token: string;
      owner_name: string;
      bio: string | null;
      items_json: string;
      created_at: number;
      updated_at: number;
    }>();
  if (!row) return null;
  let items: StoredListItem[] = [];
  try {
    items = JSON.parse(row.items_json) as StoredListItem[];
  } catch {
    items = [];
  }
  return {
    slug: row.slug,
    edit_token: row.edit_token,
    owner_name: row.owner_name,
    bio: row.bio ?? "",
    items,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function getListData(env: Env, slug: string): Promise<MangaList | null> {
  const list = await loadList(env, slug);
  if (!list) return null;
  const { edit_token, items: stored, ...rest } = list;
  // Title / author / cover aren't stored — they're resolved from site-wide data by
  // ISBN on every read, so fixes (name overrides, unified 巻数表記, a newly filled or
  // approved cover) show up in every list. A lookup failure must never take the list
  // down, so degrade to ISBN-only cards.
  let items;
  try {
    items = await resolveListItems(env, stored);
  } catch (err) {
    console.error("resolveListItems failed", err);
    items = stored.map((it) => ({ ...it, title: `ISBN ${it.isbn}`, author: "", cover_url: "" }));
  }
  return { ...rest, items };
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

  const sanitized = sanitizeItems(body.items);
  if ("error" in sanitized) return badRequest(sanitized.error);
  const items = sanitized.items;
  if (items.length !== REQUIRED_ITEMS) return badRequest(`作品はちょうど${REQUIRED_ITEMS}件にしてください`);

  const owner_name = stripUrls(String(body.owner_name ?? list.owner_name)).slice(0, MAX_NAME);
  // bio を送らない古いクライアント（キャッシュ済み app.js）で消さないよう、未指定なら現状維持。
  const bio = body.bio === undefined ? list.bio : sanitizeBio(body.bio);
  const ngError = checkListContent(owner_name, bio, items.map((it) => it.comment));
  if (ngError) return badRequest(ngError);

  const now = Date.now();

  await env.DB.prepare(
    `UPDATE lists SET owner_name = ?, bio = ?, items_json = ?, updated_at = ? WHERE slug = ?`
  )
    .bind(owner_name, bio, JSON.stringify(items), now, slug)
    .run();

  await recordPublishAudit(request, env, slug, "update", owner_name);

  // 更新公開では、旧内容に無かった isbn だけを「新しく追加された巻」として記録する。
  const oldIsbns = new Set(list.items.map((it) => toIsbn13(it.isbn)).filter(Boolean));
  const added = items.filter((it) => it.isbn && !oldIsbns.has(it.isbn));
  await recordItemAddEvents(env, slug, added, now);

  return json({ slug, ok: true });
}
