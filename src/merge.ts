import { Env } from "./types";
import { badRequest, json, notFound, readJsonObject } from "./util";
import type { PageOpts } from "./admin";

// シリーズの結合（分裂したシリーズを 1 つにまとめる）。上流 MADB は同一作品を複数の C-id に
// 分けて持つことがある（例: 「One piece」SJR 版が C451457 = 1巻 / C451211 = 2〜5巻）。
// 名前・著者・出版社・レーベルが同じでも別の版（新装版/通常版）が多いので自動では結合せず、
// 閲覧者の依頼か管理画面の候補一覧から管理者が確定する。確定した結合は series_merge に残し
// READ 時に適用する（getSeriesVolumes / 検索 / listItems）。target は常に「どこにも吸収されて
// いない」シリーズに保つ（連鎖させない）ので、読み替えは 1 段で済む。See db/schema.sql。

// D1 の bind パラメータ上限を避けるための IN 句チャンク（readCachedCovers と同じ）。
const CHUNK = 90;
// 公開 API の候補・依頼で受け付ける C-id の形（ルートの正規表現と同じ）。
const ID_RE = /^[A-Za-z0-9]{1,32}$/;
// 候補表示で返す巻ラベルの上限（長期連載でもレスポンスを膨らませない）。
const MAX_LABELS = 40;

/** 吸収済みなら残す側の C-id、そうでなければ自分自身。 */
export async function resolveMergeTarget(env: Env, seriesId: string): Promise<string> {
  const row = await env.DB.prepare(`SELECT target_id FROM series_merge WHERE absorbed_id = ?`)
    .bind(seriesId)
    .first<{ target_id: string }>();
  return row?.target_id ?? seriesId;
}

/** target と、そこに吸収された全シリーズの C-id（target が先頭）。 */
export async function mergeMembers(env: Env, targetId: string): Promise<string[]> {
  const res = await env.DB.prepare(
    `SELECT absorbed_id FROM series_merge WHERE target_id = ? ORDER BY absorbed_id`
  )
    .bind(targetId)
    .all<{ absorbed_id: string }>();
  return [targetId, ...(res.results ?? []).map((r) => r.absorbed_id)];
}

/** 渡した C-id のうち吸収済みのものについて absorbed → target の対応を返す。 */
export async function mergeTargetsFor(env: Env, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniq = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const chunk = uniq.slice(i, i + CHUNK);
    const res = await env.DB.prepare(
      `SELECT absorbed_id, target_id FROM series_merge
        WHERE absorbed_id IN (${chunk.map(() => "?").join(",")})`
    )
      .bind(...chunk)
      .all<{ absorbed_id: string; target_id: string }>();
    for (const r of res.results ?? []) out.set(r.absorbed_id, r.target_id);
  }
  return out;
}

export interface SeriesInfo {
  series_id: string;
  title: string; // series_name_override 適用後
  creator: string;
  publisher: string;
  label: string;
  volume_count: number; // 巻番号単位（番号なしは ISBN 単位）
  labels: string[]; // 巻ラベル（vol_sort 順、最大 MAX_LABELS）
  sorts: number[]; // 番号のある巻の vol_sort（重なり判定用）
}

/** シリーズ（とそこに吸収済みの member）の表示用情報。結合の候補・依頼の確認に使う。
 *  巻は member 横断でまとめるので、結合済み target は結合後の姿で見える。 */
