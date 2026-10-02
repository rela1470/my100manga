import { Env } from "./types";
import { json, notFound, normTitle, baseTitle, escapeLikeClamped, LIKE_MAX_BYTES } from "./util";
import { readCachedCovers } from "./covers";

// シリーズに属さない巻のまとまり（グループ）と、独自シリーズ。
//
// MADB の巻の ~20% は schema:isPartOf を持たず（volumes.series_id IS NULL）、どのシリーズにも
// 入らない。検索はこれを「正規化した書名 + 著者」でまとめてカードにしている（search.ts
// discoverUnlinked）。ここではそのまとまりに疑似 ID「G<ISBN>」を振り、シリーズと同じ
// 導線（巻一覧・本の詳細からのリンク・結合依頼・管理者の結合）に乗せる。G の後ろはグループ内の
// どの巻の ISBN でもよく（どれからでも同じグループを引ける）、正規形は最小の ISBN。
//
// 管理者が結合を確定すると、グループの巻を volume_series_link に ISBN 単位で記録し、
// volumes.series_id を書き換えて既存シリーズの巻にする。結合先にシリーズが無い（グループ
// 同士の結合）ときは、残す側のグループから独自シリーズ（custom_series, ID「U000001」）を作り
// series テーブルにも載せる。series / volumes は月次の取り込みで作り直されるので、取り込み後に
// APPLY_LINKS_SQL で載せ直す（scripts/ingest.mjs）。See db/schema.sql。

export const GROUP_RE = /^G(\d{13})$/;
export const isGroupId = (id: string): boolean => GROUP_RE.test(id);
/** 独自シリーズ（custom_series）の ID。MADB の C-id とは接頭辞で区別できる。独自シリーズは
 *  別々の本（キャラクターブック各冊など）を束ねるので、巻のタイトルをシリーズ名で揃えず、
 *  巻番号が同じでも書名が違えば別の巻として扱う（series.ts / listItems.ts）。 */
export const isCustomSeriesId = (id: string): boolean => /^U\d{6,}$/.test(id);

// D1 の bind パラメータ上限を避けるための IN 句チャンク（merge.ts と同じ）。
const CHUNK = 90;

/** 独自シリーズを series に、ISBN の紐付けを volumes に反映する（冪等）。取り込み直後・
 *  ダンプのリストア時に流す。マスタが自分でシリーズを付けた巻（series_id NOT NULL）は
 *  上書きしない。scripts/ingest.mjs・scripts/dump-series-merge.mjs に同じ SQL がある。 */
export const APPLY_LINKS_SQL = [
  `INSERT OR REPLACE INTO series (id, name, name_norm, name_kana, name_kana_norm, creator, publisher, label, num_items)
     SELECT id, name, name_norm, NULL, NULL, creator, publisher, label, NULL FROM custom_series`,
  `UPDATE volumes SET series_id = (SELECT l.series_id FROM volume_series_link l WHERE l.isbn = volumes.isbn)
    WHERE series_id IS NULL AND isbn IN (SELECT isbn FROM volume_series_link)`,
];

export interface GroupRow {
  isbn: string;
  volume_number: string | null;
  vol_sort: number | null;
  title: string;
  creator: string | null;
  publisher: string | null;
  label: string | null;
  pubdate: string | null;
}

export interface GroupVolume {
  isbn: string;
  isbns: string[];
  volume_number: string;
  vol_sort: number;
  title: string;
  author: string;
  publisher: string;
  label: string;
  pubdate: string;
  cover_url: string;
  correction: boolean;
}

export interface UnlinkedGroup {
  id: string; // "G" + グループ内で最小の ISBN
  title: string;
  creator: string;
  publisher: string;
  label: string;
  isbns: string[]; // 通常版/特装版などの兄弟 ISBN も含む全 ISBN
  volumes: GroupVolume[]; // 巻番号単位にまとめたもの（読み順）
}

/** 同じグループの行（正規化した書名・著者が同じ）を巻番号単位にまとめてグループにする。
 *  `rows` は全て同じグループのもの。cover は呼び出し側で読んだキャッシュから引く。 */
