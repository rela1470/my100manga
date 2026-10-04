import { Env } from "./types";
import { plainVolumeNumber } from "./util";

// ── 抜け巻が「別のシリーズ」「どのシリーズにも属さない迷子」に在る場合の名指し ────
//
// 取り込みの穴（src/gapFill.ts）とは別に、巻一覧が穴あきに見えるもう一つの原因がある。
// その巻は DB に入っているのに、別の C-id に紛れているか、schema:isPartOf を持たないまま
// どのシリーズにも属していない（マスタの巻の ~20% が後者, src/groups.ts）。
//
// 例: 大判『三国志』2017〜2018 年版は ISBN 9784267906411〜9784267906619 と連番なのに、
//     1〜14 と 19〜21 が C367640、15〜17 が 2007 年版の C276797 に紛れ、18 巻
//     （9784267906589）はどのシリーズにも属していない。
//
// この種は穴埋めでは**埋めない**。埋めると同じ本が 2 つのシリーズに重複して並ぶ。正しい
// 直し方は結合（src/merge.ts）か分離で、どちらも管理者が確定する。ここはその導線に乗せる
// ために「どの巻がどこに在るか」を名指しするだけで、データは一切書き換えない。
//
// 判定（ローカル全量での実測にもとづく）:
//   1. 表示上の抜け番であること（既存巻の最小と最大の間で欠けている番号）
//   2. 同じ name_norm・同じ著者の別シリーズか、同じ書名・著者の迷子巻に、その番号が在る
//   3. その ISBN が自シリーズの既知 ISBN と先頭 PREFIX_MIN 桁以上を共有する
//   4. 前後の巻の発行日の間に収まる（SLACK_MONTHS のはみ出しは許す）
//
// 3 だけでは足りない。『うる星やつら』の 1980 年原版（C258780）の抜け番に 2006 年新装版
// （C258774）の巻を出す誤検出が起きる。4 を足すと消える。逆に 4 だけでも足りない（同時期の
// 別レーベルが通る）ので、両方要る。
//
// 実測: ローカル全量で 293 巻 / 201 シリーズが該当。内訳の大半は迷子巻で、たとえば
// 『光の伝説』（C258353）は 2,6〜14 巻が、『ブレイクショット』（C261321）は 5,6,8,9 巻が、
// 同じ出版社・同じレーベル・連続 ISBN・発行日も内挿どおりで迷子になっている。

// ISBN13 のうち何桁一致すれば「同じ刊行ブロック」とみなすか。"978" + 出版社記号まではその
// 出版社の全レーベルで共通なので、それより深く一致することを求める。12 桁はチェック
// ディジットを除いて全桁一致＝別の本ではありえないので、実質の上限は 11。
//
// ローカル全量での実測（いずれも下の発行日チェックを通したあとの数）:
//   >=10 … 279 巻 / 198 シリーズ   >=9 … 514 巻 / 381 シリーズ   >=8 … 625 巻 / 473 シリーズ
// 10 だと取りこぼす。『光の伝説』（C258353）は 2,6〜14 巻が迷子になっているのに、9〜13 巻の
// ISBN が自シリーズと 9 桁しか共有しないため 5 巻しか拾えない。9 にすると 10 巻全部拾える。
// 9 で新たに入る 235 巻を抽出して標本を見たが、出版社・レーベルとも自シリーズと一致する
// 迷子巻ばかりで誤りは見つからなかった。誤検出の要（『うる星やつら』1980 年原版の穴に
// 2006 年新装版）は閾値ではなく発行日チェックが落としているので、9 でも通らない。
// 8 はさらに 111 巻増えるが、同一出版社の別レーベルをまたぎ始める桁なので採らない（未検証）。
const PREFIX_MIN = 9;
// 前後の巻の発行日からこれだけのはみ出しは許す（重版・刊行間隔のばらつき）。
const SLACK_MONTHS = 18;
// 1 シリーズあたりに返す上限。導線として出すだけなので、多すぎても使えない。
const MAX_SUGGESTIONS = 30;
// 候補を引くときの 1 クエリあたりの上限。長期連載でも応答を膨らませない。
const CAND_LIMIT = 500;

export interface SiblingVolume {
  isbn: string;
  volume_number: string;
  vol_sort: number;
  title: string;
  publisher: string;
  label: string;
  pubdate: string;
  /** 巻が今いる場所。別シリーズなら その C-id、どのシリーズにも属していなければ null。 */
  series_id: string | null;
}

/** 巻一覧に出ている巻のうち、判定に要る分だけ。 */
export interface PresentVolume {
  vol_sort: number;
  isbns: string[];
  pubdate: string;
}

interface CandRow {
  isbn: string;
  volume_number: string | null;
  vol_sort: number | null;
  title: string;
  publisher: string | null;
  label: string | null;
  pubdate: string | null;
  series_id: string | null;
}

/** "1986-02" / "1986-02-20" / "1986" → 月数。比較できなければ null。 */
function months(d: string | null | undefined): number | null {
  const m = /^(\d{4})(?:-(\d{2}))?/.exec((d ?? "").trim());
  if (!m) return null;
  return Number(m[1]) * 12 + (m[2] ? Number(m[2]) - 1 : 0);
}

