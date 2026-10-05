import { Env } from "./types";
import { SupplementVolume, queryVolumesInSeries } from "./madbLive";
import { rakutenReady, rakutenSeriesPage, RakutenCandidate } from "./rakuten";
import { yahooReady, yahooVolumeIsbns } from "./yahoo";
import { excludeAdult } from "./site";
import { plainVolumeNumber, volSort } from "./util";

// ── シリーズ途中の抜け巻を埋める（取得ボタンからのオンデマンド専用）──────────
//
// 月次取り込みは ISBN をキーにしているので、MADB に巻としては載っていても
// schema:isbn の無い巻は丸ごと落ちる（scripts/ingest.mjs）。実測で全 MangaBook の
// 11%（46,017 件）が ISBN 無し。そのうち「ISBN 有りの巻と混在していて、サイト上は
// 穴あきに見える」シリーズが 1,293 本・5,076 巻ある（残りは 1 巻も ISBN が無く、
// そもそもシリーズごと出てこないので別問題）。
//
// 埋め方:
//   1. MADB に schema:isPartOf <C-id> で問い合わせ、ISBN の無い巻の巻番号を確定する。
//      シリーズノードへの厳密結合なので、ここで出た巻は MADB 自身の記録として確実に
//      このシリーズのもの。名前一致の補完（madbLive.probeNewerVolumes）が末尾追加しか
//      しないのに対し、こちらは巻の途中に挿してよい根拠がこれ。
//   2. 楽天ブックスをタイトル＋著者＋出版社で引き、巻番号が一致する候補を集める。
//   3. 候補を順位付けて 1 件選ぶ。ゲートではなく順位付けなのは、楽天の salesDate が
//      重版日のことがあり（『三国志』35 巻は初版 1983-11 に対し 1996-08）、年で
//      足切りすると正解を落とすため。
//   4. それでも埋まらない巻を Yahoo!ショッピングの商品名検索で引く（src/yahoo.ts）。
//      楽天ブックスは新刊書店なので絶版の古い巻を持たない（『釣りキチ三平』講談社コミックス版
//      は 45 巻以降だけ）。Yahoo は中古書店の出品が JAN ＝ ISBN-13 付きで並ぶので、そこだけが
//      ISBN の在りかになる。
//
// 精度の要（下の MASTER-KNOWN）: master が既に知っている ISBN は、どのシリーズの
// ものであっても候補から落とす。同一出版社の別版は ISBN 接頭辞が共通で接頭辞では
// 分離できないため、これが実質唯一の確実な判別になる。実測（12 シリーズ）でこの規則を
// 入れる前は『伊賀の影丸』で秋田文庫版など 8 件を誤って拾っていたが、入れた後は
// 誤り 0 件になった。
//
// 取れないもの（既知の限界）:
//   - 楽天にも Yahoo にも出品が無い巻（『沈黙の艦隊 大望総集編』『爆弾小娘鈴!』は候補 0 件）。
//     ISBN 制度より前の刊行で ISBN 自体が無い巻もここに入る。
//   - 巻数の多いシリーズ。1req/s の枠内に収めるためページ送りを MAX_PAGES で、Yahoo の
//     1 巻 1 リクエストを MAX_YAHOO_PROBES で打ち切るので、1 回の押下では埋まりきらない。
//     押すたびに少しずつ積み上がる（合流は src/series.ts 側）。
//   - R18 版（my100shunga）は外部ストアの API を使わない方針なので rakutenReady() /
//     yahooReady() が false になり、引き当て（2〜4）は行わない。MADB だけで分かる
//     「ISBN が無い巻」の一覧（1）はそのまま返すので、抜け巻の説明は R18 版でも出る。

// 1 回のボタン押下で投げる楽天のページ数の上限。ただし実際に効く制約はこちらではなく
// レートリミッタで、高優先レーンの待ち上限が 4 秒（src/ratelimiter.ts MAX_WAIT_MS）なので
// 1 回の押下で取れる枠は 3〜4 個しかない。つまり巻数の多いシリーズは 1 回では埋まりきらず、
// 押すたびに少しずつ積み上がる（合流は src/series.ts 側）。この定数はその外側の保険。
const MAX_PAGES = 10;

/** レーベル照合用の正規化。「Action comics」と「アクションコミックス」のような
 *  ラテン／カナの揺れまでは吸収できないので、一致は加点にとどめ足切りには使わない。 */