export function buildGroup(rows: GroupRow[], covers: Map<string, string>): UnlinkedGroup {
  const vols = new Map<string, { rep: GroupRow; isbns: string[] }>();
  for (const v of rows) {
    const key = v.volume_number ? `n:${v.volume_number}` : `i:${v.isbn}`;
    const slot = vols.get(key);
    if (slot) slot.isbns.push(v.isbn);
    else vols.set(key, { rep: v, isbns: [v.isbn] });
  }
  const first = rows[0];
  const creator = first?.creator ?? "";
  const pickCover = (isbns: string[]) => {
    for (const i of isbns) {
      const c = covers.get(i);
      if (c) return c;
    }
    return "";
  };
  const volumes: GroupVolume[] = [...vols.values()]
    .map(({ rep, isbns }) => ({
      isbn: rep.isbn,
      isbns,
      volume_number: rep.volume_number ?? "",
      vol_sort: rep.vol_sort ?? 0,
      title: rep.title,
      author: rep.creator ?? creator,
      publisher: rep.publisher ?? "",
      label: rep.label ?? "",
      pubdate: rep.pubdate ?? "",
      cover_url: pickCover(isbns),
      correction: false,
    }))
    .sort(
      (a, b) => a.vol_sort - b.vol_sort || a.pubdate.localeCompare(b.pubdate) || a.isbn.localeCompare(b.isbn)
    );
  const isbns = rows.map((r) => r.isbn);
  const head = volumes[0];
  return {
    id: "G" + [...isbns].sort()[0],
    title: first?.title ?? "",
    creator,
    publisher: head?.publisher ?? "",
    label: head?.label ?? "",
    isbns,
    volumes,
  };
}

/** isbn を含むグループ。isbn がシリーズ無しのマスタ巻でなければ null。
 *  シリーズ無しの巻（~11 万行）を書名の前方一致で絞り、正規化した書名・著者の一致を JS で
 *  確かめる（検索の discoverUnlinked と同じ粒度）。 */
export async function loadGroup(env: Env, isbn: string): Promise<UnlinkedGroup | null> {
  const seed = await env.DB.prepare(
    `SELECT title, creator FROM volumes WHERE isbn = ? AND series_id IS NULL`
  )
    .bind(isbn)
    .first<{ title: string; creator: string | null }>();
  if (!seed) return null;
  const nt = normTitle(seed.title);
  const nc = normTitle(seed.creator ?? "");
  const res = await env.DB.prepare(
    `SELECT isbn, volume_number, vol_sort, title, creator, publisher, label, pubdate
       FROM volumes
      WHERE series_id IS NULL
        AND REPLACE(REPLACE(title, ' ', ''), '　', '') LIKE ? ESCAPE '\\'
      ORDER BY vol_sort, pubdate, isbn`
  )
    // 起点の巻の書名そのもの（空白だけ除く）で前方一致させ、起点が必ず引っかかるようにする。
    // normTitle の小文字化は全角英字にも効くが SQLite の LIKE は ASCII しか大小を無視しない。
    .bind(escapeLikeClamped(seed.title.replace(/[ 　]+/g, ""), LIKE_MAX_BYTES - 1) + "%")
    .all<GroupRow>();
  const rows = (res.results ?? []).filter(
    (r) => normTitle(r.title) === nt && normTitle(r.creator ?? "") === nc
  );
  if (!rows.length) return null;
  const covers = await readCachedCovers(env, rows.map((r) => r.isbn));
  return buildGroup(rows, covers);
}

/** シリーズ無しの巻の書名が、既存のどのシリーズに属すると見なせるか（書名 → シリーズ ID、
 *  見なせなければ null）。正規化した書名がちょうど 1 つのシリーズ名と一致すればそれ、複数なら
 *  決められないので null、無ければ「:」「=」以降を除いた基本書名で同じ判定をやり直す。
 *  getSeriesVolumes はこの条件の巻をシリーズの巻一覧に混ぜるので、検索・本の詳細でも同じ
 *  シリーズへ寄せる。結合済み（series_merge）の読み替えは呼び出し側で行う。 */
export async function attributeTitles(env: Env, titles: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const uniq = [...new Set(titles)];
  if (!uniq.length) return out;

  // 完全一致: idx_series_name_norm を引く 1 往復。
  const norms = [...new Set(uniq.map(normTitle))];
  const idsByNorm = new Map<string, string[]>();
  for (let i = 0; i < norms.length; i += CHUNK) {
    const chunk = norms.slice(i, i + CHUNK);
    const res = await env.DB.prepare(
      `SELECT id, name_norm FROM series WHERE name_norm IN (${chunk.map(() => "?").join(",")})`
    )
      .bind(...chunk)
      .all<{ id: string; name_norm: string }>();
    for (const r of res.results ?? []) {
      const arr = idsByNorm.get(r.name_norm);
      if (arr) arr.push(r.id);
      else idsByNorm.set(r.name_norm, [r.id]);
    }
  }

  const needsBase: string[] = [];
  for (const t of uniq) {
    const ids = idsByNorm.get(normTitle(t));
    if (ids && ids.length === 1) out.set(t, ids[0]);
    else if (ids && ids.length > 1) out.set(t, null);
    else needsBase.push(t);
  }

  // 基本書名: name_norm LIKE base||'%' で拾い（前方一致なので索引が効く）、baseTitle(name)
  // === base を JS で確かめて「…外伝」のような長い基本書名の兄弟を除く。1 つだけなら確定。
  const idsByBase = new Map<string, Set<string>>();
  for (const base of new Set(needsBase.map(baseTitle).filter(Boolean))) {
    const r = await env.DB.prepare(`SELECT id, name FROM series WHERE name_norm LIKE ? ESCAPE '\\'`)
      // 長い基本書名は D1 の LIKE バイト上限を超えるので短い前方一致に詰める（下の再判定で
      // 一致は厳密に保たれる）。
      .bind(escapeLikeClamped(base, LIKE_MAX_BYTES - 1) + "%")
      .all<{ id: string; name: string }>();
    const set = new Set<string>();
    for (const row of r.results ?? []) if (baseTitle(row.name) === base) set.add(row.id);
    idsByBase.set(base, set);
  }
  for (const t of needsBase) {
    const base = baseTitle(t);
    const ids = base ? idsByBase.get(base) : undefined;
    out.set(t, ids && ids.size === 1 ? [...ids][0] : null);
  }
  return out;
}

