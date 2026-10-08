import { Env, ViewJob } from "./types";
import { clientIp, json, toIsbn13 } from "./util";
import { currentUser } from "./auth";
import { parseStoredItems, resolveBooks } from "./listItems";
import { edgeCacheKey, purgeEdgeCache, withEdgeCache } from "./edgeCache";

// 公開リストの一覧（/lists）。並びは「新着（公開順）」と、公開ページのアクセス数順の
// 4 窓（今日 / 7日間 / 30日間 / 累計）。限定公開 (unlisted = 1) のリストは出さない。
//
// アクセス数は list_views (slug × JST 日付の日別カウンタ) から数える。数えるのは閲覧ページの
// JS が送るビーコン (POST /api/lists/:slug/view) だけで、JS を実行しないクローラは数えない。
// 作者本人（編集リンクを持つ端末・ログイン中の所有者）はクライアントが送らず、サーバも弾く。
// 同じ訪問者（IP のハッシュ）は 1 リストにつき 1 日 1 回だけ数える（list_view_seen）。
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

/** 訪問者の識別子。IP + 日付の HMAC-SHA256（鍵は secret の VIEW_HASH_SECRET）で、IP そのものは
 *  保存しない。素の SHA-256 だと IPv4 は 2^32 通りしかないので、DB が漏れれば総当たりで IP に戻せる。
 *  鍵付きにして、鍵が無ければ戻せないようにする。日付を混ぜるので日をまたいで同じ人を追跡できない。
 *  User-Agent は混ぜない: 混ぜると UA を変えて送り直すだけで 1 IP からいくらでも数を伸ばせる。
 *  代わりに同じ IP を共有する別の人（携帯キャリアの NAT・社内 LAN 等）は 1 人として数える
 *  （少なめに数える側に倒す）。鍵が未設定なら null（数えない。鍵なしのハッシュは保存しない）。 */
async function visitorKey(request: Request, env: Env, day: string): Promise<string | null> {
  const key = await viewHashKey(env);
  if (!key) return null;
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${clientIp(request)}|${day}`));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
}

// VIEW_HASH_SECRET から作った HMAC 鍵。secret は isolate の間は変わらないので 1 度だけ import する。
let hashKey: { secret: string; key: Promise<CryptoKey> } | null = null;
let warnedNoSecret = false;

function viewHashKey(env: Env): Promise<CryptoKey> | null {
  const secret = (env.VIEW_HASH_SECRET ?? "").trim();
  if (!secret) {
    if (!warnedNoSecret) {
      warnedNoSecret = true;
      console.warn("VIEW_HASH_SECRET is not set: list views are not counted (wrangler secret put VIEW_HASH_SECRET)");
    }
    return null;
  }
  if (hashKey?.secret !== secret) {
    const key = crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]);
    hashKey = { secret, key };
  }
  return hashKey.key;
}

/** POST /api/lists/:slug/view — 閲覧ページのビーコン。数えたかどうかに関係なく 204 を返す
 *  （重複・本人・存在しないリストを外から見分けられないように）。
 *  閲覧ページ本体はキャッシュから返るので、ここで毎回 D1 に書くとバズったリストの閲覧が
 *  そのまま D1 への書き込みの山になる。キューに積んで consumer が 100 件ずつまとめて書く
 *  （recordListViews）。キュー未設定（ローカル・テスト等）ならその場で 1 件だけ書く。 */
export async function handleListView(request: Request, env: Env, ctx: ExecutionContext, slug: string): Promise<Response> {
  const done = new Response(null, { status: 204 });
  if (isCrawler(request.headers.get("user-agent") ?? "")) return done;
  const day = jstDay(Date.now());
  // セッション Cookie があるときだけ D1 を引く（匿名の閲覧は D1 に触らない）。
  const user = await currentUser(request, env);
  const visitor = await visitorKey(request, env, day);
  if (!visitor) return done;
  const job: ViewJob = { slug, day, visitor, userId: user?.id ?? null };
  if (env.VIEW_QUEUE) {
    ctx.waitUntil(env.VIEW_QUEUE.send(job).catch((err) => console.error("view queue send failed", err)));
  } else {
    await recordListViews(env, [job]);
  }
  return done;
}

/** VIEW_QUEUE の consumer 本体（src/index.ts queue）。形の壊れたメッセージは捨て、残りを
 *  1 回でまとめて数える。失敗したら batch ごと再試行する（重複判定は INSERT OR IGNORE なので
 *  数え直しにはならない）。 */
export async function consumeViewBatch(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  const jobs = batch.messages
    .map((m) => m.body as Partial<ViewJob> | null)
    .filter(
      (j): j is ViewJob =>
        !!j && typeof j.slug === "string" && typeof j.day === "string" && typeof j.visitor === "string" &&
        /^[A-Za-z0-9_-]+$/.test(j.slug)
    );
  await recordListViews(env, jobs);
}

/** ビーコンをまとめて数える。D1 への往復は「リストの存在・所有者の照会」「重複判定の
 *  INSERT OR IGNORE（batch）」「日別カウンタの加算（batch）」の 3 回で、件数に依らない。 */
export async function recordListViews(env: Env, jobs: ViewJob[]): Promise<void> {
  if (!jobs.length) return;
  const slugs = [...new Set(jobs.map((j) => j.slug))];
  const owners = await env.DB.prepare(`SELECT slug, user_id FROM lists WHERE slug IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(slugs))
    .all<{ slug: string; user_id: string | null }>();
  const ownerOf = new Map((owners.results ?? []).map((r) => [r.slug, r.user_id]));
  // 存在しないリストと所有者本人の閲覧は数えない。
  const valid = jobs.filter((j) => ownerOf.has(j.slug) && !(j.userId && ownerOf.get(j.slug) === j.userId));
  if (!valid.length) return;
  const seen = await env.DB.batch(
    valid.map((j) =>
      env.DB.prepare(`INSERT OR IGNORE INTO list_view_seen (slug, day, visitor) VALUES (?, ?, ?)`).bind(j.slug, j.day, j.visitor)
    )
  );
  const counts = new Map<string, { slug: string; day: string; n: number }>();
  valid.forEach((j, i) => {
    if (!seen[i]?.meta?.changes) return; // その日はもう数えた
    const key = `${j.slug}|${j.day}`;
    const c = counts.get(key) ?? { slug: j.slug, day: j.day, n: 0 };
    c.n++;
    counts.set(key, c);
  });
  if (!counts.size) return;
  await env.DB.batch(
    [...counts.values()].map((c) =>
      env.DB.prepare(
        `INSERT INTO list_views (slug, day, views) VALUES (?, ?, ?)
         ON CONFLICT (slug, day) DO UPDATE SET views = views + excluded.views`
      ).bind(c.slug, c.day, c.n)
    )
  );
}

