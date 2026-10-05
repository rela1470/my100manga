import { Env } from "./types";
import {
  json,
  notFound,
  normTitle,
  baseTitle,
  escapeLikeClamped,
  LIKE_MAX_BYTES,
  volumeLabelTemplate,
  plainVolumeNumber,
  unifyVolumeLabel,
  workKey,
} from "./util";
import { readCachedCovers, firstCover } from "./covers";
import { edgeCacheKey, purgeEdgeCache, withEdgeCache } from "./edgeCache";
import { getViewEpoch } from "./viewSnapshot";
import {
  getSupplementVolumes,
  readCachedSupplement,
  markSupplementProbed,
  writeSupplement,
  seriesFormat,
  NumFmt,
  SupplementVolume,
} from "./madbLive";
import { findGapFillVolumes } from "./gapFill";
import { findSiblingVolumes, SiblingVolume } from "./siblingVolumes";
import { getCorrectionVolumes } from "./corrections";
import { resolveMergeTarget, mergeMembers } from "./merge";
import { attributeTitles, isCustomSeriesId, NAME_NORM_PREFIX } from "./groups";
import { effectiveTagSql } from "./labels";

interface VolumeRow {
  isbn: string;
  volume_number: string | null;
  vol_sort: number | null;
  title: string;
  subtitle?: string | null; // 巻の副題（db/add-volume-subtitle.sql）。補完・修正の巻には無い
  creator: string | null;
  creators?: string | null; // display credit line (see db/add-creators.sql)
  publisher: string | null;
  label: string | null;
  pubdate: string | null;
}

interface OutVolume {
  isbn: string;
  isbns: string[];
  volume_number: string;
  vol_sort: number;
  title: string;
  subtitle: string; // 巻の副題（「獄門塾殺人事件」）。同じ巻番号の別作品はこれでしか見分けられない
  author: string;
  creators: string; // 役割付きの全作者（巻一覧の表示用）。無ければ author と同じ
  publisher: string;
  label: string;
  pubdate: string;
  cover_url: string;
  correction: boolean; // true = user-submitted correction (gets the "間違っています" flag)
}

// 巻一覧（GET /api/series/:id/volumes、まとまりの G<ISBN> も同じ）のエッジキャッシュ。1 回で
// D1 を 10 本ほど引く一番重い閲覧系で、検索結果から巻一覧を開くたびに走る。元になるマスタは
// 月次の取り込みでしか変わらず、管理者の変更（結合・名前修正・巻の非表示）は表示データの世代
// （src/viewSnapshot.ts view_epoch）でキーが変わるので、短く持つだけでよく当たる。応答に閲覧者
// 依存の値は含まれない（通報の有無などは入らない）のでデータセンタ単位で共有してよい。
// 利用者の手動追加・補完取得は書いた本人がすぐ見に来るので、その colo のキーをその場で消す。
const VOLUMES_EDGE_TTL_SEC = 60;

async function volumesCacheKey(env: Env, id: string): Promise<Request> {
  return edgeCacheKey(env, "/api/series/volumes", { id, e: await getViewEpoch(env) });
}

/** build() の結果を巻一覧のエッジキャッシュ越しに返す（200 のときだけ入れる）。 */
export async function cachedSeriesVolumes(
  env: Env,
  id: string,
  build: () => Promise<Response>
): Promise<Response> {
  return withEdgeCache(await volumesCacheKey(env, id), VOLUMES_EDGE_TTL_SEC, build);
}

/** この colo の巻一覧キャッシュを消す（手動追加・補完取得の直後）。他の colo は TTL 待ち。 */
export async function purgeSeriesVolumesCache(env: Env, id: string): Promise<void> {
  await purgeEdgeCache([await volumesCacheKey(env, id)]);
}

