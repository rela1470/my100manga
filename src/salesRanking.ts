import { Env } from "./types";
import { baseTitle, escapeLikeClamped, hiraToKata, json, LIKE_MAX_BYTES, normTitle, searchKey, vuFold } from "./util";
import { rakutenBestsellers, rakutenReady, type RakutenBestseller } from "./rakuten";
import { resolveUnit } from "./merge";
import { groupKey, isGroupId, loadGroup, NAME_NORM_PREFIX } from "./groups";
import { tagsForLabels } from "./labels";
import { edgeCacheKey, withEdgeCache } from "./edgeCache";
import { siteVariant } from "./site";

// 売上ランキング。楽天ブックスのコミックを「売れている順」（書籍検索API sort=sales）で毎日
// 上位 300 件取得して sales_snapshot に貯め（Cron, see index.ts scheduled）、作品単位で
// 最新日・過去7日・過去30日・今年の 4 窓に集計する。
//
// 楽天は「売れている順」の集計期間も部数も公開していないので、日ごとの順位をポイント
// （1 位 = 300pt … 300 位 = 1pt）にして積み上げる。同じ日に同じ作品が複数並ぶ（新刊と既刊、
// 通常版と特装版、愛蔵版の 1〜4 巻）ときはその日の最高順位だけを数え、巻数の多い作品や
// 特装版のある作品が水増しされないようにする。
//
// 集計の単位は楽天の書名から巻数・版の表記を除いた作品名（salesWorkTitle）。発売前・直近の
// 巻はまだマスタ（MADB）に無いので ISBN ではほとんど引けず、作品名でシリーズ / まとまり
// （G-id）に寄せる（resolveTargets）。寄せ先が無い作品もランキングには出す（リンク無し）。

const PAGES = 10;
const HITS = 30;
const TOP = PAGES * HITS; // 1 日に取得する件数 = 1 位のポイント
const TOP_N = 100; // 各窓に載せる作品数
const DAY_MS = 24 * 60 * 60 * 1000;
const JST_MS = 9 * 60 * 60 * 1000;
const CHUNK = 90; // D1 の bind 上限よけ（readCachedCovers と同じ）
// 読みの照合（seriesByKana）は索引が使えず series 全行を走査するので、1 文に詰める読みは少なめに。
const KANA_CHUNK = 20;

const META_JSON_KEY = "sales_ranking_json";
// Cron が最後にスナップショットを保存した日（JST）。その日の分は Cron のものを正とし、
// 手動取得では置き換えない（毎日同じ時刻に取った順位どうしで比べたいため）。
const META_CRON_DAY_KEY = "sales_snapshot_cron_day";

// 楽天ブックスの書影が未登録の巻（予約中の新刊）は「<ISBN>.gif」の自動生成画像（書名と著者を
// 並べただけの仮表紙）になる。本物の書影は「<ISBN>_1_<n>.jpg」。
const NOW_PRINTING_RE = /\/\d{13}\.gif(?:\?|$)/;

export type SalesWindow = "day" | "d7" | "d30" | "year";
const WINDOWS: SalesWindow[] = ["day", "d7", "d30", "year"];

export interface SalesEntry {
  rank: number;
  work: string; // 作品名（巻数・版の表記を除いた楽天の書名）
  series_id: string | null; // 巻一覧を開く先（C-id / U-id / G-id）。寄せ先が無ければ null
  search_q: string; // 寄せ先が無いときの検索語（/?q=、headWord）。寄せ先があれば ""
  isbn: string; // 代表の巻（窓の中で最後に取得した日の最高順位の巻）
  title: string; // 代表の巻の楽天の書名
  author: string;
  publisher: string;
  sales_date: string;
  cover_url: string; // 書影のある巻のうち最新・最高順位のもの（仮表紙は使わない）→ 寄せ先の最新巻の表紙 → ""
  cover_isbn: string; // cover_url が "" のとき、表紙を /api/covers で引く巻（寄せ先の最新巻）
  points: number;
  best_rank: number; // 窓の中の最高順位（日次）
  days: number; // 窓の中でランクインした日数
}

export interface SalesPayload {
  windows: Record<SalesWindow, SalesEntry[]>;
  latest_day: string; // 最新のスナップショットの日付（JST）
  first_day: string; // 最初のスナップショットの日付（集計の始まり）
  year: string;
  computed_at: number;
}

const jstDay = (ms: number): string => new Date(ms + JST_MS).toISOString().slice(0, 10);
const shiftDay = (day: string, days: number): string =>
  new Date(Date.parse(day + "T00:00:00Z") + days * DAY_MS).toISOString().slice(0, 10);

// 「小冊子付き特装版」「アクリルスタンド付き特装版」など。直前の空白区切りの塊ごと消すが、
// 「（7）なんか…付き特装版」の巻数の括弧は越えない。
const EDITION_RE = /[\s　]*[^\s　）)]*?(?:特装版|限定版|同梱版|通常版|愛蔵版|新装版|特別版|豪華版)/g;
const VOLUME_RE = /(?:[\s　]+(?:第)?[0-9０-９]{1,4}(?:巻)?|[（(][\s　]*(?:第)?[0-9０-９]{1,4}(?:巻)?[\s　]*[）)]|[\s　]*第[0-9０-９]{1,4}巻)$/;

