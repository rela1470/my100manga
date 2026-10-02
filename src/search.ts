import { Env } from "./types";
import { badRequest, json, normTitle, escapeLikeClamped, LIKE_MAX_BYTES, toIsbn13 } from "./util";
import { readCachedCovers } from "./covers";
import { liveSearchByKeyword, SupplementVolume } from "./madbLive";
import { rakutenComicByIsbn } from "./rakuten";
import { mergeTargetsFor } from "./merge";
import { attributeTitles, buildGroup, resolveGroup, GroupRow, GroupVolume, UnlinkedGroup } from "./groups";

interface SeriesResult {
  series_id: string;
  title: string;
  creator: string;
  publisher: string;
  label: string;
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
  publisher: string | null;
  label: string | null;
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
// master) so an admin-corrected title (series_name_override) shows here; search MATCHING
// stays on the original name_norm / name_kana_norm columns below.
// Volume-derived columns span the merge group (MEMBERS: the series plus any series an admin
// merged into it, see src/merge.ts) so a merged card shows the combined count/cover.
const MEMBERS = `(SELECT s.id UNION ALL SELECT m.absorbed_id FROM series_merge m WHERE m.target_id = s.id)`;
const SERIES_COLS = `s.id, COALESCE(o.name, s.name) AS name, s.publisher, s.label,
        COALESCE((SELECT v.creator FROM volumes v WHERE v.series_id IN ${MEMBERS} AND v.creator != ''
           ORDER BY v.vol_sort, v.pubdate LIMIT 1), s.creator) AS creator,
        (SELECT v.isbn FROM volumes v WHERE v.series_id IN ${MEMBERS}
           ORDER BY v.vol_sort, v.pubdate LIMIT 1) AS first_isbn,
        ((SELECT COUNT(DISTINCT CASE WHEN v.volume_number IS NULL OR v.volume_number = ''
                   THEN v.isbn ELSE v.volume_number END)
           FROM volumes v WHERE v.series_id IN ${MEMBERS})
         + COALESCE((SELECT json_array_length(sp.volumes_json)
                      FROM series_supplement sp WHERE sp.series_id = s.id), 0)
         + COALESCE((SELECT COUNT(*) FROM series_correction sc
                      WHERE sc.series_id IN ${MEMBERS}), 0)) AS vol_count,
        EXISTS(SELECT 1 FROM series_supplement sp WHERE sp.series_id = s.id) AS probed,
        EXISTS(SELECT 1 FROM volumes v WHERE v.series_id IN ${MEMBERS}
                 AND ((v.volume_number GLOB '[0-9]*' AND NOT v.volume_number GLOB '*[^0-9]*')
                      OR v.volume_number GLOB '巻[0-9]*')) AS numbered`;

function toSeriesResult(r: SeriesRow, covers: Map<string, string>): SeriesResult {
  const isbn = r.first_isbn ?? "";
  return {
    series_id: r.id,
    title: r.name,
    creator: r.creator ?? "",
    publisher: r.publisher ?? "",
    label: r.label ?? "",
    volume_count: r.vol_count,
    // Only flag "＋未確認" for numbered series with a known author — the ones a 取得 probe
    // can actually extend. One-shots and unattributed rows would show a marker that never
    // resolves, so leave them exact.
    unconfirmed: !r.probed && !!r.numbered && !!(r.creator ?? ""),
    first_isbn: isbn,
    cover_url: covers.get(isbn) ?? "",
  };
}

// Search the MADB master (series table). Results are series-level; the client
// then pulls volumes via /api/series/:id/volumes to add a single volume or the
// whole series. Ordering: exact title match, then prefix, then substring; within
// each tier the longest series (most volumes) wins so core works beat spin-offs.
// TODO(diff-supplement): fall back to NDL/楽天 for releases newer than the MADB
// dump when the local master returns nothing.
export async function handleSearch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q.length < 2) return badRequest("検索語を2文字以上で入力してください");

  const isbn = isbnQuery(q);
  if (isbn) return searchByIsbn(env, isbn);

  const nq = normTitle(q);
  // Clamp below the D1 LIKE byte cap; the "%|…|%" kana wrappers add up to 4 bytes.
  // The exact tier below still binds full nq (= ? has no pattern-length limit).
  const esc = escapeLikeClamped(nq, LIKE_MAX_BYTES - 4);

  const like = "%" + esc + "%";
  const prefix = esc + "%";
  // name_kana_norm packs several readings joined by "|" (e.g. "onepiece|ワンピース").
  // Wrapping with "|" lets us detect a whole-reading exact/prefix match inside the blob,
  // so the canonical series exact-matches カナ queries and — tied at the same tier — the
  // one with the most volumes wins (vol_count DESC) instead of a small re-release.
  const kanaExact = "%|" + esc + "|%";
  const kanaPrefix = "%|" + esc + "%";
  // Match the author too. series.creator has no normalized column, so normalize it
  // inline the same way normTitle() does the query (lowercase + strip both ASCII and
  // full-width spaces) so "尾田 栄一郎" and "尾田栄一郎" both hit. Creator-only matches
  // sit in the lowest tier (mt=1) so a title hit always outranks an author hit.
  const creatorNorm = "REPLACE(REPLACE(LOWER(s.creator), ' ', ''), '　', '')";
  const res = await env.DB.prepare(
    `SELECT ${SERIES_COLS},
            CASE WHEN s.name_norm = ? OR ('|' || s.name_kana_norm || '|') LIKE ? ESCAPE '\\' THEN 4
                 WHEN s.name_norm LIKE ? ESCAPE '\\' OR ('|' || s.name_kana_norm) LIKE ? ESCAPE '\\' THEN 3
                 WHEN s.name_norm LIKE ? ESCAPE '\\' OR s.name_kana_norm LIKE ? ESCAPE '\\' THEN 2
                 ELSE 1 END AS mt
     FROM series s
     LEFT JOIN series_name_override o ON o.series_id = s.id
     WHERE (s.name_norm LIKE ? ESCAPE '\\' OR s.name_kana_norm LIKE ? ESCAPE '\\'
            OR ${creatorNorm} LIKE ? ESCAPE '\\')
       AND EXISTS (SELECT 1 FROM volumes v WHERE v.series_id = s.id)
     ORDER BY mt DESC, vol_count DESC, s.num_items DESC
     LIMIT 30`
  )
    .bind(nq, kanaExact, prefix, kanaPrefix, like, like, like, like, like)
    .all<SeriesRow & { mt: number }>();

  // Series an admin merged away (series_merge) never show as their own card: drop them and
  // surface their target instead (fetched with the promoted rows below).
  const keywordRows = res.results ?? [];
  const absorbedTo = await mergeTargetsFor(env, keywordRows.map((r) => r.id));
  const rows = keywordRows.filter((r) => !absorbedTo.has(r.id));
  const keptIds = new Set(rows.map((r) => r.id));
  const mergedTargets = [...new Set(absorbedTo.values())].filter((id) => !keptIds.has(id));

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
  const existingIds = new Set([...keptIds, ...mergedTargets]);
  const { promoteIds: discovered, standalone } = await discoverUnlinked(
    env,
    like,
    seriesTitles,
    existingIds,
    30 - rows.length - mergedTargets.length
  );
  const discoveredTo = await mergeTargetsFor(env, discovered);
  const promoteIds = [
    ...new Set([...mergedTargets, ...discovered.map((id) => discoveredTo.get(id) ?? id)]),
  ].filter((id) => !keptIds.has(id));

  // Fetch the promoted series with the same columns as the keyword query so they render
  // as ordinary series cards. Ordered longest-first, mirroring the keyword tie-break.
  let promotedRows: SeriesRow[] = [];
  if (promoteIds.length) {
    const placeholders = promoteIds.map(() => "?").join(",");
    const pr = await env.DB.prepare(
      `SELECT ${SERIES_COLS} FROM series s
       LEFT JOIN series_name_override o ON o.series_id = s.id
       WHERE s.id IN (${placeholders}) ORDER BY vol_count DESC`
    )
      .bind(...promoteIds)
      .all<SeriesRow>();
    promotedRows = pr.results ?? [];
  }

  // Cache-only: return instantly. The client fills blank covers via POST /api/covers.
  const covers = await readCachedCovers(
    env,
    [...rows, ...promotedRows].map((r) => r.first_isbn ?? "")
  );
  const results = rows.map((r) => toSeriesResult(r, covers));
  const promoted = promotedRows.map((r) => toSeriesResult(r, covers));

  // Real series first (keyword hits, then promoted complete works), then any standalone
  // series-less cards. Capped at 30 total.
  return json(
    { results: [...results, ...promoted, ...standalone].slice(0, 30) },
    200,
    { "cache-control": "no-store" }
  );
}