// All volumes of a series, in reading order. Powers the "add all volumes" button.
// `probe` controls the live-MADB supplement (see src/madbLive.ts). The default
// read (GET /volumes) is cache-only so it returns instantly and never blocks on
// SPARQL; the newest unlinked tankobon are fetched only when the user presses the
// 取得 button (POST /supplement, probe=true).
export async function getSeriesVolumes(
  env: Env,
  seriesId: string,
  probe = false
): Promise<Response> {
  // 管理者が結合したシリーズ（series_merge）: 吸収された側を開いたら残す側を返し、残す側は
  // 全 member の巻・訂正・非表示をまとめて扱う。補完(SPARQL)だけは target 単位のまま。
  const targetId = await resolveMergeTarget(env, seriesId);
  const members = await mergeMembers(env, targetId);
  const inMembers = members.map(() => "?").join(",");
  const meta = await env.DB.prepare(
    `SELECT s.id, s.name, s.name_norm, s.creator, s.creators, s.publisher, s.label, s.version,
            ${effectiveTagSql("s")} AS label_tag,
            o.name AS override_name
       FROM series s LEFT JOIN series_name_override o ON o.series_id = s.id
      WHERE s.id = ?`
  )
    .bind(targetId)
    .first<{
      id: string;
      name: string;
      name_norm: string;
      creator: string | null;
      creators: string | null;
      publisher: string | null;
      label: string | null;
      label_tag: string | null;
      version: string | null;
      override_name: string | null;
    }>();
  if (!meta) return notFound("シリーズが見つかりません");

  // Display title honors an admin correction (series_name_override); all internal
  // matching below (unlinked-volume merge, live supplement) keeps using the master
  // meta.name, since the volumes' schema:name still carries the original title.
  const displayName = meta.override_name || meta.name;

  const res = await env.DB.prepare(
    `SELECT isbn, volume_number, vol_sort, title, subtitle, creator, creators, publisher, label, pubdate
     FROM volumes WHERE series_id IN (${inMembers}) ORDER BY vol_sort, pubdate, isbn`
  )
    .bind(...members)
    .all<VolumeRow>();

  // MADB lists the same volume under several ISBNs (通常版/重版/特装版). Group them
  // by volume_number (volumes with no number key on their isbn so single-volume
  // works are never collapsed) so each volume appears once. Keep every sibling
  // ISBN so we can pick whichever one has a cover. Plain labels key on their number,
  // so one volume spelled "volume 84" / "Volume84" (名探偵コナン) still groups.
  // 巻番号だけでは足りない: 同じシリーズに「上」「下」しか巻番号を持たない別作品が並ぶことが
  // あり（金田一少年の事件簿は事件ごとに上下巻、まぼろし探偵は各編が上中下）、巻番号だけで
  // 畳むと 1 冊を残して巻一覧から消える。作品の区別は書名＋副題（volumes.subtitle、MADB の
  // schema:alternateName）。独自シリーズも元から書名で分けているので同じ扱いでよい。
  const custom = isCustomSeriesId(targetId);
  const volBucket = (v: VolumeRow): string => {
    if (!v.volume_number) return `i:${v.isbn}`;
    const p = plainVolumeNumber(v.volume_number);
    return p !== null ? `p:${p}` : `n:${v.volume_number}`;
  };
  interface VolGroup {
    rep: VolumeRow;
    isbns: string[];
    subtitle: string;
    titleKey: string; // 書名だけの正規形
    work: string; // 書名＋副題の正規形（util.ts workKey）
  }
  // 同じ巻番号の中で「同じ本か」を決める。書名＋副題が一致すれば同じ本（通常版/重版/特装版）。
  // 副題が無い行はどの副題とも矛盾しない行として扱い、書名が同じ既存の巻に寄せる: MADB は
  // 同じ巻の刷りによって副題を落としたり、作品ごとの副題ではなくシリーズの別名を
  // alternateName に入れたりする（七つの大罪の「the seven deadly sins」は一部の刷りだけ）。
  // これを別の巻にすると、同じ巻が 2 行に割れてしまう。
  const buckets = new Map<string, VolGroup[]>();
  const addToGroup = (v: VolumeRow) => {
    const bucket = volBucket(v);
    let list = buckets.get(bucket);
    if (!list) buckets.set(bucket, (list = []));
    const sub = (v.subtitle ?? "").trim();
    const titleKey = workKey(v.title, "");
    const work = workKey(v.title, sub);
    let g = list.find((x) => x.work === work);
    if (!g && !sub) g = list.find((x) => x.titleKey === titleKey);
    if (!g && sub) {
      // 先に入った副題無しの行が、この行の副題で正体の分かる巻だった場合。
      g = list.find((x) => x.titleKey === titleKey && !x.subtitle);
      if (g) {
        g.subtitle = sub;
        g.work = work;
      }
    }
    if (g) g.isbns.push(v.isbn);
    else list.push({ rep: v, isbns: [v.isbn], subtitle: sub, titleKey, work });
  };
  for (const v of res.results ?? []) addToGroup(v);

  // Fold in volumes that belong to this work but lost their schema:isPartOf in the dump
  // (series_id NULL). They carry the identical schema:name, so match on exact title —
  // only when this name maps to a single series, or same-titled works/editions would
  // steal each other's loose volumes (same guard as the SPARQL supplement below).
  // Unlike that supplement we do NOT filter by creator: 原作/作画 split works list a
  // different creator per volume (e.g. リュート vs 鍋島テツヒロ), and gating on the
  // master creator would drop one half. Duplicate volume_numbers just collapse into
  // sibling ISBNs of the volume already present, so no volume is double-counted.
  // 複数の fold（書名の完全一致・巻が名乗る書名・基本書名）が同じ行を拾うので、ISBN で一度だけ
  // 入れる。入れ直すと同じ巻の isbns に同じ ISBN が並ぶ。
  const foldedIsbns = new Set((res.results ?? []).map((v) => v.isbn));
  const foldUnlinked = (rows: VolumeRow[]) => {
    for (const v of rows) {
      if (foldedIsbns.has(v.isbn)) continue;
      foldedIsbns.add(v.isbn);
      addToGroup(v);
    }
  };

  // 結合済みなら member ごとに名前・レーベルが違う（例: C451211「One piece」/ C336558
  // 「ワンピース」）ので、下の 2 種類の fold は member 全員の (name, label) で行う。target の
  // 名前だけだと、吸収した側の名前で拾っていた迷子巻が結合でかえって消える。
  const memberMetas = await env.DB.prepare(
    `SELECT name, label FROM series WHERE id IN (${inMembers})`
  )
    .bind(...members)
    .all<{ name: string; label: string | null }>();
  const nameLabels = new Map<string, Set<string>>();
  for (const m of memberMetas.results ?? []) {
    let labels = nameLabels.get(m.name);
    if (!labels) nameLabels.set(m.name, (labels = new Set()));
    if (m.label) labels.add(m.label);
  }

  // When other editions share the name (名探偵コナン: 少年サンデーコミックス 本編 vs My first
  // big / スペシャル), fall back to name + label: loose volumes carrying this series' label
  // are still attributable as long as no sibling shares that label too.
  for (const [name, labels] of nameLabels) {
    if (await isSoleSeriesForName(env, members, name)) {
      const unlinked = await env.DB.prepare(
        `SELECT isbn, volume_number, vol_sort, title, subtitle, creator, creators, publisher, label, pubdate
         FROM volumes WHERE series_id IS NULL AND title = ? ORDER BY vol_sort, pubdate, isbn`
      )
        .bind(name)
        .all<VolumeRow>();
      foldUnlinked(unlinked.results ?? []);
      continue;
    }
    for (const label of labels) {
      if (!(await isSoleSeriesForNameLabel(env, members, name, label))) continue;
      const unlinked = await env.DB.prepare(
        `SELECT isbn, volume_number, vol_sort, title, subtitle, creator, creators, publisher, label, pubdate
         FROM volumes WHERE series_id IS NULL AND title = ? AND label = ?
         ORDER BY vol_sort, pubdate, isbn`
      )
        .bind(name, label)
        .all<VolumeRow>();
      foldUnlinked(unlinked.results ?? []);
    }
  }

  // MADB がシリーズ名には付けない別名を、巻の schema:name にだけ持つ作品
  // （series.name「東京卍リベンジャーズ」に対し巻は「東京卍リベンジャーズ = Tokyo Revengers」）。
  // 上の完全一致はシリーズ名で引くので当たらず、下の基本書名 fold もシリーズ名に区切りが無い
  // シリーズでは回らないので、同じ書名の迷子巻（7 巻）が巻一覧から抜けたままになる。そこで
  // 「このシリーズの巻が実際に名乗っている書名」でも完全一致で拾う（迷子巻の名指し
  // src/siblingVolumes.ts が既に使っているのと同じ書名）。寄せてよいかの判定は
  // groups.attributeTitles ＝ 検索・本の詳細がその書名の迷子巻をどのシリーズに寄せるかと同じ
  // 規則に委ねる。あちらは「getSeriesVolumes がこの条件の巻を巻一覧に混ぜる」前提で書かれて
  // いるので、これで「ISBN 検索ではこのシリーズが出るのに巻一覧には無い」ずれが消える。
  const volTitles = [...new Set((res.results ?? []).map((v) => (v.title ?? "").trim()))].filter(
    (t) => t && !nameLabels.has(t)
  );
  if (volTitles.length) {
    // 先に迷子巻の有無だけ引く（部分索引 idx_volumes_unlinked_title）。ほとんどのシリーズは
    // 0 件で、寄せ先の判定まで進むのは候補が実際にあるときだけ（実測 13.3 万シリーズ中 699 本）。
    const CHUNK = 80; // D1 の bind パラメータ上限（100）に当たらない刻み
    const byTitle = new Map<string, VolumeRow[]>();
    for (let i = 0; i < volTitles.length; i += CHUNK) {
      const part = volTitles.slice(i, i + CHUNK);
      const loose = await env.DB.prepare(
        `SELECT isbn, volume_number, vol_sort, title, subtitle, creator, creators, publisher, label, pubdate
         FROM volumes WHERE series_id IS NULL AND title IN (${part.map(() => "?").join(",")})
         ORDER BY vol_sort, pubdate, isbn`
      )
        .bind(...part)
        .all<VolumeRow>();
      for (const v of loose.results ?? []) {
        const list = byTitle.get(v.title);
        if (list) list.push(v);
        else byTitle.set(v.title, [v]);
      }
    }
    if (byTitle.size) {
      const owner = await attributeTitles(env, [...byTitle.keys()]);
      for (const [title, rows] of byTitle) {
        const id = owner.get(title);
        // 結合済みなら吸収された側の C-id が返るので、member のどれかなら自分のもの。
        if (id && members.includes(id)) foldUnlinked(rows);
      }
    }
  }

  // Also fold variants MADB filed under a different schema:name string for the SAME work
  // — an English alias after "=", a descriptive subtitle after ":", or none — e.g. this
  // series「Dジェネシス = D GENESIS : ダンジョンが出来て3年」plus loose「Dジェネシス」and
  // 「Dジェネシス : …．」volumes. They share a base title (see util.baseTitle) but not the
  // exact one above, so the exact fold misses them. Only when THIS series uniquely owns
  // the base (no sibling「…外伝」/sequel contends) — otherwise a loose volume can't be
  // attributed. Skipped when the name has no separator (base === full norm): the exact
  // fold already covered everything. Duplicate volume_numbers just collapse into sibling
  // ISBNs, so nothing is double-counted.
  const bases = new Set<string>();
  for (const name of nameLabels.keys()) {
    const base = baseTitle(name);
    if (base && base !== normTitle(name)) bases.add(base);
  }
  for (const base of bases) {
    if (!(await isSoleSeriesForBase(env, members, base))) continue;
    const variants = await env.DB.prepare(
      `SELECT isbn, volume_number, vol_sort, title, subtitle, creator, creators, publisher, label, pubdate
       FROM volumes
       WHERE series_id IS NULL
         AND REPLACE(REPLACE(LOWER(title), ' ', ''), '　', '') LIKE ? ESCAPE '\\'
       ORDER BY vol_sort, pubdate, isbn`
    )
      .bind(escapeLikeClamped(base, LIKE_MAX_BYTES - 1) + "%")
      .all<VolumeRow>();
    foldUnlinked((variants.results ?? []).filter((v) => baseTitle(v.title) === base));
  }

  interface Entry {
    isbn: string;
    isbns: string[];
    volume_number: string;
    vol_sort: number;
    title: string;
    subtitle: string;
    author: string;
    creators?: string; // 補完（SPARQL）の巻には無い
    publisher: string;
    label: string;
    pubdate: string;
    correction: boolean;
  }

  const entries: Entry[] = [...buckets.values()].flat().map(({ rep, isbns, subtitle }) => ({
    isbn: rep.isbn,
    isbns,
    volume_number: rep.volume_number ?? "",
    vol_sort: rep.vol_sort ?? 0,
    title: rep.title,
    subtitle,
    author: rep.creator ?? meta.creator ?? "",
    creators: rep.creators || (rep.creator ? "" : meta.creators) || "",
    publisher: rep.publisher ?? "",
    label: rep.label ?? "",
    pubdate: rep.pubdate ?? "",
    correction: false,
  }));

  // Supplement with newer tankobon that exist in live MADB but are unlinked in the
  // dump (see src/madbLive.ts). Cached per series (monthly), so only the first open
  // of a stale series pays one SPARQL round-trip. Only supplement a series that uses
  // a single standard numbering format (巻N / N) AND is the only same-name+creator
  // series using it — otherwise same-titled editions (新装版・総集編・アーク別) would
  // steal each other's loose volumes.
  // マスタが今持っている ISBN と巻番号。補完の重複除去と、抜け巻の穴埋め（下）が使う。
  const masterIsbns = new Set<string>();
  const masterSorts = new Set<number>();
  for (const e of entries) {
    for (const i of e.isbns) masterIsbns.add(i);
    if (e.volume_number && e.vol_sort > 0) masterSorts.add(e.vol_sort);
  }
  const existingNumbers = new Set(entries.map((e) => e.volume_number).filter(Boolean));
  const maxSort = entries.reduce((m, e) => Math.max(m, e.vol_sort), 0);
  const fmt = seriesFormat([...existingNumbers]);
  const eligible =
    !!fmt &&
    !!meta.creator &&
    (await isUnambiguousForSupplement(env, members, meta.name, meta.creator, fmt));

  // probe=false: merge only what a prior probe already cached (no network). null ⇒
  // never probed, which the search card surfaces as an "未確認" marker.
  // probe=true (button): hit live MADB for eligible series; for ineligible ones just
  // record that we looked, so the marker still clears.
  let supplement: SupplementVolume[] = [];
  let probed: boolean;
  let checkedAt = 0;
  if (probe) {
    // 前回までに貯まっている補完。穴埋めは楽天のレート制限（高優先の待ち上限 4 秒 ＝
    // 1 回の押下で引けるのは数ページ）で 1 回では全部埋まらないので、押すたびに積み上がる
    // よう先に読んでおく。getSupplementVolumes は行ごと置き換えるため、後でここに合流する。
    const prior = await readCachedSupplement(env, meta.id);
    if (eligible) {
      supplement = await getSupplementVolumes(
        env,
        meta.id,
        meta.name,
        meta.creator!,
        existingNumbers,
        maxSort,
        fmt!,
        true
      );
    } else {
      await markSupplementProbed(env, meta.id);
    }
    // マスタに ISBN が無いせいで取り込みから落ちた巻（シリーズ途中の抜け）を楽天から
    // 引き当てて足す（src/gapFill.ts）。上の eligible とは独立に走らせる: あちらが
    // 書名一致で同名別シリーズを恐れて末尾追加しかできないのに対し、こちらの穴の確定は
    // schema:isPartOf による C-id の厳密結合なので取り違えが起きない。
    const filled = await findGapFillVolumes(env, {
      seriesId: meta.id,
      name: meta.name,
      creator: meta.creator ?? "",
      publisher: meta.publisher ?? "",
      label: meta.label ?? "",
      knownIsbns: [...masterIsbns],
      knownSorts: masterSorts,
    });
    // 前回ぶん → 今回の SPARQL 補完（末尾の新刊。こちらが新しければ勝たせる）→ 今回の穴埋め
    // （空いている巻にだけ入れる）の順に合流する。穴埋めが既にある巻を上書きしないのは、
    // 押すたびに同じ巻の ISBN が入れ替わってちらつくのを避けるため。
    const merged = new Map<string, SupplementVolume>();
    const key = (v: SupplementVolume) => (v.vol_sort > 0 ? `n${v.vol_sort}` : `i${v.isbn}`);
    for (const v of prior?.volumes ?? []) merged.set(key(v), v);
    for (const v of supplement) merged.set(key(v), v);
    for (const v of filled) if (!merged.has(key(v))) merged.set(key(v), v);
    const next = [...merged.values()].sort((a, b) => a.vol_sort - b.vol_sort);
    // 中身が変わったときだけ書く（押しても何も増えないシリーズで無駄に書かない）。
    if (filled.length || next.length !== supplement.length) {
      await writeSupplement(env, meta.id, next);
    }
    supplement = next;
    probed = true;
    checkedAt = Date.now();
  } else {
    const cached = await readCachedSupplement(env, meta.id);
    supplement = cached?.volumes ?? [];
    probed = cached !== null;
    checkedAt = cached?.checkedAt ?? 0;
  }
  // The cache survives ingests (only entries the new master carries are pruned, see
  // scripts/ingest.mjs), so still skip anything already present by ISBN or by volume
  // number in case the master caught up between ingest and this read.
  for (const s of supplement) {
    if ((s.isbns ?? [s.isbn]).some((i) => masterIsbns.has(i)) || masterSorts.has(s.vol_sort)) continue;
    entries.push({
      isbn: s.isbn,
      isbns: s.isbns,
      volume_number: s.volume_number,
      vol_sort: s.vol_sort,
      title: s.title,
      subtitle: "", // 補完（SPARQL）は副題を引いていない
      author: s.author,
      publisher: s.publisher,
      label: "",
      pubdate: s.pubdate,
      correction: false,
    });
  }

  // Merge user-submitted corrections (volumes absent from both the dump and live
  // MADB, e.g. ONE PIECE 巻110). Keyed on this exact series C-id, so unlike the
  // SPARQL supplement there's no same-name/different-series ambiguity. Title/author
  // come from the series row; cover was resolved server-side at submit time.
  // Corrections are stored as "N" / "巻N" only while the master may say "第N巻", so
  // duplicates are detected on the plain volume number, not the label string.
  const knownNumbers = new Set(entries.map((e) => e.volume_number).filter(Boolean));
  const knownPlain = new Set<number>();
  for (const n of knownNumbers) {
    const p = plainVolumeNumber(n);
    if (p !== null) knownPlain.add(p);
  }
  const knownIsbns = new Set<string>();
  for (const e of entries) for (const i of e.isbns) knownIsbns.add(i);
  // The series' dominant plain label style, applied to every plain label on output
  // (こち亀: corrections' "1" and the master's stray "9" / "170　／　第170巻" all
  // become "第N巻"). Arc / edition labels are left as-is. See util.unifyVolumeLabel.
  const labelTemplate = volumeLabelTemplate([...knownNumbers]);
  const corrections = (await Promise.all(members.map((m) => getCorrectionVolumes(env, m)))).flat();
  for (const c of corrections) {
    if (knownIsbns.has(c.isbn)) {
      // 同じ ISBN の巻がマスタに巻番号なしで入っている（C269160 シャーリーの 1巻）なら、訂正の
      // 巻番号をその巻に付ける。付けないと番号付きの巻が 2〜 だけに見え、抜け巻と判定され続ける。
      const plain = plainVolumeNumber(c.volume_number);
      const unnumbered = entries.find((e) => !e.volume_number && e.isbns.includes(c.isbn));
      if (unnumbered && c.volume_number && !(plain !== null && knownPlain.has(plain))) {
        unnumbered.volume_number = c.volume_number;
        unnumbered.vol_sort = c.vol_sort;
        knownNumbers.add(c.volume_number);
        if (plain !== null) knownPlain.add(plain);
      }
      continue;
    }
    if (c.volume_number && knownNumbers.has(c.volume_number)) continue;
    const plain = plainVolumeNumber(c.volume_number);
    if (plain !== null && knownPlain.has(plain)) continue;
    entries.push({
      isbn: c.isbn,
      isbns: [c.isbn],
      volume_number: c.volume_number,
      vol_sort: c.vol_sort,
      title: displayName,
      subtitle: "", // 利用者のデータ修正に副題の欄は無い
      author: meta.creator ?? "",
      creators: meta.creators ?? "",
      publisher: "",
      label: "",
      pubdate: "",
      correction: true,
    });
  }

  // 管理者が「確定」した巻は volume_hidden に載る。source を問わず全閲覧者から除外する
  // （マスター/補完は元データを消せないので、ここでのフィルタが唯一の全体非表示手段）。
  const hiddenRows = await env.DB.prepare(
    `SELECT isbn FROM volume_hidden WHERE series_id IN (${inMembers})`
  )
    .bind(...members)
    .all<{ isbn: string }>();
  const hiddenIsbns = new Set((hiddenRows.results ?? []).map((r) => r.isbn));
  const shown = hiddenIsbns.size
    ? entries.filter((e) => !e.isbns.some((i) => hiddenIsbns.has(i)))
    : entries;

  shown.sort(
    (a, b) => a.vol_sort - b.vol_sort || a.pubdate.localeCompare(b.pubdate) || a.isbn.localeCompare(b.isbn)
  );

  // 残った抜け巻が「別のシリーズ」「どのシリーズにも属さない迷子」に在るなら名指しする
  // （src/siblingVolumes.ts）。穴埋めと訂正を混ぜたあとの shown を渡すので、いま埋まった巻は
  // 対象にならない。取得ボタン（probe=true）のときだけ走らせる: D1 を数本増やすので、
  // 一番重い閲覧系（probe=false）は変えない。独自シリーズ（U-id）は別々の本の寄せ集めで
  // 巻番号が比較できないので外す。
  const elsewhere: SiblingVolume[] =
    probe && !isCustomSeriesId(meta.id)
      ? await findSiblingVolumes(env, {
          seriesId: meta.id,
          members,
          name: meta.name,
          nameNorm: meta.name_norm ?? "",
          creator: meta.creator ?? "",
          // 迷子巻の引き当ては、シリーズ名だけでなくマスタ上の巻が実際に名乗っている書名でも
          // 行う（titleFor で揃えたあとの表示名ではなく、生の巻タイトル）。
          titles: [...new Set((res.results ?? []).map((v) => (v.title ?? "").trim()).filter(Boolean))],
          present: shown.map((e) => ({ vol_sort: e.vol_sort, isbns: e.isbns, pubdate: e.pubdate })),
        })
      : [];

  const allIsbns: string[] = [];
  for (const e of shown) allIsbns.push(...e.isbns);
  // Cache-only read: this endpoint must return instantly. Uncached covers come
  // back blank here; the client fills them lazily via POST /api/covers (which
  // does the rate-limited Rakuten/Google probing in the background).
  const covers = await readCachedCovers(env, allIsbns);
  const titleOverrides = await readVolumeTitleOverrides(env, allIsbns);

  // 本のタイトルをシリーズで揃える: 巻の schema:name はシリーズ名の繰り返しなので、
  // 表記ゆれ分割などで一部だけ変なタイトルを背負う。管理者がシリーズ名を直していれば
  // それ(displayName)を、無ければマスタ巻タイトルの最多(canonical)を全巻の表示タイトルに
  // する。個別 ISBN に管理者修正(volume_title_override)があれば最優先。巻番号は volLabel 側
  // で付くので、ここで title をシリーズ共通に揃えても巻は区別される。
  // 巻番号の無い巻（総集編「THE 4TH LOG …」・特別編など）は書名が唯一の区別なので揃えず、
  // 最多タイトルの集計にも入れない（全部が別名だと最長の 1 冊の名前が全巻に付いてしまう）。
  const titleCounts = new Map<string, number>();
  for (const v of res.results ?? []) {
    if (!v.volume_number) continue;
    const t = (v.title ?? "").trim();
    if (t) titleCounts.set(t, (titleCounts.get(t) ?? 0) + 1);
  }
  let canonicalTitle = "";
  let bestN = 0;
  for (const [t, n] of titleCounts) {
    const better =
      n > bestN ||
      (n === bestN &&
        (t.length > canonicalTitle.length ||
          (t.length === canonicalTitle.length && t < canonicalTitle)));
    if (better) {
      canonicalTitle = t;
      bestN = n;
    }
  }
  const seriesTitle = meta.override_name ? displayName : canonicalTitle;
  const titleFor = (e: Entry): string => {
    for (const i of e.isbns) {
      const ov = titleOverrides.get(i);
      if (ov) return ov;
    }
    // 独自シリーズの巻は書名そのものが本の区別（ルフィ / ゾロ …）なので揃えない。
    if (custom || !e.volume_number) return e.title;
    // 揃えるのは、その巻の書名が最多タイトルの表記ゆれ（「ONE PIECE = ワンピース」と
    // 「ONE PIECE」、「世界一初恋 : 小野寺律の場合」と「世界一初恋」）のときだけ。MADB の
    // シリーズには作品ごとに別の書名を持つ巻が並ぶことがあり（楳図かずおこわい本の 虫 / 影 /
    // 闇 …、日帰りクエストの各話の前後編）、それを揃えると全部同じ名前になって見分けが付かない。
    const variant = !canonicalTitle || baseTitle(e.title) === baseTitle(canonicalTitle);
    return variant ? seriesTitle || e.title : e.title;
  };

  const volumes: OutVolume[] = shown.map((e) => ({
    isbn: e.isbn,
    isbns: e.isbns,
    volume_number: unifyVolumeLabel(labelTemplate, e.volume_number),
    vol_sort: e.vol_sort,
    title: titleFor(e),
    subtitle: e.subtitle,
    author: e.author,
    creators: e.creators || e.author,
    publisher: e.publisher,
    label: e.label,
    pubdate: e.pubdate,
    cover_url: firstCover(e.isbns, covers),
    correction: e.correction,
  }));

  // Covers are resolved strictly by ISBN (Rakuten ISBN-exact, then Google). We
  // deliberately do NOT title-search to fill remaining gaps: several distinct
  // series can share a base title (e.g. 「冴えない彼女の育てかた」 has 4), so
  // volume-number matching would assign the wrong series' cover. Uncovered
  // volumes are left blank for the owner to fix via the cover picker.
  return json(
    {
      series_id: meta.id,
      title: displayName,
      // 版表示（schema:version）。検索カードと同じく書名に添える（src/search.ts SERIES_COLS）。
      // 巻一覧は検索を経由せずに開けるので（/s/:id の直リンク・リストからの遷移）、カードが
      // 持っている値に頼らずここでも返す。管理者が名前を直していても版は版なので併記する。
      version: meta.version ?? "",
      // レーベルに付いた運営のタグ（"廉価版" / "文庫版"）。検索カードと同じ印を巻一覧でも出す
      // （巻一覧は検索を経由せずに開ける: /s/:id の直リンク・リスト・本の詳細から）。
      // 上のシリーズ行と一緒に引いてあるので D1 の往復は増えない。
      label_tag: meta.label_tag ?? "",
      creator: meta.creator ?? "",
      // 役割付きの全作者表記（"原作：A、作画：B"）。検索カード（search.ts SERIES_COLS）と同じく
      // 先頭巻のものを優先し、無ければシリーズ側。
      creators: (res.results ?? []).find((v) => v.creators)?.creators || meta.creators || meta.creator || "",
      supplement_probed: probed,
      supplement_checked_at: checkedAt,
      // 抜け巻のうち、別シリーズ・迷子に在ると分かったもの。結合／分離依頼の導線に使う。
      // データは書き換えていない（確定は管理者）。取得ボタンのときだけ中身が入る。
      volumes_elsewhere: elsewhere,
      master_updated_at: await getMasterUpdatedAt(env),
      volumes,
    },
    200,
    { "cache-control": "no-store" }
  );
}

