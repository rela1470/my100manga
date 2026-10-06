import { Env } from "./types";
import { badRequest, json, normTitle, searchKey, hiraToKata, vuFold, escapeLikeClamped, LIKE_MAX_BYTES, toIsbn13, workKeySql, titleKeySql, seriesNameSql } from "./util";
import { readCachedCovers } from "./covers";
import { liveSearchByKeyword, SupplementVolume } from "./madbLive";
import { rakutenComicByIsbn } from "./rakuten";
import { adultOnlySearch, excludeAdult } from "./site";
import { mergeTargetsFor } from "./merge";
import {
  applyGroupNames,
  attributeTitles,
  buildGroup,
  groupKey,
  isGroupId,
  resolveGroup,
  GroupRow,
  GroupVolume,
  UnlinkedGroup,
} from "./groups";
import { edgeCacheKey, withEdgeCache } from "./edgeCache";
import { getViewEpoch } from "./viewSnapshot";
import { ADULT_BLOCK_MESSAGE, adultBlockMessage, findAdultIsbns, hasAdultTitleMatch } from "./adult";
import { effectiveTagSql, tagsForLabels } from "./labels";

interface SeriesResult {
  series_id: string;
  title: string;
  creator: string;
  creators: string; // all authors with roles for display; falls back to creator
  publisher: string;
  label: string;
  // レーベルに付いた運営のタグ（"廉価版" / "文庫版" / 付いていなければ ""）。マスタには
  // この区別が無く、レーベル名を鍵に label_tag が持つ（src/labels.ts）。カードの書名に添える。
  // SERIES_COLS の相関サブクエリで引くので、検索に D1 の往復は増えない。
  label_tag: string;
  // 版表示（MADB schema:version。「新装版」「大判」…）。同名の版違いが別シリーズとして
  // 並ぶので、あればカードの書名に添える。無い版も多いので label / first_year で補う。
  version: string;
  // 初版の発行年（"1974"。マスタに日付が 1 つも無ければ ""）。同名・同著者のカードが
  // 並んだときだけクライアントが出す（public/app.js ambiguousEditionKeys）。
  first_year: string;
  volume_count: number;
  // The count may be low: the newest tankobon are only fetched from live MADB when
  // the series is opened and 取得 is pressed. True until that probe has run, so the
  // UI can render "全N巻＋" instead of a possibly-stale exact count.
  unconfirmed: boolean;
  first_isbn: string;
  cover_url: string;
}

interface SeriesRow {
  id: string;
  name: string;
  creator: string | null;
  creators: string | null;
  publisher: string | null;
  label: string | null;
  label_tag: string | null;
  version: string | null;
  first_pubdate: string | null;
  first_isbn: string | null;
  vol_count: number;
  probed: number;
  numbered: number;
}

// Column list for a series card. Shared by the keyword query and the Phase-2
// "promotion" query (which fetches a series by id when an unlinked-volume match points
// back to it), so both produce identical SeriesRow shapes. `s` must alias the series
// table and `o` the series_name_override LEFT JOIN. The displayed creator/first_isbn/
// vol_count come from the LINKED volumes only; unlinked volumes fold in when the series
// is opened (see getSeriesVolumes), so an author who appears solely on the unlinked half
// still needs Phase-2 promotion to be reachable from search. name is COALESCE(override,
// master) so an admin-corrected title (series_name_override) shows here. The keyword query
// below still MATCHES on the master columns only (name_norm / name_search / name_kana_norm);
// the corrected name is matched separately and cheaply by matchNameOverrides.
// Volume-derived columns span the merge group (MEMBERS: the series plus any series an admin
// merged into it, see src/merge.ts) so a merged card shows the combined count/cover.
const MEMBERS = `(SELECT s.id UNION ALL SELECT m.absorbed_id FROM series_merge m WHERE m.target_id = s.id)`;
// 巻数（カードの「全N巻」で、キーワード検索の並び順のキーでもある）。キーワード検索の 1 段目は
// これだけを計算して並べるので、SERIES_COLS と同じ式を共有する（s.id だけを参照する）。
// 数え方は巻一覧のまとめ方（src/series.ts addToGroup）に合わせる: 巻番号だけで数えると
// 「上」「下」しか巻番号を持たない別作品（金田一少年の事件簿の事件ごとの上下巻）が 1 冊に
// 潰れて「全2巻」になり、逆に副題だけで数えると、同じ巻の刷りによって副題が付いたり付かなかったり
// するシリーズ（七つの大罪の「the seven deadly sins」）が二重に数えられる。そこで
// （巻番号, 副題抜きの書名）ごとに、副題の種類数（0 なら 1）を足す。副題を書名に畳み込んだ行
// （「世界一初恋 : 小野寺律の場合」）と分けて持つ行が同じ巻に同居するときだけ、巻一覧より 1 多く
// 数える（書名が違うので別のまとまりになる）。実測で 11 万シリーズ中 5 件。
const VOL_COUNT = `((SELECT COALESCE(SUM(MAX(nsub, 1)), 0) FROM (
             SELECT COUNT(DISTINCT CASE WHEN COALESCE(v.subtitle, '') <> ''
                                        THEN ${workKeySql("v.")} END) AS nsub
               FROM volumes v WHERE v.series_id IN ${MEMBERS}
              GROUP BY CASE WHEN COALESCE(v.volume_number, '') = '' THEN 'i' || v.isbn
                            ELSE 'n' || v.volume_number END,
                       CASE WHEN COALESCE(v.volume_number, '') = '' THEN ''
                            ELSE ${titleKeySql("v.")} END))
         + COALESCE((SELECT json_array_length(sp.volumes_json)
                      FROM series_supplement sp WHERE sp.series_id = s.id), 0)
         + COALESCE((SELECT COUNT(*) FROM series_correction sc
                      WHERE sc.series_id IN ${MEMBERS}), 0))`;