function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/** 抜け巻が別シリーズ・迷子に在るものを名指しする。D1 だけで完結し外部 API を呼ばない。
 *  読み出し専用で、series / volumes / 補完のどれも書き換えない。 */
export async function findSiblingVolumes(
  env: Env,
  opts: {
    seriesId: string;
    /** 結合済みの member も自分扱いにする（それらの巻は「別シリーズ」ではない）。 */
    members: string[];
    name: string;
    nameNorm: string;
    creator: string;
    present: PresentVolume[];
  }
): Promise<SiblingVolume[]> {
  if (!opts.creator || !opts.nameNorm) return []; // 著者が無いと同名他作品と区別できない

  // 表示上の抜け番。番号付きの巻が 2 つ以上無いと「間」が決まらない。
  const sorts = opts.present.map((p) => p.vol_sort).filter((n) => n > 0);
  if (sorts.length < 2) return [];
  const have = new Set(sorts);
  const lo = Math.min(...sorts);
  const hi = Math.max(...sorts);
  const gaps = new Set<number>();
  for (let n = lo + 1; n < hi; n++) if (!have.has(n)) gaps.add(n);
  if (gaps.size === 0) return [];

  // 抜け番の前後の巻の発行日（内挿チェック用）と、自シリーズの既知 ISBN。
  const dateBySort = new Map<number, number>();
  const myIsbns: string[] = [];
  for (const p of opts.present) {
    const m = months(p.pubdate);
    if (m !== null && p.vol_sort > 0 && !dateBySort.has(p.vol_sort)) dateBySort.set(p.vol_sort, m);
    for (const i of p.isbns) myIsbns.push(i);
  }
  if (myIsbns.length === 0) return [];

  const mine = new Set(opts.members.length ? opts.members : [opts.seriesId]);
  const rows: CandRow[] = [];

  // (a) 同じ正規化書名・同じ著者の別シリーズ（idx_series_name_norm で引く）。
  const sib = await env.DB.prepare(
    `SELECT id FROM series WHERE name_norm = ? AND COALESCE(creator, '') = ? LIMIT 50`
  )
    .bind(opts.nameNorm, opts.creator)
    .all<{ id: string }>();
  const others = (sib.results ?? []).map((r) => r.id).filter((id) => !mine.has(id));
  if (others.length) {
    const ph = others.map(() => "?").join(",");
    const res = await env.DB.prepare(
      `SELECT isbn, volume_number, vol_sort, title, publisher, label, pubdate, series_id
         FROM volumes
        WHERE series_id IN (${ph}) AND vol_sort > ? AND vol_sort < ?
        LIMIT ${CAND_LIMIT}`
    )
      .bind(...others, lo, hi)
      .all<CandRow>();
    rows.push(...(res.results ?? []));
  }

  // (b) どのシリーズにも属していない巻（idx_volumes_unlinked_title の部分索引で引く）。
  const un = await env.DB.prepare(
    `SELECT isbn, volume_number, vol_sort, title, publisher, label, pubdate, series_id
       FROM volumes
      WHERE series_id IS NULL AND title = ? AND COALESCE(creator, '') = ?
        AND vol_sort > ? AND vol_sort < ?
      LIMIT ${CAND_LIMIT}`
  )
    .bind(opts.name, opts.creator, lo, hi)
    .all<CandRow>();
  rows.push(...(un.results ?? []));

  const out: SiblingVolume[] = [];
  const seenSort = new Set<number>();
  for (const r of rows) {
    const n = r.vol_sort ?? 0;
    if (!gaps.has(n) || seenSort.has(n)) continue;
    // 巻ラベルが標準形（"12" / "第12巻" 等）でないものは巻数として突き合わせられない。
    if (plainVolumeNumber(r.volume_number ?? "") === null) continue;
    if (!r.isbn) continue;
    if (myIsbns.reduce((m, k) => Math.max(m, commonPrefix(r.isbn, k)), 0) < PREFIX_MIN) continue;

    // 前後の巻の発行日の間に収まるか。どちらかが欠けていれば判定しない（通す）。
    const cd = months(r.pubdate);
    const below = [...dateBySort.keys()].filter((k) => k < n);
    const above = [...dateBySort.keys()].filter((k) => k > n);
    if (cd !== null && below.length && above.length) {
      const a = dateBySort.get(Math.max(...below))!;
      const b = dateBySort.get(Math.min(...above))!;
      const min = Math.min(a, b) - SLACK_MONTHS;
      const max = Math.max(a, b) + SLACK_MONTHS;
      if (cd < min || cd > max) continue;
    }

    seenSort.add(n);
    out.push({
      isbn: r.isbn,
      volume_number: r.volume_number ?? "",
      vol_sort: n,
      title: r.title,
      publisher: r.publisher ?? "",
      label: r.label ?? "",
      pubdate: r.pubdate ?? "",
      series_id: r.series_id,
    });
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  out.sort((a, b) => a.vol_sort - b.vol_sort);
  return out;
}
