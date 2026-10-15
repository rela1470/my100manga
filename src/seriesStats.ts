import { Env } from "./types";
import { plainVolumeNumber } from "./util";

// シリーズの巻数の集計（series_stats, db/add-series-stats.sql）の計算と書き込み。
//
// 巻一覧（src/series.ts getSeriesVolumes）が組み立てた結果からそのまま数えるので、検索カードの
// 数え方（src/search.ts VOL_COUNT、volumes 表だけ）では漏れる迷子巻・補完・手動追加・結合・
// 非表示まで、利用者が巻一覧で見る数と一致する。書くのは巻一覧を組み立てたときと、
// cron の数え直し（src/seriesList.ts）。

export interface StatsVolume {
  isbn: string;
  volume_number: string;
  pubdate?: string;
}

export interface SeriesStats {
  vol_count: number;
  complete_run: number;
  first_isbn: string;
  last_pubdate: string;
}

/** 巻番号が 1..k で欠けなく、重複なくそろっているか。1 巻物は巻番号が空でもよい。 */
export function isCompleteRun(volumes: { volume_number: string; isbn: string }[], k: number): boolean {
  if (volumes.length !== k || k < 1) return false;
  if (volumes.some((v) => !v.isbn)) return false;
  if (k === 1) {
    const vn = (volumes[0].volume_number ?? "").trim();
    return !vn || plainVolumeNumber(vn) === 1;
  }
  const seen = new Set<number>();
  for (const v of volumes) {
    const n = plainVolumeNumber(v.volume_number ?? "");
    if (n === null || n < 1 || n > k || seen.has(n)) return false;
    seen.add(n);
  }
  return seen.size === k;
}

export function computeSeriesStats(volumes: StatsVolume[]): SeriesStats {
  const n = volumes.length;
  let last = "";
  for (const v of volumes) if ((v.pubdate ?? "") > last) last = v.pubdate ?? "";
  return {
    vol_count: n,
    complete_run: n > 0 && isCompleteRun(volumes, n) ? n : 0,
    first_isbn: volumes[0]?.isbn ?? "",
    last_pubdate: last,
  };
}

/** 巻一覧の結果を series_stats に書く。値が変わったときと、取り込み（meta imported_at）より
 *  古い行だけを書き換える（人気のシリーズは巻一覧が 1 分ごとに組み直されるので、毎回は書かない）。
 *  表がまだ無い DB（マイグレーション前）でも巻一覧を止めないよう、失敗は握りつぶす。 */
export async function recordSeriesStats(
  env: Env,
  seriesId: string,
  volumes: StatsVolume[],
  now = Date.now()
): Promise<void> {
  if (!seriesId || seriesId.startsWith("G")) return; // まとまり（G<ISBN>）はシリーズではない
  const s = computeSeriesStats(volumes);
  try {
    await env.DB.prepare(
      `INSERT INTO series_stats (series_id, vol_count, complete_run, first_isbn, last_pubdate, computed_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(series_id) DO UPDATE SET
         vol_count = excluded.vol_count, complete_run = excluded.complete_run,
         first_isbn = excluded.first_isbn, last_pubdate = excluded.last_pubdate,
         computed_at = excluded.computed_at
       WHERE series_stats.vol_count <> excluded.vol_count
          OR series_stats.complete_run <> excluded.complete_run
          OR series_stats.first_isbn <> excluded.first_isbn
          OR series_stats.last_pubdate <> excluded.last_pubdate
          OR series_stats.computed_at < COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'imported_at'), 0)`
    )
      .bind(seriesId, s.vol_count, s.complete_run, s.first_isbn, s.last_pubdate, now)
      .run();
  } catch (err) {
    console.error("series_stats write failed", seriesId, err);
  }
}