interface UnlinkedCard {
  series_id: string; // "G<ISBN>" (see src/groups.ts)
  title: string;
  creator: string;
  publisher: string;
  label: string;
  volume_count: number;
  unconfirmed: boolean;
  unlinked: true;
  first_isbn: string;
  cover_url: string;
  volumes: GroupVolume[];
}

function toUnlinkedCard(g: UnlinkedGroup): UnlinkedCard {
  const first = g.volumes[0];
  return {
    series_id: g.id,
    title: g.title,
    creator: g.creator,
    publisher: g.publisher,
    label: "",
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
  const hit = await resolveGroup(env, "G" + isbn);
  if (!hit) {
    const card = await rakutenCard(env, isbn);
    return json(card ? { results: [card] } : { results: [], isbn_miss: true }, 200, headers);
  }
  if ("group" in hit) return json({ results: [toUnlinkedCard(hit.group)] }, 200, headers);

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
    publisher: b.publisher,
    label: "",
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
// way normTitle() does the query. Titles already shown by the keyword query are skipped,
// and series already in `existingIds` are not promoted again (dedup).
async function discoverUnlinked(
  env: Env,
  like: string,
  seriesTitles: Set<string>,
  existingIds: Set<string>,
  limit: number
): Promise<{ promoteIds: string[]; standalone: UnlinkedCard[] }> {
  if (limit <= 0) return { promoteIds: [], standalone: [] };

  const norm = (col: string) => `REPLACE(REPLACE(LOWER(${col}), ' ', ''), '　', '')`;
  // Cap the scan so a prolific unlinked author can't pull unbounded rows; a single
  // work rarely exceeds ~100 volumes, so 2000 comfortably covers the cards we keep.
  const res = await env.DB.prepare(
    `SELECT isbn, volume_number, vol_sort, title, creator, publisher, label, pubdate
     FROM volumes
     WHERE series_id IS NULL
       AND (${norm("title")} LIKE ? ESCAPE '\\' OR ${norm("COALESCE(creator, '')")} LIKE ? ESCAPE '\\')
     ORDER BY vol_sort, pubdate, isbn
     LIMIT 2000`
  )
    .bind(like, like)
    .all<GroupRow>();

  // Group matched volumes into works keyed on normalized title + creator (same title,
  // different author = different work) — the same unit as groups.loadGroup.
  const groups = new Map<string, GroupRow[]>();
  for (const v of res.results ?? []) {
    const nt = normTitle(v.title);
    if (seriesTitles.has(nt)) continue; // a real series card already covers this title
    const gkey = nt + " " + normTitle(v.creator ?? "");
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
  const standalone = standaloneGroups.map((rows) => toUnlinkedCard(buildGroup(rows, covers)));

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

  let series;
  try {
    series = await liveSearchByKeyword(q);
  } catch {
    return json({ error: "最新データベースに接続できませんでした。時間をおいて再試行してください。" }, 502);
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
