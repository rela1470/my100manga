import { Env } from "./types";
import {
  json,
  notFound,
  normTitle,
  baseTitle,
  escapeLikeClamped,
  LIKE_MAX_BYTES,
  plainVolumeNumber,
  unifyVolumeLabel,
  volumeLabelTemplate,
  workKey,
} from "./util";
import { readCachedCovers } from "./covers";

/** series.name_norm の前方一致を idx_series_name_norm で引く WHERE 句。同じ前方一致文字列を 2 回
 *  bind する（下限と上限）。SQLite の LIKE は既定で ASCII の大小を無視するため BINARY の索引では
 *  LIKE 'x%' の前方一致最適化が効かず、シリーズ全行（~14 万）のスキャンになっていた。name_norm と
 *  前方一致文字列はどちらも normTitle 済み（小文字）なので、範囲比較で LIKE と同じ行が引ける。
 *  上限の char(1114111) は Unicode の最大の文字。LIKE のバイト上限も関係なくなる。 */
export const NAME_NORM_PREFIX = `name_norm >= ? AND name_norm < ? || char(1114111)`;

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
 *  ダンプのリストア時に流す。巻が紐付けたときと同じシリーズにいるときだけ書き換える:
 *  シリーズ無しの巻の紐付け（from_series_id NULL）はマスタがまだシリーズを付けていない巻だけ、
 *  分離（from_series_id = 分離元）はマスタがまだ分離元に入れている巻だけ。マスタが自分で
 *  付け替えた巻はそちらを優先する。scripts/ingest.mjs・scripts/dump-series-merge.mjs に同じ SQL がある。 */
export const APPLY_LINKS_SQL = [
  `INSERT OR REPLACE INTO series (id, name, name_norm, name_kana, name_kana_norm, creator, publisher, label, num_items)
     SELECT id, name, name_norm, NULL, NULL, creator, publisher, label, NULL FROM custom_series`,
  `UPDATE volumes SET series_id = (SELECT l.series_id FROM volume_series_link l WHERE l.isbn = volumes.isbn)
    WHERE isbn IN (SELECT isbn FROM volume_series_link)
      AND series_id IS (SELECT l.from_series_id FROM volume_series_link l WHERE l.isbn = volumes.isbn)`,
];

/** シリーズ無しの巻のまとまりの単位: 正規化した書名 + 著者 + レーベル。レーベルを入れるのは、
 *  同じ書名・著者の別版（キングダムの本編「ヤングジャンプコミックス」と「愛蔵版コミックス」など）を
 *  1 つのまとまりに混ぜないため。混ざると結合で別版の ISBN が本編の同じ巻番号に紐付いてしまう。
 *  レーベルの表記ゆれ（「ヤングジャンプ・コミックス」/「ヤングジャンプコミックス」）は中黒・空白を
 *  除いて吸収する。検索（search.ts discoverUnlinked）・売上ランキングもこの単位でまとめる。 */
export function groupKey(v: { title: string; creator: string | null; label: string | null }): string {
  const label = (v.label ?? "").replace(/[\s　・･]+/g, "").toLowerCase();
  return `${normTitle(v.title)} ${normTitle(v.creator ?? "")} ${label}`;
}

export interface GroupRow {
  isbn: string;
  volume_number: string | null;
  vol_sort: number | null;
  title: string;
  subtitle?: string | null; // 巻の副題（db/add-volume-subtitle.sql）
  creator: string | null;
  creators?: string | null; // display credit line (see db/add-creators.sql); not every query selects it
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
  subtitle: string; // 巻の副題。同じ巻番号の別作品はこれでしか見分けられない
  author: string;
  creators: string; // 役割付きの全作者（巻一覧の表示用）。無ければ author と同じ
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
  creators: string; // 役割付きの全作者表記。無ければ creator と同じ
  publisher: string;
  label: string;
  isbns: string[]; // 通常版/特装版などの兄弟 ISBN も含む全 ISBN
  volumes: GroupVolume[]; // 巻番号単位にまとめたもの（読み順）
}

/** 同じグループの行（groupKey が同じ）を巻番号単位にまとめてグループにする。
 *  `rows` は全て同じグループのもの。cover は呼び出し側で読んだキャッシュから引く。 */
