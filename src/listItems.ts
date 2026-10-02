import { Env, ListItem, StoredListItem } from "./types";
import { toIsbn13, unifyVolumeLabel, volumeLabelTemplate } from "./util";
import { isCustomSeriesId } from "./groups";

// One round-trip for any number of ISBNs. They go in as a single JSON-array parameter
// (expanded with json_each) rather than one "?" each, so a 100-book list never hits
// D1's bound-parameter cap. Per ISBN it picks the best source — master volume (1),
// user correction (2), live-MADB supplement cache (3), live search results (4) — and
// joins the per-series display data computed the same way as getSeriesVolumes: the
// admin name override, the most common master volume title, and the distinct volume
// labels (from which the dominant 巻数表記 is derived in JS). The cover is the
// site-wide one in `covers`; when this exact ISBN has none, a sibling ISBN of the
// same volume (通常版/重版 share series + volume number; supplement entries list
// theirs) is used — the same "first ISBN with a cover" rule as the volume list.
// A series an admin merged away (series_merge) is read as its target (best.tid), with the
// title/labels computed over the whole merge group (serm), matching getSeriesVolumes.
// "serm CROSS JOIN volumes" pins the join order so SQLite walks idx_volumes_series for
// just these series; with a plain JOIN it scanned the whole volumes table (~560k rows
// read per call on remote D1).
const RESOLVE_SQL = `
WITH want(isbn) AS (SELECT DISTINCT value FROM json_each(?1)),
src AS (
  SELECT w.isbn, v.series_id, v.volume_number, v.vol_sort, v.title, v.creator AS author,
         NULL AS sibs, 1 AS pri
    FROM want w JOIN volumes v ON v.isbn = w.isbn
  UNION ALL
  SELECT w.isbn, c.series_id, c.volume_number, c.vol_sort, '', NULL, NULL, 2
    FROM want w JOIN series_correction c ON c.isbn = w.isbn
  UNION ALL
  SELECT w.isbn, sp.series_id, json_extract(j.value, '$.volume_number'),
         json_extract(j.value, '$.vol_sort'), json_extract(j.value, '$.title'),
         json_extract(j.value, '$.author'), json_extract(j.value, '$.isbns'), 3
    FROM want w
    JOIN series_supplement sp ON sp.volumes_json LIKE '%' || w.isbn || '%'
    JOIN json_each(sp.volumes_json) j
    JOIN json_each(j.value, '$.isbns') ji ON ji.value = w.isbn
   WHERE NOT EXISTS (SELECT 1 FROM volumes v WHERE v.isbn = w.isbn)
     AND NOT EXISTS (SELECT 1 FROM series_correction c WHERE c.isbn = w.isbn)
  UNION ALL
  SELECT w.isbn, NULL, lv.volume_number, 0, lv.title, lv.author, NULL, 4
    FROM want w JOIN live_volumes lv ON lv.isbn = w.isbn
),
best AS (
  SELECT *, COALESCE((SELECT m.target_id FROM series_merge m WHERE m.absorbed_id = series_id),
                     series_id) AS tid
    FROM (
    SELECT src.*, ROW_NUMBER() OVER (PARTITION BY isbn ORDER BY pri) AS rn FROM src
  ) WHERE rn = 1
),
ser AS (SELECT DISTINCT tid AS series_id FROM best WHERE tid IS NOT NULL),
serm AS (
  SELECT series_id, series_id AS member FROM ser
  UNION ALL
  SELECT ser.series_id, m.absorbed_id FROM ser JOIN series_merge m ON m.target_id = ser.series_id
),
canon AS (
  SELECT series_id, title FROM (
    SELECT serm.series_id, v.title,
           ROW_NUMBER() OVER (PARTITION BY serm.series_id
                              ORDER BY COUNT(*) DESC, LENGTH(v.title) DESC, v.title) AS rn
      FROM serm CROSS JOIN volumes v ON v.series_id = serm.member
     WHERE v.title <> '' AND v.volume_number IS NOT NULL
     GROUP BY serm.series_id, v.title
  ) WHERE rn = 1
),
labs AS (
  SELECT serm.series_id, json_group_array(DISTINCT v.volume_number) AS labels
    FROM serm CROSS JOIN volumes v ON v.series_id = serm.member
   WHERE v.volume_number IS NOT NULL
   GROUP BY serm.series_id
)
SELECT w.isbn, b.isbn AS found, b.tid AS series_id, b.volume_number, b.title, b.author,
       vto.title AS title_override, sno.name AS series_override,
       canon.title AS canonical, labs.labels, s.creator AS series_creator, s.name AS series_name,
       bm.authors AS meta_authors,
       COALESCE(
         NULLIF(cv.cover_url, ''),
         (SELECT cv2.cover_url FROM volumes v2 JOIN covers cv2 ON cv2.isbn = v2.isbn
           WHERE b.pri = 1 AND v2.series_id = b.series_id AND v2.vol_sort = b.vol_sort
             AND v2.volume_number = b.volume_number AND cv2.cover_url <> ''
           ORDER BY v2.pubdate, v2.isbn LIMIT 1),
         (SELECT cv3.cover_url FROM json_each(b.sibs) sb JOIN covers cv3 ON cv3.isbn = sb.value
           WHERE cv3.cover_url <> '' LIMIT 1),
         ''
       ) AS cover
  FROM want w
  LEFT JOIN best b ON b.isbn = w.isbn
  LEFT JOIN covers cv ON cv.isbn = w.isbn
  LEFT JOIN series s ON s.id = b.tid
  LEFT JOIN book_meta bm ON bm.isbn = w.isbn
  LEFT JOIN volume_title_override vto ON vto.isbn = b.isbn
  LEFT JOIN series_name_override sno ON sno.series_id = b.tid
  LEFT JOIN canon ON canon.series_id = b.tid
  LEFT JOIN labs ON labs.series_id = b.tid`;

