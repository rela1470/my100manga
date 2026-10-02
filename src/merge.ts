import { Env } from "./types";
import { badRequest, json, notFound, normTitle, readJsonObject } from "./util";
import type { PageOpts } from "./admin";
import {
  isGroupId,
  loadGroup,
  resolveGroup,
  unattributedGroupsFor,
  nextCustomSeriesId,
  createCustomSeriesStmts,
  linkStmts,
  UnlinkedGroup,
} from "./groups";

// シリーズの結合（分裂したシリーズを 1 つにまとめる）。上流 MADB は同一作品を複数の C-id に
// 分けて持つことがある（例: 「One piece」SJR 版が C451457 = 1巻 / C451211 = 2〜5巻）。
// 名前・著者・出版社・レーベルが同じでも別の版（新装版/通常版）が多いので自動では結合せず、
// 閲覧者の依頼か管理画面の候補一覧から管理者が確定する。確定した結合は series_merge に残し
// READ 時に適用する（getSeriesVolumes / 検索 / listItems）。target は常に「どこにも吸収されて
// いない」シリーズに保つ（連鎖させない）ので、読み替えは 1 段で済む。See db/schema.sql。
//
// シリーズに属さない巻のまとまり（G<ISBN>, src/groups.ts）も結合の相手にできる。依頼には
// G-id のまま記録し、確定時にグループの巻を残す側へ ISBN 単位で紐付ける（volume_series_link）。
// 残す側がグループなら、そこから独自シリーズ（U…）を作って残す側にする。
//
// 逆に、1 つの C-id に別の版が混ざっていることもある（例: キン肉マン C261524 に 1〜36巻の
// 復刻版が入っていて、12〜36巻が元の版と二重に並ぶ）。管理者が ISBN を選んで独自シリーズへ
// 移す（分離）。仕組みは紐付けと同じで、volume_series_link に分離元（from_series_id）付きで
// 記録し、解除すると分離元に戻す。

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

/** 結合の単位。C-id/U-id は結合済みなら残す側、G-id は今の所属（既存シリーズに寄せられる・
 *  紐付け済みならそのシリーズ、そうでなければグループの正規 ID）。巻が無い G-id は null。 */
