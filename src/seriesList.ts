import { Env } from "./types";
import { json, seriesNameSql } from "./util";
import { getSeriesVolumes } from "./series";
import { edgeCacheKey, withEdgeCache } from "./edgeCache";

// シリーズ一覧ページ（/series、巻数の多い順）の API と、その元になる series_stats を
// 埋める cron の数え直し。
//
// ── 数え直し（runSeriesStatsBatch）──────────────────────────────────────────
// series_stats は巻一覧を開いたときにも書かれる（src/seriesStats.ts）が、開かれたことの無い
// シリーズは行が無いので、cron（STATS_CRON、2 分ごと）で巻数の多いシリーズから順に巻一覧を
// 組み立てて埋める。巻一覧 1 本で D1 を 20 本前後（巻数の多いシリーズは表紙の読み出しが分かれて
// もっと）引くので、1 回の起動（D1 クエリ上限 1000）で回すのは BATCH 本まで。周回は巻数の多い
// 順に始まるので、最初の数回がいちばん重い。2 分ごと × 20 本 = 1 日 1.4 万本で、巻数 2 以上の
// 約 4.7 万本を 3〜4 日で 1 周する。1 巻物（約 9 万本）は回さない（数え方でほぼ食い違わず、
// 開かれたときに埋まる）。
//
// 進み具合（cursor）は数え始める前に書く。上限に当たるなどで起動の途中で落ちても、次の起動は
// 先へ進む（同じ BATCH 本で詰まり続けない）。取りこぼした本は、開かれたときか次の周回で埋まる。
//
// 進み具合は meta の series_stats_pass に持つ。1 周し終えたら止まり、マスタが取り込み直された
// （meta imported_at が周回の開始より新しい）ら頭からもう 1 周する。止まっている間の起動は
// meta を 2 回読むだけ。

export const STATS_CRON = "*/2 * * * *";
const PASS_KEY = "series_stats_pass";
const BATCH = 20;
/** 数え直す下限の巻数（series.num_items）。1 巻物は回さない。 */
const MIN_NUM_ITEMS = 2;

interface StatsPass {
  cursor: string; // "<num_items>:<id>"（キーセット法。src/warm.ts seriesPage と同じ）
  started_at: number;
  finished_at: number; // 0 = 周回中
  done: number; // この周回で数えにいったシリーズ数
}

async function readMeta(env: Env, key: string): Promise<string | null> {
  const r = await env.DB.prepare(`SELECT value FROM meta WHERE key = ?`).bind(key).first<{ value: string }>();
  return r?.value ?? null;
}

async function writePass(env: Env, p: StatsPass): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
    .bind(PASS_KEY, JSON.stringify(p))
    .run();
}

export async function readStatsPass(env: Env): Promise<StatsPass | null> {
  try {
    const raw = await readMeta(env, PASS_KEY);
    return raw ? (JSON.parse(raw) as StatsPass) : null;
  } catch {
    return null;
  }
}

/** 数え直しの 1 歩。周回中なら次の BATCH 本の巻一覧を組み立てて series_stats を埋める。 */
export async function runSeriesStatsBatch(
  env: Env,
  now = Date.now(),
  batch = BATCH
): Promise<{ ran: number; finished: boolean; idle: boolean }> {
  const importedAt = Number((await readMeta(env, "imported_at")) || 0);
  let pass = await readStatsPass(env);
  if (!pass || (pass.finished_at && importedAt > pass.started_at)) {
    pass = { cursor: "", started_at: now, finished_at: 0, done: 0 };
  } else if (pass.finished_at) {
    return { ran: 0, finished: true, idle: true };
  }

  const [numRaw, idRaw] = pass.cursor.split(":");
  const fromNum = pass.cursor && Number.isFinite(Number(numRaw)) ? Number(numRaw) : Number.MAX_SAFE_INTEGER;
  const rows =
    (
      await env.DB.prepare(
        `SELECT id, num_items FROM series
          WHERE num_items >= ?4 AND (num_items < ?1 OR (num_items = ?1 AND id > ?2))
          ORDER BY num_items DESC, id LIMIT ?3`
      )
        .bind(fromNum, idRaw ?? "", batch, MIN_NUM_ITEMS)
        .all<{ id: string; num_items: number }>()
    ).results ?? [];

  const last = rows[rows.length - 1];
  const finished = rows.length < batch;
  await writePass(env, {
    cursor: last ? `${last.num_items}:${last.id}` : pass.cursor,
    started_at: pass.started_at,
    finished_at: finished ? now : 0,
    done: pass.done + rows.length,
  });

  let ran = 0;
  for (const r of rows) {
    try {
      // 巻一覧を組み立てるだけで series_stats に書かれる（src/series.ts → recordSeriesStats）。
      const res = await getSeriesVolumes(env, r.id);
      await res.body?.cancel();
      ran++;
    } catch (err) {
      console.error("series stats: volumes failed", r.id, err);
    }
  }
  return { ran, finished, idle: false };
}

// ── シリーズ一覧 API（GET /api/series-list）──────────────────────────────────

const PAGE = 60;
const LIST_EDGE_TTL_SEC = 300;

export interface SeriesListEntry {
  rank: number;
  series_id: string;
  title: string;
  version: string;
  creator: string;
  publisher: string;
  label: string;
  vol_count: number;
  complete: boolean;
  isbn: string;
  cover_url: string;
  last_pubdate: string;
}