interface Row {
  isbn: string;
  found: string | null; // non-null when a title source matched
  series_id: string | null;
  volume_number: string | null;
  title: string | null;
  author: string | null;
  title_override: string | null;
  series_override: string | null;
  canonical: string | null;
  labels: string | null; // JSON array of the series' distinct volume labels
  series_creator: string | null;
  series_name: string | null;
  meta_authors: string | null; // book_meta.authors ("/"-joined)
  cover: string;
}

export interface Book {
  title: string; // "" when no site-wide source knows this ISBN
  author: string;
  cover_url: string;
  series_id: string; // "" for books with no series (live-search-only volumes)
  series_title: string; // the series' display name (admin override > canonical)
}

/** Site-wide display data for each ISBN (keys are ISBN13): title rendered exactly like
 *  the editor's volume list ("<series title> <volume label>", honoring admin overrides
 *  and the unified 巻数表記), author, and the site-wide cover. ISBN-10 input is
 *  normalized. Used for lists, the ranking and admin views — nothing stores these. */
export async function resolveBooks(env: Env, isbns: string[]): Promise<Map<string, Book>> {
  const out = new Map<string, Book>();
  const want = [...new Set(isbns.map(toIsbn13).filter(Boolean))];
  if (!want.length) return out;

  const res = await env.DB.prepare(RESOLVE_SQL).bind(JSON.stringify(want)).all<Row>();
  const templates = new Map<string, string | null>();
  for (const r of res.results ?? []) {
    let title = "";
    let seriesTitle = "";
    let author = r.meta_authors ? r.meta_authors.split("/").join("、") : "";
    if (r.found) {
      const sid = r.series_id;
      let template: string | null = null;
      if (sid) {
        if (!templates.has(sid)) {
          let labels: string[] = [];
          try {
            labels = JSON.parse(r.labels ?? "[]") as string[];
          } catch {
            // no labels ⇒ no template
          }
          templates.set(sid, volumeLabelTemplate(labels));
        }
        template = templates.get(sid) ?? null;
      }
      // 独自シリーズ（src/groups.ts）は別々の本を束ねるので、本のタイトルは巻の書名のまま、
      // シリーズ名は独自シリーズの名前にする。
      const custom = !!sid && isCustomSeriesId(sid);
      seriesTitle = r.series_override || (custom ? r.series_name : r.canonical) || r.title || "";
      // 巻番号の無い巻（総集編など）も書名が本の区別なので揃えない（getSeriesVolumes と同じ）。
      const own = custom || (r.found && !r.volume_number);
      const base = r.title_override || (own ? r.title || seriesTitle : seriesTitle);
      const raw = r.volume_number ?? "";
      const label = sid ? unifyVolumeLabel(template, raw) : raw;
      title = base && label ? `${base} ${label}` : base;
      author = r.author || r.series_creator || author;
    }
    out.set(r.isbn, {
      title,
      author,
      cover_url: r.cover || "",
      series_id: r.found ? r.series_id || "" : "",
      series_title: r.found && r.series_id ? seriesTitle : "",
    });
  }
  return out;
}

/** Attach the site-wide title/author/cover to stored list items (see resolveBooks).
 *  A book no source knows (shouldn't happen for items added through the UI) shows
 *  its ISBN as the title rather than a blank card. */
export async function resolveListItems(env: Env, items: StoredListItem[]): Promise<ListItem[]> {
  const books = await resolveBooks(env, items.map((it) => it.isbn));
  return items.map((it) => {
    const b = books.get(toIsbn13(it.isbn));
    // Legacy ISBN-less items (from before ISBNs were required) still carry their own
    // title/author/cover — the migration keeps them since there's nothing to resolve.
    const legacy = it as Partial<ListItem>;
    return {
      position: it.position,
      isbn: it.isbn,
      comment: it.comment ?? "",
      spoiler: !!it.spoiler,
      title: b?.title || legacy.title || `ISBN ${it.isbn}`,
      author: b?.author || legacy.author || "",
      cover_url: b?.cover_url || legacy.cover_url || "",
    };
  });
}
