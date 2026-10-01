import { Env } from "./types";
import { badRequest, json, notFound } from "./util";
import { readCachedCovers, resolveCovers } from "./covers";

// A correction volume as merged into the series volume list. title/author are filled
// from the series row by the caller, not stored, so they always track the master.
export interface CorrectionVolume {
  isbn: string;
  volume_number: string;
  vol_sort: number;
  cover_url: string;
}

// Tunable: at most this many manual corrections per series. A light abuse cap for
// the accountless public write path (POST /api/series/:id/corrections). Normal use
// only needs a few (欠番埋め; ONE PIECE でも巻110 の1件だけ) so 20 is well above the
// legitimate ceiling while keeping a single series from being flooded.
const MAX_CORRECTIONS = 20;

/** Standard tankobon labels we accept for a correction ("巻110" or "110"). Anything
 *  else is rejected: arc labels etc. can't be numerically placed and invite noise. */
function normalizeVolume(raw: string): string | null {
  const v = raw.trim();
  return /^巻\d+$/.test(v) || /^\d+$/.test(v) ? v : null;
}

function volSort(s: string): number {
  const m = s.match(/\d+/);
  return m ? parseInt(m[0], 10) : 0;
}

/** Strip separators and keep digits; a valid ISBN13 is exactly 13 digits. */
function normalizeIsbn(raw: string): string | null {
  const d = raw.replace(/[^0-9]/g, "");
  return d.length === 13 ? d : null;
}

/** Only accept http(s) image URLs (mirrors lists.ts normalizeCover) so a suggestion
 *  can never smuggle a javascript:/data: URL into the global covers cache on approve. */
function normalizeCoverUrl(raw: string): string | null {
  const u = raw.trim();
  return /^https?:\/\//i.test(u) && u.length <= 500 ? u : null;
}

/** Cached corrections for a series, ready to merge into the volume list. Reported
 *  corrections stay here: a "間違っています" report is hidden only in the reporter's own
 *  browser (localStorage) and stays public for everyone else until an admin purges. */
export async function getCorrectionVolumes(env: Env, seriesId: string): Promise<CorrectionVolume[]> {
  const res = await env.DB.prepare(
    `SELECT isbn, volume_number, vol_sort, cover_url
       FROM series_correction WHERE series_id = ? ORDER BY vol_sort, isbn`
  )
    .bind(seriesId)
    .all<CorrectionVolume>();
  return res.results ?? [];
}

/** POST /api/series/:id/corrections — add a manually-found missing volume. Accepts
 *  only { isbn, volume_number }; the cover is re-resolved server-side and must exist
 *  (rejects fabricated ISBNs), so no client-supplied strings or images are trusted. */
