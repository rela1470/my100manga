import { Env } from "./types";
import { PageOpts } from "./admin";
import {
  badRequest,
  isValidIsbn,
  json,
  normTitle,
  notFound,
  readJsonObject,
  searchKey,
  seriesNameSql,
  toIsbn13,
  volSort,
} from "./util";
import { excludeAdult } from "./site";
import { masterPubdate, rakutenComicByIsbn } from "./rakuten";
import { yahooListingByIsbn } from "./yahoo";

// 上流（MADB）が壊している巻のマスタ行を、管理画面から直すための API 群。
// 表は volume_master_fix（db/schema.sql）で、中身は「直した後のマスタ行そのもの」。保存すると
// その場で volumes へ当て、月次取り込みのあとは scripts/ingest.mjs の APPLY_MASTER_FIX_SQL が
// 同じ行をもう一度載せ直す。だから読み出し側（巻一覧・リスト表示・詳細）は何も知らなくていい。
//
// 認証は呼び出し側（src/index.ts）が Cloudflare Access + requireAdmin でまとめてガードする。
//
// 直し方の実例と経緯は db/MIGRATIONS.md「上流が取り違えた ISBN を直す仕組み」を参照。

/** volumes の列（volume_master_fix と同じ並び）。載せ直しの SQL とフォームの往復で使う。 */
export const VOLUME_COLS = [
  "isbn",
  "series_id",
  "volume_number",
  "vol_sort",
  "title",
  "subtitle",
  "title_search",
  "creator",
  "creators",
  "creators_norm",
  "publisher",
  "label",
  "pubdate",
  "is_adult",
] as const;

type VolumeCol = (typeof VOLUME_COLS)[number];
export type MasterRow = Record<VolumeCol, string | number | null>;

const COL_LIST = VOLUME_COLS.join(", ");
const COL_PLACEHOLDERS = VOLUME_COLS.map(() => "?").join(", ");

/** 1 件分の修正を volumes へ当てる文（scripts/ingest.mjs APPLY_MASTER_FIX_SQL の 1 行版）。 */
const APPLY_ONE_SQL =
  `INSERT OR REPLACE INTO volumes (${COL_LIST}) SELECT ${COL_LIST} FROM volume_master_fix WHERE isbn = ?`;