/** 楽天の書名 → 作品名。巻数（末尾の「 18」「（33）」「 11巻」「第9巻」）、版の表記
 *  （特装版・愛蔵版…）、【特典】、〜サブタイトル〜、（※注記）を除く。巻数は 1 つだけ除く
 *  （「金色のガッシュ!! 2（7）」の「2」は作品名の一部）。 */
export function salesWorkTitle(title: string): string {
  return splitSalesTitle(title).work;
}

/** 楽天の書名 → 巻数（salesWorkTitle が除いた巻数）。巻数の無い書名（単巻・画集など）は null。
 *  リンク先の巻一覧の点検（src/salesLinkHealth.ts）が「何巻まで出ているはずか」に使う。 */
export function salesVolumeNumber(title: string): number | null {
  return splitSalesTitle(title).vol;
}

function splitSalesTitle(title: string): { work: string; vol: number | null } {
  let t = title
    .replace(/【[^】]*】/g, " ")
    .replace(/[〜～~][^〜～~]*[〜～~]/g, " ")
    .replace(/[〜～~].*$/, "")
    .replace(/[（(]※[^）)]*[）)]/g, " ")
    .replace(EDITION_RE, " ")
    .trim()
    // 先頭の「ミニクリアファイル付き　」のような特典の塊（空白区切りで後ろに書名が続くときだけ）。
    .replace(/^[^\s　]+付き?[\s　]+(?=[^\s　])/, "");
  // 末尾の「(ミニ色紙付き)」のような数字でない括弧書きを剥がしてから巻数を 1 つ除く。
  for (let prev = ""; prev !== t; ) {
    prev = t;
    t = t.replace(/[\s　]*[（(](?![\s　]*(?:第)?[0-9０-９]{1,4}(?:巻)?[\s　]*[）)])[^（()）]*[）)]$/, "").trim();
  }
  // 長音「ー」は書名の一部（ワールドトリガー）なので末尾の記号に含めない。
  // 空白・括弧の無い巻数（「ブレイド＆バスタード9」）は、和文の直後に付いた数字だけ除く
  // （「らんま1/2」「ARMS」のような英数字の続きは書名の一部とみなす）。
  const m = t.match(VOLUME_RE) ?? t.match(/(?<=[ぁ-んァ-ヶー一-龠々])[0-9０-９]{1,3}$/);
  if (m) t = t.slice(0, m.index);
  const digits = m?.[0].normalize("NFKC").match(/\d+/)?.[0];
  t = t.replace(/[\s　\-－‐:：]+$/, "").replace(/([\s　])[\s　]+/g, "$1").trim();
  return { work: t || title.trim(), vol: digits ? Number(digits) : null };
}

/** 集計キー。normTitle に加えて全角英数・記号を半角に寄せる（楽天とマスタで表記が揺れる）。 */
export const workKey = (work: string): string => normTitle(work.normalize("NFKC"));

export type SnapshotResult = { day: string; count: number; skipped?: "cron_done" };

/** 日次 Cron で売上ランキングを取るか。SALES_RANKING_CRON="true"（本家の本番だけ）で、R18版では
 *  設定を誤っても取らない（楽天ブックスの一般書籍のランキングは R18版では使わない）。 */
export function salesRankingCronEnabled(env: Pick<Env, "SALES_RANKING_CRON" | "SITE_VARIANT">): boolean {
  return env.SALES_RANKING_CRON === "true" && siteVariant(env) !== "adult";
}

/** 今日（JST）の上位 300 件を取得して sales_snapshot に保存し、集計を作り直す。同じ日に
 *  再実行すると、その日の分を置き換える。ただし手動（source = "manual"）は、その日の分を
 *  Cron がもう保存していたら何もしない（Cron の 05:00 の分を正とする。05:00 より前の手動分は
 *  その日の Cron が置き換える）。途中のページで取得できなくなったら（レート制限・HTTP
 *  エラー）、そこまでの分を保存する。 */
export async function runSalesSnapshot(
  env: Env,
  source: "cron" | "manual",
  now = Date.now()
): Promise<SnapshotResult> {
  const day = jstDay(now);
  if (source === "manual" && (await cronDay(env)) === day) return { day, count: 0, skipped: "cron_done" };
  if (!rakutenReady(env)) return { day, count: 0 };
  const items: RakutenBestseller[] = [];
  for (let page = 1; page <= PAGES; page++) {
    const got = await rakutenBestsellers(env, page, HITS);
    if (!got) break;
    items.push(...got);
    if (got.length < HITS) break;
  }
  if (!items.length) return { day, count: 0 };

  const stmts: D1PreparedStatement[] = [env.DB.prepare(`DELETE FROM sales_snapshot WHERE day = ?`).bind(day)];
  items.forEach((it, i) => {
    const work = salesWorkTitle(it.title);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO sales_snapshot
           (day, rank, isbn, title, work, work_norm, author, publisher, sales_date, cover_url)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(day, i + 1, it.isbn, it.title, work, workKey(work), it.author, it.publisher, it.sales_date, it.cover_url)
    );
  });
  if (source === "cron") {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).bind(META_CRON_DAY_KEY, day)
    );
  }
  await env.DB.batch(stmts);
  await storePayload(env, await computeSalesRanking(env, now));
  return { day, count: items.length };
}