export async function seriesInfos(env: Env, ids: string[]): Promise<Map<string, SeriesInfo>> {
  const out = new Map<string, SeriesInfo>();
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return out;

  // member → 表示単位（自身 or target として渡された id）
  const owner = new Map<string, string>();
  for (const id of uniq) owner.set(id, id);
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const chunk = uniq.slice(i, i + CHUNK);
    const res = await env.DB.prepare(
      `SELECT absorbed_id, target_id FROM series_merge
        WHERE target_id IN (${chunk.map(() => "?").join(",")})`
    )
      .bind(...chunk)
      .all<{ absorbed_id: string; target_id: string }>();
    for (const r of res.results ?? []) if (!owner.has(r.absorbed_id)) owner.set(r.absorbed_id, r.target_id);
  }

  for (let i = 0; i < uniq.length; i += CHUNK) {
    const chunk = uniq.slice(i, i + CHUNK);
    const res = await env.DB.prepare(
      `SELECT s.id, COALESCE(o.name, s.name) AS name, s.creator, s.publisher, s.label
         FROM series s LEFT JOIN series_name_override o ON o.series_id = s.id
        WHERE s.id IN (${chunk.map(() => "?").join(",")})`
    )
      .bind(...chunk)
      .all<{ id: string; name: string; creator: string | null; publisher: string | null; label: string | null }>();
    for (const r of res.results ?? []) {
      out.set(r.id, {
        series_id: r.id,
        title: r.name,
        creator: r.creator ?? "",
        publisher: r.publisher ?? "",
        label: r.label ?? "",
        volume_count: 0,
        labels: [],
        sorts: [],
      });
    }
  }

  const members = [...owner.keys()];
  const vols = new Map<string, { key: string; label: string; sort: number }[]>();
  for (let i = 0; i < members.length; i += CHUNK) {
    const chunk = members.slice(i, i + CHUNK);
    const res = await env.DB.prepare(
      `SELECT series_id, isbn, volume_number, vol_sort FROM volumes
        WHERE series_id IN (${chunk.map(() => "?").join(",")})`
    )
      .bind(...chunk)
      .all<{ series_id: string; isbn: string; volume_number: string | null; vol_sort: number | null }>();
    for (const r of res.results ?? []) {
      const unit = owner.get(r.series_id)!;
      let arr = vols.get(unit);
      if (!arr) vols.set(unit, (arr = []));
      arr.push({
        key: r.volume_number ? `n:${r.volume_number}` : `i:${r.isbn}`,
        label: r.volume_number ?? "",
        sort: r.volume_number ? r.vol_sort ?? 0 : 0,
      });
    }
  }
  for (const [unit, arr] of vols) {
    const info = out.get(unit);
    if (!info) continue;
    const seen = new Map<string, { label: string; sort: number }>();
    for (const v of arr) if (!seen.has(v.key)) seen.set(v.key, v);
    const list = [...seen.values()].sort((a, b) => a.sort - b.sort || a.label.localeCompare(b.label));
    info.volume_count = list.length;
    info.labels = list.map((v) => v.label || "(番号なし)").slice(0, MAX_LABELS);
    info.sorts = [...new Set(list.filter((v) => v.sort > 0).map((v) => v.sort))];
  }
  return out;
}

const publicInfo = (i: SeriesInfo) => ({
  series_id: i.series_id,
  title: i.title,
  creator: i.creator,
  publisher: i.publisher,
  label: i.label,
  volume_count: i.volume_count,
  labels: i.labels,
});

/** GET /api/series/:id/merge-candidates — 「シリーズが分かれている？」の候補。同じ正規化
 *  タイトル（name_norm）で同じ著者のシリーズを、結合済みは target に読み替えて返す。
 *  出版社/レーベル違いも候補に含める（判断は閲覧者と管理者に委ねる）。 */
export async function getMergeCandidates(env: Env, seriesId: string): Promise<Response> {
  const self = await resolveMergeTarget(env, seriesId);
  const meta = await env.DB.prepare(`SELECT id, name_norm, creator FROM series WHERE id = ?`)
    .bind(self)
    .first<{ id: string; name_norm: string; creator: string | null }>();
  if (!meta) return notFound("シリーズが見つかりません");

  const res = await env.DB.prepare(
    `SELECT id FROM series WHERE name_norm = ? AND COALESCE(creator, '') = ? AND id != ? LIMIT 50`
  )
    .bind(meta.name_norm, meta.creator ?? "", meta.id)
    .all<{ id: string }>();
  const raw = (res.results ?? []).map((r) => r.id);
  const targets = await mergeTargetsFor(env, raw);
  const ids = [...new Set(raw.map((id) => targets.get(id) ?? id))].filter((id) => id !== self);

  const infos = await seriesInfos(env, [self, ...ids]);
  const selfInfo = infos.get(self);
  const candidates = ids
    .map((id) => infos.get(id))
    .filter((i): i is SeriesInfo => !!i && i.volume_count > 0)
    .sort((a, b) => b.volume_count - a.volume_count)
    .map(publicInfo);
  return json(
    { series: selfInfo ? publicInfo(selfInfo) : null, candidates },
    200,
    { "cache-control": "no-store" }
  );
}