export async function addCorrection(request: Request, env: Env, seriesId: string): Promise<Response> {
  const meta = await env.DB.prepare(`SELECT id, name, creator FROM series WHERE id = ?`)
    .bind(seriesId)
    .first<{ id: string; name: string; creator: string | null }>();
  if (!meta) return notFound("シリーズが見つかりません");

  const body = (await request.json().catch(() => ({}))) as { isbn?: unknown; volume_number?: unknown };
  const isbn = typeof body.isbn === "string" ? normalizeIsbn(body.isbn) : null;
  const volume = typeof body.volume_number === "string" ? normalizeVolume(body.volume_number) : null;
  if (!isbn) return badRequest("ISBN13 を指定してください");
  if (!volume) return badRequest("巻番号は「巻N」または「N」の形式で指定してください");

  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM series_correction WHERE series_id = ?`
  )
    .bind(seriesId)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_CORRECTIONS) {
    return badRequest("このシリーズの手動追加が上限に達しています");
  }

  // Require a real cover so a fabricated ISBN can't be injected into the master.
  const cover = (await resolveCovers(env, [isbn])).get(isbn) ?? "";
  if (!cover) return badRequest("この ISBN の書影が見つかりませんでした");

  const vol_sort = volSort(volume);
  await env.DB.prepare(
    `INSERT OR REPLACE INTO series_correction
       (series_id, isbn, volume_number, vol_sort, cover_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(seriesId, isbn, volume, vol_sort, cover, Date.now())
    .run();

  return json(
    {
      volume: {
        isbn,
        isbns: [isbn],
        volume_number: volume,
        vol_sort,
        title: meta.name,
        author: meta.creator ?? "",
        publisher: "",
        label: "",
        pubdate: "",
        cover_url: cover,
      },
    },
    200,
    { "cache-control": "no-store" }
  );
}

// A light abuse cap on how many distinct cover suggestions we keep per ISBN. A book
// only has a handful of legitimate cover variants; beyond this we stop recording new
// ones (existing ones still bump their count) so one ISBN can't be flooded with junk.
const MAX_COVER_SUGGESTIONS_PER_ISBN = 10;

/** User-submitted cover URL flow. Off by default — letting accountless visitors post
 *  arbitrary image URLs into the review queue (and, on approve, the global covers
 *  cache) is too high a vandalism risk. Set COVER_SUGGESTIONS_ENABLED="true" (or "1")
 *  to re-enable. The code stays wired up so it can be turned back on later. */
export function coverSuggestionsEnabled(env: Env): boolean {
  return env.COVER_SUGGESTIONS_ENABLED === "true" || env.COVER_SUGGESTIONS_ENABLED === "1";
}

/** POST /api/cover-suggestions — collect a user-chosen cover that differs from the
 *  global cache. When a list editor uses 「表紙を変更」to fix a wrong/missing cover,
 *  that URL is only saved into their own list (items_json), so the master covers cache
 *  and everyone else's view keep the old cover. We queue the pick here for admin review;
 *  on approve the admin overwrites the covers cache so the fix propagates to everyone.
 *  Nothing is auto-applied — same "collect only, admin finalizes" policy as volume
 *  reports. Only { isbn, cover_url } is trusted; both are validated and a pick that
 *  already equals the cached cover is ignored (no correction needed). */
export async function suggestCover(request: Request, env: Env): Promise<Response> {
  // Kill switch (default off): accept silently without queuing so the client's local
  // cover change still works, but no user-supplied URL ever reaches the review queue
  // or the global covers cache. This is the authoritative boundary — a direct POST
  // can't bypass it. See coverSuggestionsEnabled.
  if (!coverSuggestionsEnabled(env)) {
    return json({ ok: true, queued: false }, 200, { "cache-control": "no-store" });
  }

  const body = (await request.json().catch(() => ({}))) as { isbn?: unknown; cover_url?: unknown };
  const isbn = typeof body.isbn === "string" ? normalizeIsbn(body.isbn) : null;
  const coverUrl = typeof body.cover_url === "string" ? normalizeCoverUrl(body.cover_url) : null;
  if (!isbn) return badRequest("ISBN13 を指定してください");
  if (!coverUrl) return badRequest("表紙URLが不正です");

  // Compare against the current cache. If the pick matches what everyone already sees,
  // there's nothing to correct — accept silently so the client can fire freely.
  const cached = (await readCachedCovers(env, [isbn])).get(isbn);
  if (cached !== undefined && cached === coverUrl) {
    return json({ ok: true, queued: false }, 200, { "cache-control": "no-store" });
  }

  // New (isbn, cover_url) pairs are capped; an already-queued pair just bumps its count.
  const existing = await env.DB.prepare(
    `SELECT 1 FROM cover_suggestion WHERE isbn = ? AND cover_url = ?`
  )
    .bind(isbn, coverUrl)
    .first();
  if (!existing) {
    // Cap only against pending picks — resolved history doesn't count toward the limit.
    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM cover_suggestion WHERE isbn = ? AND resolved_at = 0`
    )
      .bind(isbn)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_COVER_SUGGESTIONS_PER_ISBN) {
      return json({ ok: true, queued: false }, 200, { "cache-control": "no-store" });
    }
  }

  const now = Date.now();
  // A re-suggest of a previously-resolved pick reopens it (resolved_at/resolution reset),
  // so an issue that recurs after being handled comes back to the admin queue.
  await env.DB.prepare(
    `INSERT INTO cover_suggestion (isbn, cover_url, old_cover_url, suggest_count, first_at, last_at)
     VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT (isbn, cover_url) DO UPDATE SET
       suggest_count = suggest_count + 1,
       last_at = excluded.last_at,
       resolved_at = 0,
       resolution = ''`
  )
    .bind(isbn, coverUrl, cached ?? "", now, now)
    .run();

  return json({ ok: true, queued: true }, 200, { "cache-control": "no-store" });
}

/** POST /api/series/:id/report — flag the SERIES NAME as wrong (e.g. a corrupt master
 *  title like "ｖ" for ハレグゥ). Mirrors reportVolume's collect-only policy: it does NOT
 *  rewrite the name globally, only bumps report_count (+timestamps) in series_report for
 *  the admin audit. Nothing is trusted from the client — the name snapshot is read from
 *  the series row server-side. The admin later 却下 (deletes) or 名前修正 (writes an
 *  override applied at read time). Repeated flags just bump the count. */
export async function reportSeriesName(_request: Request, env: Env, seriesId: string): Promise<Response> {
  const meta = await env.DB.prepare(`SELECT id, name FROM series WHERE id = ?`)
    .bind(seriesId)
    .first<{ id: string; name: string }>();
  if (!meta) return notFound("シリーズが見つかりません");

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO series_report
       (series_id, reported_name, report_count, first_reported_at, last_reported_at)
     VALUES (?, ?, 1, ?, ?)
     ON CONFLICT (series_id) DO UPDATE SET
       report_count = report_count + 1,
       last_reported_at = excluded.last_reported_at,
       reported_name = excluded.reported_name`
  )
    .bind(seriesId, meta.name ?? "", now, now)
    .run();

  return json({ ok: true }, 200, { "cache-control": "no-store" });
}

/** POST /api/series/:id/corrections/report — flag ANY volume as wrong. Works for user
 *  corrections AND master/live-supplement volumes, since the master data can be wrong
 *  too. A report does NOT hide the row globally: it only bumps report_count (+timestamps)
 *  in volume_report for the admin audit, and the reporter's own browser hides it locally.
 *  The volume stays public for everyone else until an admin finalizes. Repeated flags
 *  just bump the count. Only the ISBN is trusted from the client; the volume label is a
 *  best-effort server-side snapshot (empty if the volume isn't in a table we can read). */
export async function reportVolume(request: Request, env: Env, seriesId: string): Promise<Response> {
  const meta = await env.DB.prepare(`SELECT id FROM series WHERE id = ?`)
    .bind(seriesId)
    .first<{ id: string }>();
  if (!meta) return notFound("シリーズが見つかりません");

  const body = (await request.json().catch(() => ({}))) as { isbn?: unknown };
  const isbn = typeof body.isbn === "string" ? normalizeIsbn(body.isbn) : null;
  if (!isbn) return badRequest("ISBN13 を指定してください");

  // Best-effort label snapshot for the admin view: prefer the master volume row, then
  // a user correction. Live-supplement volumes aren't stored per-row, so they stay "".
  const vol =
    (await env.DB.prepare(`SELECT volume_number FROM volumes WHERE isbn = ?`)
      .bind(isbn)
      .first<{ volume_number: string | null }>()) ??
    (await env.DB.prepare(
      `SELECT volume_number FROM series_correction WHERE series_id = ? AND isbn = ?`
    )
      .bind(seriesId, isbn)
      .first<{ volume_number: string | null }>());
  const label = vol?.volume_number ?? "";

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO volume_report
       (series_id, isbn, volume_number, report_count, first_reported_at, last_reported_at)
     VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT (series_id, isbn) DO UPDATE SET
       report_count = report_count + 1,
       last_reported_at = excluded.last_reported_at,
       volume_number = CASE WHEN volume_report.volume_number = '' THEN excluded.volume_number
                            ELSE volume_report.volume_number END`
  )
    .bind(seriesId, isbn, label, now, now)
    .run();

  return json({ ok: true }, 200, { "cache-control": "no-store" });
}

/** POST /api/volume-title-reports — flag a VOLUME'S TITLE as wrong (本のタイトルが違う？).
 *  Book titles are per-volume schema:name; variant-title splits make some volumes carry an
 *  odd title. Mirrors reportVolume's collect-only policy: does NOT rewrite the title
 *  globally, only bumps report_count (+timestamps) in volume_title_report for the admin
 *  audit; the reporter's own browser suppresses nothing (title is normalized at read time).
 *  Only the ISBN is trusted from the client — series_id and the title snapshot are read
 *  server-side from the master volumes row (empty if unknown). Admin later 却下 or
 *  修正 (writes volume_title_override / snaps to the series' most-common title). */
export async function reportVolumeTitle(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { isbn?: unknown };
  const isbn = typeof body.isbn === "string" ? normalizeIsbn(body.isbn) : null;
  if (!isbn) return badRequest("ISBN13 を指定してください");

  // Resolve series + current master title snapshot server-side (never trust the client).
  const vol = await env.DB.prepare(`SELECT series_id, title FROM volumes WHERE isbn = ?`)
    .bind(isbn)
    .first<{ series_id: string | null; title: string | null }>();
  const seriesId = vol?.series_id ?? "";
  const reportedTitle = vol?.title ?? "";

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO volume_title_report
       (isbn, series_id, reported_title, report_count, first_reported_at, last_reported_at)
     VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT (isbn) DO UPDATE SET
       report_count = report_count + 1,
       last_reported_at = excluded.last_reported_at,
       series_id = CASE WHEN volume_title_report.series_id = '' THEN excluded.series_id
                        ELSE volume_title_report.series_id END,
       reported_title = excluded.reported_title`
  )
    .bind(isbn, seriesId, reportedTitle, now, now)
    .run();

  return json({ ok: true }, 200, { "cache-control": "no-store" });
}
