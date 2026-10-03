// 公開閲覧用の「解決済みリスト」スナップショット（R2）と、閲覧レスポンスの colo キャッシュ。
//
// getListData は表示のたびに D1 で 100 冊ぶんの書誌・表紙を解決する（src/listItems.ts）。
// 閲覧ページ /l/:slug・公開 JSON GET /api/lists/:slug・共有画像はこれを R2 の
// view/<slug>.json（MangaList + built_at）から読み、D1 を叩くのはスナップショットが
// 無いとき・古いときだけにする。
//
// 更新の反映:
//   - 作成/更新（POST/PUT /api/lists）: 応答前に作り直す（編集者はすぐ /l/:slug を開く）。
//   - 管理者の伏字・削除、退会時の削除: スナップショットを消す（次の閲覧で D1 から作る）。
//   - 管理者の結合・表紙承認などリスト自体を触らない変更: 表示に効く admin の更新系 API が
//     成功するたびに「表示データの世代」（meta.view_epoch）を上げる（bumpsViewEpoch が
//     どの API で上げるかを決める）。スナップショットと colo キャッシュのキーは世代を含むので、
//     世代が変わると次の閲覧で古いスナップショットを返しつつ裏で D1 から作り直す。反映は
//     世代のメモ（EPOCH_MEMO_MS）・作り直しの間隔（REBUILD_MIN_INTERVAL_MS）・colo キャッシュ
//     （VIEW_CACHE_TTL）を足して、おおむね数分以内。
//   - それ以外（利用者の表紙取得で covers が埋まった等）: 24 時間を過ぎたスナップショットは
//     返しつつ裏で作り直す（stale-while-revalidate）。
//
// 手前に Cache API（caches.default）も置く。これは colo ごとなので、ここでの削除は
// 操作した colo にしか効かない。他の colo は s-maxage（VIEW_CACHE_TTL）で自然に切れる。
// 真の無効化は R2 側、colo キャッシュは短い TTL の上乗せという位置付け。
import { appVersion } from "./analytics";
import { getListData } from "./lists";
import { purgePublicListsCache } from "./publicLists";
import { Env, MangaList } from "./types";

// 中身の形を変えたら上げる（古い版のスナップショットはミス扱いで作り直す）。
const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** 世代が古いスナップショットを作り直す最短の間隔。 */
export const REBUILD_MIN_INTERVAL_MS = 60_000;
/** 閲覧レスポンスを colo キャッシュに置く秒数。 */
export const VIEW_CACHE_TTL = 300;

interface StoredSnapshot {
  v: number;
  built_at: number;
  epoch?: string;
  list: MangaList;
}

// --- 表示データの世代（管理者の変更を全リストに反映する）---

const EPOCH_KEY = "view_epoch";
const EPOCH_MEMO_MS = 30_000;
let epochMemo: { value: string; at: number } | null = null;

