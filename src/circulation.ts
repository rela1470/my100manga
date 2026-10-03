import { Env } from "./types";
import { badRequest, json, notFound } from "./util";
import { edgeCacheKey, withEdgeCache } from "./edgeCache";
import { headWord, latestSeriesCover, resolveTargets, workKey, type WorkRef } from "./salesRanking";
import { resolveUnit } from "./merge";

// 発行部数ランキング。英語版 Wikipedia「List of best-selling manga」（累計 2000 万部以上の
// 約 200 作品）から取り込んだ累計発行部数を部数の降順で出す（circulation 表、取り込みは
// scripts/wikipedia-circulation.mjs → db/circulation-data.sql）。
//
// 売上ランキング（src/salesRanking.ts）が「いま売れている」直近の実測なのに対して、こちらは
// 出版社が発表した累計で、完結した定番も入る。性質が違うので別ページ・別集計にしてある。
//
// 作品 → 巻一覧へのリンクは、管理画面で確定した指定（circulation_link）があればそれ、無ければ
// 売上ランキングと同じ resolveTargets による作品名からの自動照合。元データがほとんど動かない
// ので、既定のデータ（db/circulation-links.sql）では自動照合の結果を 'suggested' として
// 入れてあり、間違っているものだけ管理画面で直す運用にしている。結果は meta に materialize する。集計は重い（200 作品 ×
// シリーズ検索）が、元データが変わるのは取り込み直したときだけなので、TTL では更新せず
// 管理画面の再集計か、meta が空のときの初回だけ計算する。
//
// ライセンス: 取り込んでいるのは作品名・著者・出版社・部数・時点という事実の列だけで、
// Wikipedia の文章は持ち込んでいない。表示側（public/circulation.html）に出典・CC BY-SA 4.0・
// 改変の明示を出す。/terms の無断複製の禁止からもこの表の内容を適用除外にしてある。

const META_JSON_KEY = "circulation_ranking_json";
const CHUNK = 90; // D1 の bind 上限よけ（salesRanking と同じ）
const META_SOURCE_KEY = "circulation_source";

export interface CirculationEntry {
  rank: number;
  title: string; // 日本語の作品名
  title_en: string;
  author: string; // 著者（Wikipedia のローマ字表記）
  publisher: string;
  copies: number; // 累計発行部数（部）
  as_of: string; // 出典の時点（"2026-03"。空 = 出典に日付が無い）
  series_id: string | null; // 巻一覧を開く先（C-id / U-id / G-id）。寄せ先が無ければ null
  search_q: string; // 寄せ先が無いときの検索語。寄せ先があれば ""
  cover_url: string; // 寄せ先の最新巻の表紙。キャッシュに無ければ ""
  cover_isbn: string; // cover_url が "" のとき /api/covers で引く巻
}

/** 取り込み元（db/circulation-data.sql が meta に入れる）。表示の出典表記に使う。 */
export interface CirculationSource {
  url: string; // 取り込んだ版への固定リンク（Special:PermanentLink/<oldid>）
  page_url: string; // 記事そのもの（最新版）
  title: string;
  revid: number;
  touched: string; // その版の日付 (YYYY-MM-DD)
  retrieved: string; // 取り込んだ日 (YYYY-MM-DD)
  license: string;
  license_url: string;
}

export interface CirculationPayload {
  entries: CirculationEntry[];
  source: CirculationSource | null;
  computed_at: number;
}

interface Row {
  article: string;
  title_ja: string;
  title_en: string;
  author: string;
  publisher: string;
  copies: number;
  as_of: string;
}