const SERIES_COLS = `s.id, ${seriesNameSql("s", "o")} AS name, s.publisher, s.label, s.version,
        ${effectiveTagSql("s")} AS label_tag,
        (SELECT MIN(NULLIF(v.pubdate, '')) FROM volumes v WHERE v.series_id IN ${MEMBERS}) AS first_pubdate,
        COALESCE((SELECT v.creator FROM volumes v WHERE v.series_id IN ${MEMBERS} AND v.creator != ''
           ORDER BY v.vol_sort, v.pubdate LIMIT 1), s.creator) AS creator,
        COALESCE((SELECT v.creators FROM volumes v WHERE v.series_id IN ${MEMBERS} AND v.creators != ''
           ORDER BY v.vol_sort, v.pubdate LIMIT 1), s.creators) AS creators,
        (SELECT v.isbn FROM volumes v WHERE v.series_id IN ${MEMBERS}
           ORDER BY v.vol_sort, v.pubdate LIMIT 1) AS first_isbn,
        ${VOL_COUNT} AS vol_count,
        EXISTS(SELECT 1 FROM series_supplement sp WHERE sp.series_id = s.id) AS probed,
        EXISTS(SELECT 1 FROM volumes v WHERE v.series_id IN ${MEMBERS}
                 AND ((v.volume_number GLOB '[0-9]*' AND NOT v.volume_number GLOB '*[^0-9]*')
                      OR v.volume_number GLOB '巻[0-9]*')) AS numbered`;

// Search column for author matching on series/volumes (prefix = table alias + "."):
// creators_norm (all names, pre-normalized at ingest) or, where absent, the single creator
// normalized inline the same way.
function creatorsMatchCol(prefix: string): string {
  return `COALESCE(${prefix}creators_norm, REPLACE(REPLACE(LOWER(COALESCE(${prefix}creator, '')), ' ', ''), '　', ''))`;
}

function toSeriesResult(r: SeriesRow, covers: Map<string, string>): SeriesResult {
  const isbn = r.first_isbn ?? "";
  return {
    series_id: r.id,
    title: r.name,
    creator: r.creator ?? "",
    creators: r.creators || r.creator || "",
    publisher: r.publisher ?? "",
    label: r.label ?? "",
    label_tag: r.label_tag ?? "",
    version: r.version ?? "",
    first_year: (r.first_pubdate ?? "").slice(0, 4),
    volume_count: r.vol_count,
    // Only flag "＋未確認" for numbered series with a known author — the ones a 取得 probe
    // can actually extend. One-shots and unattributed rows would show a marker that never
    // resolves, so leave them exact.
    unconfirmed: !r.probed && !!r.numbered && !!(r.creator ?? ""),
    first_isbn: isbn,
    cover_url: covers.get(isbn) ?? "",
  };
}

const PAGE = 30;
const SEARCH_MAX_OFFSET = 300;
// 1 ページ目に足せる「管理者が直した名前で当たったカード」の数（matchNameOverrides）。上書きは
// 管理者が 1 件ずつ入れたものなので当たっても数件だが、「スランプ」のような短い語で中間一致が
// 増えたときに 1 ページ目が上書きだらけにならないよう上限を置く。
const OVERRIDE_MAX = 5;
// キーワード検索の結果をエッジ（Cache API）で持つ秒数。検索は series / volumes を '%q%' の LIKE で
// 全行なめる一番重い読み取りで、マスタは月次取り込みと管理者の結合・修正でしか変わらないので
// 1 時間遅れてよい。表紙はキャッシュ済みのものだけ返し、空欄はクライアントが POST /api/covers で
// 埋めるので、古い結果でも表示は崩れない。
const SEARCH_CACHE_SEC = 3600;

// Search the MADB master (series table). Results are series-level; the client
// then pulls volumes via /api/series/:id/volumes to add a single volume or the
// whole series. Ordering: exact title/reading match, then title prefix, title substring,
// reading prefix/suffix, reading substring, author only; within
// each tier the longest series (most volumes) wins so core works beat spin-offs.
// TODO(diff-supplement): fall back to NDL/楽天 for releases newer than the MADB
// dump when the local master returns nothing.
export async function handleSearch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q.length < 2) return badRequest("検索語を2文字以上で入力してください");
  // Paging (「さらに表示」): offset into the keyword query, in steps of PAGE. Capped so a
  // runaway client can't page through the whole table.
  const offset = Math.min(Math.max(Math.floor(Number(url.searchParams.get("offset"))) || 0, 0), SEARCH_MAX_OFFSET);

  // 作者名だけで探す（検索結果の「作品名 / 作者名」の切り替え。public/app.js searchBy）。既定は
  // 今までどおり書名中心の検索で、作者名は一番下の段（mt=1）でしか当たらない。by=creator のときは
  // 書名を一切見ず、作者名だけで引く。
  const byCreator = url.searchParams.get("by") === "creator";

  // ISBN 検索は索引 1 本で引けて軽く、マスタに無いときの楽天の結果（レート制限で取れなかった
  // 「無し」を含む）を固定したくないのでキャッシュしない。「9784…」という名前の作者は居ないので
  // 作者名の検索では見ない。
  const isbn = byCreator ? "" : isbnQuery(q);
  // ISBN は 1 冊を名指しで引く操作なので、成年向けの既定の絞り込みは掛けない（R18版では
  // どちらの巻も収録していて、ISBN を知っているなら出していい）。
  if (isbn) return searchByIsbn(env, isbn);

  // R18版は既定で成年向けだけを出す（src/site.ts adultOnlySearch）。検索フォームの
  // 「全年齢の作品も含める」が all=1 を付けてきたら外す。本家は常に false。
  const adultOnly = adultOnlySearch(env) && url.searchParams.get("all") !== "1";

  // キーは正規化した検索語（normTitle: 空白除去・小文字化）と offset、それに表示データの世代
  // （src/viewSnapshot.ts）。検索の照合は全部 normTitle / searchKey 後の文字列で行うので、空白や
  // 大文字小文字だけ違う検索語は同じ結果になる。世代を混ぜてあるので、管理者が結合・名前修正を
  // したら SEARCH_CACHE_SEC を待たずに鍵が変わる（長く持たせても反映は遅れない）。
  return withEdgeCache(
    edgeCacheKey(env, "/api/search", {
      q: normTitle(q),
      offset,
      // 絞り込みの有無で結果が変わるので鍵に混ぜる（本家は常に 0 なので今までと同じ鍵）。
      a: adultOnly ? 1 : 0,
      // 検索の対象（0 = 書名中心 / 1 = 作者名だけ）。同じ語でも結果が別物なので鍵を分ける。
      b: byCreator ? 1 : 0,
      e: await getViewEpoch(env),
    }),
    SEARCH_CACHE_SEC,
    () => (byCreator ? searchByCreator(env, q, offset, adultOnly) : searchByKeyword(env, q, offset, adultOnly))
  );
}