/** GET /api/master-info — public provenance of the MADB master for the about page:
 *  the dump release tag/date and when this site last imported it. */
export async function handleMasterInfo(env: Env): Promise<Response> {
  let tag: string | null = null;
  let releasedAt = 0;
  let importedAt = 0;
  try {
    const res = await env.DB.prepare(
      `SELECT key, value FROM meta WHERE key IN ('madb_release_tag', 'madb_released_at', 'imported_at')`
    ).all<{ key: string; value: string }>();
    const m = new Map((res.results ?? []).map((r) => [r.key, r.value]));
    tag = m.get("madb_release_tag") ?? null;
    releasedAt = Number(m.get("madb_released_at") || 0);
    importedAt = Number(m.get("imported_at") || 0);
  } catch {
    // meta table absent (pre-migration DB) → all defaults.
  }
  return json(
    { tag, released_at: releasedAt || null, imported_at: importedAt || null },
    200,
    { "cache-control": "public, max-age=3600" }
  );
}

/** Epoch-ms the MADB master was last refreshed: the dump's release date if the
 *  ingest recorded one, else the import time. 0 when never ingested / no meta table. */
export async function getMasterUpdatedAt(env: Env): Promise<number> {
  try {
    const res = await env.DB.prepare(
      `SELECT key, value FROM meta WHERE key IN ('madb_released_at', 'imported_at')`
    ).all<{ key: string; value: string }>();
    const m = new Map((res.results ?? []).map((r) => [r.key, r.value]));
    return Number(m.get("madb_released_at") || m.get("imported_at") || 0);
  } catch {
    return 0; // meta table absent (pre-migration DB)
  }
}