function normLabel(s: string): string {
  return (s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s・:：;,，.。/\-–—‐]/g, "");
}

function pubYear(s: string): number | null {
  const m = /(\d{4})/.exec(s ?? "");
  return m ? Number(m[1]) : null;
}

/** 2 つの ISBN が先頭から何桁一致するか。同じ出版社の同じ刊行ブロックほど長くなる。 */
function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/** `isbns` のうち master が既に知っているもの（series を問わない）＋ 他シリーズの補完が
 *  既に握っているものを返す。D1 のプレースホルダ上限に当たらないよう分割して引く。 */
async function alreadyTaken(env: Env, seriesId: string, isbns: string[]): Promise<Set<string>> {
  const taken = new Set<string>();
  // D1 の bind パラメータ上限（100）に当たらない刻み。補完側のクエリは seriesId を
  // 1 個余分に bind するので、その分も見込んで 80 にしてある（groups.ts / merge.ts は 90）。
  const CHUNK = 80;
  for (let i = 0; i < isbns.length; i += CHUNK) {
    const part = isbns.slice(i, i + CHUNK);
    const ph = part.map(() => "?").join(",");
    const [vol, sup] = await Promise.all([
      env.DB.prepare(`SELECT isbn FROM volumes WHERE isbn IN (${ph})`)
        .bind(...part)
        .all<{ isbn: string }>(),
      env.DB.prepare(
        `SELECT isbn FROM series_supplement_isbn WHERE isbn IN (${ph}) AND series_id <> ?`
      )
        .bind(...part, seriesId)
        .all<{ isbn: string }>(),
    ]);
    for (const r of vol.results ?? []) taken.add(r.isbn);
    for (const r of sup.results ?? []) taken.add(r.isbn);
  }
  return taken;
}

export interface GapFillInput {
  seriesId: string;
  name: string;
  creator: string;
  publisher: string;
  label: string;
  /** master が既に持っているこのシリーズの ISBN（順位付けの接頭辞比較に使う）。 */
  knownIsbns: string[];
  /** 既に巻一覧に出ている巻の vol_sort（master ＋ 前回までの補完）。ここに入っている巻は
   *  穴ではない。前回までの補完を含めるのが要点で、含めないと 1 回では埋まりきらない穴埋めが
   *  押すたびに同じ先頭の巻を引き直して先へ進まない（src/series.ts の filledSorts）。 */
  knownSorts: Set<number>;
}

export interface GapFillResult {
  /** 楽天・Yahoo から引き当てられた巻。 */
  filled: SupplementVolume[];
  /** MADB にはあるのに ISBN が見つからず、埋められなかった巻の巻数（昇順）。
   *  null = 判定できなかった（SPARQL が落ちた）。[] = そういう巻は無い。 */
  noIsbn: number[] | null;
}

/** 抜け巻を楽天・Yahoo から引き当てて返す。ネットワークや D1 の失敗は握りつぶして空の結果を
 *  返す（呼び手が既存の補完ごと落とさないように）。呼ぶのは取得ボタンの経路だけ。
 *
 *  埋まらなかった穴は noIsbn で返す。これは「この 2 つのストアで ISBN を見つけられなかった」
 *  であって「ISBN が存在しない」ではない。C326076「釣りキチ三平」(講談社コミックス・全65巻) の
 *  26 巻は MADB にも国会図書館サーチにも ISBN が無く、楽天の取り扱いも 45 巻以降だが、講談社の
 *  公式サイトには 9784061735057 が載っている（Yahoo の中古出品にも同じ JAN がある）。呼び手は
 *  候補検索が空振りすることの予告としてだけ使い、ISBN の直接指定の導線は残すこと
 *  （public/app.js の renderVolumes）。 */