async function readSource(env: Env): Promise<CirculationSource | null> {
  const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = ?`)
    .bind(META_SOURCE_KEY)
    .first<{ value: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as CirculationSource;
  } catch {
    return null;
  }
}

interface LinkRow {
  series_id: string; // '' = 寄せない（として確定したもの）
  source: string; // 'suggested' | 'manual'
}

/** 管理画面で確定した寄せ先（circulation_link）。記事名 → 指定。 */
async function readLinks(env: Env): Promise<Map<string, LinkRow>> {
  const r = await env.DB.prepare(`SELECT article, series_id, source FROM circulation_link`).all<{
    article: string;
    series_id: string;
    source: string;
  }>();
  return new Map((r.results ?? []).map((x) => [x.article, { series_id: x.series_id, source: x.source }]));
}

/** circulation 表を部数の降順に読み、各作品をシリーズ（C-id / U-id / G-id）へ寄せて
 *  表紙を付ける。寄せ先が無い作品も順位は出す（リンクは検索結果に向ける）。 */
export async function computeCirculation(env: Env): Promise<CirculationPayload> {
  const r = await env.DB.prepare(
    `SELECT article, title_ja, title_en, author, publisher, copies, as_of
       FROM circulation ORDER BY copies DESC, title_ja`
  ).all<Row>();
  const rows = r.results ?? [];

  // 1. 管理画面で確定した指定。'' は「寄せない」として確定したもの。
  const links = await readLinks(env);
  // 指定先は結合・分離に追従させる（resolveUnit）。ただし resolveUnit は結合を読み替えるだけで
  // シリーズの実在までは見ないので、マスタを取り込み直して消えた C-id / U-id はここで落とす
  // （まとまり G-id は resolveUnit が解決できなければ null を返す）。消えていたら自動照合には
  // 戻さず「指定先が見つからない」として出す ー 勝手に別のシリーズへ寄せると、管理者が直した
  // 判断が黙って覆るため。
  const pinned = new Map<string, string | null>();
  for (const [article, link] of links) {
    pinned.set(article, link.series_id ? await resolveUnit(env, link.series_id) : null);
  }
  const needCheck = [
    ...new Set([...pinned.values()].filter((id): id is string => Boolean(id) && !id!.startsWith("G"))),
  ];
  const alive = new Set<string>();
  for (let i = 0; i < needCheck.length; i += CHUNK) {
    const chunk = needCheck.slice(i, i + CHUNK);
    const r = await env.DB.prepare(
      `SELECT id FROM series WHERE id IN (${chunk.map(() => "?").join(",")})`
    )
      .bind(...chunk)
      .all<{ id: string }>();
    for (const row of r.results ?? []) alive.add(row.id);
  }
  for (const [article, id] of pinned) {
    if (id && !id.startsWith("G") && !alive.has(id)) pinned.set(article, null);
  }

  // 2. 指定の無い作品だけ、作品名から自動で寄せる。寄せのキーは作品名（売上ランキングの
  //    work_norm と同じ正規化）。同名の別作品が並ぶことは無い表だが、キーが衝突したら先
  //    （部数の多い方）を残す。
  const works: WorkRef[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (links.has(row.article)) continue;
    const key = workKey(row.title_ja);
    if (seen.has(key)) continue;
    seen.add(key);
    // 著者はローマ字なのでマスタ（日本語表記）とは一致しない。resolveTargets の著者照合は
    // 「合えば優先」なので空で渡しても害は無く、巻数の多いシリーズが選ばれる。
    works.push({ key, work: row.title_ja, author: "", isbns: [] });
  }
  const targets = works.length ? await resolveTargets(env, works) : new Map<string, string>();

  const idFor = (row: Row): string | null =>
    links.has(row.article) ? (pinned.get(row.article) ?? null) : (targets.get(workKey(row.title_ja)) ?? null);

  // 表紙は寄せ先ごとに 1 回だけ引く。
  const covers = new Map<string, { url: string; isbn: string }>();
  for (const id of new Set(rows.map(idFor).filter((x): x is string => Boolean(x)))) {
    covers.set(id, await latestSeriesCover(env, id));
  }

  const entries: CirculationEntry[] = rows.map((row, i) => {
    const id = idFor(row);
    const cover = id ? covers.get(id) : undefined;
    return {
      rank: i + 1,
      title: row.title_ja,
      title_en: row.title_en,
      author: row.author,
      publisher: row.publisher,
      copies: row.copies,
      as_of: row.as_of,
      series_id: id,
      search_q: id ? "" : headWord(row.title_ja).normalize("NFKC"),
      cover_url: cover?.url ?? "",
      cover_isbn: cover?.url ? "" : (cover?.isbn ?? ""),
    };
  });

  return { entries, source: await readSource(env), computed_at: Date.now() };
}

async function storePayload(env: Env, payload: CirculationPayload): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
    .bind(META_JSON_KEY, JSON.stringify(payload))
    .run();
}

async function readPayload(env: Env): Promise<CirculationPayload | null> {
  const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = ?`)
    .bind(META_JSON_KEY)
    .first<{ value: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as CirculationPayload;
  } catch {
    return null;
  }
}