/** 現在の世代。D1 を毎回引かないよう isolate ごとに EPOCH_MEMO_MS だけ覚える。 */
export async function getViewEpoch(env: Env): Promise<string> {
  if (epochMemo && Date.now() - epochMemo.at < EPOCH_MEMO_MS) return epochMemo.value;
  let value = "0";
  try {
    const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = ?`).bind(EPOCH_KEY).first<{ value: string }>();
    value = row?.value ?? "0";
  } catch (err) {
    console.error("view epoch read failed", err);
    if (epochMemo) return epochMemo.value;
  }
  epochMemo = { value, at: Date.now() };
  return value;
}

// 表示に影響しない admin の更新系 API（却下・売上の手動取得など）。世代を上げると全リストの
// 閲覧キャッシュが外れて作り直しになるので、これらでは上げない。迷うものは上げる側に倒す。
const NO_EPOCH_ADMIN: [string, RegExp][] = [
  ["POST", /^\/api\/admin\/sales-ranking\/snapshot$/],
  ["POST", /^\/api\/admin\/merge-candidates\/dismiss$/],
  ["DELETE", /^\/api\/admin\/merge-requests\/[^/]+\/[^/]+$/],
  ["DELETE", /^\/api\/admin\/split-requests\/[^/]+$/],
  ["DELETE", /^\/api\/admin\/series-reports\/[^/]+$/],
  ["DELETE", /^\/api\/admin\/volume-title-reports\/[^/]+$/],
  ["POST", /^\/api\/admin\/cover-suggestions\/[^/]+\/dismiss$/],
  ["DELETE", /^\/api\/admin\/reports\/[0-9]+$/],
];

export function bumpsViewEpoch(request: Request): boolean {
  const { method } = request;
  if (method === "GET" || method === "HEAD") return false;
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith("/api/admin/")) return false;
  if (NO_EPOCH_ADMIN.some(([m, re]) => m === method && re.test(path))) return false;
  // 巻の通報は「確定」（巻を非表示にする）だけが表示に効き、却下は効かない。
  if (method === "DELETE" && /^\/api\/admin\/volume-reports\//.test(path) && url.searchParams.get("confirm") !== "1") {
    return false;
  }
  return true;
}

/** 世代を上げる。admin の更新系 API が成功したあとに呼ぶ（src/index.ts）。 */
export async function bumpViewEpoch(env: Env): Promise<void> {
  const value = String(Date.now());
  await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
    .bind(EPOCH_KEY, value)
    .run();
  epochMemo = { value, at: Date.now() };
}

export function snapshotKey(slug: string): string {
  return `view/${slug}.json`;
}

/** D1 から解決し直して R2 に置く。リストが無ければスナップショットも消して null。
 *  解決に失敗したら（縮退表示を 24 時間残さないよう）保存せずに縮退版を返す。 */
export async function buildListSnapshot(env: Env, slug: string, knownAbsent = false): Promise<MangaList | null> {
  // 世代は解決より先に読む（解決中に世代が上がったら、古い世代の印が付いて次で作り直される）。
  const epoch = await getViewEpoch(env);
  let list: MangaList | null;
  try {
    list = await getListData(env, slug, { strict: true });
  } catch (err) {
    console.error("snapshot build failed; serving unresolved list", err);
    return await getListData(env, slug);
  }
  if (!env.COVERS) return list;
  if (!list) {
    // 元からスナップショットが無いと分かっていれば消さない（存在しない slug の閲覧で
    // R2 の書き込み系操作を積ませない）。
    if (!knownAbsent) await env.COVERS.delete(snapshotKey(slug));
    return null;
  }
  const body: StoredSnapshot = { v: SNAPSHOT_VERSION, built_at: Date.now(), epoch, list };
  await env.COVERS.put(snapshotKey(slug), JSON.stringify(body), {
    httpMetadata: { contentType: "application/json" },
  });
  return list;
}

async function readSnapshot(env: Env, slug: string): Promise<StoredSnapshot | null> {
  if (!env.COVERS) return null;
  const obj = await env.COVERS.get(snapshotKey(slug));
  if (!obj) return null;
  try {
    const s = (await obj.json()) as StoredSnapshot;
    return s && s.v === SNAPSHOT_VERSION && s.list && typeof s.built_at === "number" ? s : null;
  } catch {
    return null;
  }
}

// 同じ isolate で同じ slug の作り直しが重ならないように（古いスナップショットへのアクセスが
// 集中したとき D1 を何本も叩かない）。
const rebuilding = new Map<string, Promise<MangaList | null>>();

function rebuildOnce(env: Env, slug: string, knownAbsent = false): Promise<MangaList | null> {
  let p = rebuilding.get(slug);
  if (!p) {
    p = buildListSnapshot(env, slug, knownAbsent).finally(() => rebuilding.delete(slug));
    rebuilding.set(slug, p);
  }
  return p;
}

/** 公開表示用のリスト（edit_token は元から含まない）。R2 のスナップショットを優先し、
 *  24 時間を過ぎていれば返しつつ裏で作り直す。無ければ D1 から作って置く。 */
export async function getListSnapshot(
  env: Env,
  ctx: { waitUntil(p: Promise<unknown>): void },
  slug: string
): Promise<MangaList | null> {
  const [snap, epoch] = await Promise.all([readSnapshot(env, slug).catch(() => null), getViewEpoch(env)]);
  if (!snap) return await rebuildOnce(env, slug, true);
  const age = Date.now() - snap.built_at;
  // 世代は時刻なので大小で比べる（古い世代を覚えた isolate が、新しい世代で作られたものを
  // 不一致とみなして作り直す「ピンポン」を起こさないように）。
  const stale = Number(snap.epoch ?? "0") < Number(epoch);
  // 世代が古い（管理者の変更後）ものも、24 時間を過ぎたものも、いったん返して裏で作り直す。
  // 同期で作り直すと、管理者が 1 操作するたびに人気リストの閲覧が一斉に D1 解決で待たされる。
  // 連続操作で同じリストを何度も作り直さないよう、作ってから REBUILD_MIN_INTERVAL_MS 以内なら
  // 世代が古くても作り直さない（次の閲覧で作り直す）。
  if ((stale && age > REBUILD_MIN_INTERVAL_MS) || age > SNAPSHOT_MAX_AGE_MS) {
    ctx.waitUntil(rebuildOnce(env, slug).catch((err) => console.error("snapshot refresh failed", err)));
  }
  return snap.list;
}

// --- colo キャッシュ（Cache API）---

/** 閲覧レスポンスのキャッシュキー。デプロイ版を混ぜて、デプロイ直後に古い HTML
 *  （古い script ?v=）を返さないようにする。表示データの世代も混ぜて、管理者の変更後は
 *  どの colo でも古いキャッシュを使わない。utm 等のクエリはキーに含めない。 */
export async function viewCacheKeys(
  env: Env,
  origin: string,
  slug: string
): Promise<{ page: string; pageNoCard: string; json: string }> {
  const v = encodeURIComponent(`${appVersion(env)}.${await getViewEpoch(env)}`);
  return {
    page: `${origin}/l/${slug}?__cv=${v}`,
    pageNoCard: `${origin}/l/${slug}?i=1&__cv=${v}`,
    json: `${origin}/api/lists/${slug}?__cv=${v}`,
  };
}

function viewCache(): Cache | null {
  return typeof caches !== "undefined" && caches.default ? caches.default : null;
}

export async function readViewCache(key: string): Promise<Response | null> {
  const cache = viewCache();
  if (!cache) return null;
  try {
    return (await cache.match(key)) ?? null;
  } catch {
    return null;
  }
}

/** res（未消費）を colo キャッシュに置く。呼び出し側は clone を返す。 */
export async function writeViewCache(key: string, res: Response): Promise<void> {
  const cache = viewCache();
  if (!cache) return;
  try {
    await cache.put(key, res);
  } catch (err) {
    console.error("view cache put failed", err);
  }
}

/** この colo の閲覧キャッシュ（ページ 2 種と JSON）を消す。origin が分からなければ何もしない。 */
export async function purgeViewCache(env: Env, origin: string | undefined, slug: string): Promise<void> {
  const cache = viewCache();
  if (!cache || !origin) return;
  const keys = await viewCacheKeys(env, origin, slug);
  await Promise.all(
    [keys.page, keys.pageNoCard, keys.json].map((k) => cache.delete(k).catch(() => false))
  );
}

// --- 変更時のフック ---

/** 作成/更新の直後: スナップショットを作り直し、この colo の閲覧キャッシュを消す。
 *  失敗しても公開自体は成功しているので握り潰す（次の閲覧で作り直される）。 */
export async function refreshListView(env: Env, slug: string, origin: string | undefined): Promise<MangaList | null> {
  try {
    // 公開リスト一覧（src/publicLists.ts）の 1 ページ目もこの colo では消して、すぐ一覧に出す。
    const [list] = await Promise.all([
      buildListSnapshot(env, slug),
      purgeViewCache(env, origin, slug),
      purgePublicListsCache(env),
    ]);
    return list;
  } catch (err) {
    console.error("list view refresh failed", err);
    if (env.COVERS) await env.COVERS.delete(snapshotKey(slug)).catch(() => {});
    return null;
  }
}

/** 伏字など D1 側の内容が変わったとき: スナップショットを消す（次の閲覧で D1 から作る）。 */
export async function invalidateListView(env: Env, slug: string, origin: string | undefined): Promise<void> {
  try {
    await Promise.all([
      env.COVERS ? env.COVERS.delete(snapshotKey(slug)) : Promise.resolve(),
      purgeViewCache(env, origin, slug),
    ]);
  } catch (err) {
    console.error("list view invalidate failed", err);
  }
}

/** リスト削除後: スナップショット・共有画像（share/<slug>/）・閲覧キャッシュを消す。
 *  DB 側の削除が成功した slug にだけ呼ぶ。R2 の掃除の失敗で削除 API を失敗させない。 */
export async function purgeListArtifacts(env: Env, slug: string, origin: string | undefined): Promise<void> {
  try {
    const tasks: Promise<unknown>[] = [purgeViewCache(env, origin, slug), purgePublicListsCache(env)];
    if (env.COVERS) {
      const bucket = env.COVERS;
      tasks.push(bucket.delete(snapshotKey(slug)));
      tasks.push(
        (async () => {
          let cursor: string | undefined;
          do {
            const page = await bucket.list({ prefix: `share/${slug}/`, cursor });
            const keys = page.objects.map((o) => o.key);
            if (keys.length) await bucket.delete(keys);
            cursor = page.truncated ? page.cursor : undefined;
          } while (cursor);
        })()
      );
    }
    await Promise.all(tasks);
  } catch (err) {
    console.error("list artifacts purge failed", err);
  }
}

/** OGP の説明文に出す作品名。同じシリーズの巻は 1 つにまとめる（「ONE PIECE 1巻、
 *  ONE PIECE 2巻…」と並べない）。シリーズの無い本は巻のタイトルのまま。 */
export function ogpWorkTitles(data: MangaList, max = 5): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of data.items) {
    const name = (it.series_title || it.title || "").trim();
    if (!name || name.startsWith("ISBN ") || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= max) break;
  }
  return out;
}