async function searchByKeyword(env: Env, q: string, offset: number, adultOnly: boolean): Promise<Response> {
  const nq = normTitle(q);
  // Clamp below the D1 LIKE byte cap; the "%|…|%" kana wrappers add up to 4 bytes.
  // The exact tier below still binds full nq (= ? has no pattern-length limit).
  const esc = escapeLikeClamped(nq, LIKE_MAX_BYTES - 4);

  const like = "%" + esc + "%";
  const prefix = esc + "%";
  // 記号・全角半角を無視した照合（searchKey）。name_search は ingest が埋める検索専用列で、
  // まだ無い行（列追加直後・独自シリーズ）は name_norm で照合する。記号だけの検索語で
  // キーが 2 文字未満になるときは、ふつうの正規化（nq）のまま探す。
  const sqRaw = searchKey(q);
  const sq = sqRaw.length >= 2 ? sqRaw : nq;
  const escS = escapeLikeClamped(sq, LIKE_MAX_BYTES - 2);
  const likeS = "%" + escS + "%";
  const prefixS = escS + "%";
  const nameSearch = "COALESCE(s.name_search, s.name_norm)";
  // name_kana_norm packs several readings joined by "|" (e.g. "onepiece|ワンピース").
  // Wrapping with "|" lets us detect a whole-reading exact/prefix match inside the blob,
  // so the canonical series exact-matches カナ queries and — tied at the same tier — the
  // one with the most volumes wins (vol_count DESC) instead of a small re-release.
  // The readings are katakana, so the query's hiragana is folded to katakana for these
  // three patterns: 「ひだまりすけっち」 hits the reading ヒダマリスケッチ of 「ひだまりスケッチ」.
  // ヴ is folded to バ行 too; ingest stores each reading's folded form alongside it, so
  // 「でじゃぶ」 and 「デジャヴ」 both hit デジャヴ and デジャブ.
  const escK = escapeLikeClamped(vuFold(hiraToKata(nq)), LIKE_MAX_BYTES - 4);
  const kanaExact = "%|" + escK + "|%";
  const kanaPrefix = "%|" + escK + "%";
  const kanaSuffix = "%" + escK + "|%";
  const kanaLike = "%" + escK + "%";
  // Match the author too, against creators_norm: every credited name (not just the
  // displayed series.creator) normalized like normTitle() and "|"-joined at ingest, so a
  // co-author such as 原作 丸戸史明 behind 作画 よむ still hits. Rows without it (custom
  // series) fall back to normalizing creator inline. Creator-only matches sit in the
  // lowest tier (mt=1) so a title hit always outranks an author hit.
  // A query found verbatim in the title (mt=4) outranks one that only matches a reading
  // (mt=3/2): otherwise 「カイジ」 fills all 30 slots with readings starting カイジ…
  // (海獣の子供 カイジュウ…, 怪人麗嬢 カイジン…) and pushes 賭博黙示録カイジ out. A reading
  // that ENDS with the query ranks with the prefix ones — a title's name often comes last
  // (トバクモクシロクカイジ), so 「かいじ」 still lists カイジ by volume count among them.
  // An all-hiragana query is meant as a reading, so there the reading prefix/suffix tier
  // joins the title-prefix one (mt=5) and volume count decides: 「かいじ」 then lists
  // 賭博黙示録カイジ ahead of one-volume titles that literally start かいじゅう….
  // Patterns that use "|": the readings blob gets wrapped as "|r1|r2|" so each one's
  // start/end can be matched.
  const creatorNorm = creatorsMatchCol("s.");
  const hiraganaQuery = /^[\p{Script=Hiragana}ー]+$/u.test(nq);
  const titleSub = `WHEN s.name_norm LIKE ? ESCAPE '\\' OR ${nameSearch} LIKE ? ESCAPE '\\' THEN 4`;
  const kanaEdge = `WHEN ('|' || s.name_kana_norm || '|') LIKE ? ESCAPE '\\' OR ('|' || s.name_kana_norm || '|') LIKE ? ESCAPE '\\' THEN ${hiraganaQuery ? 5 : 3}`;
  // 並び順は mt DESC, vol_count DESC, num_items DESC, id。SERIES_COLS は相関サブクエリが多く、
  // 1 文で ORDER BY すると当たった全行（「の」で 3 万件超）について計算してから LIMIT するので、
  // 段階に分けて重い列はページの行だけで計算する（並び・結果は 1 文のときと同じ）:
  //   hit  … 当たった行の id / num_items / mt だけ（LIKE の全行走査はここ 1 回）
  //   tier … mt ごとの件数と、その段より前の件数（before）
  //   win  … このページ（offset から PAGE+1 行）にかかる段だけ。ほかの段の行は前後どちらかに
  //          まるごと並ぶので巻数を見なくてよい
  //   page … win の段の行だけ巻数（VOL_COUNT）を出して並べ、段の先頭からの位置で切り出す
  // 最後に page の ≤PAGE+1 行だけ SERIES_COLS を計算し、同じキーで並べ直す。
  const res = await env.DB.prepare(
    `WITH hit AS MATERIALIZED (
       SELECT s.id, s.num_items,
              CASE WHEN s.name_norm = ? OR ${nameSearch} = ? OR ('|' || s.name_kana_norm || '|') LIKE ? ESCAPE '\\' THEN 6
                   WHEN s.name_norm LIKE ? ESCAPE '\\' OR ${nameSearch} LIKE ? ESCAPE '\\' THEN 5
                   ${hiraganaQuery ? kanaEdge : titleSub}
                   ${hiraganaQuery ? titleSub : kanaEdge}
                   WHEN s.name_kana_norm LIKE ? ESCAPE '\\' THEN 2
                   ELSE 1 END AS mt
       FROM series s
       WHERE (s.name_norm LIKE ? ESCAPE '\\' OR ${nameSearch} LIKE ? ESCAPE '\\' OR s.name_kana_norm LIKE ? ESCAPE '\\'
              OR ${creatorNorm} LIKE ? ESCAPE '\\')
         AND EXISTS (SELECT 1 FROM volumes v WHERE v.series_id = s.id)
         ${adultOnly ? "AND s.is_adult = 1" : ""}),
     tier AS (
       SELECT mt, COUNT(*) AS n, SUM(COUNT(*)) OVER (ORDER BY mt DESC) - COUNT(*) AS before
       FROM hit GROUP BY mt),
     win AS (SELECT mt, before FROM tier WHERE before < ${offset + PAGE + 1} AND before + n > ${offset}),
     page AS (
       SELECT s.id, s.mt, s.num_items, ${VOL_COUNT} AS vol_count
       FROM hit s JOIN win w ON w.mt = s.mt
       ORDER BY s.mt DESC, vol_count DESC, s.num_items DESC, s.id
       LIMIT ${PAGE + 1} OFFSET ${offset} - (SELECT COALESCE(MIN(before), 0) FROM win))
     SELECT ${SERIES_COLS}, p.mt
     FROM page p JOIN series s ON s.id = p.id
     LEFT JOIN series_name_override o ON o.series_id = s.id
     ORDER BY p.mt DESC, p.vol_count DESC, p.num_items DESC, p.id`
  )
    .bind(nq, sq, kanaExact, prefix, prefixS,
          ...(hiraganaQuery ? [kanaPrefix, kanaSuffix, like, likeS] : [like, likeS, kanaPrefix, kanaSuffix]),
          kanaLike, like, likeS, kanaLike, like)
    .all<SeriesRow & { mt: number }>();

  // 管理者が直したシリーズ名（series_name_override）でも引く。上の照合はマスタの列だけを見るので、
  // マスタが書名を壊している作品はどの段にも載らない —『Dr.スランプ』のジャンプ・コミックス版
  // 18 巻（G9784088511818）は書名が「Dr」で、シリーズ行も無いから読み（name_kana_norm）も無く、
  // 「Dr.スランプ」では 1 件も当たらなかった。直した名前はその唯一の手掛かりなので、照合にも使う。
  // 足すのは 1 ページ目だけ（2 ページ目以降にも足すと 1 ページ目と重なる）。
  const nameHits = offset === 0
    ? await matchNameOverrides(env, { nq, sq, prefix, prefixS, like, likeS }, adultOnly)
    : [];
  // まとまり（G-id）の上書きは、まとまりを組み立ててそのままカードにする。通報の後に既存シリーズへ
  // 寄せられるようになっていれば、そのシリーズの上書きとして扱う（resolveGroup）。
  const hitGroups: { group: UnlinkedGroup; mt: number }[] = [];
  const hitSeries = new Map<string, number>(); // シリーズ ID → 段（mt）。結合先への読み替えは下で
  for (const h of nameHits) {
    if (hitGroups.length + hitSeries.size >= OVERRIDE_MAX) break;
    if (!isGroupId(h.id)) {
      hitSeries.set(h.id, Math.max(hitSeries.get(h.id) ?? 0, h.mt));
      continue;
    }
    const r = await resolveGroup(env, h.id);
    if (!r) continue;
    if ("seriesId" in r) hitSeries.set(r.seriesId, Math.max(hitSeries.get(r.seriesId) ?? 0, h.mt));
    else hitGroups.push({ group: r.group, mt: h.mt });
  }

  // Series an admin merged away (series_merge) never show as their own card: drop them and
  // surface their target instead (fetched with the promoted rows below).
  // One row past the page tells whether another page exists; s.id breaks ties so pages
  // don't overlap or skip.
  const hasMore = (res.results ?? []).length > PAGE;
  const keywordRows = (res.results ?? []).slice(0, PAGE);
  const absorbedTo = await mergeTargetsFor(env, [...keywordRows.map((r) => r.id), ...hitSeries.keys()]);
  const rows = keywordRows.filter((r) => !absorbedTo.has(r.id));
  const keptIds = new Set(rows.map((r) => r.id));
  const mergedTargets = [...new Set(absorbedTo.values())].filter((id) => !keptIds.has(id));
  // 吸収されたシリーズに付いた上書きは、結合先のカードの段に効かせる。
  const overrideTier = new Map<string, number>();
  for (const [id, mt] of hitSeries) {
    const target = absorbedTo.get(id) ?? id;
    overrideTier.set(target, Math.max(overrideTier.get(target) ?? 0, mt));
  }
  const overrideIds = [...overrideTier.keys()].filter((id) => !keptIds.has(id));
  const groupHitIds = new Set(hitGroups.map(({ group }) => group.id));

  // ~20% of the MADB dump's volumes carry no schema:isPartOf, so they never join a
  // series row and are invisible to the series-based query above. Two cases, handled by
  // discoverUnlinked:
  //   (1) The work has NO series at all → return a client-side card (like live cards):
  //       volumes embedded, added by ISBN, no /volumes round-trip.
  //   (2) The work HAS a series but the match hit only its unlinked half — e.g. the
  //       原作 author リュート on vols 8-11 while the series creator is 作画 鍋島テツヒロ.
  //       "Promote" to that series id so opening it folds the unlinked volumes back in
  //       (getSeriesVolumes), giving the complete work instead of a partial card.
  const seriesTitles = new Set(rows.map((r) => normTitle(r.name)));
  const existingIds = new Set([...keptIds, ...mergedTargets, ...overrideIds]);
  const { promoteIds: discovered, standalone: discoveredStandalone } = await discoverUnlinked(
    env,
    like,
    likeS,
    seriesTitles,
    existingIds,
    // Only the last page has room for them: series cards always come first.
    hasMore ? 0 : PAGE - rows.length - mergedTargets.length,
    adultOnly
  );
  // 直した名前でもうカードにしたまとまりは、マスタの書名でも当たったときに二重に出さない。
  const standalone = discoveredStandalone.filter((c) => !groupHitIds.has(c.series_id));
  const discoveredTo = await mergeTargetsFor(env, discovered);
  const promoteIds = [
    ...new Set([...overrideIds, ...mergedTargets, ...discovered.map((id) => discoveredTo.get(id) ?? id)]),
  ].filter((id) => !keptIds.has(id));

  // Fetch the promoted series with the same columns as the keyword query so they render
  // as ordinary series cards. Ordered longest-first, mirroring the keyword tie-break.
  const promotedRows = await fetchSeriesRows(env, promoteIds);

  // Cache-only: return instantly. The client fills blank covers via POST /api/covers.
  const covers = await readCachedCovers(
    env,
    [...rows, ...promotedRows].map((r) => r.first_isbn ?? "")
  );

  // 直した名前で当たったカードを、キーワードで当たったカードと同じ物差し（段 → 巻数）で並べる。
  // まとまりのカードはここでしか出ない（マスタの書名では当たらないので discoverUnlinked にも
  // 載らない）。表紙はまとまりを組み立てた時点で引いてある（groups.loadGroup）。
  const overrideRows = promotedRows.filter((r) => overrideTier.has(r.id));
  const plainPromoted = promotedRows.filter((r) => !overrideTier.has(r.id));
  const hitTags = hitGroups.length
    ? await tagsForLabels(env, hitGroups.map(({ group }) => group.label))
    : new Map<string, string>();
  const ranked: { mt: number; count: number; card: SeriesResult | UnlinkedCard }[] = [
    ...rows.map((r) => ({
      mt: Math.max(r.mt, overrideTier.get(r.id) ?? 0),
      count: r.vol_count,
      card: toSeriesResult(r, covers),
    })),
    ...overrideRows.map((r) => ({
      mt: overrideTier.get(r.id) ?? 0,
      count: r.vol_count,
      card: toSeriesResult(r, covers),
    })),
    ...hitGroups.map(({ group, mt }) => ({
      mt,
      count: group.volumes.length,
      card: toUnlinkedCard(group, hitTags.get(group.label) ?? ""),
    })),
  ];
  // 同点はもとの並びを保つ（Array#sort は安定なので、キーワード側は SQL の
  // mt → 巻数 → num_items → id のまま）。
  ranked.sort((a, b) => b.mt - a.mt || b.count - a.count);
  const results = ranked.map((x) => x.card);
  const promoted = plainPromoted.map((r) => toSeriesResult(r, covers));

  // 書名に検索語を含む成年向けの巻（取り込みで外したもの, adult_volumes）があれば、結果の下に
  // 「成年向けは追加できません」と注記できるよう adult_hits を立てる。1 ページ目だけ見る。
  // この応答ごとエッジキャッシュされる（handleSearch の withEdgeCache）ので、検索のたびには引かない。
  const adultHits = offset === 0 ? await hasAdultTitleMatch(env, likeS) : false;

  // Real series first (keyword hits, then promoted complete works), then any standalone
  // series-less cards. Capped at PAGE per page. A merge target or promoted series can
  // reappear on a later page; the client drops cards it already shows.
  // 直した名前で当たった分は PAGE の枠の外に足す。枠を食わせるとキーワードで当たった行が
  // こぼれ、2 ページ目は SQL の offset で続きを出すのでそのまま消えてしまう。
  const extra = overrideRows.length + hitGroups.length;
  return json(
    {
      results: [...results, ...promoted, ...standalone].slice(0, PAGE + extra),
      next_offset: hasMore && offset + PAGE <= SEARCH_MAX_OFFSET ? offset + PAGE : null,
      ...(adultHits ? { adult_hits: true, adult_message: ADULT_BLOCK_MESSAGE } : {}),
    },
    200,
    { "cache-control": "no-store" }
  );
}

