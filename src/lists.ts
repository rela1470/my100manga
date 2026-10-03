import { Env, MangaList, StoredListItem } from "./types";
import {
  badRequest,
  clientIp,
  json,
  MAX_CUSTOM_SLUG,
  normalizeCustomSlug,
  notFound,
  randomSlug,
  randomToken,
  toIsbn13,
  BODY_TOO_LARGE,
  readJsonBody,
  timingSafeEqualStr,
} from "./util";
import { checkListContent, findNgWord } from "./ngwords";
import { parseStoredItems, resolveListItems } from "./listItems";
import { adultBlockMessage, findAdultIsbns } from "./adult";

/** リスト 1 件とその付随データを消す文。lists 本体に加え、ランキングが消えたリストを数え
 *  続けないよう追加イベント (src/ranking.ts) を、一覧のアクセス数順 (src/publicLists.ts) の
 *  日別カウンタも一緒に掃除する。管理者削除と退会時の削除で使う。 */
export function deleteListStatements(env: Env, slug: string): D1PreparedStatement[] {
  return ["lists", "list_item_events", "list_views", "list_view_seen"].map((t) =>
    env.DB.prepare(`DELETE FROM ${t} WHERE slug = ?`).bind(slug)
  );
}

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
  // 件数超過は 1 件ずつの検証（ISBN 正規化・URL 除去）を回す前に弾く。
  if (raw.length > REQUIRED_ITEMS) return { error: `作品はちょうど${REQUIRED_ITEMS}件にしてください` };
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