/** GET /api/circulation。materialize 済みの集計を返す。まだ無ければ（取り込み直後）その場で
 *  集計して保存する。元データは取り込みでしか変わらないので TTL で作り直したりはしない。 */
export async function handleCirculation(env: Env): Promise<Response> {
  return withEdgeCache(
    edgeCacheKey(env, "/api/circulation"),
    300,
    async () => {
      let payload = await readPayload(env);
      if (!payload) {
        payload = await computeCirculation(env);
        if (payload.entries.length) await storePayload(env, payload);
      }
      // 内容がほとんど動かないので長めに持たせる。空（未取り込み）はキャッシュさせない。
      const cache = payload.entries.length ? "public, max-age=3600" : "no-store";
      return json(payload, 200, { "cache-control": cache });
    },
    (res) => res.status === 200 && !(res.headers.get("cache-control") ?? "").includes("no-store")
  );
}

/** 管理画面の 1 行。寄せ先のシリーズ名・巻数まで付けて返す（画面で確かめられるように）。 */
export interface AdminCirculationRow {
  rank: number;
  article: string; // 指定するときのキー
  title: string;
  title_en: string;
  author: string;
  copies: number;
  as_of: string;
  series_id: string | null; // 実際に使われている寄せ先
  series_name: string; // 寄せ先のシリーズ名（マスタに無ければ ""）
  series_label: string;
  volume_count: number;
  /** manual = 管理者が指定 / suggested = サジェストのまま / auto = 指定が無く自動照合 /
   *  none = 寄せ先なし（自動照合でも見つからなかった） / skipped = 「寄せない」として確定 /
   *  stale = 指定先がマスタに無い */
  state: "manual" | "suggested" | "auto" | "none" | "skipped" | "stale";
  search_q: string;
}