/** 促し（promote）や結合先として結果に足すシリーズを、キーワード検索のカードと同じ列で引く。
 *  巻数の多い順。書名検索・作者名検索のどちらからも使う。 */
async function fetchSeriesRows(env: Env, ids: string[]): Promise<SeriesRow[]> {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const res = await env.DB.prepare(
    `SELECT ${SERIES_COLS} FROM series s
     LEFT JOIN series_name_override o ON o.series_id = s.id
     WHERE s.id IN (${placeholders}) ORDER BY vol_count DESC`
  )
    .bind(...ids)
    .all<SeriesRow>();
  return res.results ?? [];
}

// 作者名だけで探す（/api/search?by=creator）。書名は一切見ないので、「ヤマダ」なら書名に
// 「ヤマダ」が入っているだけの作品は落ち、ヤマダ某の作品だけが並ぶ。
// 照合先は creators_norm（取り込みが役割を外して「|」でつないだ全作者名。creatorsMatchCol）だけ。
// 段（mt）は
//   3 … 作者名がまるごと一致（囲んだ blob に「|名前|」として入っている）
//   2 … いずれかの作者名が検索語で始まる（「ヤマダ」→「ヤマダ玲司」）
//   1 … それ以外（名前の途中に含む）
// で、同じ段の中は書名検索と同じく巻数 → num_items → id。段ごとに数えてページの行だけ巻数を
// 出す組み立て（hit → tier → win → page）も searchByKeyword と同じ。
// 読みでは引けない: MADB の schema:creator に読み仮名が無く、作者名の読みをどこにも持っていない
// （書名の name_kana_norm に当たるものが無い）ので、ひらがな⇔カナの折り返しはしない。
async function searchByCreator(env: Env, q: string, offset: number, adultOnly: boolean): Promise<Response> {
  const nq = normTitle(q);
  // 「%|…|%」の囲みで最大 4 バイト増えるぶんを引いて D1 の LIKE 長の上限に収める。
  const esc = escapeLikeClamped(nq, LIKE_MAX_BYTES - 4);
  const like = "%" + esc + "%";
  const nameExact = "%|" + esc + "|%";
  const namePrefix = "%|" + esc + "%";
  // 作者名の blob を「|」で囲む。作者が 1 人の行（creators_norm が無く creator から作る行を含む）
  // でも「|名前|」になるので、まるごと一致・前方一致を同じ式で見られる。
  const creators = `('|' || ${creatorsMatchCol("s.")} || '|')`;

  const res = await env.DB.prepare(
    `WITH hit AS MATERIALIZED (
       SELECT s.id, s.num_items,
              CASE WHEN ${creators} LIKE ? ESCAPE '\\' THEN 3
                   WHEN ${creators} LIKE ? ESCAPE '\\' THEN 2
                   ELSE 1 END AS mt
       FROM series s
       WHERE ${creators} LIKE ? ESCAPE '\\'
         AND EXISTS (SELECT 1 FROM volumes v WHERE v.series_id = s.id)
         ${adultOnly ? "AND s.is_adult = 1" : ""}),
     tier AS (
       SELECT mt, COUNT(*) AS n, SUM(COUNT(*)) OVER (ORDER BY mt DESC) - COUNT(*) AS before
       FROM hit GROUP BY mt),
     win AS (SELECT mt, before FROM tier WHERE before < ${offset + PAGE + 1} AND before + n > ${offset}),
     page AS (
       SELECT s.id, s.mt, s.num_items, ${VOL_COUNT} AS vol_count
       FROM hit s JOIN win w ON w.mt = s.mt
       ORDER BY s.mt DESC, vol_count DESC, s.num_items DESC, s.id
       LIMIT ${PAGE + 1} OFFSET ${offset} - (SELECT COALESCE(MIN(before), 0) FROM win))
     SELECT ${SERIES_COLS}, p.mt
     FROM page p JOIN series s ON s.id = p.id
     LEFT JOIN series_name_override o ON o.series_id = s.id
     ORDER BY p.mt DESC, p.vol_count DESC, p.num_items DESC, p.id`
  )
    .bind(nameExact, namePrefix, like)
    .all<SeriesRow & { mt: number }>();

  // 管理者が結合したシリーズ（series_merge）は自分のカードを出さず、結合先を代わりに出す。
  // 書名検索と同じ扱い。
  const hasMore = (res.results ?? []).length > PAGE;
  const hitRows = (res.results ?? []).slice(0, PAGE);
  const absorbedTo = await mergeTargetsFor(env, hitRows.map((r) => r.id));
  const rows = hitRows.filter((r) => !absorbedTo.has(r.id));
  const keptIds = new Set(rows.map((r) => r.id));
  const mergedTargets = [...new Set(absorbedTo.values())].filter((id) => !keptIds.has(id));

  // シリーズに属さない巻（マスタの約 2 割）にも作者名で当たる。作者名の検索ではここが効きやすい:
  // 共著の片方だけが迷子巻に載っている作品（原作リュート / 作画 鍋島テツヒロ）は、シリーズ行の
  // creators_norm に名前が無く、上の照合では 1 件も当たらない。
  const seriesTitles = new Set(rows.map((r) => normTitle(r.name)));
  const existingIds = new Set([...keptIds, ...mergedTargets]);
  const { promoteIds: discovered, standalone } = await discoverUnlinked(
    env,
    like,
    like, // 書名は見ないので使われない（creatorOnly）
    seriesTitles,
    existingIds,
    hasMore ? 0 : PAGE - rows.length - mergedTargets.length,
    adultOnly,
    true
  );
  const discoveredTo = await mergeTargetsFor(env, discovered);
  const promoteIds = [
    ...new Set([...mergedTargets, ...discovered.map((id) => discoveredTo.get(id) ?? id)]),
  ].filter((id) => !keptIds.has(id));
  const promotedRows = await fetchSeriesRows(env, promoteIds);

  const covers = await readCachedCovers(env, [...rows, ...promotedRows].map((r) => r.first_isbn ?? ""));
  // 成年向けの注記（adult_hits）は出さない。adult_volumes は書名しか持たず、作者名では引けない。
  return json(
    {
      results: [
        ...rows.map((r) => toSeriesResult(r, covers)),
        ...promotedRows.map((r) => toSeriesResult(r, covers)),
        ...standalone,
      ].slice(0, PAGE),
      next_offset: hasMore && offset + PAGE <= SEARCH_MAX_OFFSET ? offset + PAGE : null,
    },
    200,
    { "cache-control": "no-store" }
  );
}