async function cronDay(env: Env): Promise<string> {
  const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = ?`)
    .bind(META_CRON_DAY_KEY)
    .first<{ value: string }>();
  return row?.value ?? "";
}

interface AggRow {
  work_norm: string;
  p_day: number;
  b_day: number | null;
  n_day: number;
  p7: number;
  b7: number | null;
  n7: number;
  p30: number;
  b30: number | null;
  n30: number;
  py: number;
  by: number | null;
  ny: number;
}

interface RepRow {
  work_norm: string;
  work: string;
  isbn: string;
  title: string;
  author: string | null;
  publisher: string | null;
  sales_date: string | null;
  cover_url: string | null;
}

async function computeSalesRanking(env: Env, now = Date.now()): Promise<SalesPayload> {
  const bounds = await env.DB.prepare(`SELECT MIN(day) AS first, MAX(day) AS latest FROM sales_snapshot`).first<{
    first: string | null;
    latest: string | null;
  }>();
  const latest = bounds?.latest ?? "";
  const year = (latest || jstDay(now)).slice(0, 4);
  const empty = Object.fromEntries(WINDOWS.map((w) => [w, []])) as unknown as Record<SalesWindow, SalesEntry[]>;
  if (!latest) return { windows: empty, latest_day: "", first_day: "", year, computed_at: now };

  // 窓は最新のスナップショットの日を基準にする（Cron が止まっても窓が空にならない）。
  const d7 = shiftDay(latest, -6);
  const d30 = shiftDay(latest, -29);
  const yearStart = `${year}-01-01`;
  const from = d30 < yearStart ? d30 : yearStart;

  const res = await env.DB.prepare(
    `WITH daily AS (
       SELECT day, work_norm, MAX(?1 + 1 - rank) AS pt, MIN(rank) AS best
         FROM sales_snapshot WHERE day >= ?2 GROUP BY day, work_norm
     )
     SELECT work_norm,
            SUM(CASE WHEN day = ?3 THEN pt ELSE 0 END)  AS p_day,
            MIN(CASE WHEN day = ?3 THEN best END)       AS b_day,
            COUNT(CASE WHEN day = ?3 THEN 1 END)        AS n_day,
            SUM(CASE WHEN day >= ?4 THEN pt ELSE 0 END) AS p7,
            MIN(CASE WHEN day >= ?4 THEN best END)      AS b7,
            COUNT(CASE WHEN day >= ?4 THEN 1 END)       AS n7,
            SUM(CASE WHEN day >= ?5 THEN pt ELSE 0 END) AS p30,
            MIN(CASE WHEN day >= ?5 THEN best END)      AS b30,
            COUNT(CASE WHEN day >= ?5 THEN 1 END)       AS n30,
            SUM(CASE WHEN day >= ?6 THEN pt ELSE 0 END) AS py,
            MIN(CASE WHEN day >= ?6 THEN best END)      AS by,
            COUNT(CASE WHEN day >= ?6 THEN 1 END)       AS ny
       FROM daily GROUP BY work_norm`
  )
    .bind(TOP, from, latest, d7, d30, yearStart)
    .all<AggRow>();
  const rows = res.results ?? [];

  const picks: Record<SalesWindow, (r: AggRow) => [number, number, number]> = {
    day: (r) => [r.p_day, r.b_day ?? 0, r.n_day],
    d7: (r) => [r.p7, r.b7 ?? 0, r.n7],
    d30: (r) => [r.p30, r.b30 ?? 0, r.n30],
    year: (r) => [r.py, r.by ?? 0, r.ny],
  };
  const tops = Object.fromEntries(
    WINDOWS.map((w) => [
      w,
      rows
        .filter((r) => picks[w](r)[0] > 0)
        .sort((a, b) => {
          const [pa, ba] = picks[w](a);
          const [pb, bb] = picks[w](b);
          return pb - pa || ba - bb || a.work_norm.localeCompare(b.work_norm);
        })
        .slice(0, TOP_N),
    ])
  ) as Record<SalesWindow, AggRow[]>;

  // 代表の巻: その作品を最後に取得した日の最高順位の巻（最新刊・予約中の新刊になりやすい）。
  const keys = [...new Set(WINDOWS.flatMap((w) => tops[w].map((r) => r.work_norm)))];
  const reps = new Map<string, RepRow>();
  const isbnsByWork = new Map<string, Set<string>>();
  const covers = new Map<string, string>(); // 表紙は書影のある巻のうち最新・最高順位のもの
  for (let i = 0; i < keys.length; i += CHUNK) {
    const chunk = keys.slice(i, i + CHUNK);
    const r = await env.DB.prepare(
      `SELECT work_norm, work, isbn, title, author, publisher, sales_date, cover_url
         FROM sales_snapshot
        WHERE day >= ? AND work_norm IN (${chunk.map(() => "?").join(",")})
        ORDER BY day DESC, rank ASC`
    )
      .bind(from, ...chunk)
      .all<RepRow>();
    for (const row of r.results ?? []) {
      if (!reps.has(row.work_norm)) reps.set(row.work_norm, row);
      if (!covers.has(row.work_norm) && row.cover_url && !NOW_PRINTING_RE.test(row.cover_url)) {
        covers.set(row.work_norm, row.cover_url);
      }
      const set = isbnsByWork.get(row.work_norm) ?? new Set<string>();
      set.add(row.isbn);
      isbnsByWork.set(row.work_norm, set);
    }
  }
  const targets = await resolveTargets(
    env,
    keys.map((k) => ({
      key: k,
      work: reps.get(k)?.work ?? k,
      author: reps.get(k)?.author ?? "",
      isbns: [...(isbnsByWork.get(k) ?? [])],
    }))
  );

  // 書影のある巻がランキングに無い作品（予約中の新刊だけが並んでいる等）は、寄せ先のシリーズ /
  // まとまりの最新巻のキャッシュ済み表紙で代える。
  const coverIsbns = new Map<string, string>();
  for (const k of keys) {
    const id = targets.get(k);
    if (covers.has(k) || !id) continue;
    const c = await latestSeriesCover(env, id);
    if (c.url) covers.set(k, c.url);
    else if (c.isbn) coverIsbns.set(k, c.isbn);
  }

  const build = (w: SalesWindow): SalesEntry[] =>
    tops[w].map((r, i) => {
      const rep = reps.get(r.work_norm);
      const [points, best, days] = picks[w](r);
      return {
        rank: i + 1,
        work: rep?.work ?? r.work_norm,
        series_id: targets.get(r.work_norm) ?? null,
        // マスタの書名は英数記号が半角（「もやしもん+」）なので全角を寄せる。
        search_q: targets.has(r.work_norm) ? "" : headWord(rep?.work ?? r.work_norm).normalize("NFKC"),
        isbn: rep?.isbn ?? "",
        title: rep?.title ?? "",
        author: rep?.author ?? "",
        publisher: rep?.publisher ?? "",
        sales_date: rep?.sales_date ?? "",
        cover_url: covers.get(r.work_norm) ?? "",
        cover_isbn: coverIsbns.get(r.work_norm) ?? "",
        points,
        best_rank: best,
        days,
      };
    });

  return {
    windows: Object.fromEntries(WINDOWS.map((w) => [w, build(w)])) as Record<SalesWindow, SalesEntry[]>,
    latest_day: latest,
    first_day: bounds?.first ?? latest,
    year,
    computed_at: now,
  };
}

/** 寄せ先の最新巻の表紙。キャッシュに表紙が無ければ url は "" で、最新巻の ISBN だけ返す
 *  （閲覧側が /api/covers で引く）。 */
export async function latestSeriesCover(env: Env, id: string): Promise<{ url: string; isbn: string }> {
  if (isGroupId(id)) {
    const vols = [...((await loadGroup(env, id.slice(1)))?.volumes ?? [])].reverse();
    return { url: vols.find((v) => v.cover_url)?.cover_url ?? "", isbn: vols[0]?.isbn ?? "" };
  }
  const r = await env.DB.prepare(
    `SELECT v.isbn, COALESCE(c.cover_url, '') AS cover_url
       FROM volumes v LEFT JOIN covers c ON c.isbn = v.isbn
      WHERE v.series_id = ?
      ORDER BY v.vol_sort DESC, v.pubdate DESC LIMIT 20`
  )
    .bind(id)
    .all<{ isbn: string; cover_url: string }>();
  const rows = r.results ?? [];
  return { url: rows.find((x) => x.cover_url)?.cover_url ?? "", isbn: rows[0]?.isbn ?? "" };
}

export interface WorkRef {
  key: string;
  work: string;
  author: string;
  isbns: string[];
}

// 楽天の著者表記（「金城 宗幸/ノ村 優介」）→ 照合用の著者名（空白を除く）。
const authorNames = (author: string): string[] =>
  author
    .split(/[\/／,、]/)
    .map((a) => workKey(a))
    .filter(Boolean);
const creatorMatches = (creator: string | null, names: string[]): boolean => {
  const c = workKey(creator ?? "");
  return Boolean(c) && names.some((n) => c.includes(n));
};

/** 作品 → 巻一覧を開く先（C-id / U-id / G-id）。見つからない作品は Map に入れない。
 *   1. 楽天の ISBN がマスタにありシリーズが付いている → そのシリーズ
 *   2. 作品名と同じ名前のシリーズ（完全一致 → 区切り記号・全角半角を無視した一致 /「:」「=」
 *      以降を除いた基本書名の一致）。同名が複数（レーベル違いの文庫版・総集編など）なら pickBest
 *   3. シリーズの無い巻のまとまり（書名 + 著者 + レーベル）。複数なら同じく pickBest
 *   4. 読み（name_kana_norm）の一致。マスタが英字で楽天がカタカナの作品
 *      （「BLACK LAGOON」↔「ブラック・ラグーン」）を拾う
 *   5. 副題・外伝を落とした名前（workVariants）で 2 / 3 をもう一度
 *  最後に resolveUnit で結合済みの読み替え・まとまりの正規 ID への寄せをする。 */
export async function resolveTargets(env: Env, works: WorkRef[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();

  // 1. ISBN
  const allIsbns = [...new Set(works.flatMap((w) => w.isbns))];
  const seriesByIsbn = new Map<string, string>();
  for (let i = 0; i < allIsbns.length; i += CHUNK) {
    const chunk = allIsbns.slice(i, i + CHUNK);
    const r = await env.DB.prepare(
      `SELECT isbn, series_id FROM volumes
        WHERE series_id IS NOT NULL AND isbn IN (${chunk.map(() => "?").join(",")})`
    )
      .bind(...chunk)
      .all<{ isbn: string; series_id: string }>();
    for (const row of r.results ?? []) seriesByIsbn.set(row.isbn, row.series_id);
  }
  for (const w of works) {
    const sid = w.isbns.map((i) => seriesByIsbn.get(i)).find(Boolean);
    if (sid) found.set(w.key, sid);
  }

  // 2. シリーズ名 / 3. シリーズの無い巻のまとまり
  const rest: WorkRef[] = [];
  for (const w of works) {
    if (found.has(w.key)) continue;
    const names = authorNames(w.author);
    const id = (await seriesByName(env, w.work, names)) ?? (await groupByTitle(env, w.work, names));
    if (id) found.set(w.key, id);
    else rest.push(w);
  }

  // 4. 読み
  for (const [key, id] of await seriesByKana(env, rest)) found.set(key, id);

  // 5. 副題・外伝を落とした名前（確かなものから順に、最初に当たったもの）
  for (const w of rest) {
    if (found.has(w.key)) continue;
    const names = authorNames(w.author);
    for (const v of workVariants(w.work).slice(1)) {
      const id = (await seriesByName(env, v, names)) ?? (await groupByTitle(env, v, names));
      if (id) {
        found.set(w.key, id);
        break;
      }
    }
  }

  const out = new Map<string, string>();
  for (const [key, id] of found) {
    const unit = await resolveUnit(env, id);
    if (unit) out.set(key, unit);
  }
  return out;
}

interface NamedSeries {
  id: string;
  name: string;
  creator: string | null;
  n: number;
  tag: string | null; // レーベルに付いた運営のタグ（廉価版 / 文庫版 / 傑作選。src/labels.ts）
}

interface KanaSeries extends NamedSeries {
  kana: string; // name_kana_norm（「|」区切りの読み）
  creators: string; // creators_norm（取り込みが「|」でつないだ全作者名）
}

/** 同名の候補から 1 つ選ぶ。巻の多いもの（本編の単行本）を優先し、著者が合うものは 4 倍に
 *  数える。著者で絞り切らないのは、マスタの著者表記が楽天と違うことがあるため（こち亀の
 *  ジャンプ・コミックス 201 巻は旧筆名「山止たつひこ」、文庫版 26 巻は「秋本治」）。
 *
 *  レーベルにタグ（廉価版・文庫版・傑作選）が付いている候補は、タグの無い候補がある限り
 *  選ばない（点数での減点ではなく後回し）。ランキングから開きたいのは本編の単行本で、
 *  廉価版・文庫版・傑作選はどれも別の形の本だから。巻数だけで選ぶと、本編が複数シリーズに
 *  分かれていて文庫版が 1 本にまとまっている作品で文庫版が勝ってしまう。タグの付いた候補
 *  しか無いときはそれを選ぶ（寄せ先なしよりは開ける方がよい）。 */
function pickBest<T extends { creator: string | null; n: number; tag?: string | null }>(
  cands: T[],
  names: string[]
): T | undefined {
  const score = (c: T) => c.n * (creatorMatches(c.creator, names) ? 4 : 1);
  const tagged = (c: T) => (c.tag ? 1 : 0);
  return [...cands].sort((a, b) => tagged(a) - tagged(b) || score(b) - score(a))[0];
}

// 照合用のゆるいキー: 全角半角を寄せ、空白と区切り記号（「ちいかわ : なんか…」の「:」、
// 「あさドラ!」の「!」、長音・中黒・星など）を全部落とす。楽天とマスタで表記が揺れるところ
// （「遊☆戯☆王」↔ マスタの「遊・戯・王」）。
const LOOSE_PUNCT = /[\s:：=＝・･☆★!！?？、。,.．\-－‐ー~〜～＠@'"’”「」『』]/g;
const looseKey = (s: string): string => s.normalize("NFKC").toLowerCase().replace(LOOSE_PUNCT, "");

/** 作品名の先頭の語（最初の空白・区切り記号まで。2 文字未満なら作品名そのまま）。表記揺れは
 *  先頭より後ろに出やすい（「ハナバス 苔石花江のバスケ論」↔ マスタ「ハナバス」）ので、照合の
 *  LIKE と、寄せ先が無い作品の検索リンク（search_q）はこれで広めに拾う。 */
export function headWord(work: string): string {
  const head = work.split(/[\s　:：=＝・!！?？、。,.\-－‐~〜～＠@（(]/)[0];
  return head.length >= 2 ? head : work;
}

/** LIKE の前方一致パターン。headWord で広めに拾って looseKey で絞る。 */
function likePrefix(work: string): string {
  return escapeLikeClamped(normTitle(headWord(work)), LIKE_MAX_BYTES - 1) + "%";
}

/** シリーズ名（name_norm）の前方一致文字列（NAME_NORM_PREFIX に 2 回 bind）。likePrefix と同じ範囲。 */
function namePrefix(work: string): string {
  return normTitle(headWord(work));
}

/** 書名が作品名と同じ作品を指すか: ゆるいキーで一致（〜サブタイトル〜を除いても可）、または
 *  「:」「=」以降を除いた基本書名が一致。 */
const sameWork = (title: string, work: string): boolean => {
  const w = looseKey(work);
  const t = title.replace(/[〜～~][^〜～~]*[〜～~]/g, ""); // salesWorkTitle と同じく〜サブタイトル〜を除く
  return looseKey(title) === w || looseKey(t) === w || looseKey(baseTitle(title)) === w;
};

// 候補と一緒に引く列。タグは search.ts SERIES_COLS と同じ相関サブクエリなので D1 の往復は増えない。
const CAND_COLS = `s.id, s.name, s.creator,
        (SELECT t.tag FROM label_tag t WHERE t.label = s.label) AS tag,
        (SELECT COUNT(*) FROM volumes v WHERE v.series_id = s.id) AS n`;

async function seriesByName(env: Env, work: string, names: string[]): Promise<string | null> {
  const exact = [...new Set([normTitle(work), workKey(work)])];
  const r = await env.DB.prepare(
    `SELECT ${CAND_COLS}
       FROM series s WHERE s.name_norm IN (${exact.map(() => "?").join(",")})`
  )
    .bind(...exact)
    .all<NamedSeries>();
  let cands = r.results ?? [];
  if (!cands.length) {
    const like = await env.DB.prepare(
      `SELECT ${CAND_COLS}
         FROM series s WHERE ${NAME_NORM_PREFIX} LIMIT 500`
    )
      .bind(namePrefix(work), namePrefix(work))
      .all<NamedSeries>();
    cands = (like.results ?? []).filter((s) => sameWork(s.name, work));
  }
  return pickBest(cands, names)?.id ?? null;
}

async function groupByTitle(env: Env, work: string, names: string[]): Promise<string | null> {
  const r = await env.DB.prepare(
    `SELECT isbn, title, creator, label FROM volumes
      WHERE series_id IS NULL AND REPLACE(REPLACE(title, ' ', ''), '　', '') LIKE ? ESCAPE '\\'
      LIMIT 2000`
  )
    .bind(likePrefix(work))
    .all<{ isbn: string; title: string; creator: string | null; label: string | null }>();
  // まとまりは「書名 + 著者 + レーベル」（groups.groupKey、loadGroup と同じ粒度）。
  const groups = new Map<string, { isbn: string; creator: string | null; label: string; n: number }>();
  for (const v of r.results ?? []) {
    if (!sameWork(v.title, work)) continue;
    const g = groupKey(v);
    const slot = groups.get(g);
    if (slot) slot.n++;
    else groups.set(g, { isbn: v.isbn, creator: v.creator, label: v.label ?? "", n: 1 });
  }
  if (!groups.size) return null;
  // まとまりは series 行が無いので、レーベルのタグは別に引く（候補があるときだけ）。
  const tags = await tagsForLabels(env, [...groups.values()].map((g) => g.label));
  const best = pickBest(
    [...groups.values()].map((g) => ({ ...g, tag: tags.get(g.label) ?? null })),
    names
  );
  return best ? "G" + best.isbn : null;
}

// ダッシュとして使われる記号。楽天は副題を「ー」「-」で囲むことがある
// （「ながたんと青とーいちかの料理帖ー」= マスタ「ながたんと青と : いちかの料理帖」、
// 「ホタルの嫁入り外伝 -人斬りと幼童ー」）。長音「ー」と区別が付かないので、作品名そのままで
// 寄せ先が見つからなかったときの二の矢（workVariants）としてだけ切る。
const DASH_RE = /[-－‐‑–—ー]/;
// 「ホタルの嫁入り外伝」のような外伝・番外編。新刊はマスタに無いことが多いので本編に寄せる。
const SPINOFF_RE = /[\s　]*(?:外伝|番外編|番外篇|スピンオフ)$/;

/** 作品名の照合に使う名前を、確かなものから順に。
 *   1. 作品名そのまま
 *   2. 最初のダッシュから後ろ（副題）を落としたもの。長音を切ってしまっても
 *      （「スキップとローファー」→「スキップとロ」）照合は完全一致（sameWork / baseTitle）なので
 *      別の作品には当たらない。2 文字以下（「ワールドトリガー」→「ワ」）は短すぎるので使わない
 *   3. さらに末尾の「外伝」「番外編」を落としたもの（本編のシリーズに寄せる）。外伝そのものが
 *      マスタにあれば 2 までで当たるので、本編に寄るのは外伝がマスタに無いときだけ */
export function workVariants(work: string): string[] {
  const out = [work];
  const head = work.split(DASH_RE)[0].replace(/[\s　]+$/, "");
  if (head.length >= 3 && head !== work) out.push(head);
  const base = out[out.length - 1].replace(SPINOFF_RE, "");
  if (base.length >= 2 && !out.includes(base)) out.push(base);
  return out;
}

/** 読みの照合キー。記号・全角半角を無視し（「ブラック・ラグーン」→「ブラックラグーン」）、
 *  ひらがなをカタカナに、ヴをバ行に寄せる（ingest が name_kana_norm に入れる形に合わせる）。 */
const kanaKey = (s: string): string => vuFold(hiraToKata(searchKey(s)));

/** 読み（series.name_kana_norm）での照合。マスタが英字・楽天がカタカナのように書名の字が違う
 *  作品（「BLACK LAGOON」↔「ブラック・ラグーン」）を拾う。読みだけの一致は同音の別作品に
 *  当たりやすいので、著者が合う候補に限る。
 *
 *  name_kana_norm は読みを「|」でつないだもの（英字の別名も読みのひとつ: ONE PIECE なら
 *  「onepiece|ワンピース」）で、当たりが先頭とは限らないから読みの索引では引けない。全行走査に
 *  なるので作品ごとに引かず、残り全部の読みを 1 文にまとめる。 */
async function seriesByKana(env: Env, works: WorkRef[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const byKey = new Map<string, WorkRef[]>();
  for (const w of works) {
    const k = kanaKey(w.work);
    if (k.length < 3 || !authorNames(w.author).length) continue; // 短い読み・著者不明は当てにしない
    const slot = byKey.get(k);
    if (slot) slot.push(w);
    else byKey.set(k, [w]);
  }
  const keys = [...byKey.keys()];
  for (let i = 0; i < keys.length; i += KANA_CHUNK) {
    const chunk = keys.slice(i, i + KANA_CHUNK);
    const r = await env.DB.prepare(
      `SELECT ${CAND_COLS}, s.name_kana_norm AS kana, COALESCE(s.creators_norm, '') AS creators
         FROM series s
        WHERE ${chunk.map(() => `('|' || s.name_kana_norm || '|') LIKE ? ESCAPE '\\'`).join(" OR ")}`
    )
      .bind(...chunk.map((k) => "%|" + escapeLikeClamped(k, LIKE_MAX_BYTES - 4) + "|%"))
      .all<KanaSeries>();
    const cands = new Map<string, KanaSeries[]>();
    for (const row of r.results ?? []) {
      for (const k of new Set((row.kana ?? "").split("|").map(kanaKey))) {
        if (!byKey.has(k)) continue;
        const slot = cands.get(k);
        if (slot) slot.push(row);
        else cands.set(k, [row]);
      }
    }
    for (const [k, rows] of cands) {
      for (const w of byKey.get(k) ?? []) {
        const names = authorNames(w.author);
        // 読みが同じでも、記号の有無しか違わない候補（「もやしもん＋」に対する「もやしもん」）は
        // 別の作品。記号を落とした一致を作品の同定に使わないのはマスタ側の決まりでもある
        // （src/util.ts searchKey）。区切り記号の揺れだけの候補（「ブラック・ラグーン」↔
        // 「ブラックラグーン」）は looseKey で一致する＝同じ作品なので残す。
        const sk = searchKey(w.work);
        const lk = looseKey(w.work);
        const sameButForSymbols = (name: string) => searchKey(name) === sk && looseKey(name) !== lk;
        const best = pickBest(
          rows.filter(
            (s) =>
              !sameButForSymbols(s.name) &&
              (creatorMatches(s.creator, names) || creatorMatches(s.creators, names))
          ),
          names
        );
        if (best) out.set(w.key, best.id);
      }
    }
  }
  return out;
}

async function storePayload(env: Env, payload: SalesPayload): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
    .bind(META_JSON_KEY, JSON.stringify(payload))
    .run();
}

/** GET /api/sales-ranking。Cron が保存した集計を返す。まだ無ければ（初回・手動で
 *  スナップショットを入れた直後など）その場で集計して保存する。 */
export async function handleSalesRanking(env: Env): Promise<Response> {
  // エッジで 60 秒持って、要求ごとに meta の大きな JSON を D1 から読まないようにする。空の集計
  // （no-store）はエッジにも入れない。
  return withEdgeCache(
    edgeCacheKey(env, "/api/sales-ranking"),
    60,
    async () => {
      let payload = await readPayload(env); // 壊れていたら null → 作り直す
      if (!payload) {
        payload = await computeSalesRanking(env);
        if (payload.latest_day) await storePayload(env, payload);
      }
      // 更新は 1 日 1 回だが、更新直後（毎朝の Cron・手動取得）に古い集計が長く残らないよう短めに
      // する。空の集計（まだ取得していない）はキャッシュさせない（データが入った後も空のまま見える）。
      const cache = payload.latest_day ? "public, max-age=300" : "no-store";
      return json(payload, 200, { "cache-control": cache });
    },
    (res) => res.status === 200 && !(res.headers.get("cache-control") ?? "").includes("no-store")
  );
}

/** 売上ランキングに出ている作品の寄せ先 ID を、窓をまたいだ最高順位の順に。暖機
 *  （src/warm.ts）が「いま売れている作品の巻から先に温める」のに使う。 */
export async function salesSeriesIds(env: Env): Promise<string[]> {
  const payload = await readPayload(env);
  const best = new Map<string, number>();
  for (const w of WINDOWS) {
    for (const e of payload?.windows[w] ?? []) {
      if (!e.series_id) continue;
      const cur = best.get(e.series_id);
      if (cur === undefined || e.rank < cur) best.set(e.series_id, e.rank);
    }
  }
  return [...best.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
}

/** 保存済みの行の作品名を今の salesWorkTitle で付け直す（書名ごと、変わったものだけ）。 */
async function rederiveWorks(env: Env): Promise<void> {
  const r = await env.DB.prepare(`SELECT DISTINCT title, work FROM sales_snapshot`).all<{ title: string; work: string }>();
  const stmts = (r.results ?? [])
    .map((row) => ({ title: row.title, old: row.work, work: salesWorkTitle(row.title) }))
    .filter((x) => x.work !== x.old)
    .map((x) =>
      env.DB.prepare(`UPDATE sales_snapshot SET work = ?, work_norm = ? WHERE title = ?`).bind(x.work, workKey(x.work), x.title)
    );
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
}

/** POST /api/admin/sales-ranking/snapshot。Cron を待たずに今日の分を取得・集計する
 *  （今日の分を Cron が保存済みなら skipped: "cron_done" で何もしない）。
 *  ?recompute=1 なら取得せず集計だけ作り直す（作品名・寄せ先の判定を直した後など）。 */
export async function adminSalesSnapshot(env: Env, recompute: boolean): Promise<Response> {
  if (recompute) {
    await rederiveWorks(env);
    const payload = await computeSalesRanking(env);
    await storePayload(env, payload);
    return json({ ok: true, latest_day: payload.latest_day }, 200, { "cache-control": "no-store" });
  }
  const r = await runSalesSnapshot(env, "manual");
  return json({ ok: r.count > 0, ...r }, 200, { "cache-control": "no-store" });
}

export async function readPayload(env: Env): Promise<SalesPayload | null> {
  const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = ?`)
    .bind(META_JSON_KEY)
    .first<{ value: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as SalesPayload;
  } catch {
    return null;
  }
}

