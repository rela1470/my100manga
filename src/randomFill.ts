import { Env } from "./types";
import { json, badRequest, toIsbn13 } from "./util";
import { getSeriesVolumes } from "./series";
import { edgeCacheKey, withEdgeCache } from "./edgeCache";
import { isCompleteRun } from "./seriesStats";

export { isCompleteRun };

// ── 残りの枠をランダムなシリーズで埋める（GET /api/random-fill）──────────────
//
// 100 冊を最後まで選びきるのがしんどい人向けに、残り n 枠を「1 巻から最終巻まで欠けずに
// そろっているシリーズ」だけで、合計がちょうど n 冊になるように選ぶ。途中の巻だけ入る
// ことはない（シリーズは丸ごと入るか、入らないか）。
//
// 選び方（1 本で埋まるのを最優先にする）:
//   1. まず巻数がちょうど n のシリーズを探す。候補が少ない巻数（大きい n はたいてい数本）は
//      全部を並べてシャッフルし、順に確かめる。ランダムに 1 本ずつ引くと同じものに当たり
//      続けて、在るのに見つからないことがあるため。確かめる回数もここだけ多めに取る。
//   2. 無ければ巻数 k を選んで 1 本取り、n -= k で繰り返す（次の回はまた「ちょうど残り」から
//      探すので、2 本目で埋まりやすい）。k は [n/2, n-1] → [n/3, n/2) → それ未満 の順に、
//      各帯の中はランダムに試す。大きい方から取るのは本数を少なくするため（1 巻物ばかり
//      30 本並ぶような埋まり方を避ける）。最後は 1 巻物でも必ず埋まる（マスタに 9 万本ある）。
//
// 巻数の当たりは、まず series_stats.complete_run（巻一覧と同じ数え方で 1..k がそろっていると
// 分かっているもの。src/seriesStats.ts）で付け、足りなければ series.num_items
// （schema:numberOfItems）で付ける。num_items は巻一覧と食い違うことがあり（迷子巻・ISBN の
// 無い巻・結合先への吸収。銀魂は記録 76 に対して巻一覧は 1〜77 巻）、series_stats の無い
// 巻数（数え直しが届いていない・取り込み直後）の保険。どちらで引いても最後に実際の巻一覧
// （getSeriesVolumes。利用者が「全N巻を追加」で入れるのと同じもの）で確かめ、巻番号が 1..k で
// 欠けなくそろうものだけを採る。
//
// 候補の多い巻数のランダムな引き方: ORDER BY random() や OFFSET は該当行を全部読む（1 巻物は
// 9 万行）ので使わず、その巻数の id の範囲 [MIN, MAX] から乱数で閾値を作り、id >= 閾値の
// 先頭を索引で 1 行だけ引く。id は全部 "C" + 6 桁（独自シリーズは "U" + 6 桁）で同じ長さ
// なので文字列比較で数値順に並ぶ。id の間隔の偏りぶんだけ一様ではないが、気にするほどではない。
//
// exclude: 再抽選（public/app.js randomFill）で、直前に出したシリーズを外して別の顔ぶれにする。

/** 1 回で埋めにいく枠の上限。公開は 100 冊ちょうどなので、それ以上は要らない。 */
const MAX_N = 100;
/** 選んだ結果に出してよいシリーズ数の上限（暴走よけ。実際は 100 枠でも数本で埋まる）。 */
const MAX_PIECES = 30;
/** 1 本を見つけるまでに巻一覧を確かめる回数の上限（巻数ごと）。 */
const TRIES_PER_SIZE = 4;
/** 「ちょうど残り」の 1 本で埋める回だけの上限（1 本で埋まるのを優先するので多め）。 */
const TRIES_EXACT = 12;
/** 候補をまとめて読んでシャッフルする巻数の上限本数（これより多い巻数は乱数で 1 本ずつ引く）。 */
const LIST_ALL_MAX = 40;
/** 1 回の要求で巻一覧を確かめる総回数の上限。巻一覧 1 本で D1 を 20 本前後引き、Worker 1 回の
 *  D1 クエリ上限は 1000 なので、候補引きの分（下の QUERY_BUDGET）と合わせて収まるようにする。 */
const MAX_CHECKS = 30;
/** 候補引き（巻数ごとの MIN / MAX と乱数の 1 行）に使ってよい D1 クエリ数。巻一覧の確認
 *  （MAX_CHECKS × 約 20 本）と合わせて 1000 の内側に収める。 */
const QUERY_BUDGET = 250;
/** 既にリストにある ISBN として受け取る数の上限（URL に載るので）。 */
const MAX_HAVE = 200;