/** POST /api/series/:id/merge-request — 「このシリーズと同じ作品」と結合を依頼する。
 *  series_report と同じ collect-only 方針で、件数だけ記録し全体反映は管理者の確定まで
 *  行わない。body: { other_id }。両方とも結合済みなら target に読み替えて記録する。 */
export async function requestSeriesMerge(request: Request, env: Env, seriesId: string): Promise<Response> {
  const body = (await readJsonObject(request)) as { other_id?: unknown };
  const otherRaw = typeof body.other_id === "string" ? body.other_id.trim().toUpperCase() : "";
  if (!ID_RE.test(otherRaw)) return badRequest("シリーズIDの形式が正しくありません（例: C451211）");

  const a = await resolveMergeTarget(env, seriesId);
  const b = await resolveMergeTarget(env, otherRaw);
  if (a === b) return badRequest("同じシリーズです（既に結合済みの場合も含みます）");
  const found = await env.DB.prepare(`SELECT COUNT(*) AS n FROM series WHERE id IN (?, ?)`)
    .bind(a, b)
    .first<{ n: number }>();
  if ((found?.n ?? 0) < 2) return notFound("シリーズが見つかりません");

  const [lo, hi] = a < b ? [a, b] : [b, a];
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO series_merge_request (series_a, series_b, report_count, first_reported_at, last_reported_at)
     VALUES (?, ?, 1, ?, ?)
     ON CONFLICT (series_a, series_b) DO UPDATE SET
       report_count = report_count + 1,
       last_reported_at = excluded.last_reported_at`
  )
    .bind(lo, hi, now, now)
    .run();
  return json({ ok: true }, 200, { "cache-control": "no-store" });
}

// ── 管理画面 ──────────────────────────────────────────────────────────────

const adminInfo = (i: SeriesInfo | undefined, id: string) =>
  i
    ? publicInfo(i)
    : { series_id: id, title: "(マスターに無いシリーズ)", creator: "", publisher: "", label: "", volume_count: 0, labels: [] };

/** 結合依頼の一覧。件数の多い順。各シリーズの巻構成を併記して管理者が判断できるようにする。 */
export async function adminListMergeRequests(env: Env, opts: PageOpts): Promise<Response> {
  const total =
    (await env.DB.prepare(`SELECT COUNT(*) AS n FROM series_merge_request`).first<{ n: number }>())?.n ?? 0;
  const res = await env.DB.prepare(
    `SELECT series_a, series_b, report_count, first_reported_at, last_reported_at
       FROM series_merge_request
      ORDER BY report_count DESC, last_reported_at DESC LIMIT ? OFFSET ?`
  )
    .bind(opts.per, opts.offset)
    .all<{ series_a: string; series_b: string; report_count: number; first_reported_at: number; last_reported_at: number }>();
  const rows = res.results ?? [];
  const infos = await seriesInfos(env, rows.flatMap((r) => [r.series_a, r.series_b]));
  const requests = rows.map((r) => ({
    series_a: r.series_a,
    series_b: r.series_b,
    report_count: r.report_count,
    first_reported_at: r.first_reported_at,
    last_reported_at: r.last_reported_at,
    overlap: overlaps(infos.get(r.series_a), infos.get(r.series_b)),
    series: [adminInfo(infos.get(r.series_a), r.series_a), adminInfo(infos.get(r.series_b), r.series_b)],
  }));
  return json({ requests, total, page: opts.page, per: opts.per }, 200, { "cache-control": "no-store" });
}

/** 2 シリーズで巻番号（vol_sort）が重なるか。重なるなら別の版の可能性が高い。 */
function overlaps(a: SeriesInfo | undefined, b: SeriesInfo | undefined): boolean {
  if (!a || !b) return false;
  const s = new Set(a.sorts);
  return b.sorts.some((n) => s.has(n));
}

/** 結合依頼を却下（行だけ消す）。 */
export async function adminDismissMergeRequest(env: Env, a: string, b: string): Promise<Response> {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const res = await env.DB.prepare(`DELETE FROM series_merge_request WHERE series_a = ? AND series_b = ?`)
    .bind(lo, hi)
    .run();
  if (!(res.meta?.changes ?? 0)) return notFound("依頼が見つかりません");
  return json({ ok: true });
}

/** 自動検出の結合候補。名前（name_norm）・著者・出版社・レーベルが同じシリーズのグループ
 *  のうち、結合済みを target に読み替えた上で番号付きの巻を持つ単位が 2 つ以上あり、
 *  巻番号が重ならないもの。
 *  毎回全グループを JS で判定してから in-memory でページングする（本番で ~1,300 グループ、
 *  巻の取得は ~3,000 シリーズ分なので admin 用途なら許容）。却下済みグループは除く。 */
export async function adminListMergeCandidates(env: Env, opts: PageOpts): Promise<Response> {
  const res = await env.DB.prepare(
    `SELECT GROUP_CONCAT(id) AS ids FROM series
      GROUP BY name_norm, COALESCE(creator, ''), COALESCE(publisher, ''), COALESCE(label, '')
     HAVING COUNT(*) > 1`
  ).all<{ ids: string }>();
  const groups = (res.results ?? []).map((r) => r.ids.split(","));

  const targets = await mergeTargetsFor(env, groups.flat());
  const dismissed = new Set(
    ((await env.DB.prepare(`SELECT group_key FROM series_merge_dismissed`).all<{ group_key: string }>())
      .results ?? []).map((r) => r.group_key)
  );
  const unitGroups: string[][] = [];
  for (const g of groups) {
    const units = [...new Set(g.map((id) => targets.get(id) ?? id))].sort();
    if (units.length < 2) continue;
    if (dismissed.has(units.join(","))) continue;
    unitGroups.push(units);
  }

  const infos = await seriesInfos(env, unitGroups.flat());
  const candidates: { group_key: string; total: number; series: ReturnType<typeof publicInfo>[] }[] = [];
  for (const units of unitGroups) {
    // 巻番号の無い巻だけのシリーズ（総集編・異装版などの別冊が多い）は重なり判定ができず
    // ノイズになるので、番号付きの巻を持つシリーズ同士だけを候補にする。
    const members = units.map((id) => infos.get(id)).filter((i): i is SeriesInfo => !!i && i.sorts.length > 0);
    if (members.length < 2) continue;
    const seen = new Set<number>();
    let collide = false;
    for (const m of members) {
      for (const n of m.sorts) {
        if (seen.has(n)) collide = true;
      }
      for (const n of m.sorts) seen.add(n);
      if (collide) break;
    }
    if (collide) continue;
    candidates.push({
      group_key: units.join(","),
      total: members.reduce((s, m) => s + m.volume_count, 0),
      series: members.sort((a, b) => b.volume_count - a.volume_count).map(publicInfo),
    });
  }
  candidates.sort((a, b) => b.total - a.total || a.group_key.localeCompare(b.group_key));
  return json(
    {
      candidates: candidates.slice(opts.offset, opts.offset + opts.per),
      total: candidates.length,
      page: opts.page,
      per: opts.per,
    },
    200,
    { "cache-control": "no-store" }
  );
}

/** 自動検出候補を「別の版なので結合しない」と却下する。body: { group_key }。 */
export async function adminDismissMergeCandidate(request: Request, env: Env): Promise<Response> {
  const body = (await readJsonObject(request)) as { group_key?: unknown };
  const key = typeof body.group_key === "string" ? body.group_key : "";
  if (!key || !key.split(",").every((id) => ID_RE.test(id))) return badRequest("group_key が不正です");
  await env.DB.prepare(
    `INSERT INTO series_merge_dismissed (group_key, created_at) VALUES (?, ?)
     ON CONFLICT (group_key) DO NOTHING`
  )
    .bind(key, Date.now())
    .run();
  return json({ ok: true });
}

/** シリーズを結合する。body: { target_id, absorbed_ids: [] }。target が吸収済みならその
 *  target に、absorbed に吸収済みの member があればそれごと付け替えて、連鎖のない形に保つ。
 *  対応する結合依頼（両方が結合後の同じ target に入るもの）は片付ける。 */
export async function adminMergeSeries(request: Request, env: Env): Promise<Response> {
  const body = (await readJsonObject(request)) as { target_id?: unknown; absorbed_ids?: unknown };
  const targetRaw = typeof body.target_id === "string" ? body.target_id : "";
  const absorbedRaw = Array.isArray(body.absorbed_ids)
    ? body.absorbed_ids.filter((x): x is string => typeof x === "string")
    : [];
  if (!ID_RE.test(targetRaw) || !absorbedRaw.length || !absorbedRaw.every((id) => ID_RE.test(id))) {
    return badRequest("target_id / absorbed_ids が不正です");
  }

  const target = await resolveMergeTarget(env, targetRaw);
  const ids = [...new Set([target, ...absorbedRaw])];
  const found = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM series WHERE id IN (${ids.map(() => "?").join(",")})`
  )
    .bind(...ids)
    .first<{ n: number }>();
  if ((found?.n ?? 0) !== ids.length) return notFound("シリーズが見つかりません");

  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  const merged: string[] = [];
  for (const raw of absorbedRaw) {
    const a = await resolveMergeTarget(env, raw);
    if (a === target || merged.includes(a)) continue;
    merged.push(a);
    stmts.push(env.DB.prepare(`UPDATE series_merge SET target_id = ? WHERE target_id = ?`).bind(target, a));
    stmts.push(
      env.DB.prepare(
        `INSERT INTO series_merge (absorbed_id, target_id, created_at) VALUES (?, ?, ?)
         ON CONFLICT (absorbed_id) DO UPDATE SET target_id = excluded.target_id, created_at = excluded.created_at`
      ).bind(a, target, now)
    );
  }
  if (!stmts.length) return badRequest("既に結合済みです");
  stmts.push(
    env.DB.prepare(
      `DELETE FROM series_merge_request
        WHERE COALESCE((SELECT target_id FROM series_merge WHERE absorbed_id = series_a), series_a) = ?1
          AND COALESCE((SELECT target_id FROM series_merge WHERE absorbed_id = series_b), series_b) = ?1`
    ).bind(target)
  );
  await env.DB.batch(stmts);
  return json({ ok: true, target_id: target, absorbed_ids: merged });
}