/** 管理者が直したシリーズ名（series_name_override）での照合。当たった上書きの ID（C-id / U-id /
 *  G-id）と段（mt）を強い順に返す。
 *
 *  キーワード検索の本体はマスタの列（name_norm / name_search / name_kana_norm）だけを見るので、
 *  マスタが書名を壊している作品は正しい名前では 1 件も当たらない。『Dr.スランプ』のジャンプ・
 *  コミックス版 18 巻は書名が「Dr」で入っていて、しかもシリーズに属さない巻のまとまりなので
 *  読みも無い。管理者が直した名前だけが正しい名前を知っているので、それを検索の鍵にもする。
 *
 *  段は本体と揃える（前方一致 5 / 中間一致 4）が、完全一致だけは 1 つ上の 7 に置く。上書きは
 *  「この名前の作品はこれ」という管理者の明示なので、たまたま同じ名前で並ぶマスタ行（『Dr.スランプ』
 *  は同名のシリーズが 5 件ある）より確かな手掛かりで、同率の巻数勝負にせず先頭に出す。
 *
 *  表は管理者が直した分しかなく（本番で数十行）、照合は中間一致なのでどのみち索引は効かない。
 *  全行走査 1 回で済むので、重いキーワード検索の方には手を入れない。name_norm / name_search は
 *  修正時に書く（src/admin.ts）。列を足す前からある行・テストが直に入れた行は空なので、
 *  空なら SQL で正規化して代用する（name_search 相当は SQL で作れないので name_norm で代える）。 */