/** 収録巻の schema:name のうち最も多いタイトル（最頻値）を返す。MADB は同一作品を複数の
 *  title 文字列で登録することがあり（英題別名・サブタイトル付き等）、series.name がその中の
 *  少数派バリアントになっていることがある。巻側の多数派タイトルが実質的な正しい表示名なので、
 *  シリーズ名の修正候補として使う。空タイトルと巻番号の無い巻（総集編など書名が本の区別に
 *  なっている巻）は除外。同数なら長い（情報量が多い）方を優先。
 *  収録巻が無ければ null。 */
export async function getMostCommonVolumeTitle(
  env: Env,
  seriesId: string
): Promise<{ title: string; count: number; total: number } | null> {
  const res = await env.DB.prepare(
    `SELECT title, COUNT(*) AS n FROM volumes
       WHERE series_id = ? AND title <> '' AND volume_number IS NOT NULL
       GROUP BY title
       ORDER BY n DESC, LENGTH(title) DESC, title`
  )
    .bind(seriesId)
    .all<{ title: string; n: number }>();
  const list = res.results ?? [];
  if (!list.length) return null;
  const total = list.reduce((sum, r) => sum + r.n, 0);
  return { title: list[0].title, count: list[0].n, total };
}

// Admin-confirmed per-ISBN title overrides (volume_title_override) for a set of
// ISBNs. Chunked like readCachedCovers because D1 caps bound params per statement.
export async function readVolumeTitleOverrides(
  env: Env,
  isbns: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniq = [...new Set(isbns.filter(Boolean))];
  if (uniq.length === 0) return out;
  const CHUNK = 90;
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const chunk = uniq.slice(i, i + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT isbn, title FROM volume_title_override WHERE isbn IN (${placeholders})`
    )
      .bind(...chunk)
      .all<{ isbn: string; title: string }>();
    for (const r of rows.results ?? []) out.set(r.isbn, r.title);
  }
  return out;
}

/** True when no OTHER series (outside this merge group, see src/merge.ts) shares this
 *  exact name — so unlinked volumes carrying the same schema:name can be safely attributed to this one series (see the local merge in
 *  getSeriesVolumes). If a sibling series shares the name (新装版/総集編/別作品), a loose
 *  volume can't be attributed, so we skip the merge. */
async function isSoleSeriesForName(env: Env, members: string[], name: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM series WHERE name = ? AND id NOT IN (${members.map(() => "?").join(",")})`
  )
    .bind(name, ...members)
    .first<{ n: number }>();
  return (row?.n ?? 0) === 0;
}