export function buildGroup(rows: GroupRow[], covers: Map<string, string>): UnlinkedGroup {
  // まとめる単位は巻番号＋作品（書名＋副題）。巻番号だけで畳むと「上」「下」しか巻番号を
  // 持たない別作品が 1 冊に潰れる。副題の無い行はどの副題とも矛盾しない行として同じ書名の巻に
  // 寄せる（同じ巻でも刷りによって副題が付かないことがある）。src/series.ts addToGroup と同じ規則。
  const vols = new Map<string, { rep: GroupRow; isbns: string[]; subtitle: string; titleKey: string; work: string }[]>();
  for (const v of rows) {
    const bucket = v.volume_number ? `n:${v.volume_number}` : `i:${v.isbn}`;
    let list = vols.get(bucket);
    if (!list) vols.set(bucket, (list = []));
    const sub = (v.subtitle ?? "").trim();
    const titleKey = workKey(v.title, "");
    const work = workKey(v.title, sub);
    let slot = list.find((x) => x.work === work);
    if (!slot && !sub) slot = list.find((x) => x.titleKey === titleKey);
    if (!slot && sub) {
      slot = list.find((x) => x.titleKey === titleKey && !x.subtitle);
      if (slot) {
        slot.subtitle = sub;
        slot.work = work;
      }
    }
    if (slot) slot.isbns.push(v.isbn);
    else list.push({ rep: v, isbns: [v.isbn], subtitle: sub, titleKey, work });
  }
  const first = rows[0];
  const creator = first?.creator ?? "";
  const creators = first?.creators || creator;
  const pickCover = (isbns: string[]) => {
    for (const i of isbns) {
      const c = covers.get(i);
      if (c) return c;
    }
    return "";
  };
  const volumes: GroupVolume[] = [...vols.values()]
    .flat()
    .map(({ rep, isbns, subtitle }) => ({
      isbn: rep.isbn,
      isbns,
      volume_number: rep.volume_number ?? "",
      vol_sort: rep.vol_sort ?? 0,
      title: rep.title,
      subtitle,
      author: rep.creator ?? creator,
      creators: rep.creators || rep.creator || creators,
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
    creators,
    publisher: head?.publisher ?? "",
    label: head?.label ?? "",
    isbns,
    volumes,
  };
}

/** isbn を含むグループ。isbn がシリーズ無しのマスタ巻でなければ null。
 *  シリーズ無しの巻（~11 万行）を書名の前方一致で絞り、groupKey（書名・著者・レーベル）の一致を
 *  JS で確かめる（検索の discoverUnlinked と同じ粒度）。 */
export async function loadGroup(env: Env, isbn: string): Promise<UnlinkedGroup | null> {
  const seed = await env.DB.prepare(
    `SELECT title, creator, label FROM volumes WHERE isbn = ? AND series_id IS NULL`
  )
    .bind(isbn)
    .first<{ title: string; creator: string | null; label: string | null }>();
  if (!seed) return null;
  const key = groupKey(seed);
  const res = await env.DB.prepare(
    `SELECT isbn, volume_number, vol_sort, title, subtitle, creator, creators, publisher, label, pubdate
       FROM volumes
      WHERE series_id IS NULL
        AND REPLACE(REPLACE(title, ' ', ''), '　', '') LIKE ? ESCAPE '\\'
      ORDER BY vol_sort, pubdate, isbn`
  )
    // 起点の巻の書名そのもの（空白だけ除く）で前方一致させ、起点が必ず引っかかるようにする。
    // normTitle の小文字化は全角英字にも効くが SQLite の LIKE は ASCII しか大小を無視しない。
    .bind(escapeLikeClamped(seed.title.replace(/[ 　]+/g, ""), LIKE_MAX_BYTES - 1) + "%")
    .all<GroupRow>();
  const rows = (res.results ?? []).filter((r) => groupKey(r) === key);
  if (!rows.length) return null;
  const covers = await readCachedCovers(env, rows.map((r) => r.isbn));
  return buildGroup(rows, covers);
}

/** シリーズ名 `name` と同じ作品かもしれない、どのシリーズにも寄せられていないグループ。
 *  シリーズの結合候補（merge.getMergeCandidates）に並べ、シリーズページから迷子の巻へ
 *  たどり着けるようにする。書名の基本書名（「=」「:」以降を除いたもの）が一致するものを拾う
 *  ので、素の「キングダム」に対して「キングダム = KINGDOM」の巻も候補になる。著者は問わない
 *  （判断は閲覧者と管理者に委ねる）。attributeTitles で既存シリーズに寄せられる書名は
 *  getSeriesVolumes がそのシリーズの巻一覧に混ぜ済みなので除く。 */
export async function unattributedGroupsFor(env: Env, name: string): Promise<UnlinkedGroup[]> {
  const base = baseTitle(name);
  if (!base) return [];
  const res = await env.DB.prepare(
    `SELECT isbn, volume_number, vol_sort, title, subtitle, creator, creators, publisher, label, pubdate
       FROM volumes
      WHERE series_id IS NULL
        AND REPLACE(REPLACE(LOWER(title), ' ', ''), '　', '') LIKE ? ESCAPE '\\'
      ORDER BY vol_sort, pubdate, isbn
      LIMIT 2000`
  )
    .bind(escapeLikeClamped(base, LIKE_MAX_BYTES - 1) + "%")
    .all<GroupRow>();
  const byKey = new Map<string, GroupRow[]>();
  for (const r of res.results ?? []) {
    if (baseTitle(r.title) !== base) continue;
    const k = groupKey(r);
    const g = byKey.get(k);
    if (g) g.push(r);
    else byKey.set(k, [r]);
  }
  if (!byKey.size) return [];
  const owner = await attributeTitles(env, [...byKey.values()].map((rows) => rows[0].title));
  return [...byKey.values()]
    .filter((rows) => !owner.get(rows[0].title))
    .map((rows) => buildGroup(rows, new Map()));
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

  // 基本書名: name_norm の前方一致（NAME_NORM_PREFIX、索引で引く）で拾い、baseTitle(name)
  // === base を JS で確かめて「…外伝」のような長い基本書名の兄弟を除く。1 つだけなら確定。
  const idsByBase = new Map<string, Set<string>>();
  for (const base of new Set(needsBase.map(baseTitle).filter(Boolean))) {
    const r = await env.DB.prepare(`SELECT id, name FROM series WHERE ${NAME_NORM_PREFIX}`)
      .bind(base, base)
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
  const volumes = await withGroupCorrections(env, g);
  return json(
    {
      series_id: g.id,
      title: g.title,
      creator: g.creator,
      creators: g.creators,
      publisher: g.publisher,
      group: true,
      supplement_probed: true,
      supplement_checked_at: 0,
      master_updated_at: await masterUpdatedAt(),
      volumes,
    },
    200,
    { "cache-control": "no-store" }
  );
}

/** グループの手動追加（series_correction）・非表示（volume_hidden）の行が使う ID。
 *  正規 ID（G + 最小 ISBN）で書くが、後からマスタに小さい ISBN の巻が入ると正規 ID が
 *  変わるので、読むときはグループのどの巻の ISBN の G-id でも拾う。 */
export const groupMemberIds = (g: Pick<UnlinkedGroup, "isbns">): string[] => g.isbns.map((i) => "G" + i);

/** グループの巻に手動追加の巻（マスタに 1・2巻が無い、など）を足し、管理者が確定で非表示に
 *  した巻を除く。getSeriesVolumes の訂正のマージと同じく、ISBN か巻番号が既にある巻は足さない。 */
async function withGroupCorrections(env: Env, g: UnlinkedGroup): Promise<GroupVolume[]> {
  const ids = groupMemberIds(g);
  const corrections: { isbn: string; volume_number: string; vol_sort: number; cover_url: string }[] = [];
  const hidden = new Set<string>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const inIds = chunk.map(() => "?").join(",");
    const [c, h] = await env.DB.batch([
      env.DB.prepare(
        `SELECT isbn, volume_number, vol_sort, cover_url FROM series_correction
          WHERE series_id IN (${inIds}) ORDER BY vol_sort, isbn`
      ).bind(...chunk),
      env.DB.prepare(`SELECT isbn FROM volume_hidden WHERE series_id IN (${inIds})`).bind(...chunk),
    ]);
    corrections.push(...((c.results ?? []) as typeof corrections));
    for (const r of (h.results ?? []) as { isbn: string }[]) hidden.add(r.isbn);
  }
  if (!corrections.length && !hidden.size) return g.volumes;

  const volumes = [...g.volumes];
  const knownIsbns = new Set(volumes.flatMap((v) => v.isbns));
  const knownPlain = new Set<number>();
  for (const v of volumes) {
    const p = plainVolumeNumber(v.volume_number);
    if (p !== null) knownPlain.add(p);
  }
  const template = volumeLabelTemplate(volumes.map((v) => v.volume_number).filter(Boolean));
  for (const c of corrections) {
    const plain = plainVolumeNumber(c.volume_number);
    if (knownIsbns.has(c.isbn) || (plain !== null && knownPlain.has(plain))) continue;
    knownIsbns.add(c.isbn);
    if (plain !== null) knownPlain.add(plain);
    volumes.push({
      isbn: c.isbn,
      isbns: [c.isbn],
      volume_number: unifyVolumeLabel(template, c.volume_number),
      vol_sort: c.vol_sort,
      title: g.title,
      subtitle: "", // 利用者のデータ修正に副題の欄は無い
      author: g.creator,
      creators: g.creators,
      publisher: "",
      label: "",
      pubdate: "",
      cover_url: c.cover_url,
      correction: true,
    });
  }
  return volumes
    .filter((v) => !v.isbns.some((i) => hidden.has(i)))
    .sort((a, b) => a.vol_sort - b.vol_sort || a.pubdate.localeCompare(b.pubdate) || a.isbn.localeCompare(b.isbn));
}

/** グループを結合したとき、グループに付いていた手動追加・非表示・通報を結合先へ移す文。 */
export function moveGroupRowsStmts(env: Env, g: Pick<UnlinkedGroup, "isbns">, seriesId: string): D1PreparedStatement[] {
  const ids = groupMemberIds(g);
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const inIds = chunk.map(() => "?").join(",");
    for (const table of ["series_correction", "volume_hidden", "volume_report"]) {
      stmts.push(
        env.DB.prepare(`UPDATE OR REPLACE ${table} SET series_id = ? WHERE series_id IN (${inIds})`).bind(
          seriesId,
          ...chunk
        )
      );
    }
  }
  return stmts;
}

/** 次の独自シリーズ ID（U + 6 桁の連番）。 */
export async function nextCustomSeriesId(env: Env): Promise<string> {
  const row = await env.DB.prepare(`SELECT id FROM custom_series ORDER BY id DESC LIMIT 1`).first<{ id: string }>();
  const n = row ? parseInt(row.id.slice(1), 10) + 1 : 1;
  return "U" + String(n).padStart(6, "0");
}

/** グループ（または分離元のシリーズ）から独自シリーズを作る文（custom_series と、即時反映の
 *  ための series 行）。 */
export function createCustomSeriesStmts(
  env: Env,
  id: string,
  g: Pick<UnlinkedGroup, "title" | "creator" | "publisher" | "label">,
  now: number
): D1PreparedStatement[] {
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

/** ISBN をシリーズに紐付ける文（volume_series_link への記録と volumes への即時反映）。
 *  fromSeriesId はシリーズの分離のとき、巻が今いる（マスタが付けた）シリーズ。省略時は
 *  シリーズ無しの巻の紐付け。 */
export function linkStmts(
  env: Env,
  isbns: string[],
  seriesId: string,
  now: number,
  fromSeriesId: string | null = null
): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  const ins = env.DB.prepare(
    `INSERT INTO volume_series_link (isbn, series_id, created_at, from_series_id) VALUES (?, ?, ?, ?)
     ON CONFLICT (isbn) DO UPDATE SET series_id = excluded.series_id, created_at = excluded.created_at,
       from_series_id = excluded.from_series_id`
  );
  for (const i of isbns) stmts.push(ins.bind(i, seriesId, now, fromSeriesId));
  for (let i = 0; i < isbns.length; i += CHUNK) {
    const chunk = isbns.slice(i, i + CHUNK);
    stmts.push(
      env.DB.prepare(
        `UPDATE volumes SET series_id = ? WHERE series_id IS ? AND isbn IN (${chunk.map(() => "?").join(",")})`
      ).bind(seriesId, fromSeriesId, ...chunk)
    );
  }
  return stmts;
}