async function matchNameOverrides(
  env: Env,
  pat: { nq: string; sq: string; prefix: string; prefixS: string; like: string; likeS: string },
  adultOnly: boolean
): Promise<{ id: string; mt: number }[]> {
  // 別名 o を必ず付ける。volumes にも series_id 列があるので、下の EXISTS で裸の series_id を
  // 書くと内側の volumes.series_id に束縛される。
  const norm = `COALESCE(NULLIF(o.name_norm, ''), REPLACE(REPLACE(LOWER(o.name), ' ', ''), '　', ''))`;
  const search = `COALESCE(NULLIF(o.name_search, ''), ${norm})`;
  // R18版の既定の絞り込み。series 行のある上書き（C-id / U-id）はその行で、まとまり（G-id）は
  // ID が名乗る ISBN の巻で見る（まとまりの巻は成年向けの別がそろっている）。
  const adultFilter = adultOnly
    ? `AND (EXISTS (SELECT 1 FROM series s WHERE s.id = o.series_id AND s.is_adult = 1)
            OR EXISTS (SELECT 1 FROM volumes v WHERE v.isbn = substr(o.series_id, 2) AND v.is_adult = 1))`
    : "";
  const res = await env.DB.prepare(
    `SELECT o.series_id AS id,
            CASE WHEN ${norm} = ? OR ${search} = ? THEN 7
                 WHEN ${norm} LIKE ? ESCAPE '\\' OR ${search} LIKE ? ESCAPE '\\' THEN 5
                 ELSE 4 END AS mt
       FROM series_name_override o
      WHERE (${norm} LIKE ? ESCAPE '\\' OR ${search} LIKE ? ESCAPE '\\')
      ${adultFilter}`
  )
    .bind(pat.nq, pat.sq, pat.prefix, pat.prefixS, pat.like, pat.likeS)
    .all<{ id: string; mt: number }>();
  // 強い段から。同じ段の中はどれを採っても優劣が無いので ID で決め打ちして並びを安定させる。
  return (res.results ?? []).sort((a, b) => b.mt - a.mt || a.id.localeCompare(b.id));
}

interface UnlinkedCard {
  series_id: string; // "G<ISBN>" (see src/groups.ts)
  title: string;
  creator: string;
  creators: string;
  publisher: string;
  label: string;
  label_tag: string;
  volume_count: number;
  unconfirmed: boolean;
  unlinked: true;
  first_isbn: string;
  cover_url: string;
  volumes: GroupVolume[];
}

