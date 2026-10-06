import { Env } from "./types";
import { toIsbn13, volSort } from "./util";
import { sparqlNotAdult } from "./adult";
import { excludeAdult } from "./site";

// The MADB monthly dump (see scripts/ingest.mjs) links volumes to series via
// schema:isPartOf, but the newest tankobon frequently lack that edge upstream, so
// they arrive unlinked (~20% overall; e.g. ONE PIECE vol 101+ is absent from the
// canonical series). The live SPARQL endpoint carries fresher data, so we probe it
// for tankobon whose title matches the series exactly and whose (role-stripped)
// creator matches, then append the volume numbers the dump is missing. Matching is
// deliberately strict (exact name + normalized creator) to avoid attaching a
// same-titled but different work's volume.
// 成年コミック（schema:contentRating）は月次取り込みと同じくライブ検索・補完でも落とす（src/adult.ts）。
const SPARQL_ENDPOINT = "https://mediaarts-db.artmuseums.go.jp/sparql";
// Re-probe monthly (aligned with the MADB dump cadence).
const CACHE_TTL_MS = 30 * 24 * 3600 * 1000;
const SPARQL_TIMEOUT_MS = 12000;

export interface SupplementVolume {
  isbn: string;
  isbns: string[];
  volume_number: string;
  vol_sort: number;
  title: string;
  author: string;
  publisher: string;
  pubdate: string;
}

// Mirror scripts/ingest.mjs cleanCreator: strip role tags like "[著]" and collapse
// whitespace so live literals ("[著]尾田栄一郎") match the stored creator ("尾田栄一郎").
function cleanCreator(s: string): string {
  return s
    .replace(/\[[^\]]*\]/g, "")
    .replace(/[\s　]+/g, " ")
    .trim();
}

// Standard tankobon numbering styles we trust for supplementing. "巻107" (KAN) and
// plain "12" (NUM). Anything else — arc labels like "6 (アラバスタ編)", 総集編, etc. —
// is NOT a supplementable format: several distinct same-titled editions use those,
// so we can't tell which series a loose volume belongs to.
export type NumFmt = "KAN" | "NUM";

function matchesFmt(vol: string, fmt: NumFmt): boolean {
  return fmt === "KAN" ? /^巻\d+$/.test(vol) : /^\d+$/.test(vol);
}

/** The single numbering format a series uses, or null if it mixes formats / uses a
 *  non-standard label — in which case it is unsafe to supplement (see NumFmt). */
export function seriesFormat(volumeNumbers: string[]): NumFmt | null {
  let kan = 0;
  let num = 0;
  for (const n of volumeNumbers) {
    if (!n) continue;
    if (/^巻\d+$/.test(n)) kan++;
    else if (/^\d+$/.test(n)) num++;
    else return null; // any non-standard label ⇒ don't supplement this series
  }
  if (kan > 0 && num > 0) return null; // mixed ⇒ ambiguous
  if (kan > 0) return "KAN";
  if (num > 0) return "NUM";
  return null;
}

function sparqlString(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
}

// Normalize a live schema:isbn literal to ISBN13. Box-set ISBNs ("9784099430115(set)",
// e.g. the bonus Banana fish 20 inside the 2018 復刻版BOX) are shared by every book in
// the box and never identify a single volume, so they're dropped ("" = skip). A volume
// whose only ISBN is a set one is therefore not offered at all.
function liveIsbn(raw: string | undefined): string {
  if (!raw || /\(set\)/i.test(raw)) return "";
  return toIsbn13(raw);
}

interface Binding {
  name?: { value: string };
  isbn?: { value: string };
  vol?: { value: string };
  creator?: { value: string };
  publisher?: { value: string };
  date?: { value: string };
}

/** Run a SPARQL SELECT against live MADB and return its bindings. Throws on
 *  network / non-OK so callers can degrade (dump-only, or a fetch error to the UI). */
async function runSparql(query: string): Promise<Binding[]> {
  const url = SPARQL_ENDPOINT + "?query=" + encodeURIComponent(query);
  const res = await fetch(url, {
    headers: { accept: "application/sparql-results+json" },
    signal: AbortSignal.timeout(SPARQL_TIMEOUT_MS),
    cf: { cacheEverything: true, cacheTtl: 3600 },
  });
  if (!res.ok) throw new Error(`SPARQL ${res.status}`);
  const data = (await res.json()) as { results?: { bindings?: Binding[] } };
  return data.results?.bindings ?? [];
}