/** 巻数の多い順。cursor は "<vol_count>:<series_id>:<次の並び番号>:<前ページ末尾の順位>"。同じ巻数は同じ順位にする
 *  （順位 = 自分より巻数の多いシリーズの数 + 1）。結合で吸収された側は出さない。 */
export async function handleSeriesList(env: Env, url: URL): Promise<Response> {
  const cursor = (url.searchParams.get("cursor") ?? "").slice(0, 80);
  return withEdgeCache(edgeCacheKey(env, "/api/series-list", { cursor }), LIST_EDGE_TTL_SEC, async () => {
    const [numRaw, idRaw = "", posRaw, rankRaw] = cursor.split(":");
    const fromNum = cursor && Number.isFinite(Number(numRaw)) ? Number(numRaw) : Number.MAX_SAFE_INTEGER;
    const startPos = Math.max(1, Number(posRaw) || 1);
    const rows =
      (
        await env.DB.prepare(
          `SELECT st.series_id, st.vol_count, st.complete_run, st.first_isbn, st.last_pubdate,
                  ${seriesNameSql("s", "o")} AS name, s.version, s.creator, s.publisher, s.label,
                  COALESCE(c.cover_url, '') AS cover_url
             FROM series_stats st
             JOIN series s ON s.id = st.series_id
             LEFT JOIN series_name_override o ON o.series_id = s.id
             LEFT JOIN covers c ON c.isbn = st.first_isbn
            WHERE (st.vol_count < ?1 OR (st.vol_count = ?1 AND st.series_id > ?2))
              AND NOT EXISTS (SELECT 1 FROM series_merge m WHERE m.absorbed_id = st.series_id)
            ORDER BY st.vol_count DESC, st.series_id
            LIMIT ?3`
        )
          .bind(fromNum, idRaw, PAGE + 1)
          .all<{
            series_id: string;
            vol_count: number;
            complete_run: number;
            first_isbn: string;
            last_pubdate: string;
            name: string;
            version: string | null;
            creator: string | null;
            publisher: string | null;
            label: string | null;
            cover_url: string;
          }>()
      ).results ?? [];
    const page = rows.slice(0, PAGE);

    // 順位: ページ先頭が前ページ末尾と同じ巻数なら、その順位を引き継ぐ（cursor に前ページ末尾の
    // 巻数と順位が入っている）。巻数が変わったところで並び番号に追いつく。
    let prevCount = cursor && Number.isFinite(Number(numRaw)) ? Number(numRaw) : -1;
    let prevRank = Number(rankRaw) || 0;
    const entries: SeriesListEntry[] = page.map((r, i) => {
      const pos = startPos + i;
      const rank = r.vol_count === prevCount && prevRank ? prevRank : pos;
      prevCount = r.vol_count;
      prevRank = rank;
      return {
        rank,
        series_id: r.series_id,
        title: r.name,
        version: r.version ?? "",
        creator: r.creator ?? "",
        publisher: r.publisher ?? "",
        label: r.label ?? "",
        vol_count: r.vol_count,
        complete: r.complete_run > 0,
        isbn: r.first_isbn,
        cover_url: r.cover_url,
        last_pubdate: r.last_pubdate,
      };
    });
    const last = page[page.length - 1];
    const next =
      rows.length > PAGE && last
        ? `${last.vol_count}:${last.series_id}:${startPos + page.length}:${entries[entries.length - 1].rank}`
        : null;
    return json(
      { entries, next },
      200,
      { "cache-control": "public, max-age=300" }
    );
  });
}

// ── 管理画面（巻数の集計のページ）──────────────────────────────────────────

/** GET /api/admin/series-stats。集計の埋まり具合と、数え直しの周回の状態。 */
export async function adminSeriesStatsStatus(env: Env): Promise<Response> {
  const importedAt = Number((await readMeta(env, "imported_at")) || 0);
  const r = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM series_stats) AS rows,
            (SELECT COUNT(*) FROM series_stats WHERE computed_at >= ?1) AS fresh,
            (SELECT COUNT(*) FROM series_stats WHERE complete_run > 0) AS complete,
            (SELECT COUNT(*) FROM series WHERE num_items >= ?2) AS target`
  )
    .bind(importedAt, MIN_NUM_ITEMS)
    .first<{ rows: number; fresh: number; complete: number; target: number }>();
  return json(
    {
      rows: r?.rows ?? 0,
      fresh: r?.fresh ?? 0,
      complete: r?.complete ?? 0,
      target: r?.target ?? 0,
      batch: BATCH,
      cron: STATS_CRON,
      imported_at: importedAt || null,
      pass: await readStatsPass(env),
    },
    200,
    { "cache-control": "no-store" }
  );
}

/** POST /api/admin/series-stats/step。cron と同じ 1 歩を今すぐ回す（初回の埋め込みを早めたいとき、
 *  管理画面の「続けて回す」が繰り返し叩く）。restart=1 なら周回を頭からやり直してから回す。 */
export async function adminSeriesStatsStep(env: Env, url: URL): Promise<Response> {
  if (url.searchParams.get("restart") === "1") await env.DB.prepare(`DELETE FROM meta WHERE key = ?`).bind(PASS_KEY).run();
  const r = await runSeriesStatsBatch(env);
  return json({ ...r, pass: await readStatsPass(env) }, 200, { "cache-control": "no-store" });
}