// labelTag はまとまりのレーベル（g.label）に付いているタグ。label 自体はカードに出さない
// （まとまりの鍵の一部で、表示用に選ばれた値ではない）が、タグは出す。
function toUnlinkedCard(g: UnlinkedGroup, labelTag = ""): UnlinkedCard {
  const first = g.volumes[0];
  return {
    series_id: g.id,
    title: g.name,
    creator: g.creator,
    creators: g.creators,
    publisher: g.publisher,
    label: "",
    label_tag: labelTag,
    volume_count: g.volumes.length,
    unconfirmed: false,
    unlinked: true,
    first_isbn: first?.isbn ?? "",
    cover_url: first?.cover_url ?? "",
    volumes: g.volumes,
  };
}

// The query as an ISBN13 when it is one (ISBN10/13, hyphens/spaces and full-width digits
// allowed), else "". 13-digit input must carry a book prefix (978/979) so a numeric title
// isn't mistaken for an ISBN.
function isbnQuery(q: string): string {
  const s = q.normalize("NFKC").replace(/[\s\-‐－ー]/g, "");
  if (!/^(97[89]\d{10}|\d{9}[\dXx])$/.test(s)) return "";
  return toIsbn13(s);
}

// ISBN search: the series (or series-less group) that holds that volume, as a single card.
// resolveGroup already covers every case — unlinked volume attributable to a series, a
// standalone group, or a linked volume — and series_merge is applied on top. A volume not in
// the master falls back to 楽天ブックス (manga genres only, see rakutenComicByIsbn) as a
// one-volume live card; when that misses too, no results with isbn_miss so the client can
// say why (live MADB search matches titles only, so it can't help with an ISBN either).
async function searchByIsbn(env: Env, isbn: string): Promise<Response> {
  const headers = { "cache-control": "no-store" };
  // 成年向けとして取り込みから外した巻（adult_volumes）は「見つからない」ではなく、追加できない
  // 理由を返す。楽天ブックスへのフォールバックより先に見る（楽天側に一般の漫画として載っていても出さない）。
  const adultTitle = (await findAdultIsbns(env, [isbn])).get(isbn);
  if (adultTitle !== undefined) {
    return json(
      { results: [], blocked: { reason: "adult", message: adultBlockMessage(adultTitle) } },
      200,
      headers
    );
  }
  const hit = await resolveGroup(env, "G" + isbn);
  if (!hit) {
    const card = await rakutenCard(env, isbn);
    return json(card ? { results: [card] } : { results: [], isbn_miss: true }, 200, headers);
  }
  if ("group" in hit) {
    const tag = (await tagsForLabels(env, [hit.group.label])).get(hit.group.label) ?? "";
    return json({ results: [toUnlinkedCard(hit.group, tag)] }, 200, headers);
  }

  const id = (await mergeTargetsFor(env, [hit.seriesId])).get(hit.seriesId) ?? hit.seriesId;
  const row = await env.DB.prepare(
    `SELECT ${SERIES_COLS} FROM series s
     LEFT JOIN series_name_override o ON o.series_id = s.id
     WHERE s.id = ?`
  )
    .bind(id)
    .first<SeriesRow>();
  if (!row) return json({ results: [], isbn_miss: true }, 200, headers);
  const covers = await readCachedCovers(env, [row.first_isbn ?? ""]);
  return json({ results: [toSeriesResult(row, covers)] }, 200, headers);
}

// A one-volume live card for an ISBN only 楽天ブックス knows (コンビニ版・再編集本 etc. that
// MADB doesn't carry). Opens client-side like live MADB cards; the volume is remembered in
// live_volumes so a list holding it can still show its title.
async function rakutenCard(env: Env, isbn: string) {
  const b = await rakutenComicByIsbn(env, isbn);
  if (!b) return null;
  const vol = {
    isbn,
    isbns: [isbn],
    volume_number: b.volume,
    vol_sort: Number(b.volume) || 0,
    title: b.title,
    author: b.author,
    publisher: b.publisher,
    pubdate: b.pubdate,
  };
  await rememberLiveVolumes(env, [vol]);
  const cover = (await readCachedCovers(env, [isbn])).get(isbn) || b.cover_url;
  return {
    series_id: `rakuten${isbn}`,
    title: b.title,
    creator: b.author,
    creators: b.author.split("/").map((s) => s.trim()).filter(Boolean).join("、"), // 楽天は "/" 区切り
    publisher: b.publisher,
    label: "",
    label_tag: "", // 楽天だけが知っている本。マスタのレーベルが無いので印も付かない
    volume_count: 1,
    unconfirmed: false,
    live: true,
    source: "rakuten",
    first_isbn: isbn,
    cover_url: cover,
    volumes: [{ ...vol, cover_url: cover }],
  };
}