/** GET /api/admin/circulation。取り込み状況と、全作品の寄せ先の一覧。 */
export async function adminCirculationStatus(env: Env): Promise<Response> {
  const totals = await env.DB.prepare(
    `SELECT COUNT(*) AS works, MAX(updated_at) AS updated_at FROM circulation`
  ).first<{ works: number; updated_at: number | null }>();
  const payload = await readPayload(env);
  const entries = payload?.entries ?? [];
  const links = await readLinks(env);

  // 記事名は payload に入れていないので、作品名から引き直す（circulation は作品名が一意）。
  const byTitle = await env.DB.prepare(`SELECT article, title_ja FROM circulation`).all<{
    article: string;
    title_ja: string;
  }>();
  const articleOf = new Map((byTitle.results ?? []).map((x) => [x.title_ja, x.article]));

  // 寄せ先のシリーズ名・巻数。まとまり（G-id）はマスタに行が無いので名前は空のまま。
  const ids = [...new Set(entries.map((e) => e.series_id).filter((x): x is string => Boolean(x)))];
  const names = new Map<string, { name: string; label: string; n: number }>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const r = await env.DB.prepare(
      `SELECT s.id, s.name, COALESCE(s.label, '') AS label,
              (SELECT COUNT(*) FROM volumes v WHERE v.series_id = s.id) AS n
         FROM series s WHERE s.id IN (${chunk.map(() => "?").join(",")})`
    )
      .bind(...chunk)
      .all<{ id: string; name: string; label: string; n: number }>();
    for (const row of r.results ?? []) names.set(row.id, { name: row.name, label: row.label, n: row.n });
  }

  const rows: AdminCirculationRow[] = entries.map((e) => {
    const article = articleOf.get(e.title) ?? "";
    const link = links.get(article);
    const info = e.series_id ? names.get(e.series_id) : undefined;
    let state: AdminCirculationRow["state"];
    if (!link) state = e.series_id ? "auto" : "none";
    else if (!link.series_id) state = "skipped";
    else if (!e.series_id) state = "stale"; // 指定はあるが resolveUnit で解決できなかった
    else state = link.source === "manual" ? "manual" : "suggested";
    return {
      rank: e.rank,
      article,
      title: e.title,
      title_en: e.title_en,
      author: e.author,
      copies: e.copies,
      as_of: e.as_of,
      series_id: e.series_id,
      series_name: info?.name ?? "",
      series_label: info?.label ?? "",
      volume_count: info?.n ?? 0,
      state,
      search_q: e.search_q || headWord(e.title).normalize("NFKC"),
    };
  });

  const count = (s: AdminCirculationRow["state"]) => rows.filter((r) => r.state === s).length;
  return json(
    {
      works: totals?.works ?? 0,
      updated_at: totals?.updated_at ?? 0,
      computed_at: payload?.computed_at ?? 0,
      source: payload?.source ?? (await readSource(env)),
      linked: [entries.filter((e) => e.series_id).length, entries.length],
      states: {
        manual: count("manual"),
        suggested: count("suggested"),
        auto: count("auto"),
        none: count("none"),
        skipped: count("skipped"),
        stale: count("stale"),
      },
      rows,
    },
    200,
    { "cache-control": "no-store" }
  );
}

/** POST /api/admin/circulation/suggest。指定の無い作品を自動照合して circulation_link に
 *  'suggested' で入れる。既定のデータ（db/circulation-links.sql）を作るのもこれ。
 *  `overwrite` のときは 'suggested' の行も入れ直す（'manual' は触らない）。マスタを取り込み
 *  直して寄せ先が変わったときに使う。 */
export async function suggestCirculationLinks(env: Env, overwrite: boolean): Promise<{ added: number; kept: number }> {
  const r = await env.DB.prepare(`SELECT article, title_ja FROM circulation`).all<{
    article: string;
    title_ja: string;
  }>();
  const rows = r.results ?? [];
  const links = await readLinks(env);

  // 'manual' は常に残す。overwrite のときだけ 'suggested' を対象に含める。
  const target = rows.filter((row) => {
    const link = links.get(row.article);
    if (!link) return true;
    return overwrite && link.source === "suggested";
  });
  if (!target.length) return { added: 0, kept: rows.length };

  const works: WorkRef[] = [];
  const seen = new Set<string>();
  for (const row of target) {
    const key = workKey(row.title_ja);
    if (seen.has(key)) continue;
    seen.add(key);
    works.push({ key, work: row.title_ja, author: "", isbns: [] });
  }
  const targets = await resolveTargets(env, works);

  const now = Date.now();
  const stmts = target
    .map((row) => ({ article: row.article, id: targets.get(workKey(row.title_ja)) }))
    // 寄せ先が見つからなかったものは行を作らない（「寄せない」として確定したことになり、
    // あとでマスタに入っても拾えなくなるため）。意図的に寄せないものは画面で指定する。
    .filter((x): x is { article: string; id: string } => Boolean(x.id))
    .map((x) =>
      env.DB.prepare(
        `INSERT INTO circulation_link (article, series_id, source, created_at) VALUES (?, ?, 'suggested', ?)
         ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, created_at = excluded.created_at
         WHERE circulation_link.source = 'suggested'`
      ).bind(x.article, x.id, now)
    );
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return { added: stmts.length, kept: rows.length - target.length };
}