/** 重複判定の記録は当日分しか要らないので、前日より古いものを消す（日次 cron）。1 文で
 *  全部消すと行が多い日に D1 を長く塞ぐので、5000 行ずつ小分けにする。 */
export async function purgeListViewSeen(env: Env): Promise<void> {
  const before = jstDay(Date.now() - DAY_MS);
  for (let i = 0; i < 200; i++) {
    const res = await env.DB.prepare(
      `DELETE FROM list_view_seen WHERE rowid IN (SELECT rowid FROM list_view_seen WHERE day < ? LIMIT 5000)`
    )
      .bind(before)
      .run();
    if ((res.meta?.changes ?? 0) < 5000) break;
  }
}

interface Row {
  slug: string;
  owner_name: string | null;
  bio: string | null;
  items_json: string;
  created_at: number;
  views: number | null;
}

// エッジ（Cache API）で持つ秒数。ブラウザ向けの max-age と同じ 60 秒。新しく公開したリストが
// 一覧に出るまで最大でこれだけ遅れる。アクセス数順は list_views の集計が重く、並びが数分
// 遅れても困らないので長めに持つ。
const EDGE_TTL_SEC = 60;
const EDGE_TTL_VIEWS_SEC = 300;
// ページ番号の上限。上限なしだと page=1..N を順に叩くだけでキャッシュを外し、毎回の集計を
// 走らせられる。24 件 × 50 ページ = 1200 件より先は一覧からはたどれない。
const MAX_PAGE = 50;

export async function handlePublicLists(url: URL, env: Env): Promise<Response> {
  const sortParam = url.searchParams.get("sort") as PublicListSort | null;
  const sort: PublicListSort = sortParam && SORTS.includes(sortParam) ? sortParam : "new";
  let page = Math.floor(Number(url.searchParams.get("page")));
  if (!Number.isFinite(page) || page < 1) page = 1;
  page = Math.min(page, MAX_PAGE);
  // キーは正規化した sort / page だけ（他のクエリ文字列でキャッシュを散らされないように）。
  return withEdgeCache(edgeCacheKey(env, "/api/public-lists", { sort, page }), sort === "new" ? EDGE_TTL_SEC : EDGE_TTL_VIEWS_SEC, () =>
    buildPublicLists(env, sort, page)
  );
}

/** 公開リスト一覧の 1 ページ目のエッジキャッシュを（このデータセンタで）消す。公開・更新・削除の
 *  直後に呼べば、その人の見ている一覧にはすぐ出る（他のデータセンタは最大 EDGE_TTL_SEC 遅れる）。 */
export async function purgePublicListsCache(env: Pick<Env, "SITE_VARIANT">): Promise<void> {
  await purgeEdgeCache(SORTS.map((sort) => edgeCacheKey(env, "/api/public-lists", { sort, page: 1 })));
}

async function buildPublicLists(env: Env, sort: PublicListSort, page: number): Promise<Response> {
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
    // 並べ替えは全公開リストが対象なので、まず細い列（rowid・created_at・アクセス数）だけで
    // 並べてページ分の rowid を決め、items_json など重い列はそのページの行だけ読む（items_json を
    // 抱えたまま全行をソートしない）。
    const days = WINDOW_DAYS[sort];
    const since = days ? jstDay(Date.now() - (days - 1) * DAY_MS) : "";
    const res = await env.DB.prepare(
      `WITH page AS (
         SELECT l.rowid AS rid, l.created_at, COALESCE(v.n, 0) AS views
           FROM lists l
           LEFT JOIN (SELECT slug, SUM(views) AS n FROM list_views WHERE day >= ? GROUP BY slug) v
             ON v.slug = l.slug
          WHERE l.unlisted = 0
          ORDER BY views DESC, l.created_at DESC, l.rowid DESC LIMIT ? OFFSET ?
       )
       SELECT l.slug, l.owner_name, l.bio, l.items_json, l.created_at, page.views
         FROM page CROSS JOIN lists l ON l.rowid = page.rid
        ORDER BY page.views DESC, page.created_at DESC, page.rid DESC`
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