export async function findGapFillVolumes(env: Env, input: GapFillInput): Promise<GapFillResult> {
  let members;
  try {
    members = await queryVolumesInSeries(input.seriesId, excludeAdult(env));
  } catch {
    return { filled: [], noIsbn: null }; // SPARQL が落ちた: 穴が確定できないので何も言わない
  }

  // ISBN を持たない巻だけが対象。master に既にある巻番号は穴ではない。
  const gaps = new Map<number, { label: string; pubdate: string }>();
  for (const m of members) {
    if (m.isbn) continue;
    const n = plainVolumeNumber(m.volume_number);
    if (n === null) continue; // アーク名など非標準ラベルは巻数で突合できない
    if (input.knownSorts.has(volSort(m.volume_number))) continue;
    if (!gaps.has(n)) gaps.set(n, { label: m.volume_number, pubdate: m.pubdate });
  }
  if (gaps.size === 0) return { filled: [], noIsbn: [] };

  // 楽天を使わない構成（R18版）では引き当てはできないが、「MADB にはあるが ISBN が無い」ことは
  // MADB だけで分かるので、そこまでは返す。楽天は 1 回も叩かない。
  const allGaps = [...gaps.keys()].sort((a, b) => a - b);
  if (!rakutenReady(env)) return { filled: [], noIsbn: allGaps };

  // 楽天を引く。著者で絞って空振りしたら著者を外して引き直す（「さいとう・たかを」の
  // ような表記揺れで 0 件になることがある）。
  const base = { title: input.name, publisher: input.publisher || undefined };
  let items = await collect(env, { ...base, author: input.creator || undefined }, gaps);
  if (items.length === 0 && input.creator) items = await collect(env, base, gaps);

  // 巻ごとに 1 件まで選ぶ。鍵は MADB の巻数なので、ラベル表記が巻数と一致しなくても
  // 「埋まったか」の判定を取りこぼさない。
  const picked = new Map<number, SupplementVolume>();
  if (items.length) {
    const taken = await alreadyTaken(env, input.seriesId, [...new Set(items.map((i) => i.isbn))]);

    // 巻ごとに候補を集め、接頭辞 → レーベル一致 → 発行年の近さ、の順で 1 件選ぶ。
    const byVol = new Map<number, RakutenCandidate[]>();
    for (const i of items) {
      if (i.volume === null || !gaps.has(i.volume)) continue;
      if (i.isbn.length !== 13 || taken.has(i.isbn)) continue;
      const list = byVol.get(i.volume);
      if (list) list.push(i);
      else byVol.set(i.volume, [i]);
    }

    const label = normLabel(input.label);
    for (const [vol, list] of byVol) {
      const gap = gaps.get(vol)!;
      const my = pubYear(gap.pubdate);
      const best = list
        .map((i) => {
          const prefix = input.knownIsbns.reduce((m, k) => Math.max(m, commonPrefix(i.isbn, k)), 0);
          const labelHit = label && normLabel(i.seriesName).startsWith(label) ? 1 : 0;
          const ry = pubYear(i.pubdate);
          const yearGap = my !== null && ry !== null ? -Math.abs(ry - my) : -99;
          return { i, key: [prefix, labelHit, yearGap] as const };
        })
        .sort((a, b) => b.key[0] - a.key[0] || b.key[1] - a.key[1] || b.key[2] - a.key[2])[0].i;
      picked.set(vol, {
        isbn: best.isbn,
        isbns: [best.isbn],
        volume_number: gap.label, // MADB のラベル表記のまま（シリーズの表記統一が効くように）
        vol_sort: volSort(gap.label),
        title: input.name,
        author: input.creator,
        publisher: best.publisher || input.publisher,
        pubdate: best.pubdate,
      });
    }
  }

  // 楽天で埋まらなかった巻を Yahoo!ショッピングで引く（src/yahoo.ts）。
  await fillFromYahoo(env, input, gaps, picked);

  const out = [...picked.values()].sort((a, b) => a.vol_sort - b.vol_sort);
  return { filled: out, noIsbn: allGaps.filter((n) => !picked.has(n)) };
}

// 1 回の押下で Yahoo に投げる巻数の上限。Yahoo は 1 巻 1 リクエストで、レートリミッタが
// 約 0.9 req/s に均すので、この数がそのまま押下の待ち時間（秒）になる。巻一覧の「取得」は
// 利用者が待っているボタンなので、1 回で全部やろうとせず、下の巡回カーソルで押すたびに
// 続きへ進める。
const MAX_YAHOO_PROBES = 8;

// 巡回カーソルの meta キー。値は「前回どの巻まで投げたか」の巻数。
// 投げて空振りだった巻（出品が無い / 出品はあるが master が既に持つ ISBN）は穴に残り続けるので、
// 毎回 1 巻目から投げると先頭の空振りだけで枠を使い切り、押しても先へ進まなくなる（実測:
// C326076 で 23 巻から進まなくなった）。巻数そのものではなく「どこまで見たか」だけを覚えて、
// 一周したら先頭へ戻る。一周の間に出品が増えることもあるので、巡回は止めない。
const PROBE_CURSOR_PREFIX = "yahoo_gap_cursor:";