interface FillVolume {
  isbn: string;
  isbns?: string[];
  volume_number: string;
  [k: string]: unknown;
}
interface FillSeries {
  series_id: string;
  title: string;
  version?: string;
  creator?: string;
  creators?: string;
  volumes: FillVolume[];
}

function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 候補の引き先。series_stats（巻一覧と同じ数え方で、1..k がそろっていると分かっている）が先、
 *  series.num_items（MADB の記録。巻一覧とずれることがある）が後。 */
const SOURCES = [
  { table: "series_stats", id: "series_id", size: "complete_run" },
  { table: "series", id: "id", size: "num_items" },
] as const;
type Source = (typeof SOURCES)[number];

/** 1 回の抽選の中で使い回すもの: 候補引きのクエリ数と、巻数ごとの id の範囲。 */
interface DrawCtx {
  queries: number;
  ranges: Map<string, { lo: string; hi: string }>;
}

/** 巻数 k のシリーズ id を 1 本、ランダムに（候補の多い巻数用）。無ければ null。 */
async function randomSeriesId(env: Env, ctx: DrawCtx, src: Source, k: number): Promise<string | null> {
  const where = `FROM ${src.table} WHERE ${src.size} = ?`;
  const rk = `${src.table}:${k}`;
  let range = ctx.ranges.get(rk);
  if (!range) {
    ctx.queries += 2;
    const mn = await env.DB.prepare(`SELECT MIN(${src.id}) AS v ${where}`).bind(k).first<{ v: string | null }>();
    if (!mn?.v) return null;
    const mx = await env.DB.prepare(`SELECT MAX(${src.id}) AS v ${where}`).bind(k).first<{ v: string | null }>();
    range = { lo: mn.v, hi: mx?.v ?? mn.v };
    ctx.ranges.set(rk, range);
  }
  const { lo, hi } = range;
  // 同じ接頭辞・同じ長さのときだけ数値で閾値を作る。それ以外（混在）は先頭から。
  let threshold = lo;
  const a = /^([A-Z])(\d+)$/.exec(lo);
  const b = /^([A-Z])(\d+)$/.exec(hi);
  if (a && b && a[1] === b[1] && a[2].length === b[2].length) {
    const from = parseInt(a[2], 10);
    const to = parseInt(b[2], 10);
    const pick = from + Math.floor(Math.random() * (to - from + 1));
    threshold = a[1] + String(pick).padStart(a[2].length, "0");
  }
  ctx.queries++;
  const row = await env.DB.prepare(`SELECT ${src.id} AS id ${where} AND ${src.id} >= ? ORDER BY ${src.id} LIMIT 1`)
    .bind(k, threshold)
    .first<{ id: string }>();
  return row?.id ?? lo;
}

/** 1 つの引き先から、巻数 k の候補 id を最大 tries 本。候補が LIST_ALL_MAX 本以下なら全部を
 *  シャッフルして返し（同じ候補に何度も当たらない）、多ければ乱数で引く。 */
async function idsFrom(env: Env, ctx: DrawCtx, src: Source, k: number, tries: number): Promise<string[]> {
  if (ctx.queries >= QUERY_BUDGET) return [];
  let ids: string[];
  ctx.queries++;
  try {
    const rows = await env.DB.prepare(`SELECT ${src.id} AS id FROM ${src.table} WHERE ${src.size} = ? LIMIT ?`)
      .bind(k, LIST_ALL_MAX + 1)
      .all<{ id: string }>();
    ids = (rows.results ?? []).map((r) => r.id);
  } catch {
    return []; // series_stats がまだ無い DB（マイグレーション前）
  }
  if (ids.length <= LIST_ALL_MAX) return shuffle(ids).slice(0, tries);
  const out = new Set<string>();
  for (let t = 0; t < tries * 2 && out.size < tries && ctx.queries < QUERY_BUDGET; t++) {
    const id = await randomSeriesId(env, ctx, src, k);
    if (id) out.add(id);
  }
  return [...out];
}

/** 巻数 k の候補 id を、確かめる順に最大 tries 本（series_stats の候補が先）。 */
async function candidateIds(env: Env, ctx: DrawCtx, k: number, tries: number): Promise<string[]> {
  const out: string[] = [];
  for (const src of SOURCES) {
    if (out.length >= tries) break;
    for (const id of await idsFrom(env, ctx, src, k, tries)) if (!out.includes(id)) out.push(id);
  }
  return out.slice(0, tries);
}

/** 2 本目以降の巻数の候補の並び（「ちょうど残り」は呼び出し側で先に試す）。
 *  [rem/2, rem-1] → [rem/3, rem/2) → それ未満、各帯の中はランダム。 */
