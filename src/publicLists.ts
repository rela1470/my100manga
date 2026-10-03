import { Env } from "./types";
import { clientIp, json, toIsbn13 } from "./util";
import { currentUser } from "./auth";
import { parseStoredItems, resolveBooks } from "./listItems";

// 公開リストの一覧（/lists）。並びは「新着（公開順）」と、公開ページのアクセス数順の
// 4 窓（今日 / 7日間 / 30日間 / 累計）。限定公開 (unlisted = 1) のリストは出さない。
//
// アクセス数は list_views (slug × JST 日付の日別カウンタ) から数える。数えるのは閲覧ページの
// JS が送るビーコン (POST /api/lists/:slug/view) だけで、JS を実行しないクローラは数えない。
// 作者本人（編集リンクを持つ端末・ログイン中の所有者）はクライアントが送らず、サーバも弾く。
// 同じ訪問者（IP + User-Agent のハッシュ）は 1 リストにつき 1 日 1 回だけ数える（list_view_seen）。
// 人気傾向用の Analytics Engine (src/popularity.ts) は保持期間が 3 か月で累計を出せず、読むにも API
// トークンが要るので、一覧の並びには D1 の日別カウンタを使う。

const PER = 24;
const PREVIEW_COVERS = 5; // カードに並べる先頭の表紙の数
const DAY_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export type PublicListSort = "new" | "today" | "d7" | "d30" | "all";
const SORTS: PublicListSort[] = ["new", "today", "d7", "d30", "all"];
// 窓の起点（今日を 1 日目として何日ぶんさかのぼるか）。累計は無制限。
const WINDOW_DAYS: Record<Exclude<PublicListSort, "new">, number> = { today: 1, d7: 7, d30: 30, all: 0 };

/** JST の日付キー（YYYY-MM-DD）。「今日」は日本時間の 0 時で切り替える。 */
export function jstDay(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
}

// クローラやリンクプレビューの取得はアクセスとして数えない（X に貼るたびに数が伸びないように）。
const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|headless|curl|wget|python|httpclient|okhttp/i;

/** アクセスとして数えない User-Agent か（空・クローラ・リンクプレビュー・スクリプト）。 */
export function isCrawler(ua: string): boolean {
  return !ua || BOT_UA.test(ua);
}

/** 訪問者の識別子。IP + User-Agent + 日付の SHA-256 で、IP そのものは保存しない。日付を混ぜるので
 *  日をまたいで同じ人を追跡できない。同じ IP を共有する別の人（携帯キャリアの NAT 等）は
 *  User-Agent で区別する。 */
async function visitorKey(request: Request, day: string): Promise<string> {
  const text = `${clientIp(request)}|${request.headers.get("user-agent") ?? ""}|${day}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** POST /api/lists/:slug/view — 閲覧ページのビーコン。数えたかどうかに関係なく 204 を返す
 *  （重複・本人・存在しないリストを外から見分けられないように）。 */
export async function handleListView(request: Request, env: Env, slug: string): Promise<Response> {
  const done = new Response(null, { status: 204 });
  if (isCrawler(request.headers.get("user-agent") ?? "")) return done;
  const list = await env.DB.prepare(`SELECT user_id FROM lists WHERE slug = ?`).bind(slug).first<{ user_id: string | null }>();
  if (!list) return done;
  if (list.user_id) {
    const user = await currentUser(request, env);
    if (user?.id === list.user_id) return done;
  }
  const day = jstDay(Date.now());
  const seen = await env.DB.prepare(`INSERT OR IGNORE INTO list_view_seen (slug, day, visitor) VALUES (?, ?, ?)`)
    .bind(slug, day, await visitorKey(request, day))
    .run();
  if (!seen.meta?.changes) return done; // 今日はもう数えた
  await env.DB.prepare(
    `INSERT INTO list_views (slug, day, views) VALUES (?, ?, 1)
     ON CONFLICT (slug, day) DO UPDATE SET views = views + 1`
  )
    .bind(slug, day)
    .run();
  return done;
}

/** 重複判定の記録は当日分しか要らないので、前日より古いものを消す（日次 cron）。 */
export async function purgeListViewSeen(env: Env): Promise<void> {
  await env.DB.prepare(`DELETE FROM list_view_seen WHERE day < ?`)
    .bind(jstDay(Date.now() - DAY_MS))
    .run();
}

interface Row {
  slug: string;
  owner_name: string | null;
  bio: string | null;
  items_json: string;
  created_at: number;
  views: number | null;
}

export async function handlePublicLists(url: URL, env: Env): Promise<Response> {
  const sortParam = url.searchParams.get("sort") as PublicListSort | null;
  const sort: PublicListSort = sortParam && SORTS.includes(sortParam) ? sortParam : "new";
  let page = Math.floor(Number(url.searchParams.get("page")));
  if (!Number.isFinite(page) || page < 1) page = 1;
  const offset = (page - 1) * PER;

  const totalRow = await env.DB.prepare(`SELECT COUNT(*) AS n FROM lists WHERE unlisted = 0`).first<{ n: number }>();
  const total = totalRow?.n ?? 0;

  let rows: Row[];
  if (sort === "new") {
    const res = await env.DB.prepare(
      `SELECT slug, owner_name, bio, items_json, created_at, NULL AS views
         FROM lists WHERE unlisted = 0
        ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`
    )
      .bind(PER, offset)
      .all<Row>();
    rows = res.results ?? [];
  } else {
    // 窓の中で 1 回も見られていないリストも、新しい順で後ろに並べる（一覧から消さない）。
    const days = WINDOW_DAYS[sort];
    const since = days ? jstDay(Date.now() - (days - 1) * DAY_MS) : "";
    const res = await env.DB.prepare(
      `SELECT l.slug, l.owner_name, l.bio, l.items_json, l.created_at, COALESCE(v.n, 0) AS views
         FROM lists l
         LEFT JOIN (SELECT slug, SUM(views) AS n FROM list_views WHERE day >= ? GROUP BY slug) v
           ON v.slug = l.slug
        WHERE l.unlisted = 0
        ORDER BY views DESC, l.created_at DESC, l.rowid DESC LIMIT ? OFFSET ?`
    )
      .bind(since, PER, offset)
      .all<Row>();
    rows = res.results ?? [];
  }

  const previews = rows.map((r) => {
    const items = parseStoredItems(r.items_json);
    return items.slice(0, PREVIEW_COVERS).map((it) => toIsbn13(it?.isbn ?? ""));
  });
  const books = await resolveBooks(env, previews.flat());

  const lists = rows.map((r, i) => ({
    slug: r.slug,
    owner_name: r.owner_name ?? "",
    bio: r.bio ?? "",
    created_at: r.created_at,
    views: sort === "new" ? null : r.views ?? 0,
    covers: previews[i].map((isbn) => {
      const b = books.get(isbn);
      return { isbn, title: b?.title ?? "", cover_url: b?.cover_url ?? "" };
    }),
  }));

  return json({ sort, lists, total, page, per: PER }, 200, { "cache-control": "public, max-age=60" });
}