export async function adminCirculationSuggest(env: Env, overwrite: boolean): Promise<Response> {
  const r = await suggestCirculationLinks(env, overwrite);
  const payload = await refreshCirculation(env);
  return json(
    { ok: true, ...r, linked: payload.entries.filter((e) => e.series_id).length, works: payload.entries.length },
    200,
    { "cache-control": "no-store" }
  );
}

/** POST /api/admin/circulation/link。寄せ先を確定する。
 *   series_id が文字列 … そのシリーズへ寄せる（'manual'）
 *   series_id が ""    … 「寄せない」として確定する（自動照合もしない）
 *   series_id が null  … 指定を取り消して自動照合に戻す */
export async function adminCirculationLink(env: Env, body: unknown): Promise<Response> {
  const b = (body ?? {}) as { article?: unknown; series_id?: unknown };
  const article = typeof b.article === "string" ? b.article.trim() : "";
  if (!article) return badRequest("article を指定してください");
  const exists = await env.DB.prepare(`SELECT 1 AS x FROM circulation WHERE article = ?`).bind(article).first();
  if (!exists) return notFound("その作品は取り込まれていません");

  if (b.series_id === null) {
    await env.DB.prepare(`DELETE FROM circulation_link WHERE article = ?`).bind(article).run();
  } else {
    const id = typeof b.series_id === "string" ? b.series_id.trim() : null;
    if (id === null) return badRequest("series_id は文字列か null で指定してください");
    // '' は「寄せない」。それ以外は実在するシリーズ / まとまりだけ受ける。
    if (id && !(await unitExists(env, id))) return badRequest("そのシリーズが見つかりません");
    await env.DB.prepare(
      `INSERT INTO circulation_link (article, series_id, source, created_at) VALUES (?, ?, 'manual', ?)
       ON CONFLICT(article) DO UPDATE SET series_id = excluded.series_id, source = 'manual', created_at = excluded.created_at`
    )
      .bind(article, id, Date.now())
      .run();
  }
  const payload = await refreshCirculation(env);
  const row = await env.DB.prepare(`SELECT title_ja FROM circulation WHERE article = ?`)
    .bind(article)
    .first<{ title_ja: string }>();
  const entry = payload.entries.find((e) => e.title === row?.title_ja);
  return json(
    { ok: true, series_id: entry?.series_id ?? null, linked: payload.entries.filter((e) => e.series_id).length },
    200,
    { "cache-control": "no-store" }
  );
}

/** 指定先が実在するか。C-id / U-id は series、まとまり（G-id）は resolveUnit で確かめる。 */
async function unitExists(env: Env, id: string): Promise<boolean> {
  if (id.startsWith("G")) return Boolean(await resolveUnit(env, id));
  const row = await env.DB.prepare(`SELECT 1 AS x FROM series WHERE id = ?`).bind(id).first();
  return Boolean(row);
}


/** 集計し直して materialize する。取り込み直した後・シリーズを結合した後に呼ぶ。 */
export async function refreshCirculation(env: Env): Promise<CirculationPayload> {
  const payload = await computeCirculation(env);
  await storePayload(env, payload);
  return payload;
}

/** POST /api/admin/circulation/recompute。 */
export async function adminCirculationRecompute(env: Env): Promise<Response> {
  const payload = await refreshCirculation(env);
  return json(
    {
      ok: true,
      works: payload.entries.length,
      linked: payload.entries.filter((e) => e.series_id).length,
    },
    200,
    { "cache-control": "no-store" }
  );
}

/** 暖機（src/warm.ts）が使う、発行部数の多い順のシリーズ ID。集計済みの寄せ先をそのまま使う
 *  （まだ集計していなければ空）。 */
export async function circulationSeriesIds(env: Env): Promise<string[]> {
  const payload = await readPayload(env);
  const ids: string[] = [];
  for (const e of payload?.entries ?? []) if (e.series_id) ids.push(e.series_id);
  return ids;
}