export async function resolveUnit(env: Env, id: string): Promise<string | null> {
  if (!isGroupId(id)) return resolveMergeTarget(env, id);
  const r = await resolveGroup(env, id);
  if (!r) return null;
  return "seriesId" in r ? resolveMergeTarget(env, r.seriesId) : r.group.id;
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
  const all = [...new Set(ids.filter(Boolean))];
  // グループ（G-id）は巻をその場で集めて同じ形にする。紐付け済みで巻が残っていなければ載せない。
  for (const id of all.filter(isGroupId)) {
    const g = await loadGroup(env, id.slice(1));
    if (g) out.set(id, groupInfo(id, g));
  }
  const uniq = all.filter((id) => !isGroupId(id));
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

function groupInfo(id: string, g: UnlinkedGroup): SeriesInfo {
  return {
    series_id: id,
    title: g.title,
    creator: g.creator,
    publisher: g.publisher,
    label: g.label,
    volume_count: g.volumes.length,
    labels: g.volumes.map((v) => v.volume_number || "(番号なし)").slice(0, MAX_LABELS),
    sorts: [...new Set(g.volumes.filter((v) => v.volume_number && v.vol_sort > 0).map((v) => v.vol_sort))],
  };
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
 *  出版社/レーベル違いも候補に含める（判断は閲覧者と管理者に委ねる）。続けて、どのシリーズにも
 *  寄せられていない同名のグループ（unattributedGroupsFor）を返す。同名シリーズが複数ある書名の
 *  迷子巻は検索に出ないので、シリーズページからたどり着ける入口はここだけになる。 */
export async function getMergeCandidates(env: Env, seriesId: string): Promise<Response> {
  const self = await resolveUnit(env, seriesId);
  if (!self) return notFound("シリーズが見つかりません");
  if (isGroupId(self)) return getGroupMergeCandidates(env, self);
  const meta = await env.DB.prepare(`SELECT id, name, name_norm, creator FROM series WHERE id = ?`)
    .bind(self)
    .first<{ id: string; name: string; name_norm: string; creator: string | null }>();
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
  const groups = (await unattributedGroupsFor(env, meta.name))
    .filter((g) => g.volumes.length > 0)
    .sort((a, b) => b.volumes.length - a.volumes.length)
    .map((g) => publicInfo(groupInfo(g.id, g)));
  return json(
    { series: selfInfo ? publicInfo(selfInfo) : null, candidates: [...candidates, ...groups] },
    200,
    { "cache-control": "no-store" }
  );
}

/** グループの結合候補: 同じ正規化書名のシリーズ（同名が複数あってどれにも寄せられなかった
 *  ものが主。著者は問わない）。 */
async function getGroupMergeCandidates(env: Env, groupId: string): Promise<Response> {
  const g = await loadGroup(env, groupId.slice(1));
  if (!g) return notFound("シリーズが見つかりません");
  const res = await env.DB.prepare(`SELECT id FROM series WHERE name_norm = ? LIMIT 50`)
    .bind(normTitle(g.title))
    .all<{ id: string }>();
  const raw = (res.results ?? []).map((r) => r.id);
  const targets = await mergeTargetsFor(env, raw);
  const ids = [...new Set(raw.map((id) => targets.get(id) ?? id))];
  const infos = await seriesInfos(env, ids);
  const candidates = ids
    .map((id) => infos.get(id))
    .filter((i): i is SeriesInfo => !!i && i.volume_count > 0)
    .sort((a, b) => b.volume_count - a.volume_count)
    .map(publicInfo);
  return json(
    { series: publicInfo(groupInfo(groupId, g)), candidates },
    200,
    { "cache-control": "no-store" }
  );
}

/** 1 回の依頼でまとめて指定できる相手シリーズの上限。 */
const MERGE_REQUEST_MAX = 10;

/** POST /api/series/:id/merge-request — 「このシリーズと同じ作品」と結合を依頼する。
 *  series_report と同じ collect-only 方針で、件数だけ記録し全体反映は管理者の確定まで
 *  行わない。body: { other_ids: [] }（旧形式の { other_id } も可）。相手は複数まとめて
 *  指定でき、1 つでも不正なら何も記録しない。結合済みは target に読み替えて記録する。 */
export async function requestSeriesMerge(request: Request, env: Env, seriesId: string): Promise<Response> {
  const body = (await readJsonObject(request)) as { other_id?: unknown; other_ids?: unknown };
  const rawList = Array.isArray(body.other_ids) ? body.other_ids : [body.other_id];
  const others = [
    ...new Set(rawList.map((v) => (typeof v === "string" ? v.trim().toUpperCase() : ""))),
  ];
  if (!others.length || others.some((id) => !ID_RE.test(id))) {
    return badRequest("シリーズIDの形式が正しくありません（例: C451211）");
  }
  if (others.length > MERGE_REQUEST_MAX) {
    return badRequest(`一度に依頼できるのは ${MERGE_REQUEST_MAX} 件までです`);
  }

  const a = await resolveUnit(env, seriesId.toUpperCase());
  if (!a) return notFound(`シリーズが見つかりません: ${seriesId}`);
  const resolved = await Promise.all(others.map((id) => resolveUnit(env, id)));
  const gone = others.filter((_, i) => !resolved[i]);
  if (gone.length) return notFound(`シリーズが見つかりません: ${gone.join(", ")}`);
  // 自分自身・既に自分へ結合済みの相手は、どれが該当するか分かるよう ID を挙げて弾く。
  const same = others.filter((_, i) => resolved[i] === a);
  if (same.length) {
    return badRequest(`${same.join(", ")} は既にこのシリーズと同じ（結合済み）です。選択から外してください`);
  }
  const bs = [...new Set(resolved as string[])];
  // グループは resolveUnit が巻の存在を確かめ済み。シリーズは series にあるかを見る。
  const ids = [a, ...bs].filter((id) => !isGroupId(id));
  if (ids.length) {
    const found = await env.DB.prepare(
      `SELECT id FROM series WHERE id IN (${ids.map(() => "?").join(",")})`
    )
      .bind(...ids)
      .all<{ id: string }>();
    const have = new Set((found.results ?? []).map((r) => r.id));
    const missing = ids.filter((id) => !have.has(id));
    if (missing.length) return notFound(`シリーズが見つかりません: ${missing.join(", ")}`);
  }

  const now = Date.now();
  const stmt = env.DB.prepare(
    `INSERT INTO series_merge_request (series_a, series_b, report_count, first_reported_at, last_reported_at)
     VALUES (?, ?, 1, ?, ?)
     ON CONFLICT (series_a, series_b) DO UPDATE SET
       report_count = report_count + 1,
       last_reported_at = excluded.last_reported_at`
  );
  await env.DB.batch(
    bs.map((b) => {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      return stmt.bind(lo, hi, now, now);
    })
  );
  return json({ ok: true, count: bs.length }, 200, { "cache-control": "no-store" });
}

/** 1 回の分離依頼で送れる ISBN の上限（兄弟 ISBN 込み。長期連載の別の版をまとめて選べる程度）。 */
const SPLIT_REQUEST_MAX = 500;

/** POST /api/series/:id/split-request — 「このシリーズに別の版が混ざっている」と分離を依頼する。
 *  body: { isbns: [] }（別の版だと選んだ巻の ISBN。兄弟 ISBN 込み）。結合依頼と同じ collect-only
 *  方針で、ISBN ごとに件数だけ記録し、分離は管理者が確定する。マスタの巻（volumes にあり、
 *  このシリーズ＝結合済みなら全 member に属するもの）だけを記録し、補完・ユーザ投稿の巻は
 *  分離の対象外なので黙って除く。全巻を選んだ依頼は分離にならないので弾く。 */
export async function requestSeriesSplit(request: Request, env: Env, seriesId: string): Promise<Response> {
  const body = (await readJsonObject(request)) as { isbns?: unknown };
  const isbns = Array.isArray(body.isbns)
    ? [...new Set(body.isbns.filter((x): x is string => typeof x === "string" && /^\d{13}$/.test(x)))]
    : [];
  if (!isbns.length) return badRequest("別の版の巻を選んでください");
  if (isbns.length > SPLIT_REQUEST_MAX) return badRequest("選んだ巻が多すぎます");
  const id = seriesId.toUpperCase();
  if (isGroupId(id)) return badRequest("シリーズに属さないまとまりは分離を依頼できません");

  const target = await resolveMergeTarget(env, id);
  const members = await mergeMembers(env, target);
  const inMembers = members.map(() => "?").join(",");
  const total =
    (
      await env.DB.prepare(`SELECT COUNT(*) AS n FROM volumes WHERE series_id IN (${inMembers})`)
        .bind(...members)
        .first<{ n: number }>()
    )?.n ?? 0;
  if (!total) return notFound(`シリーズが見つかりません: ${seriesId}`);

  const found: string[] = [];
  for (let i = 0; i < isbns.length; i += CHUNK) {
    const chunk = isbns.slice(i, i + CHUNK);
    const res = await env.DB.prepare(
      `SELECT isbn FROM volumes WHERE series_id IN (${inMembers}) AND isbn IN (${chunk.map(() => "?").join(",")})`
    )
      .bind(...members, ...chunk)
      .all<{ isbn: string }>();
    for (const r of res.results ?? []) found.push(r.isbn);
  }
  if (!found.length) return badRequest("選んだ巻はこのシリーズのマスターの巻ではありません");
  if (found.length >= total) return badRequest("全ての巻を選ぶと分離になりません。別の版の巻だけを選んでください");

  const now = Date.now();
  const stmt = env.DB.prepare(
    `INSERT INTO series_split_request (series_id, isbn, report_count, first_reported_at, last_reported_at)
     VALUES (?, ?, 1, ?, ?)
     ON CONFLICT (series_id, isbn) DO UPDATE SET
       report_count = report_count + 1,
       last_reported_at = excluded.last_reported_at`
  );
  await env.DB.batch(found.map((isbn) => stmt.bind(target, isbn, now, now)));
  return json({ ok: true, count: found.length }, 200, { "cache-control": "no-store" });
}

// ── 管理画面 ──────────────────────────────────────────────────────────────

const adminInfo = (i: SeriesInfo | undefined, id: string) =>
  i
    ? publicInfo(i)
    : {
        series_id: id,
        title: isGroupId(id) ? "(紐付け済み・巻の無いまとまり)" : "(マスターに無いシリーズ)",
        creator: "",
        publisher: "",
        label: "",
        volume_count: 0,
        labels: [],
      };

/** 結合依頼の一覧。依頼は 2 シリーズの組で記録されるが、1 回でまとめて依頼されたもの
 *  （A–B, A–C）や別々の依頼でつながるものは、組のつながり（連結成分）で 1 グループに
 *  まとめて返す。グループは合計件数の多い順。各シリーズの巻構成を併記して管理者が判断
 *  できるようにする。依頼の行数は小さいので全件読んでから in-memory でページングする。 */
export async function adminListMergeRequests(env: Env, opts: PageOpts): Promise<Response> {
  const res = await env.DB.prepare(
    `SELECT series_a, series_b, report_count, first_reported_at, last_reported_at FROM series_merge_request`
  ).all<{ series_a: string; series_b: string; report_count: number; first_reported_at: number; last_reported_at: number }>();
  const rows = res.results ?? [];

  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const r of rows) {
    const a = find(r.series_a);
    const b = find(r.series_b);
    if (a !== b) parent.set(a, b);
  }
  const byRoot = new Map<string, typeof rows>();
  for (const r of rows) {
    const root = find(r.series_a);
    byRoot.set(root, [...(byRoot.get(root) ?? []), r]);
  }

  const groups = [...byRoot.values()]
    .map((pairs) => ({
      pairs,
      report_count: pairs.reduce((n, p) => n + p.report_count, 0),
      last_reported_at: Math.max(...pairs.map((p) => p.last_reported_at)),
    }))
    .sort((a, b) => b.report_count - a.report_count || b.last_reported_at - a.last_reported_at);
  const page = groups.slice(opts.offset, opts.offset + opts.per);
  const infos = await seriesInfos(env, page.flatMap((g) => g.pairs.flatMap((p) => [p.series_a, p.series_b])));

  const requests = page.map((g) => {
    const ids = [...new Set(g.pairs.flatMap((p) => [p.series_a, p.series_b]))];
    const series = ids
      .map((id) => adminInfo(infos.get(id), id))
      .sort((a, b) => b.volume_count - a.volume_count || a.series_id.localeCompare(b.series_id));
    return {
      group_key: ids.sort().join(","),
      report_count: g.report_count,
      last_reported_at: g.last_reported_at,
      pairs: g.pairs.map((p) => ({
        series_a: p.series_a,
        series_b: p.series_b,
        report_count: p.report_count,
        overlap: overlaps(infos.get(p.series_a), infos.get(p.series_b)),
      })),
      overlap: g.pairs.some((p) => overlaps(infos.get(p.series_a), infos.get(p.series_b))),
      series,
    };
  });
  return json({ requests, total: groups.length, page: opts.page, per: opts.per }, 200, { "cache-control": "no-store" });
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

/** 結合で片付いた依頼（両側が同じ単位に入ったもの）を消す文。G-id は紐付け先、結合済みは
 *  残す側に読み替えて比べる。scripts/dump-series-merge.mjs にも同じ SQL がある。 */
export const CLEANUP_MERGE_REQUESTS_SQL = (() => {
  const unit = (col: string) =>
    `(CASE WHEN ${col} GLOB 'G[0-9]*' THEN COALESCE((SELECT l.series_id FROM volume_series_link l WHERE l.isbn = SUBSTR(${col}, 2)), ${col}) ELSE ${col} END)`;
  const target = (col: string) =>
    `COALESCE((SELECT m.target_id FROM series_merge m WHERE m.absorbed_id = ${unit(col)}), ${unit(col)})`;
  return `DELETE FROM series_merge_request WHERE ${target("series_a")} = ${target("series_b")}`;
})();

/** シリーズを結合する。body: { target_id, absorbed_ids: [], name? }。target が吸収済みならその
 *  target に、absorbed に吸収済みの member があればそれごと付け替えて、連鎖のない形に保つ。
 *  グループ（G-id）は巻を target に紐付ける。target がグループなら独自シリーズを作って残す側に
 *  する。対応する結合依頼（両方が結合後の同じ target に入るもの）は片付ける。 */
export async function adminMergeSeries(request: Request, env: Env): Promise<Response> {
  const body = (await readJsonObject(request)) as { target_id?: unknown; absorbed_ids?: unknown; name?: unknown };
  const targetRaw = typeof body.target_id === "string" ? body.target_id : "";
  // 残す側がグループのときに作る独自シリーズの名前（省略時はグループの書名）。
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 200) : "";
  const absorbedRaw = Array.isArray(body.absorbed_ids)
    ? body.absorbed_ids.filter((x): x is string => typeof x === "string")
    : [];
  if (!ID_RE.test(targetRaw) || !absorbedRaw.length || !absorbedRaw.every((id) => ID_RE.test(id))) {
    return badRequest("target_id / absorbed_ids が不正です");
  }

  // 各 ID を結合の単位に読み替える（グループは今の所属。巻の無いグループは弾く）。
  const units = new Map<string, string>();
  for (const raw of [targetRaw, ...absorbedRaw]) {
    const u = await resolveUnit(env, raw);
    if (!u) return notFound(`シリーズが見つかりません: ${raw}`);
    units.set(raw, u);
  }
  const seriesIds = [...new Set(units.values())].filter((id) => !isGroupId(id));
  if (seriesIds.length) {
    const found = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM series WHERE id IN (${seriesIds.map(() => "?").join(",")})`
    )
      .bind(...seriesIds)
      .first<{ n: number }>();
    if ((found?.n ?? 0) !== seriesIds.length) return notFound("シリーズが見つかりません");
  }

  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  const merged: string[] = [];
  let target = units.get(targetRaw)!;
  let created: string | null = null;
  if (isGroupId(target)) {
    const g = await loadGroup(env, target.slice(1));
    if (!g) return notFound(`シリーズが見つかりません: ${targetRaw}`);
    created = await nextCustomSeriesId(env);
    stmts.push(
      ...createCustomSeriesStmts(env, created, name ? { ...g, title: name } : g, now),
      ...linkStmts(env, g.isbns, created, now)
    );
    merged.push(target);
    target = created;
  }
  for (const raw of absorbedRaw) {
    const a = units.get(raw)!;
    if (a === target || a === units.get(targetRaw) || merged.includes(a)) continue;
    merged.push(a);
    if (isGroupId(a)) {
      const g = await loadGroup(env, a.slice(1));
      if (g) stmts.push(...linkStmts(env, g.isbns, target, now));
      continue;
    }
    stmts.push(env.DB.prepare(`UPDATE series_merge SET target_id = ? WHERE target_id = ?`).bind(target, a));
    stmts.push(
      env.DB.prepare(
        `INSERT INTO series_merge (absorbed_id, target_id, created_at) VALUES (?, ?, ?)
         ON CONFLICT (absorbed_id) DO UPDATE SET target_id = excluded.target_id, created_at = excluded.created_at`
      ).bind(a, target, now)
    );
  }
  if (!stmts.length || (created && merged.length < 2)) return badRequest("既に結合済みです");
  stmts.push(env.DB.prepare(CLEANUP_MERGE_REQUESTS_SQL));
  await env.DB.batch(stmts);
  return json({ ok: true, target_id: target, absorbed_ids: merged, created_series: created });
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

/** 巻の紐付け（グループを結合したもの）の一覧。1 回の結合で紐付けた ISBN を
 *  (series_id, created_at) でまとめて新しい順に返す。解除の導線用。 */
export async function adminListLinks(env: Env, opts: PageOpts): Promise<Response> {
  const total =
    (
      await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM (SELECT 1 FROM volume_series_link GROUP BY series_id, created_at)`
      ).first<{ n: number }>()
    )?.n ?? 0;
  const res = await env.DB.prepare(
    `SELECT g.*, COALESCE(fo.name, fs.name) AS from_series_name
       FROM (SELECT l.series_id, l.created_at, COUNT(*) AS isbn_count,
                    json_group_array(DISTINCT v.title) AS titles,
                    COALESCE(o.name, s.name) AS series_name,
                    EXISTS(SELECT 1 FROM custom_series cs WHERE cs.id = l.series_id) AS custom,
                    MAX(l.from_series_id) AS from_series_id
               FROM volume_series_link l
               LEFT JOIN volumes v ON v.isbn = l.isbn
               LEFT JOIN series s ON s.id = l.series_id
               LEFT JOIN series_name_override o ON o.series_id = l.series_id
              GROUP BY l.series_id, l.created_at
              ORDER BY l.created_at DESC LIMIT ? OFFSET ?) g
       LEFT JOIN series fs ON fs.id = g.from_series_id
       LEFT JOIN series_name_override fo ON fo.series_id = g.from_series_id
      ORDER BY g.created_at DESC`
  )
    .bind(opts.per, opts.offset)
    .all<{
      series_id: string;
      created_at: number;
      isbn_count: number;
      titles: string | null;
      series_name: string | null;
      custom: number;
      from_series_id: string | null;
      from_series_name: string | null;
    }>();
  const links = (res.results ?? []).map((r) => ({
    series_id: r.series_id,
    created_at: r.created_at,
    isbn_count: r.isbn_count,
    // 書名に「,」を含むことがあるので JSON 配列で受ける（巻が消えた ISBN は null）。
    titles: (JSON.parse(r.titles ?? "[]") as (string | null)[]).filter((t): t is string => !!t),
    series_name: r.series_name ?? "",
    custom: !!r.custom,
    // 分離（別の版を独自シリーズへ移したもの）なら分離元。null はシリーズ無しの巻の紐付け。
    from_series_id: r.from_series_id,
    from_series_name: r.from_series_name ?? "",
  }));
  return json({ links, total, page: opts.page, per: opts.per }, 200, { "cache-control": "no-store" });
}

