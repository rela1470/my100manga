import { Env } from "./types";

// 全件集計の結果を meta テーブルに JSON で materialize する読み取り時キャッシュ（ランキング・
// 収録数）。TTL が切れた瞬間に来た要求がそろって再計算する（スタンピード）のを避けるため:
//   ・TTL 切れを見つけた要求は、計算時刻の行を「読んだ値のままなら今の時刻に書き換える」条件付き
//     UPDATE で取り合う。勝った 1 件だけが再計算し、負けた要求は古い結果をそのまま返す。
// （同じ isolate 内で Promise を共有する手もあるが、Workers では別リクエストの I/O を待つと
//   取り消されることがあるので使わない。）
// 結果がまだ一度も無いとき（初回）は待つしかないので、全員が計算する（その 1 回だけ）。
// ctx を渡すと、取り合いに勝った要求も古い結果をすぐ返し、再計算は waitUntil で裏で行う
// （重い集計の間ユーザを待たせない）。

interface Keys {
  json: string; // 結果 JSON を入れる meta.key
  at: string; // 計算時刻 (epoch ms) を入れる meta.key
}

async function store(env: Env, keys: Keys, value: string, at: number): Promise<void> {
  const upsert = `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
  await env.DB.batch([
    env.DB.prepare(upsert).bind(keys.json, value),
    env.DB.prepare(upsert).bind(keys.at, String(at)),
  ]);
}

/** meta に materialize した compute() の結果を返す。TTL 切れなら 1 要求だけが再計算する。 */
export async function readMaterialized<T>(
  env: Env,
  keys: Keys,
  ttlMs: number,
  compute: () => Promise<T>,
  ctx?: { waitUntil(p: Promise<unknown>): void }
): Promise<T> {
  const rows = await env.DB.prepare(`SELECT key, value FROM meta WHERE key IN (?, ?)`)
    .bind(keys.json, keys.at)
    .all<{ key: string; value: string }>();
  const atRaw = rows.results?.find((r) => r.key === keys.at)?.value ?? null;
  const jsonRaw = rows.results?.find((r) => r.key === keys.json)?.value ?? null;
  let cached: T | null = null;
  if (jsonRaw !== null) {
    try {
      cached = JSON.parse(jsonRaw) as T;
    } catch {
      cached = null; // 壊れていたら初回と同じく作り直す
    }
  }
  const now = Date.now();
  const at = atRaw ? Number(atRaw) : 0;
  if (cached !== null && at && now - at < ttlMs) return cached;

  if (cached !== null && atRaw !== null) {
    // 古い結果がある: 計算時刻の行を取り合い、負けたら古い結果を返す。
    const claim = await env.DB.prepare(`UPDATE meta SET value = ? WHERE key = ? AND value = ?`)
      .bind(String(now), keys.at, atRaw)
      .run();
    if (!claim.meta?.changes) return cached;
    if (ctx) {
      const stale = cached;
      ctx.waitUntil(
        compute()
          .then((value) => store(env, keys, JSON.stringify(value), Date.now()))
          .catch((err) => console.error("materialized recompute failed", keys.json, err))
      );
      return stale;
    }
  }

  try {
    const value = await compute();
    await store(env, keys, JSON.stringify(value), Date.now());
    return value;
  } catch (err) {
    // 再計算に失敗しても古い結果があれば出す（計算時刻は取り合いで進めてあるので、次の再試行は
    // TTL 後。失敗が続く間に毎要求で重い集計を繰り返さないため）。
    if (cached !== null) {
      console.error("materialized recompute failed", keys.json, err);
      return cached;
    }
    throw err;
  }
}