/** Query live MADB for every tankobon whose title exactly equals `name`, returning
 *  one entry per ISBN with its volume label, all creator literals, publisher and
 *  date. Throws on network / non-OK so the caller can degrade to dump-only. */
async function queryTankobonByName(name: string, exclude: boolean): Promise<Binding[]> {
  return runSparql(`PREFIX schema: <https://schema.org/>
SELECT ?isbn ?vol ?creator ?publisher ?date WHERE {
  ?book schema:name ${sparqlString(name)} ;
        schema:isbn ?isbn ;
        schema:volumeNumber ?vol ;
        schema:creator ?creator .
  ${sparqlNotAdult("?book", exclude)}
  OPTIONAL { ?book schema:publisher ?publisher }
  OPTIONAL { ?book schema:datePublished ?date }
} LIMIT 2000`);
}

// MADB のシリーズノードの URI。巻→シリーズの厳密結合に使う。
const ID_BASE = "https://mediaarts-db.artmuseums.go.jp/id/";

export interface SeriesMemberVolume {
  volume_number: string; // MADB の巻ラベルそのまま（"12" / "第12巻"）
  isbn: string; // MADB が持っていなければ ""
  pubdate: string;
}

/** MADB がこのシリーズ C-id 配下（schema:isPartOf）に置いている単行本を全部返す。ISBN の
 *  無い巻も返すのが queryTankobonByName との違いで、そこが要点になる。
 *
 *  ダンプ側は ISBN をキーにしているので ISBN の無い巻は丸ごと落ちる（scripts/ingest.mjs の
 *  `if (!isbn ...) return`）。横山光輝『三国志』希望コミックス（C276805）は MADB に 60 巻
 *  あるが ISBN を持つのは 32 巻だけで、残り 28 巻がこれで消える。実測で全 MangaBook の
 *  11%（46,017 件）が ISBN 無し、うち 85% がシリーズに紐付いている。
 *
 *  名前一致の補完（queryTankobonByName）と違い、これはシリーズノードへの厳密結合なので
 *  同名別シリーズの取り違えが起きない。巻の途中に挿し込んでよいのはそのため（名前一致の
 *  補完が末尾追加しかしないのと対照的）。*/
export async function queryVolumesInSeries(
  seriesId: string,
  exclude: boolean
): Promise<SeriesMemberVolume[]> {
  // C-id は自前のマスタ由来だが、SPARQL に素で埋めるので念のため形を縛る。
  if (!/^C\d+$/.test(seriesId)) return [];
  const rows = await runSparql(`PREFIX schema: <https://schema.org/>
SELECT ?vol ?isbn ?date WHERE {
  ?book schema:isPartOf <${ID_BASE}${seriesId}> ;
        schema:volumeNumber ?vol .
  ${sparqlNotAdult("?book", exclude)}
  OPTIONAL { ?book schema:isbn ?isbn }
  OPTIONAL { ?book schema:datePublished ?date }
} LIMIT 2000`);
  return rows
    .map((b) => ({
      volume_number: b.vol?.value ?? "",
      isbn: liveIsbn(b.isbn?.value),
      pubdate: b.date?.value ?? "",
    }))
    .filter((v) => v.volume_number);
}

/** 補完リストを丸ごと差し替える。SPARQL 由来（末尾追加）と楽天由来の穴埋め
 *  （src/gapFill.ts）を 1 本にまとめて持たせるため、series.ts が合算後に呼ぶ。
 *  series_supplement_isbn はトリガが追随する（db/schema.sql）。*/