/** 紐付けを解除する（その回に紐付けた巻を元に戻す: シリーズ無しの巻はシリーズ無しに、分離した
 *  巻は分離元に）。独自シリーズに巻も結合も残らなければ独自シリーズごと消す。 */
export async function adminUnlinkVolumes(env: Env, seriesId: string, createdAt: number): Promise<Response> {
  const res = await env.DB.prepare(
    `SELECT isbn FROM volume_series_link WHERE series_id = ? AND created_at = ?`
  )
    .bind(seriesId, createdAt)
    .all<{ isbn: string }>();
  const isbns = (res.results ?? []).map((r) => r.isbn);
  if (!isbns.length) return notFound("紐付けが見つかりません");

  // 戻し先は紐付けの行から引くので、行を消す前に volumes を戻す。
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < isbns.length; i += CHUNK) {
    const chunk = isbns.slice(i, i + CHUNK);
    stmts.push(
      env.DB.prepare(
        `UPDATE volumes SET series_id = (SELECT l.from_series_id FROM volume_series_link l WHERE l.isbn = volumes.isbn)
          WHERE series_id = ? AND isbn IN (${chunk.map(() => "?").join(",")})`
      ).bind(seriesId, ...chunk)
    );
  }
  stmts.push(
    env.DB.prepare(`DELETE FROM volume_series_link WHERE series_id = ? AND created_at = ?`).bind(seriesId, createdAt)
  );
  await env.DB.batch(stmts);

  let removedSeries = false;
  const orphan = await env.DB.prepare(
    `SELECT 1 AS x FROM custom_series cs
      WHERE cs.id = ?1
        AND NOT EXISTS (SELECT 1 FROM volumes v WHERE v.series_id = ?1)
        AND NOT EXISTS (SELECT 1 FROM series_merge m WHERE m.target_id = ?1 OR m.absorbed_id = ?1)`
  )
    .bind(seriesId)
    .first();
  if (orphan) {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM custom_series WHERE id = ?`).bind(seriesId),
      env.DB.prepare(`DELETE FROM series WHERE id = ?`).bind(seriesId),
      env.DB.prepare(`DELETE FROM series_name_override WHERE series_id = ?`).bind(seriesId),
    ]);
    removedSeries = true;
  }
  return json({ ok: true, isbns: isbns.length, removed_series: removedSeries });
}

/** 分離の画面用: シリーズ（結合済みなら全 member）の巻を ISBN ごとに返す。巻一覧の API は
 *  同じ巻番号の ISBN を 1 巻にまとめてしまうので、別の版を 1 冊ずつ選べるよう生の行を返す。 */
export async function adminSplitSourceVolumes(env: Env, seriesId: string): Promise<Response> {
  if (isGroupId(seriesId)) return badRequest("シリーズに属さないまとまりは分離できません");
  const target = await resolveMergeTarget(env, seriesId);
  const meta = await env.DB.prepare(
    `SELECT s.id, COALESCE(o.name, s.name) AS name, s.creator, s.publisher, s.label
       FROM series s LEFT JOIN series_name_override o ON o.series_id = s.id WHERE s.id = ?`
  )
    .bind(target)
    .first<{ id: string; name: string; creator: string | null; publisher: string | null; label: string | null }>();
  if (!meta) return notFound("シリーズが見つかりません");
  const members = await mergeMembers(env, target);
  // 閲覧者の分離依頼で「別の版」と選ばれた回数も添える（画面で依頼された巻を選んだ状態にする）。
  const res = await env.DB.prepare(
    `SELECT v.isbn, v.series_id, v.volume_number, v.vol_sort, v.title, v.label, v.pubdate,
            COALESCE(r.report_count, 0) AS report_count
       FROM volumes v
       LEFT JOIN series_split_request r ON r.series_id = ? AND r.isbn = v.isbn
      WHERE v.series_id IN (${members.map(() => "?").join(",")})
      ORDER BY v.vol_sort, v.pubdate, v.isbn`
  )
    .bind(target, ...members)
    .all<{
      isbn: string;
      series_id: string;
      volume_number: string | null;
      vol_sort: number | null;
      title: string;
      label: string | null;
      pubdate: string | null;
      report_count: number;
    }>();
  return json(
    { series_id: meta.id, name: meta.name, creator: meta.creator ?? "", label: meta.label ?? "", volumes: res.results ?? [] },
    200,
    { "cache-control": "no-store" }
  );
}

/** シリーズを分離する。body: { source_id, isbns: [], name }。選んだ ISBN を新しい独自シリーズ
 *  （名前は name、著者・出版社・レーベルは分離元から）へ移す。結合済みのシリーズなら全 member の巻
 *  から選べ、巻ごとに今いる member を分離元として記録する。全巻を移すことはできない。 */
export async function adminSplitSeries(request: Request, env: Env): Promise<Response> {
  const body = (await readJsonObject(request)) as { source_id?: unknown; isbns?: unknown; name?: unknown };
  const sourceRaw = typeof body.source_id === "string" ? body.source_id : "";
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 200) : "";
  const isbns = Array.isArray(body.isbns)
    ? [...new Set(body.isbns.filter((x): x is string => typeof x === "string"))]
    : [];
  if (!ID_RE.test(sourceRaw) || isGroupId(sourceRaw)) return badRequest("source_id が不正です");
  if (!isbns.length || !isbns.every((i) => /^\d{13}$/.test(i))) return badRequest("isbns が不正です");
  if (!name) return badRequest("名前を入力してください");

  const target = await resolveMergeTarget(env, sourceRaw);
  const meta = await env.DB.prepare(`SELECT creator, publisher, label FROM series WHERE id = ?`)
    .bind(target)
    .first<{ creator: string | null; publisher: string | null; label: string | null }>();
  if (!meta) return notFound("シリーズが見つかりません");
  const members = await mergeMembers(env, target);
  const inMembers = members.map(() => "?").join(",");
  const total =
    (
      await env.DB.prepare(`SELECT COUNT(*) AS n FROM volumes WHERE series_id IN (${inMembers})`)
        .bind(...members)
        .first<{ n: number }>()
    )?.n ?? 0;

  // 選んだ ISBN が分離元の巻であることを確かめ、今いる member ごとに分ける。
  const fromOf = new Map<string, string[]>();
  for (let i = 0; i < isbns.length; i += CHUNK) {
    const chunk = isbns.slice(i, i + CHUNK);
    const res = await env.DB.prepare(
      `SELECT isbn, series_id FROM volumes
        WHERE series_id IN (${inMembers}) AND isbn IN (${chunk.map(() => "?").join(",")})`
    )
      .bind(...members, ...chunk)
      .all<{ isbn: string; series_id: string }>();
    for (const r of res.results ?? []) {
      const list = fromOf.get(r.series_id);
      if (list) list.push(r.isbn);
      else fromOf.set(r.series_id, [r.isbn]);
    }
  }
  const found = [...fromOf.values()].reduce((n, l) => n + l.length, 0);
  if (found !== isbns.length) return badRequest("このシリーズの巻ではない ISBN が含まれています");
  if (found >= total) return badRequest("全ての巻は分離できません");

  const now = Date.now();
  const created = await nextCustomSeriesId(env);
  const stmts: D1PreparedStatement[] = createCustomSeriesStmts(
    env,
    created,
    { title: name, creator: meta.creator ?? "", publisher: meta.publisher ?? "", label: meta.label ?? "" },
    now
  );
  for (const [from, list] of fromOf) stmts.push(...linkStmts(env, list, created, now, from));
  // 移した巻への分離依頼は片付く（残りの巻への依頼は管理者が却下するまで残す）。
  for (let i = 0; i < isbns.length; i += CHUNK) {
    const chunk = isbns.slice(i, i + CHUNK);
    stmts.push(
      env.DB.prepare(
        `DELETE FROM series_split_request WHERE series_id = ? AND isbn IN (${chunk.map(() => "?").join(",")})`
      ).bind(target, ...chunk)
    );
  }
  await env.DB.batch(stmts);
  return json({ ok: true, source_id: target, created_series: created, isbns: found });
}

/** 分離依頼の一覧（シリーズ単位、最後の依頼が新しい順）。依頼された巻（巻番号・依頼回数）を
 *  添えて返す。分離するときは分離の画面に読み込み直す（依頼された巻が選ばれた状態で開く）。 */
export async function adminListSplitRequests(env: Env, opts: PageOpts): Promise<Response> {
  const total =
    (await env.DB.prepare(`SELECT COUNT(DISTINCT series_id) AS n FROM series_split_request`).first<{ n: number }>())
      ?.n ?? 0;
  const res = await env.DB.prepare(
    `SELECT g.series_id, g.report_count, g.isbn_count, g.first_reported_at, g.last_reported_at,
            COALESCE(o.name, s.name) AS name, s.label,
            (SELECT COUNT(*) FROM volumes v WHERE v.series_id = g.series_id
                OR v.series_id IN (SELECT absorbed_id FROM series_merge WHERE target_id = g.series_id)) AS volume_count
       FROM (SELECT series_id, MAX(report_count) AS report_count, COUNT(*) AS isbn_count,
                    MIN(first_reported_at) AS first_reported_at, MAX(last_reported_at) AS last_reported_at
               FROM series_split_request GROUP BY series_id
              ORDER BY last_reported_at DESC LIMIT ? OFFSET ?) g
       LEFT JOIN series s ON s.id = g.series_id
       LEFT JOIN series_name_override o ON o.series_id = g.series_id
      ORDER BY g.last_reported_at DESC`
  )
    .bind(opts.per, opts.offset)
    .all<{
      series_id: string;
      report_count: number;
      isbn_count: number;
      first_reported_at: number;
      last_reported_at: number;
      name: string | null;
      label: string | null;
      volume_count: number;
    }>();
  const rows = res.results ?? [];
  // 依頼された巻の中身（巻番号）。ページ内のシリーズ分だけ引く。
  const vols = new Map<string, { isbn: string; volume_number: string; pubdate: string; report_count: number }[]>();
  if (rows.length) {
    const ids = rows.map((r) => r.series_id);
    const vr = await env.DB.prepare(
      `SELECT r.series_id, r.isbn, r.report_count, v.volume_number, v.pubdate
         FROM series_split_request r LEFT JOIN volumes v ON v.isbn = r.isbn
        WHERE r.series_id IN (${ids.map(() => "?").join(",")})
        ORDER BY r.series_id, v.vol_sort, v.pubdate, r.isbn`
    )
      .bind(...ids)
      .all<{ series_id: string; isbn: string; report_count: number; volume_number: string | null; pubdate: string | null }>();
    for (const v of vr.results ?? []) {
      const list = vols.get(v.series_id) ?? [];
      list.push({ isbn: v.isbn, volume_number: v.volume_number ?? "", pubdate: v.pubdate ?? "", report_count: v.report_count });
      vols.set(v.series_id, list);
    }
  }
  const requests = rows.map((r) => ({
    series_id: r.series_id,
    name: r.name ?? "",
    label: r.label ?? "",
    volume_count: r.volume_count,
    report_count: r.report_count,
    isbn_count: r.isbn_count,
    first_reported_at: r.first_reported_at,
    last_reported_at: r.last_reported_at,
    volumes: vols.get(r.series_id) ?? [],
  }));
  return json({ requests, total, page: opts.page, per: opts.per }, 200, { "cache-control": "no-store" });
}

/** 分離依頼を却下する（そのシリーズへの依頼を全て消す）。 */
export async function adminDismissSplitRequest(env: Env, seriesId: string): Promise<Response> {
  const res = await env.DB.prepare(`DELETE FROM series_split_request WHERE series_id = ?`).bind(seriesId).run();
  if (!(res.meta?.changes ?? 0)) return notFound("依頼が見つかりません");
  return json({ ok: true, series_id: seriesId });
}