// Find works among the unlinked volumes (series_id IS NULL) that match the query, and
// classify each into one of two buckets:
//   • promoteIds  — the work's title maps to a single existing series (attributeTitles),
//                   so the match really belongs to that series (return its id; the caller
//                   renders it as a normal card and getSeriesVolumes folds the unlinked
//                   volumes back in).
//   • standalone  — no (or ambiguous) series for the title, so surface a self-contained
//                   client-side card with the volumes embedded, keyed by its group id
//                   (G<ISBN>) so it can be opened / merged like a series.
// `like` is the already-escaped "%q%" pattern; matching normalizes title/creator the same
// way normTitle() does the query. `likeS` is the searchKey() form (symbols / width ignored),
// matched against title_search. Titles already shown by the keyword query are skipped,
// and series already in `existingIds` are not promoted again (dedup).
// `creatorOnly`（作者名だけの検索 /api/search?by=creator）のときは書名を見ず、作者名だけで拾う
// （likeS はそのとき使わない）。
async function discoverUnlinked(
  env: Env,
  like: string,
  likeS: string,
  seriesTitles: Set<string>,
  existingIds: Set<string>,
  limit: number,
  adultOnly: boolean,
  creatorOnly = false
): Promise<{ promoteIds: string[]; standalone: UnlinkedCard[] }> {
  if (limit <= 0) return { promoteIds: [], standalone: [] };

  const norm = (col: string) => `REPLACE(REPLACE(LOWER(${col}), ' ', ''), '　', '')`;
  // Cap the scan so a prolific unlinked author can't pull unbounded rows; a single
  // work rarely exceeds ~100 volumes, so 2000 comfortably covers the cards we keep.
  const match = creatorOnly
    ? `${creatorsMatchCol("")} LIKE ? ESCAPE '\\'`
    : `${norm("title")} LIKE ? ESCAPE '\\' OR COALESCE(title_search, ${norm("title")}) LIKE ? ESCAPE '\\'
            OR ${creatorsMatchCol("")} LIKE ? ESCAPE '\\'`;
  const res = await env.DB.prepare(
    `SELECT isbn, volume_number, vol_sort, title, subtitle, creator, creators, publisher, label, pubdate
     FROM volumes
     WHERE series_id IS NULL
       AND (${match})
       ${adultOnly ? "AND is_adult = 1" : ""}
     ORDER BY vol_sort, pubdate, isbn
     LIMIT 2000`
  )
    .bind(...(creatorOnly ? [like] : [like, likeS, like]))
    .all<GroupRow>();

  // Group matched volumes into works keyed on normalized title + creator + label (same
  // title, different author = different work; different label = different edition such as
  // 愛蔵版) — the same unit as groups.loadGroup (see groups.groupKey).
  const groups = new Map<string, GroupRow[]>();
  for (const v of res.results ?? []) {
    const nt = normTitle(v.title);
    if (seriesTitles.has(nt)) continue; // a real series card already covers this title
    const gkey = groupKey(v);
    const g = groups.get(gkey);
    if (g) g.push(v);
    else groups.set(gkey, [v]);
  }

  // Longest works first, then take the cap. Author searches often return many small
  // works; showing the biggest ones first matches the series ordering (vol_count DESC).
  // Size is counted in volumes (sibling ISBNs of one volume_number count once).
  const volCount = (rows: GroupRow[]) =>
    new Set(rows.map((v) => (v.volume_number ? `n:${v.volume_number}` : `i:${v.isbn}`))).size;
  const picked = [...groups.values()]
    .sort((a, b) => volCount(b) - volCount(a))
    .slice(0, limit);
  if (!picked.length) return { promoteIds: [], standalone: [] };

  const owner = await attributeTitles(env, picked.map((rows) => rows[0].title));
  const promoteIds = new Set<string>();
  const standaloneGroups: GroupRow[][] = [];
  for (const rows of picked) {
    const id = owner.get(rows[0].title);
    if (id) {
      if (!existingIds.has(id)) promoteIds.add(id);
    } else {
      standaloneGroups.push(rows);
    }
  }

  const covers = await readCachedCovers(env, standaloneGroups.flat().map((r) => r.isbn));
  const built = standaloneGroups.map((rows) => buildGroup(rows, covers));
  // 管理者が直したまとまりの名前（series_name_override を G-id で引く）をカードにも反映する。
  await applyGroupNames(env, built);
  const groupTags = await tagsForLabels(env, built.map((g) => g.label));
  const standalone = built.map((g) => toUnlinkedCard(g, groupTags.get(g.label) ?? ""));

  return { promoteIds: [...promoteIds], standalone };
}

// Live keyword discovery against MADB SPARQL, for works absent from the monthly
// dump so the master returns nothing (or misses a whole series). User-triggered by
// the "最新DBから取得" button. Returns the same series-card shape as handleSearch,
// but with `live: true` and the volumes embedded (there's no local C-id, so the
// client renders/opens these entirely client-side; add works by ISBN). Cached
// covers are attached where available; the rest fill via POST /api/covers.
export async function handleLiveSearch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q.length < 2) return badRequest("検索語を2文字以上で入力してください");
  // 検索結果が「作者名」側のときは、取得も作者名で探す（書名で探すと別人の作品が返る）。
  const byCreator = url.searchParams.get("by") === "creator";

  let series;
  try {
    series = await liveSearchByKeyword(q, excludeAdult(env), byCreator ? "creator" : "name");
  } catch {
    return json({ error: "最新データベースに接続できませんでした。時間をおいて再試行してください。" }, 502);
  }
  // SPARQL 側でも成年向けは落としている（sparqlNotAdult）が、取り込みで外した巻（adult_volumes）に
  // 当たるものは念のためここでも除き、巻が残らないシリーズごと落とす。
  const adult = await findAdultIsbns(env, series.flatMap((s) => s.volumes.flatMap((v) => v.isbns.map((i) => toIsbn13(i)))));
  if (adult.size) {
    series = series
      .map((s) => {
        const volumes = s.volumes.filter((v) => !v.isbns.some((i) => adult.has(toIsbn13(i))));
        return volumes.length === s.volumes.length
          ? s
          : { ...s, volumes, volume_count: volumes.length, first_isbn: volumes[0]?.isbn ?? "" };
      })
      .filter((s) => s.volumes.length > 0);
  }

  await rememberLiveVolumes(env, series.flatMap((s) => s.volumes));

  const allIsbns: string[] = [];
  for (const s of series) for (const v of s.volumes) allIsbns.push(...v.isbns);
  const covers = await readCachedCovers(env, allIsbns);
  const firstCover = (isbns: string[]) => {
    for (const i of isbns) {
      const c = covers.get(i);
      if (c) return c;
    }
    return "";
  };

  const results = series.map((s, i) => ({
    series_id: `live${i}`,
    title: s.title,
    creator: s.creator,
    publisher: s.publisher,
    label: "",
    volume_count: s.volume_count,
    unconfirmed: false,
    live: true,
    first_isbn: s.first_isbn,
    cover_url: firstCover(s.volumes[0]?.isbns ?? []),
    volumes: s.volumes.map((v) => ({ ...v, cover_url: firstCover(v.isbns) })),
  }));

  return json({ results }, 200, { "cache-control": "no-store" });
}

/** Persist live-search volumes the master lacks into live_volumes, so a book picked
 *  from these results can still resolve its title/author by ISBN once it's in a list
 *  (lists store only the ISBN — see src/listItems.ts). The data is what this server
 *  just fetched from MADB / 楽天ブックス, never client input. One statement: the rows go in as one
 *  JSON parameter. Failures are logged and ignored — search results still render. */
async function rememberLiveVolumes(env: Env, volumes: SupplementVolume[]): Promise<void> {
  const rows: { isbn: string; title: string; volume_number: string; author: string }[] = [];
  for (const v of volumes) {
    for (const raw of v.isbns) {
      const isbn = toIsbn13(raw);
      if (isbn) rows.push({ isbn, title: v.title, volume_number: v.volume_number, author: v.author });
    }
  }
  if (!rows.length) return;
  try {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO live_volumes (isbn, title, volume_number, author, fetched_at)
       SELECT json_extract(value, '$.isbn'), json_extract(value, '$.title'),
              json_extract(value, '$.volume_number'), json_extract(value, '$.author'), ?2
         FROM json_each(?1)
        WHERE NOT EXISTS (SELECT 1 FROM volumes v WHERE v.isbn = json_extract(value, '$.isbn'))`
    )
      .bind(JSON.stringify(rows), Date.now())
      .run();
  } catch (err) {
    console.error("live_volumes write failed", err);
  }
}
