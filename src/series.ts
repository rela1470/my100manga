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
} from "./util";
import { readCachedCovers, firstCover } from "./covers";
import {
  getSupplementVolumes,
  readCachedSupplement,
  markSupplementProbed,
  seriesFormat,
  NumFmt,
  SupplementVolume,
} from "./madbLive";
import { getCorrectionVolumes } from "./corrections";
import { resolveMergeTarget, mergeMembers } from "./merge";
import { isCustomSeriesId } from "./groups";

interface VolumeRow {
  isbn: string;
  volume_number: string | null;
  vol_sort: number | null;
  title: string;
  creator: string | null;
  creators?: string | null; // only the series' own volumes select it (byline fallback)
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
  author: string;
  publisher: string;
  label: string;
  pubdate: string;
  cover_url: string;
  correction: boolean; // true = user-submitted correction (gets the "間違っています" flag)
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
    `SELECT s.id, s.name, s.creator, s.creators, s.publisher, s.label, o.name AS override_name
       FROM series s LEFT JOIN series_name_override o ON o.series_id = s.id
      WHERE s.id = ?`
  )
    .bind(targetId)
    .first<{
      id: string;
      name: string;
      creator: string | null;
      creators: string | null;
      publisher: string | null;
      label: string | null;
      override_name: string | null;
    }>();
  if (!meta) return notFound("シリーズが見つかりません");

  // Display title honors an admin correction (series_name_override); all internal
  // matching below (unlinked-volume merge, live supplement) keeps using the master
  // meta.name, since the volumes' schema:name still carries the original title.
  const displayName = meta.override_name || meta.name;

  const res = await env.DB.prepare(
    `SELECT isbn, volume_number, vol_sort, title, creator, creators, publisher, label, pubdate
     FROM volumes WHERE series_id IN (${inMembers}) ORDER BY vol_sort, pubdate, isbn`
  )
    .bind(...members)
    .all<VolumeRow>();

  // MADB lists the same volume under several ISBNs (通常版/重版/特装版). Group them
  // by volume_number (volumes with no number key on their isbn so single-volume
  // works are never collapsed) so each volume appears once. Keep every sibling
  // ISBN so we can pick whichever one has a cover. Plain labels key on their number,
  // so one volume spelled "volume 84" / "Volume84" (名探偵コナン) still groups.
  // 独自シリーズは別々の本を束ねたものなので、同じ巻番号でも書名が違えば別の巻にする。
  const custom = isCustomSeriesId(targetId);
  const groupKey = (v: VolumeRow): string => {
    if (!v.volume_number) return `i:${v.isbn}`;
    const p = plainVolumeNumber(v.volume_number);
    const k = p !== null ? `p:${p}` : `n:${v.volume_number}`;
    return custom ? `${normTitle(v.title)}|${k}` : k;
  };
  const groups = new Map<string, { rep: VolumeRow; isbns: string[] }>();
  for (const v of res.results ?? []) {
    const key = groupKey(v);
    const g = groups.get(key);
    if (g) g.isbns.push(v.isbn);
    else groups.set(key, { rep: v, isbns: [v.isbn] });
  }

  // Fold in volumes that belong to this work but lost their schema:isPartOf in the dump
  // (series_id NULL). They carry the identical schema:name, so match on exact title —
  // only when this name maps to a single series, or same-titled works/editions would
  // steal each other's loose volumes (same guard as the SPARQL supplement below).
  // Unlike that supplement we do NOT filter by creator: 原作/作画 split works list a
  // different creator per volume (e.g. リュート vs 鍋島テツヒロ), and gating on the
  // master creator would drop one half. Duplicate volume_numbers just collapse into
  // sibling ISBNs of the volume already present, so no volume is double-counted.
  const foldUnlinked = (rows: VolumeRow[]) => {
    for (const v of rows) {
      const key = groupKey(v);
      const g = groups.get(key);
      if (g) g.isbns.push(v.isbn);
      else groups.set(key, { rep: v, isbns: [v.isbn] });
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
        `SELECT isbn, volume_number, vol_sort, title, creator, publisher, label, pubdate
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
        `SELECT isbn, volume_number, vol_sort, title, creator, publisher, label, pubdate
         FROM volumes WHERE series_id IS NULL AND title = ? AND label = ?
         ORDER BY vol_sort, pubdate, isbn`
      )
        .bind(name, label)
        .all<VolumeRow>();
      foldUnlinked(unlinked.results ?? []);
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
      `SELECT isbn, volume_number, vol_sort, title, creator, publisher, label, pubdate
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
    author: string;
    publisher: string;
    label: string;
    pubdate: string;
    correction: boolean;
  }

  const entries: Entry[] = [...groups.values()].map(({ rep, isbns }) => ({
    isbn: rep.isbn,
    isbns,
    volume_number: rep.volume_number ?? "",
    vol_sort: rep.vol_sort ?? 0,
    title: rep.title,
    author: rep.creator ?? meta.creator ?? "",
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
  const masterIsbns = new Set<string>();
  const masterSorts = new Set<number>();
  for (const e of entries) {
    for (const i of e.isbns) masterIsbns.add(i);
    if (e.volume_number && e.vol_sort > 0) masterSorts.add(e.vol_sort);
  }
  for (const s of supplement) {
    if ((s.isbns ?? [s.isbn]).some((i) => masterIsbns.has(i)) || masterSorts.has(s.vol_sort)) continue;
    entries.push({
      isbn: s.isbn,
      isbns: s.isbns,
      volume_number: s.volume_number,
      vol_sort: s.vol_sort,
      title: s.title,
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
      author: meta.creator ?? "",
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
    return custom || !e.volume_number ? e.title : seriesTitle || e.title;
  };

  const volumes: OutVolume[] = shown.map((e) => ({
    isbn: e.isbn,
    isbns: e.isbns,
    volume_number: unifyVolumeLabel(labelTemplate, e.volume_number),
    vol_sort: e.vol_sort,
    title: titleFor(e),
    author: e.author,
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
      creator: meta.creator ?? "",
      // 役割付きの全作者表記（"原作：A、作画：B"）。検索カード（search.ts SERIES_COLS）と同じく
      // 先頭巻のものを優先し、無ければシリーズ側。
      creators: (res.results ?? []).find((v) => v.creators)?.creators || meta.creators || meta.creator || "",
      supplement_probed: probed,
      supplement_checked_at: checkedAt,
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
 *  fold in getSeriesVolumes). base is a prefix of name_norm, so name_norm LIKE base||'%'
 *  (index-backed) narrows the scan; we re-check baseTitle(name) === base in JS to drop a
 *  longer-based sibling (「…外伝」/「…:re」) that merely shares the prefix. */
async function isSoleSeriesForBase(env: Env, members: string[], base: string): Promise<boolean> {
  const res = await env.DB.prepare(
    `SELECT id, name FROM series WHERE name_norm LIKE ? ESCAPE '\\'
       AND id NOT IN (${members.map(() => "?").join(",")})`
  )
    .bind(escapeLikeClamped(base, LIKE_MAX_BYTES - 1) + "%", ...members)
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