/** G-id のグループが今どこに属するか。
 *  - グループがあり既存シリーズに寄せられる → そのシリーズ ID（結合の読み替えは呼び出し側）
 *  - グループがあり寄せ先が無い → グループの正規 ID（G + 最小 ISBN）
 *  - グループが無い（紐付け済み・マスタ側でシリーズが付いた）→ その巻の series_id
 *  - その ISBN がマスタに無い → null */
export async function resolveGroup(
  env: Env,
  id: string
): Promise<{ seriesId: string } | { group: UnlinkedGroup } | null> {
  const isbn = id.slice(1);
  const group = await loadGroup(env, isbn);
  if (group) {
    const attributed = (await attributeTitles(env, [group.title])).get(group.title);
    return attributed ? { seriesId: attributed } : { group };
  }
  const row = await env.DB.prepare(`SELECT series_id FROM volumes WHERE isbn = ?`)
    .bind(isbn)
    .first<{ series_id: string | null }>();
  return row?.series_id ? { seriesId: row.series_id } : null;
}

/** GET /api/series/G…/volumes。既存シリーズに寄せられる・紐付け済みのグループは
 *  `openSeries` でそのシリーズを開く（レスポンスの series_id が変わり、クライアントは結合済みと
 *  同じく読み替える）。それ以外はグループの巻を getSeriesVolumes と同じ形で返す。 */
export async function getGroupVolumes(
  env: Env,
  id: string,
  openSeries: (seriesId: string) => Promise<Response>,
  masterUpdatedAt: () => Promise<number>
): Promise<Response> {
  const r = await resolveGroup(env, id);
  if (!r) return notFound("シリーズが見つかりません");
  if ("seriesId" in r) return openSeries(r.seriesId);
  const g = r.group;
  return json(
    {
      series_id: g.id,
      title: g.title,
      creator: g.creator,
      publisher: g.publisher,
      group: true,
      supplement_probed: true,
      supplement_checked_at: 0,
      master_updated_at: await masterUpdatedAt(),
      volumes: g.volumes,
    },
    200,
    { "cache-control": "no-store" }
  );
}

/** 次の独自シリーズ ID（U + 6 桁の連番）。 */
export async function nextCustomSeriesId(env: Env): Promise<string> {
  const row = await env.DB.prepare(`SELECT id FROM custom_series ORDER BY id DESC LIMIT 1`).first<{ id: string }>();
  const n = row ? parseInt(row.id.slice(1), 10) + 1 : 1;
  return "U" + String(n).padStart(6, "0");
}

/** グループから独自シリーズを作る文（custom_series と、即時反映のための series 行）。 */
export function createCustomSeriesStmts(env: Env, id: string, g: UnlinkedGroup, now: number): D1PreparedStatement[] {
  const nn = normTitle(g.title);
  return [
    env.DB.prepare(
      `INSERT INTO custom_series (id, name, name_norm, creator, publisher, label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, g.title, nn, g.creator, g.publisher, g.label, now),
    env.DB.prepare(
      `INSERT OR REPLACE INTO series (id, name, name_norm, name_kana, name_kana_norm, creator, publisher, label, num_items)
       VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, NULL)`
    ).bind(id, g.title, nn, g.creator, g.publisher, g.label),
  ];
}

/** ISBN をシリーズに紐付ける文（volume_series_link への記録と volumes への即時反映）。 */
export function linkStmts(env: Env, isbns: string[], seriesId: string, now: number): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  const ins = env.DB.prepare(
    `INSERT INTO volume_series_link (isbn, series_id, created_at) VALUES (?, ?, ?)
     ON CONFLICT (isbn) DO UPDATE SET series_id = excluded.series_id, created_at = excluded.created_at`
  );
  for (const i of isbns) stmts.push(ins.bind(i, seriesId, now));
  for (let i = 0; i < isbns.length; i += CHUNK) {
    const chunk = isbns.slice(i, i + CHUNK);
    stmts.push(
      env.DB.prepare(
        `UPDATE volumes SET series_id = ? WHERE series_id IS NULL AND isbn IN (${chunk.map(() => "?").join(",")})`
      ).bind(seriesId, ...chunk)
    );
  }
  return stmts;
}