async function countRows(env: Env, sql: string, binds: unknown[] = []): Promise<number> {
  const row = await env.DB.prepare(sql).bind(...binds).first<{ n: number }>();
  return row?.n ?? 0;
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/** 空文字は NULL にする（マスタは「値が無い」を NULL で持つ。'' のまま入れると
 *  COALESCE(NULLIF(...)) 頼みの SQL と噛み合わない）。 */
function nullable(s: string): string | null {
  return s === "" ? null : s;
}

/** 表示用の著者欄（creators、"原作：A、作画：B"）から検索用の creators_norm を作る。
 *  区切りは MADB の表記に合わせて 、/，/,/／/・、役割の "原作：" は落とす。creators が空なら
 *  NULL（検索は src/search.ts の creatorNormSql が creator 側へ落ちる）。 */
function creatorsNormOf(creators: string, creator: string): string | null {
  const src = creators || creator;
  if (!src) return null;
  const names = src
    .split(/[、,，／/・]/)
    .map((part) => normTitle(part.replace(/^[^：:]{1,10}[：:]/, "")))
    .filter(Boolean);
  const uniq = [...new Set(names)];
  return uniq.length ? uniq.join("|") : null;
}

/** マスタ行 1 件分の素材（人が入れる値だけ）。検索キー（title_search / creators_norm）と
 *  vol_sort は buildMasterRow が導くので渡さない。 */
export interface MasterRowInput {
  isbn: string;
  title: string;
  series_id?: string;
  volume_number?: string;
  /** 省略・0 なら volume_number から導く。漢数字や「上/下」も util.volSort が扱う。 */
  vol_sort?: number;
  subtitle?: string;
  creator?: string;
  creators?: string;
  publisher?: string;
  label?: string;
  pubdate?: string;
  is_adult?: boolean;
}

/** 素材から volumes の 1 行を組み立てる。検索キーをここで作るので、呼び手（管理画面の
 *  フォーム・シリーズの新規登録 src/seriesRegister.ts）が作り方を知らなくて済む。 */
export function buildMasterRow(v: MasterRowInput): MasterRow {
  const volumeNumber = v.volume_number ?? "";
  const rawSort = Number(v.vol_sort);
  return {
    isbn: v.isbn,
    series_id: nullable(v.series_id ?? ""),
    volume_number: nullable(volumeNumber),
    vol_sort: Number.isFinite(rawSort) && rawSort !== 0 ? Math.floor(rawSort) : volSort(volumeNumber),
    title: v.title,
    subtitle: nullable(v.subtitle ?? ""),
    title_search: searchKey(v.title),
    creator: nullable(v.creator ?? ""),
    creators: nullable(v.creators ?? ""),
    creators_norm: creatorsNormOf(v.creators ?? "", v.creator ?? ""),
    publisher: nullable(v.publisher ?? ""),
    label: nullable(v.label ?? ""),
    pubdate: nullable(v.pubdate ?? ""),
    is_adult: v.is_adult ? 1 : 0,
  };
}

/** 修正 1 件を volume_master_fix へ upsert し、その場で volumes へ当てる 2 文。
 *  prevJson は差し替える前のマスタ行の控え（上流に無い巻を足すときは null = 取り消しで消す）。
 *  2 回目以降の保存で控えが自分の値に化けないよう、ON CONFLICT 側は prev_json を触らない。 */
export function masterFixStmts(
  env: Env,
  row: MasterRow,
  note: string,
  now: number,
  prevJson: string | null
): D1PreparedStatement[] {
  const setCols = VOLUME_COLS.filter((c) => c !== "isbn")
    .map((c) => `${c} = excluded.${c}`)
    .join(", ");
  return [
    env.DB.prepare(
      `INSERT INTO volume_master_fix (${COL_LIST}, note, created_at, prev_json)
       VALUES (${COL_PLACEHOLDERS}, ?, ?, ?)
       ON CONFLICT (isbn) DO UPDATE SET ${setCols}, note = excluded.note, created_at = excluded.created_at`
    ).bind(...VOLUME_COLS.map((c) => row[c]), note, now, prevJson),
    env.DB.prepare(APPLY_ONE_SQL).bind(row.isbn),
  ];
}

interface AdminMasterFixRow {
  isbn: string;
  series_id: string | null;
  volume_number: string | null;
  vol_sort: number | null;
  title: string;
  subtitle: string | null;
  creator: string | null;
  creators: string | null;
  publisher: string | null;
  label: string | null;
  pubdate: string | null;
  is_adult: number;
  note: string;
  created_at: number;
  prev_json: string | null;
  series_name: string | null;
  cover_url: string | null;
  applied: number; // 1 = 今の volumes が修正後の値になっている
}

/** 修正済みの一覧（新しい順）。applied は「今の volumes に当たっているか」。取り込みの
 *  載せ直しが効いていれば必ず 1 になるので、0 が出ていたら載せ直しが抜けている合図。 */
export async function adminListMasterFixes(env: Env, opts: PageOpts): Promise<Response> {
  const total = await countRows(env, `SELECT COUNT(*) AS n FROM volume_master_fix`);
  const { results } = await env.DB.prepare(
    `SELECT f.isbn, f.series_id, f.volume_number, f.vol_sort, f.title, f.subtitle,
            f.creator, f.creators, f.publisher, f.label, f.pubdate, f.is_adult,
            f.note, f.created_at, f.prev_json,
            ${seriesNameSql("s", "so")} AS series_name,
            cov.cover_url AS cover_url,
            CASE WHEN v.isbn IS NOT NULL
                  AND v.series_id IS f.series_id
                  AND v.volume_number IS f.volume_number
                  AND v.title = f.title
                  AND v.creator IS f.creator
                  AND v.pubdate IS f.pubdate
                 THEN 1 ELSE 0 END AS applied
       FROM volume_master_fix f
       LEFT JOIN volumes v ON v.isbn = f.isbn
       LEFT JOIN series s ON s.id = f.series_id
       LEFT JOIN series_name_override so ON so.series_id = f.series_id
       LEFT JOIN covers cov ON cov.isbn = f.isbn
      ORDER BY f.created_at DESC, f.isbn LIMIT ? OFFSET ?`
  )
    .bind(opts.per, opts.offset)
    .all<AdminMasterFixRow>();

  const fixes = (results ?? []).map((r) => ({
    isbn: r.isbn,
    series_id: r.series_id ?? "",
    volume_number: r.volume_number ?? "",
    vol_sort: r.vol_sort ?? 0,
    title: r.title,
    subtitle: r.subtitle ?? "",
    creator: r.creator ?? "",
    creators: r.creators ?? "",
    publisher: r.publisher ?? "",
    label: r.label ?? "",
    pubdate: r.pubdate ?? "",
    is_adult: r.is_adult === 1,
    note: r.note ?? "",
    created_at: r.created_at,
    series_name: r.series_name ?? "",
    cover_url: r.cover_url ?? "",
    applied: r.applied === 1,
    // 取り消したときに何が起きるか（戻すのか、消すのか）をボタンの文言に出すため。
    restores: r.prev_json ? "restore" : "delete",
  }));

  return json({ fixes, total, page: opts.page, per: opts.per }, 200, { "cache-control": "no-store" });
}

const OPENBD_TIMEOUT_MS = 5000;

interface OpenbdSummary {
  title: string;
  volume: string;
  series: string;
  publisher: string;
  pubdate: string;
  author: string;
}

/** openBD（JPRO/NDL 由来の書誌、鍵なし・無料）で ISBN の正しい書誌を引く。あらすじは
 *  主要漫画出版社でほぼ空なので使わないが（memory の調査どおり）、書名・著者・出版社・
 *  発行日は 97% の収録率で、取り違えの判定とフォームの下書きにちょうどよい。
 *  落ちても修正作業は続けられるべきなので、失敗は null にして握りつぶす。 */
async function openbdLookup(isbn: string): Promise<OpenbdSummary | null> {
  try {
    const res = await fetch(`https://api.openbd.jp/v1/get?isbn=${encodeURIComponent(isbn)}`, {
      signal: AbortSignal.timeout(OPENBD_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Array<{ summary?: Record<string, unknown> } | null> | null;
    const s = Array.isArray(body) ? body[0]?.summary : null;
    if (!s) return null;
    const get = (k: string) => (typeof s[k] === "string" ? (s[k] as string) : "");
    // 著者は NDL 形式の "真島,ヒロ,1977-"。姓名のカンマを畳み、生没年は落とす。
    const author = get("author")
      .split(/[;；]/)
      .map((one) =>
        one
          .split(",")
          .map((p) => p.trim())
          .filter((p) => p && !/^\d{4}/.test(p))
          .join("")
      )
      .filter(Boolean)
      .join("、");
    // 発行日は "200103" / "20010316" の詰めた形。マスタの表記（"2001-03"）に寄せる。
    const raw = get("pubdate").replace(/[^0-9]/g, "");
    const pubdate =
      raw.length >= 8
        ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
        : raw.length >= 6
          ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}`
          : raw.slice(0, 4);
    return {
      title: get("title"),
      volume: get("volume"),
      series: get("series"),
      publisher: get("publisher"),
      pubdate,
      author,
    };
  } catch {
    return null;
  }
}

/** 下書きの材料を集める（GET /api/admin/master-fixes/lookup?isbn=&series=）。
 *  ・master  … 今の volumes の行（これが壊れている当人。無ければ null）
 *  ・fix     … 既にある修正行（編集で開いたとき）
 *  ・openbd  … 外部の書誌（正しい書名・著者・発行日の出どころ）
 *  ・series  … series に指定した C-id/U-id の素性と、そのシリーズで最多の巻の値
 *              （「シリーズの巻に揃える」でレーベルや著者表記を揃えるため） */
export async function adminLookupMasterFix(env: Env, url: URL): Promise<Response> {
  const isbn = toIsbn13(url.searchParams.get("isbn") ?? "");
  if (!isValidIsbn(isbn)) return badRequest("ISBN を正しく指定してください");
  const seriesId = str(url.searchParams.get("series"), 32);

  const [master, fix, openbd, rakuten, yahoo] = await Promise.all([
    env.DB.prepare(
      `SELECT v.${VOLUME_COLS.join(", v.")}, ${seriesNameSql("s", "so")} AS series_name
         FROM volumes v
         LEFT JOIN series s ON s.id = v.series_id
         LEFT JOIN series_name_override so ON so.series_id = v.series_id
        WHERE v.isbn = ?`
    )
      .bind(isbn)
      .first<MasterRow & { series_name: string | null }>(),
    env.DB.prepare(
      `SELECT ${COL_LIST}, note, created_at, prev_json FROM volume_master_fix WHERE isbn = ?`
    )
      .bind(isbn)
      .first<MasterRow & { note: string; created_at: number; prev_json: string | null }>(),
    openbdLookup(isbn),
    // openBD が持たない本（絶版・古い巻・一部の出版社）の受け皿。楽天ブックスは
    // 書名・著者・出版社・レーベル（seriesName）・発売日・書影を構造化して持っている。
    rakutenComicByIsbn(env, isbn).catch(() => null),
    // 楽天にも無い絶版巻の最後の手掛かり。出品者の自由入力なので「材料」としてそのまま出す。
    yahooListingByIsbn(env, isbn).catch(() => null),
  ]);

  let series = null;
  if (seriesId) {
    const row = await env.DB.prepare(
      `SELECT s.id, ${seriesNameSql("s", "so")} AS name, s.creator, s.creators, s.publisher, s.label
         FROM series s LEFT JOIN series_name_override so ON so.series_id = s.id
        WHERE s.id = ?`
    )
      .bind(seriesId)
      .first<{
        id: string;
        name: string;
        creator: string | null;
        creators: string | null;
        publisher: string | null;
        label: string | null;
      }>();
    if (row) {
      // そのシリーズで最も多い（書名・著者・出版社・レーベル）の組。版違いが混ざっていても
      // 多数派に揃うので、1 巻だけ浮いている行を直すときの手本になる。
      const common = await env.DB.prepare(
        `SELECT title, creator, creators, publisher, label, COUNT(*) AS n
           FROM volumes WHERE series_id = ?
          GROUP BY title, creator, creators, publisher, label
          ORDER BY n DESC, title LIMIT 1`
      )
        .bind(seriesId)
        .first<{
          title: string;
          creator: string | null;
          creators: string | null;
          publisher: string | null;
          label: string | null;
        }>();
      series = {
        id: row.id,
        name: row.name ?? "",
        volume_count: await countRows(env, `SELECT COUNT(*) AS n FROM volumes WHERE series_id = ?`, [seriesId]),
        common: common
          ? {
              title: common.title ?? "",
              creator: common.creator ?? "",
              creators: common.creators ?? "",
              publisher: common.publisher ?? "",
              label: common.label ?? "",
            }
          : null,
      };
    }
  }

  return json(
    {
      isbn,
      master: master
        ? {
            series_id: master.series_id ?? "",
            series_name: master.series_name ?? "",
            volume_number: master.volume_number ?? "",
            vol_sort: master.vol_sort ?? 0,
            title: master.title ?? "",
            subtitle: master.subtitle ?? "",
            creator: master.creator ?? "",
            creators: master.creators ?? "",
            publisher: master.publisher ?? "",
            label: master.label ?? "",
            pubdate: master.pubdate ?? "",
            is_adult: master.is_adult === 1,
          }
        : null,
      fix: fix
        ? {
            series_id: fix.series_id ?? "",
            volume_number: fix.volume_number ?? "",
            vol_sort: fix.vol_sort ?? 0,
            title: fix.title ?? "",
            subtitle: fix.subtitle ?? "",
            creator: fix.creator ?? "",
            creators: fix.creators ?? "",
            publisher: fix.publisher ?? "",
            label: fix.label ?? "",
            pubdate: fix.pubdate ?? "",
            is_adult: fix.is_adult === 1,
            note: fix.note ?? "",
            created_at: fix.created_at,
            restores: fix.prev_json ? "restore" : "delete",
          }
        : null,
      openbd,
      // 楽天ブックス（ISBN 直引き）。発売日はマスタの表記（"2009-12"）に寄せて渡す。
      rakuten: rakuten
        ? {
            title: rakuten.title,
            volume: rakuten.volume,
            author: rakuten.author,
            publisher: rakuten.publisher,
            pubdate: masterPubdate(rakuten.pubdate),
            cover_url: rakuten.cover_url,
          }
        : null,
      // Yahoo!ショッピングの出品名（構造化されていない。書名を起こすための材料）。
      yahoo,
      series,
      // 成年向けの印を出すのは R18版だけ（本家の volumes には成年向けの行を入れない）。
      allow_adult: !excludeAdult(env),
    },
    200,
    { "cache-control": "no-store" }
  );
}

/** 修正を保存（POST /api/admin/master-fixes）。volume_master_fix に upsert して、その場で
 *  volumes へ当てる。差し替える前のマスタ行は prev_json に控える（取り消しの戻し先）。
 *  2 回目以降の保存では prev_json を触らない: 控えたいのは「上流の行」であって、
 *  自分が 1 回目に書いた行ではないため。 */
export async function adminSaveMasterFix(request: Request, env: Env): Promise<Response> {
  const body = (await readJsonObject(request)) as Record<string, unknown>;

  const isbn = toIsbn13(str(body.isbn, 20));
  if (!isValidIsbn(isbn)) return badRequest("ISBN を正しく指定してください");

  const title = str(body.title, 200);
  if (!title) return badRequest("書名を指定してください");

  const seriesId = str(body.series_id, 32);
  if (seriesId) {
    if (seriesId.startsWith("G")) {
      return badRequest("まとまり（G-id）は指定できません。シリーズ（C-id / U-id）を指定してください");
    }
    const exists = await env.DB.prepare(`SELECT 1 AS n FROM series WHERE id = ?`).bind(seriesId).first();
    if (!exists) return badRequest(`シリーズ ${seriesId} が見つかりません`);
  }

  const volumeNumber = str(body.volume_number, 32);
  const rawSort = Number(body.vol_sort);

  const pubdate = str(body.pubdate, 20);
  if (pubdate && !/^\d{4}(-\d{2}(-\d{2})?)?$/.test(pubdate)) {
    return badRequest("発行日は 2001 / 2001-03 / 2001-03-16 の形で指定してください");
  }

  const isAdult = body.is_adult === true || body.is_adult === 1;
  if (isAdult && excludeAdult(env)) {
    return badRequest("このサイトでは成年向けの巻を入れられません");
  }

  const creator = str(body.creator, 200);
  const creators = str(body.creators, 400);
  const subtitle = str(body.subtitle, 200);
  const publisher = str(body.publisher, 200);
  const label = str(body.label, 200);
  const note = str(body.note, 500);

  const row = buildMasterRow({
    isbn,
    series_id: seriesId,
    volume_number: volumeNumber,
    vol_sort: rawSort,
    title,
    subtitle,
    creator,
    creators,
    publisher,
    label,
    pubdate,
    is_adult: isAdult,
  });

  // 差し替える前のマスタ行の控え。既に修正行があるときは取らない（上書き保存で控えが
  // 自分の値に化けるのを防ぐ）。上流に行が無ければ NULL のまま＝取り消しで消す。
  const existing = await env.DB.prepare(`SELECT 1 AS n FROM volume_master_fix WHERE isbn = ?`)
    .bind(isbn)
    .first();
  let prevJson: string | null = null;
  if (!existing) {
    const prev = await env.DB.prepare(`SELECT ${COL_LIST} FROM volumes WHERE isbn = ?`)
      .bind(isbn)
      .first<MasterRow>();
    if (prev) prevJson = JSON.stringify(prev);
  }

  await env.DB.batch(masterFixStmts(env, row, note, Date.now(), prevJson));

  return json({ ok: true, isbn, restores: existing || prevJson ? "restore" : "delete" });
}

/** 修正の取り消し（DELETE /api/admin/master-fixes/:isbn）。控え（prev_json）があれば
 *  その行を volumes へ書き戻し、無ければ（上流に無い巻を足していたので）volumes から消す。
 *  どちらの場合も修正行自体を消すので、次の取り込みで載せ直されることもない。 */
export async function adminDeleteMasterFix(env: Env, rawIsbn: string): Promise<Response> {
  const isbn = toIsbn13(rawIsbn);
  const fix = await env.DB.prepare(`SELECT prev_json FROM volume_master_fix WHERE isbn = ?`)
    .bind(isbn)
    .first<{ prev_json: string | null }>();
  if (!fix) return notFound("修正が見つかりません");

  let prev: MasterRow | null = null;
  if (fix.prev_json) {
    try {
      prev = JSON.parse(fix.prev_json) as MasterRow;
    } catch {
      // 控えが壊れていたら戻しようがないので、マスタ行はそのままにして修正だけ消す
      // （次の取り込みで上流の行に置き換わる）。
      prev = null;
    }
  }

  const statements = [env.DB.prepare(`DELETE FROM volume_master_fix WHERE isbn = ?`).bind(isbn)];
  if (prev) {
    statements.unshift(
      env.DB.prepare(`INSERT OR REPLACE INTO volumes (${COL_LIST}) VALUES (${COL_PLACEHOLDERS})`).bind(
        ...VOLUME_COLS.map((c) => prev[c] ?? null)
      )
    );
  } else if (!fix.prev_json) {
    statements.unshift(env.DB.prepare(`DELETE FROM volumes WHERE isbn = ?`).bind(isbn));
  }
  await env.DB.batch(statements);

  return json({ ok: true, isbn, restored: !!prev });
}