/** True when no OTHER series (outside this merge group) shares both this exact name and
 *  label — the narrower guard for the name+label fold in getSeriesVolumes. */
async function isSoleSeriesForNameLabel(
  env: Env,
  members: string[],
  name: string,
  label: string
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM series
      WHERE name = ? AND label = ? AND id NOT IN (${members.map(() => "?").join(",")})`
  )
    .bind(name, label, ...members)
    .first<{ n: number }>();
  return (row?.n ?? 0) === 0;
}

/** True when no OTHER series (outside this merge group) shares this exact BASE title
 *  (see util.baseTitle) — so the loose variants carrying it can be safely attributed to this one series (base-title
 *  fold in getSeriesVolumes). base is a prefix of name_norm, so a name_norm prefix range
 *  (NAME_NORM_PREFIX, index-backed) narrows the scan; we re-check baseTitle(name) === base in JS to drop a
 *  longer-based sibling (「…外伝」/「…:re」) that merely shares the prefix. */
async function isSoleSeriesForBase(env: Env, members: string[], base: string): Promise<boolean> {
  const res = await env.DB.prepare(
    `SELECT id, name FROM series WHERE ${NAME_NORM_PREFIX}
       AND id NOT IN (${members.map(() => "?").join(",")})`
  )
    .bind(base, base, ...members)
    .all<{ id: string; name: string }>();
  return !(res.results ?? []).some((r) => baseTitle(r.name) === base);
}

/** True when no OTHER series (outside this merge group) with the same exact name and
 *  creator also uses `fmt`.
 *  If a sibling shares the numbering style (e.g. two 「One piece」 by 尾田栄一郎), a
 *  loose live volume can't be attributed to one of them, so we skip supplementing. */
async function isUnambiguousForSupplement(
  env: Env,
  members: string[],
  name: string,
  creator: string,
  fmt: NumFmt
): Promise<boolean> {
  const cond =
    fmt === "KAN"
      ? "v.volume_number GLOB '巻[0-9]*'"
      : "(v.volume_number GLOB '[0-9]*' AND NOT v.volume_number GLOB '*[^0-9]*')";
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM series s2
       WHERE s2.name = ? AND COALESCE(s2.creator, '') = ?
         AND s2.id NOT IN (${members.map(() => "?").join(",")})
         AND EXISTS (SELECT 1 FROM volumes v WHERE v.series_id = s2.id AND ${cond})`
  )
    .bind(name, creator, ...members)
    .first<{ n: number }>();
  return (row?.n ?? 0) === 0;
}