export function sizeOrder(rem: number): number[] {
  const band = (from: number, to: number): number[] => {
    const out: number[] = [];
    for (let k = to; k >= from; k--) out.push(k);
    return out;
  };
  const half = Math.max(1, Math.ceil(rem / 2));
  const third = Math.max(1, Math.ceil(rem / 3));
  return [
    ...shuffle(band(half, rem - 1)),
    ...shuffle(band(third, Math.min(half - 1, rem - 1))),
    ...band(1, Math.min(third - 1, rem - 1)),
  ];
}

/** 何も持っていない人（have も exclude も無い）の抽選をエッジに持つ秒数。エディタはボタンが
 *  見えた時点で先に引いて書名をボタンに出す（public/app.js prefetchFill）ので、トップを開いた
 *  人の数だけ抽選が走る。本棚が空の人は条件が全員同じ（n=100）なので、その応答を短く共有して
 *  抽選を 1 分に 1 回程度に抑える。同じ 1 分に来た人は同じ顔ぶれを見るが、引き直せば変わる。 */
const SHARED_EDGE_TTL_SEC = 60;

export async function handleRandomFill(env: Env, url: URL): Promise<Response> {
  const n = parseInt(url.searchParams.get("n") ?? "", 10);
  if (!Number.isFinite(n) || n < 1 || n > MAX_N) return badRequest(`n は 1〜${MAX_N} で指定してください`);
  if (!url.searchParams.get("have") && !url.searchParams.get("exclude")) {
    // ちょうど埋まらなかった抽選（打ち切り）は共有しない。
    return withEdgeCache(
      edgeCacheKey(env, "/api/random-fill", { n }),
      SHARED_EDGE_TTL_SEC,
      () => drawFill(env, url, n),
      (res) => res.status === 200 && res.headers.get("x-fill") === "full"
    );
  }
  return drawFill(env, url, n);
}

async function drawFill(env: Env, url: URL, n: number): Promise<Response> {
  const have = new Set(
    (url.searchParams.get("have") ?? "")
      .split(",")
      .slice(0, MAX_HAVE)
      .map((s) => toIsbn13(s.trim()))
      .filter(Boolean)
  );
  const usedSeries = new Set(
    (url.searchParams.get("exclude") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^[A-Za-z0-9]{1,32}$/.test(s))
      .slice(0, 50)
  );

  const picked: FillSeries[] = [];
  let rem = n;
  let checks = 0;
  const ctx: DrawCtx = { queries: 0, ranges: new Map() };
  const exhausted = () => checks >= MAX_CHECKS || ctx.queries >= QUERY_BUDGET;

  // 巻数 k のシリーズを 1 本、確かめたうえで返す。見つからなければ null。
  const tryPick = async (k: number, tries: number): Promise<FillSeries | null> => {
    for (const id of await candidateIds(env, ctx, k, tries)) {
      if (checks >= MAX_CHECKS) return null;
      if (usedSeries.has(id)) continue;
      checks++;
      const res = await getSeriesVolumes(env, id);
      if (!res.ok) continue;
      const data = (await res.json()) as FillSeries;
      // 結合で別のシリーズに吸収されていた場合も、返ってきた側の id で重複を見る。
      if (usedSeries.has(data.series_id)) continue;
      usedSeries.add(id);
      usedSeries.add(data.series_id);
      if (!isCompleteRun(data.volumes ?? [], k)) continue;
      const isbnsOf = (v: FillVolume) => [v.isbn, ...(v.isbns ?? [])].map(toIsbn13).filter(Boolean);
      if (data.volumes.some((v) => isbnsOf(v).some((i) => have.has(i)))) continue;
      for (const v of data.volumes) for (const i of isbnsOf(v)) have.add(i);
      return data;
    }
    return null;
  };

  while (rem > 0 && picked.length < MAX_PIECES && !exhausted()) {
    let got = await tryPick(rem, TRIES_EXACT);
    if (!got) {
      for (const k of sizeOrder(rem)) {
        if (exhausted()) break;
        got = await tryPick(k, TRIES_PER_SIZE);
        if (got) break;
      }
    }
    if (!got) break;
    picked.push(got);
    rem -= got.volumes.length;
  }

  return json(
    {
      n,
      filled: n - rem,
      series: picked.map((s) => ({
        series_id: s.series_id,
        title: s.title,
        version: s.version ?? "",
        creator: s.creator ?? "",
        creators: s.creators ?? "",
        volumes: s.volumes,
      })),
    },
    200,
    { "cache-control": "no-store", "x-fill": rem === 0 ? "full" : "partial" }
  );
}