// スキーム無しの URL（example.com/x, bit.ly/abc）。誤検知を避けるため、英数字のラベルが
// ドットで繋がり、末尾が誘導に使われがちな TLD で終わるものだけを拾う（「Vol.2」「Dr.STONE」
// のような作品名・巻表記は TLD に当たらないので残る）。前後が英数字・ドット・@ に続くもの
// （メールアドレスの一部や長い英単語の途中）は対象外。
const BARE_URL_RE =
  /(?<![A-Za-z0-9.@-])(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+(?:com|net|org|jp|io|co|info|biz|xyz|ly|gl|be|tv|cc|app|dev|site|online|top|link|shop|me|to|ru|cn|club|live|page|work|fun|blog|tokyo)(?![A-Za-z0-9-])(?:[/?#:][^\s]*)?/gi;

/** コメントはアカウント無しの匿名公開なので URL を書けないようにする（スパム・誘導リンク
 *  対策）。http(s):// や www. で始まるトークンと、スキーム無しのドメイン形式（BARE_URL_RE）を
 *  除去する。クライアントでも入力時に弾くが、バイパスされうるのでサーバ側を最終防衛線にする。 */
export function stripUrls(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/www\.\S+/gi, "")
    .replace(BARE_URL_RE, "")
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
  const ip = clientIp(request);
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

/** 成年向け（adult_volumes）の巻が入っていれば拒否文言を返す。検索・巻の追加でも止めているが、
 *  下書きの古いデータや API 直叩きで紛れ込むので公開時に最終確認する。書名は最初の 1 件だけ添える。 */
async function adultItemError(env: Env, items: StoredListItem[]): Promise<string | null> {
  const adult = await findAdultIsbns(env, items.map((it) => it.isbn));
  if (!adult.size) return null;
  const first = items.find((it) => adult.has(it.isbn));
  return adultBlockMessage(first ? adult.get(first.isbn) : "");
}

/** リスト作成・更新の本文の上限。100 冊分（クライアントは title / author / cover_url も送って
 *  くるが保存はしない）にコメント 200 字を足しても 150KB 程度に収まる。 */
export const MAX_LIST_BODY = 200 * 1024;

/** リスト作成・更新の JSON 本文を上限付きで読む。上限超えは 413、壊れた JSON・オブジェクト
 *  以外は 400 のレスポンスを返す。 */
async function readListBody(request: Request): Promise<Record<string, unknown> | Response> {
  const body = await readJsonBody(request, MAX_LIST_BODY);
  if (body === BODY_TOO_LARGE) return json({ error: "リクエストが大きすぎます" }, 413);
  if (!body || typeof body !== "object" || Array.isArray(body)) return badRequest("不正なリクエストです");
  return body as Record<string, unknown>;
}

/** userId はログイン中ならそのアカウント（リストを紐付ける）、匿名なら null。編集権限は
 *  どちらでも edit_token で、ログイン中のユーザには /api/me/lists がそれを返す。 */
export async function createList(request: Request, env: Env, userId: string | null): Promise<Response> {
  const parsed = await readListBody(request);
  if (parsed instanceof Response) return parsed;
  const body = parsed;

  const sanitized = sanitizeItems(body.items);
  if ("error" in sanitized) return badRequest(sanitized.error);
  const items = sanitized.items;
  if (items.length !== REQUIRED_ITEMS) return badRequest(`作品はちょうど${REQUIRED_ITEMS}件にしてください`);
  const adultError = await adultItemError(env, items);
  if (adultError) return badRequest(adultError);

  const owner_name = stripUrls(String(body.owner_name ?? "")).slice(0, MAX_NAME);
  const bio = sanitizeBio(body.bio);
  const ngError = checkListContent(owner_name, bio, items.map((it) => it.comment));
  if (ngError) return badRequest(ngError);

  const unlisted = body.unlisted === true ? 1 : 0;
  const edit_token = randomToken(24);
  const items_json = JSON.stringify(items);
  const now = Date.now();

  const insert = env.DB.prepare(
    `INSERT INTO lists (slug, edit_token, owner_name, bio, items_json, created_at, updated_at, user_id, unlisted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  // slug 未指定ならランダム、指定ありならユーザ指定を検証して使う。
  const hasCustomSlug = body.slug !== undefined && body.slug !== null && String(body.slug).trim() !== "";
  if (hasCustomSlug) {
    const slug = normalizeCustomSlug(body.slug);
    if (slug === null) {
      return badRequest(`URLは英数字・ハイフン・アンダースコアのみ、${MAX_CUSTOM_SLUG}文字以内で指定してください`);
    }
    // 公開 URL に出るので、お名前・コメントと同じ NG ワードを当てる。
    if (findNgWord(slug)) return badRequest("URLに不適切な表現が含まれています");
    const existing = await env.DB.prepare(`SELECT 1 FROM lists WHERE slug = ?`).bind(slug).first();
    if (existing) return json({ error: "このURLはすでに使われています" }, 409);
    try {
      await insert.bind(slug, edit_token, owner_name, bio, items_json, now, now, userId, unlisted).run();
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
      await insert.bind(slug, edit_token, owner_name, bio, items_json, now, now, userId, unlisted).run();
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
  unlisted: boolean;
  created_at: number;
  updated_at: number;
}

async function loadList(env: Env, slug: string): Promise<StoredList | null> {
  const row = await env.DB.prepare(
    `SELECT slug, edit_token, owner_name, bio, items_json, unlisted, created_at, updated_at FROM lists WHERE slug = ?`
  )
    .bind(slug)
    .first<{
      slug: string;
      edit_token: string;
      owner_name: string;
      bio: string | null;
      items_json: string;
      unlisted: number;
      created_at: number;
      updated_at: number;
    }>();
  if (!row) return null;
  const items = parseStoredItems(row.items_json);
  return {
    slug: row.slug,
    edit_token: row.edit_token,
    owner_name: row.owner_name,
    bio: row.bio ?? "",
    items,
    unlisted: row.unlisted === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** strict: 解決（resolveListItems）の失敗を握り潰さず投げる。R2 の閲覧スナップショット
 *  （src/viewSnapshot.ts）は ISBN だけの縮退表示を 24 時間残さないよう strict で作る。 */
export async function getListData(env: Env, slug: string, opts: { strict?: boolean } = {}): Promise<MangaList | null> {
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
    if (opts.strict) throw err;
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

  const parsed = await readListBody(request);
  if (parsed instanceof Response) return parsed;
  const body = parsed;

  const token = String(body.edit_token ?? request.headers.get("x-edit-token") ?? "");
  // 定数時間比較（応答時間の差から edit_token を 1 文字ずつ当てられないように）。
  if (!timingSafeEqualStr(token, list.edit_token)) return json({ error: "編集権限がありません" }, 403);

  const sanitized = sanitizeItems(body.items);
  if ("error" in sanitized) return badRequest(sanitized.error);
  const items = sanitized.items;
  if (items.length !== REQUIRED_ITEMS) return badRequest(`作品はちょうど${REQUIRED_ITEMS}件にしてください`);
  const adultError = await adultItemError(env, items);
  if (adultError) return badRequest(adultError);

  const owner_name = stripUrls(String(body.owner_name ?? list.owner_name)).slice(0, MAX_NAME);
  // bio を送らない古いクライアント（キャッシュ済み app.js）で消さないよう、未指定なら現状維持。
  const bio = body.bio === undefined ? list.bio : sanitizeBio(body.bio);
  const unlisted = body.unlisted === undefined ? list.unlisted : body.unlisted === true;
  const ngError = checkListContent(owner_name, bio, items.map((it) => it.comment));
  if (ngError) return badRequest(ngError);

  const now = Date.now();

  await env.DB.prepare(
    `UPDATE lists SET owner_name = ?, bio = ?, items_json = ?, unlisted = ?, updated_at = ? WHERE slug = ?`
  )
    .bind(owner_name, bio, JSON.stringify(items), unlisted ? 1 : 0, now, slug)
    .run();

  await recordPublishAudit(request, env, slug, "update", owner_name);

  // 更新公開では、旧内容に無かった isbn だけを「新しく追加された巻」として記録する。
  const oldIsbns = new Set(list.items.map((it) => toIsbn13(it.isbn)).filter(Boolean));
  const added = items.filter((it) => it.isbn && !oldIsbns.has(it.isbn));
  await recordItemAddEvents(env, slug, added, now);

  return json({ slug, ok: true });
}