async function readProbeCursor(env: Env, seriesId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = ?`)
    .bind(PROBE_CURSOR_PREFIX + seriesId)
    .first<{ value: string }>();
  const n = Number(row?.value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function writeProbeCursor(env: Env, seriesId: string, volume: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
    .bind(PROBE_CURSOR_PREFIX + seriesId, String(volume))
    .run();
}

/** 楽天に無かった巻を Yahoo!ショッピングの商品名検索で引き当て、`picked` に足す。
 *
 *  楽天ブックスは新刊書店なので絶版の古い巻を持たない（『釣りキチ三平』講談社コミックス版は
 *  45 巻以降だけ）。Yahoo は中古書店の出品が JAN ＝ ISBN-13 付きで並ぶので、そこだけが
 *  ISBN の在りかになる。1 巻 1 リクエストなので、枠が取れなくなった時点（null）で打ち切る
 *  ＝ 巻数の多いシリーズは押すたびに少しずつ埋まる（楽天側と同じ振る舞い）。 */
async function fillFromYahoo(
  env: Env,
  input: GapFillInput,
  gaps: Map<number, { label: string; pubdate: string }>,
  picked: Map<number, SupplementVolume>
): Promise<void> {
  if (!yahooReady(env)) return;
  const missing = [...gaps.keys()].filter((n) => !picked.has(n)).sort((a, b) => a - b);
  if (missing.length === 0) return;

  // 前回の続きから。末尾まで行ったら先頭へ戻る（巡回）ので、どの押下でも必ず前進する。
  const cursor = await readProbeCursor(env, input.seriesId);
  const order = [...missing.filter((n) => n > cursor), ...missing.filter((n) => n <= cursor)];

  const found = new Map<number, string[]>();
  let last = 0;
  for (const n of order.slice(0, MAX_YAHOO_PROBES)) {
    const isbns = await yahooVolumeIsbns(env, input.name, n);
    if (isbns === null) break; // 枠が取れない: 残りは次の押下に回す
    last = n;
    if (isbns.length) found.set(n, isbns);
  }
  // 空振りでもカーソルは進める（空振りした巻を次の押下で引き直さないのが目的）。
  if (last) await writeProbeCursor(env, input.seriesId, last);
  if (found.size === 0) return;

  const taken = await alreadyTaken(env, input.seriesId, [...new Set([...found.values()].flat())]);
  for (const [n, isbns] of found) {
    const left = isbns.filter((i) => !taken.has(i));
    if (left.length === 0) continue;
    // 同じ巻番号で別版が並ぶことがある（『釣りキチ三平』26 巻は KCスペシャル版と講談社
    // コミックス版の 2 件）。master が持つ ISBN と接頭辞が長く一致する方を採る。
    const best = left
      .map((isbn) => ({
        isbn,
        prefix: input.knownIsbns.reduce((m, k) => Math.max(m, commonPrefix(isbn, k)), 0),
      }))
      .sort((a, b) => b.prefix - a.prefix)[0].isbn;
    const gap = gaps.get(n)!;
    picked.set(n, {
      isbn: best,
      isbns: [best],
      volume_number: gap.label,
      vol_sort: volSort(gap.label),
      title: input.name,
      author: input.creator,
      publisher: input.publisher,
      pubdate: gap.pubdate, // Yahoo は刊行日を持たないので MADB の日付をそのまま使う
    });
  }
}

/** 穴が全部埋まるか、ページが尽きるか、MAX_PAGES に達するまでページ送りする。
 *  rakutenSeriesPage が null（枠が取れない / エラー）を返したらそこで打ち切る。 */
async function collect(
  env: Env,
  q: { title: string; author?: string; publisher?: string },
  gaps: Map<number, unknown>
): Promise<RakutenCandidate[]> {
  const items: RakutenCandidate[] = [];
  const seenVols = new Set<number>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await rakutenSeriesPage(env, q, page);
    if (!res) break;
    items.push(...res.items);
    for (const i of res.items) if (i.volume !== null && gaps.has(i.volume)) seenVols.add(i.volume);
    if (seenVols.size >= gaps.size) break; // 全部見つかった
    if (page >= res.pageCount) break;
  }
  return items;
}