export async function writeSupplement(
  env: Env,
  seriesId: string,
  vols: SupplementVolume[]
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO series_supplement (series_id, volumes_json, checked_at) VALUES (?, ?, ?)`
  )
    .bind(seriesId, JSON.stringify(vols), Date.now())
    .run();
}

export interface LiveSeries {
  title: string;
  creator: string;
  publisher: string;
  volume_count: number;
  first_isbn: string;
  volumes: SupplementVolume[];
}

/** Keyword discovery against live MADB: find tankobon whose title CONTAINS the
 *  query and group them into series (by title). Powers the search-page "最新DBから
 *  取得" button for works absent from the monthly dump entirely. Unlike the
 *  per-series supplement this is a broad substring scan, so it's user-triggered
 *  only and never cached in D1. Throws on fetch failure. */
export async function liveSearchByKeyword(
  keyword: string,
  exclude = true,
  // 照合先。"name" = 書名（既定）、"creator" = 作者名（検索結果の「作者名」側から呼ばれる）。
  // schema:creator は "[著]尾田栄一郎" のように役割が付いた文字列なので、そのまま部分一致で見る。
  field: "name" | "creator" = "name"
): Promise<LiveSeries[]> {
  const rows = await runSparql(`PREFIX schema: <https://schema.org/>
SELECT ?name ?isbn ?vol ?creator ?publisher ?date WHERE {
  ?book schema:name ?name ;
        schema:isbn ?isbn ;
        schema:volumeNumber ?vol ;
        schema:creator ?creator .
  FILTER(CONTAINS(?${field}, ${sparqlString(keyword)}))
  ${sparqlNotAdult("?book", exclude)}
  OPTIONAL { ?book schema:publisher ?publisher }
  OPTIONAL { ?book schema:datePublished ?date }
} LIMIT 2000`);

  // name → { vol → {isbns, ...} , creator tallies }
  interface VolAgg {
    isbns: Set<string>;
    publisher: string;
    date: string;
  }
  interface NameAgg {
    vols: Map<string, VolAgg>;
    creators: Map<string, number>;
  }
  const byName = new Map<string, NameAgg>();
  for (const b of rows) {
    const name = b.name?.value;
    const isbn = liveIsbn(b.isbn?.value);
    const vol = b.vol?.value;
    if (!name || !isbn || !vol) continue;
    let n = byName.get(name);
    if (!n) {
      n = { vols: new Map(), creators: new Map() };
      byName.set(name, n);
    }
    let g = n.vols.get(vol);
    if (!g) {
      g = { isbns: new Set(), publisher: "", date: "" };
      n.vols.set(vol, g);
    }
    g.isbns.add(isbn);
    if (b.publisher?.value && !g.publisher) g.publisher = b.publisher.value.split(/[／∥]/)[0].trim();
    if (b.date?.value && !g.date) g.date = b.date.value;
    if (b.creator?.value) {
      const c = cleanCreator(b.creator.value);
      if (c) n.creators.set(c, (n.creators.get(c) ?? 0) + 1);
    }
  }

  const out: LiveSeries[] = [];
  for (const [name, n] of byName) {
    // Dominant creator literal for the title (a book carries several role-tagged ones).
    let creator = "";
    let best = -1;
    for (const [c, cnt] of n.creators) if (cnt > best) ((best = cnt), (creator = c));

    const volumes: SupplementVolume[] = [...n.vols.entries()]
      .map(([vol, g]) => {
        const isbns = [...g.isbns];
        return {
          isbn: isbns[0],
          isbns,
          volume_number: vol,
          vol_sort: volSort(vol),
          title: name,
          author: creator,
          publisher: g.publisher,
          pubdate: g.date,
        };
      })
      .sort((a, b) => a.vol_sort - b.vol_sort);

    out.push({
      title: name,
      creator,
      publisher: volumes[0]?.publisher ?? "",
      volume_count: volumes.length,
      first_isbn: volumes[0]?.isbn ?? "",
      volumes,
    });
  }
  out.sort((a, b) => b.volume_count - a.volume_count);
  return out.slice(0, 30);
}

/** Extra volumes for a series present in live MADB but missing from the dump.
 *  `existingNumbers` are volume_number strings already known locally; only strictly
 *  newer numbered volumes (vol_sort greater than the local max) whose creator
 *  matches are returned. Propagates fetch errors so the caller avoids caching them. */
async function probeNewerVolumes(
  name: string,
  creator: string,
  existingNumbers: Set<string>,
  maxSort: number,
  fmt: NumFmt,
  exclude: boolean
): Promise<SupplementVolume[]> {
  const rows = await queryTankobonByName(name, exclude);

  // Group by volume_number: collect creator literals (a book carries several) and
  // every ISBN (通常版/重版) so we can later pick whichever has a cover.
  const byVol = new Map<
    string,
    { isbns: Set<string>; creators: Set<string>; publisher: string; date: string }
  >();
  for (const b of rows) {
    const isbn = liveIsbn(b.isbn?.value);
    const vol = b.vol?.value;
    if (!isbn || !vol) continue;
    let g = byVol.get(vol);
    if (!g) {
      g = { isbns: new Set(), creators: new Set(), publisher: "", date: "" };
      byVol.set(vol, g);
    }
    g.isbns.add(isbn);
    if (b.creator?.value) g.creators.add(cleanCreator(b.creator.value));
    if (b.publisher?.value && !g.publisher) g.publisher = b.publisher.value.split(/[／∥]/)[0].trim();
    if (b.date?.value && !g.date) g.date = b.date.value;
  }

  const out: SupplementVolume[] = [];
  for (const [vol, g] of byVol) {
    if (!matchesFmt(vol, fmt)) continue; // only the series' own numbering style
    if (existingNumbers.has(vol)) continue; // already in the dump
    if (!g.creators.has(creator)) continue; // strict: same title AND same author
    const sort = volSort(vol);
    if (sort <= maxSort) continue; // only append the missing tail, never insert mid-series
    const isbns = [...g.isbns];
    out.push({
      isbn: isbns[0],
      isbns,
      volume_number: vol,
      vol_sort: sort,
      title: name,
      author: creator,
      publisher: g.publisher,
      pubdate: g.date,
    });
  }
  out.sort((a, b) => a.vol_sort - b.vol_sort);
  return out;
}

/** Supplement volumes for a series, cached in D1 with a monthly TTL. On cache miss
 *  it probes live MADB once; failures cache nothing so the next open retries. */
export async function getSupplementVolumes(
  env: Env,
  seriesId: string,
  name: string,
  creator: string,
  existingNumbers: Set<string>,
  maxSort: number,
  fmt: NumFmt,
  // The 取得 button is an explicit user request to refresh, so it bypasses the TTL
  // and always re-probes (updating checked_at). The TTL still short-circuits any
  // non-forced caller.
  force = false
): Promise<SupplementVolume[]> {
  if (!creator) return []; // creator match is required; nothing safe to do without it

  const now = Date.now();
  const cached = await env.DB.prepare(
    `SELECT volumes_json, checked_at FROM series_supplement WHERE series_id = ?`
  )
    .bind(seriesId)
    .first<{ volumes_json: string; checked_at: number }>();
  if (!force && cached && now - cached.checked_at < CACHE_TTL_MS) {
    try {
      return JSON.parse(cached.volumes_json) as SupplementVolume[];
    } catch {
      // fall through and re-probe on corrupt cache
    }
  }

  let vols: SupplementVolume[];
  try {
    vols = await probeNewerVolumes(name, creator, existingNumbers, maxSort, fmt, excludeAdult(env));
  } catch {
    return cached ? (safeParse(cached.volumes_json) ?? []) : [];
  }

  await env.DB.prepare(
    `INSERT OR REPLACE INTO series_supplement (series_id, volumes_json, checked_at) VALUES (?, ?, ?)`
  )
    .bind(seriesId, JSON.stringify(vols), now)
    .run();
  return vols;
}

function safeParse(s: string): SupplementVolume[] | null {
  try {
    return JSON.parse(s) as SupplementVolume[];
  } catch {
    return null;
  }
}

/** Supplement volumes already cached for a series, or null if it was never probed.
 *  Used by the default (button-less) volume read, which must never hit the network:
 *  it merges whatever a previous probe stored and nothing more. */
export async function readCachedSupplement(
  env: Env,
  seriesId: string
): Promise<{ volumes: SupplementVolume[]; checkedAt: number } | null> {
  const row = await env.DB.prepare(
    `SELECT volumes_json, checked_at FROM series_supplement WHERE series_id = ?`
  )
    .bind(seriesId)
    .first<{ volumes_json: string; checked_at: number }>();
  if (!row) return null;
  return { volumes: safeParse(row.volumes_json) ?? [], checkedAt: row.checked_at };
}

/** Record that a series was probed even when it isn't supplement-eligible (no
 *  creator / mixed numbering / same-name ambiguity), so the search "＋未確認"
 *  marker clears once the user presses 取得. Stores an empty list and never
 *  clobbers a real one (an eligible probe's INSERT OR REPLACE overwrites this). */
export async function markSupplementProbed(env: Env, seriesId: string): Promise<void> {
  // Advance checked_at on every probe (so "最終確認" reflects the latest check) but
  // keep any real list a prior eligible probe stored — only the timestamp is updated.
  await env.DB.prepare(
    `INSERT INTO series_supplement (series_id, volumes_json, checked_at) VALUES (?, '[]', ?)
       ON CONFLICT(series_id) DO UPDATE SET checked_at = excluded.checked_at`
  )
    .bind(seriesId, Date.now())
    .run();
}