/** GET /api/admin/sales-ranking。管理画面の「売上ランキング」: 取得状況（Cron が止まって
 *  いないか）と、巻一覧へのリンクが付かなかった作品（どれかの窓の上位に入っているもの）。 */
export async function adminSalesStatus(env: Env): Promise<Response> {
  const days = await env.DB.prepare(
    `SELECT day, COUNT(*) AS count FROM sales_snapshot GROUP BY day ORDER BY day DESC LIMIT 14`
  ).all<{ day: string; count: number }>();
  const totals = await env.DB.prepare(
    `SELECT COUNT(DISTINCT day) AS days, COUNT(*) AS rows, MIN(day) AS first FROM sales_snapshot`
  ).first<{ days: number; rows: number; first: string | null }>();
  const payload = await readPayload(env);

  // 作品ごとに、載っている窓の順位をまとめる（日次の順位が高い順 → 30日の順位順）。
  const unlinked = new Map<
    string,
    { work: string; search_q: string; title: string; author: string; ranks: Partial<Record<SalesWindow, number>> }
  >();
  for (const w of WINDOWS) {
    for (const e of payload?.windows[w] ?? []) {
      if (e.series_id) continue;
      const u = unlinked.get(e.work) ?? { work: e.work, search_q: e.search_q, title: e.title, author: e.author, ranks: {} };
      u.ranks[w] = e.rank;
      unlinked.set(e.work, u);
    }
  }
  const order = (u: { ranks: Partial<Record<SalesWindow, number>> }) =>
    Math.min(...WINDOWS.map((w) => u.ranks[w] ?? Infinity));
  const linkedCount = (w: SalesWindow) => (payload?.windows[w] ?? []).filter((e) => e.series_id).length;

  return json(
    {
      days: days.results ?? [],
      total_days: totals?.days ?? 0,
      total_rows: totals?.rows ?? 0,
      first_day: totals?.first ?? "",
      latest_day: payload?.latest_day ?? "",
      cron_day: await cronDay(env),
      computed_at: payload?.computed_at ?? 0,
      linked: Object.fromEntries(WINDOWS.map((w) => [w, [linkedCount(w), (payload?.windows[w] ?? []).length]])),
      unlinked: [...unlinked.values()].sort((a, b) => order(a) - order(b)),
    },
    200,
    { "cache-control": "no-store" }
  );
}