/** 確定済みの結合の一覧（新しい順）。解除の導線用。 */
export async function adminListMerges(env: Env, opts: PageOpts): Promise<Response> {
  const total = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM series_merge`).first<{ n: number }>())?.n ?? 0;
  const res = await env.DB.prepare(
    `SELECT m.absorbed_id, m.target_id, m.created_at,
            COALESCE(oa.name, sa.name) AS absorbed_name, COALESCE(ot.name, st.name) AS target_name
       FROM series_merge m
       LEFT JOIN series sa ON sa.id = m.absorbed_id
       LEFT JOIN series_name_override oa ON oa.series_id = m.absorbed_id
       LEFT JOIN series st ON st.id = m.target_id
       LEFT JOIN series_name_override ot ON ot.series_id = m.target_id
      ORDER BY m.created_at DESC LIMIT ? OFFSET ?`
  )
    .bind(opts.per, opts.offset)
    .all<{ absorbed_id: string; target_id: string; created_at: number; absorbed_name: string | null; target_name: string | null }>();
  const merges = (res.results ?? []).map((r) => ({
    absorbed_id: r.absorbed_id,
    target_id: r.target_id,
    created_at: r.created_at,
    absorbed_name: r.absorbed_name ?? "",
    target_name: r.target_name ?? "",
  }));
  return json({ merges, total, page: opts.page, per: opts.per }, 200, { "cache-control": "no-store" });
}

/** 結合を解除する（absorbed を独立したシリーズに戻す）。 */
export async function adminUnmergeSeries(env: Env, absorbedId: string): Promise<Response> {
  const res = await env.DB.prepare(`DELETE FROM series_merge WHERE absorbed_id = ?`).bind(absorbedId).run();
  if (!(res.meta?.changes ?? 0)) return notFound("結合が見つかりません");
  return json({ ok: true, absorbed_id: absorbedId });
}
