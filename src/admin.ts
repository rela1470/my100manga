import { Env, StoredListItem } from "./types";
import { resolveBooks, resolveListItems } from "./listItems";
import { json, notFound, readJsonObject, toIsbn13 } from "./util";
import { getMostCommonVolumeTitle } from "./series";

// 管理画面用のエンドポイント群。認証は呼び出し側（src/index.ts）が Cloudflare Access +
// JWT 検証（src/adminAuth.ts の requireAdmin）で /admin・/api/admin/* をまとめてガードする。
// ここでは個別に認証チェックしないので、新しい admin ルートも必ずそのガード配下に置くこと。

// 一覧系は全件をメモリに載せると件数増加で破綻するため、必ずページング（LIMIT/OFFSET）で返す。
// COUNT を併記してフロントがページャーを描ける総件数を渡す。
const DEFAULT_PER = 50;
const MAX_PER = 200;

export interface PageOpts {
  page: number; // 1-origin
  per: number;
  offset: number;
}

/** ?page / ?per を安全にパースする。page は 1 以上、per は 1〜MAX_PER にクランプ。 */
export function parsePage(url: URL): PageOpts {
  let per = Math.floor(Number(url.searchParams.get("per")));
  if (!Number.isFinite(per) || per < 1) per = DEFAULT_PER;
  if (per > MAX_PER) per = MAX_PER;
  let page = Math.floor(Number(url.searchParams.get("page")));
  if (!Number.isFinite(page) || page < 1) page = 1;
  return { page, per, offset: (page - 1) * per };
}

async function countRows(env: Env, sql: string, binds: unknown[] = []): Promise<number> {
  const row = await env.DB.prepare(sql).bind(...binds).first<{ n: number }>();
  return row?.n ?? 0;
}

interface AdminListRow {
  slug: string;
  owner_name: string;
  item_count: number;
  cover_count: number;
  created_at: number;
  updated_at: number;
  publish_count: number;      // publish_audit の件数（新規＋更新公開の合計）
  last_published_at: number;  // 直近の公開時刻（無ければ 0）
  last_ip: string;            // 直近の公開元 IP
  last_country: string;       // 直近の公開元 国
}

export async function adminListLists(env: Env, opts: PageOpts): Promise<Response> {
  // 公開リスト一覧に publish_audit を紐づけ、直近の公開元 IP / 国 / 公開回数を併記する。
  const total = await countRows(env, `SELECT COUNT(*) AS n FROM lists`);
  const { results } = await env.DB.prepare(
    `SELECT l.slug, l.owner_name, l.items_json, l.created_at, l.updated_at,
            (SELECT COUNT(*) FROM publish_audit a WHERE a.slug = l.slug) AS publish_count,
            (SELECT MAX(a.created_at) FROM publish_audit a WHERE a.slug = l.slug) AS last_published_at,
            (SELECT a.ip FROM publish_audit a WHERE a.slug = l.slug ORDER BY a.created_at DESC LIMIT 1) AS last_ip,
            (SELECT a.country FROM publish_audit a WHERE a.slug = l.slug ORDER BY a.created_at DESC LIMIT 1) AS last_country
       FROM lists l ORDER BY l.created_at DESC LIMIT ? OFFSET ?`
  )
    .bind(opts.per, opts.offset)
    .all<{
      slug: string;
      owner_name: string | null;
      items_json: string;
      created_at: number;
      updated_at: number;
      publish_count: number | null;
      last_published_at: number | null;
      last_ip: string | null;
      last_country: string | null;
    }>();

  const parsed = (results ?? []).map((row) => {
    let items: StoredListItem[] = [];
    try {
      items = JSON.parse(row.items_json) as StoredListItem[];
    } catch {
      items = [];
    }
    return { row, items };
  });
  // Covers are site-wide, so count them by resolving every ISBN on this page at once.
  const books = await resolveBooks(env, parsed.flatMap((p) => p.items.map((i) => i?.isbn ?? "")));
  const lists: AdminListRow[] = parsed.map(({ row, items }) => {
    return {
      slug: row.slug,
      owner_name: row.owner_name ?? "",
      item_count: items.length,
      cover_count: items.filter((i) => i && books.get(toIsbn13(i.isbn))?.cover_url).length,
      created_at: row.created_at,
      updated_at: row.updated_at,
      publish_count: row.publish_count ?? 0,
      last_published_at: row.last_published_at ?? 0,
      last_ip: row.last_ip ?? "",
      last_country: row.last_country ?? "",
    };
  });

  return json({ lists, total, page: opts.page, per: opts.per }, 200, { "cache-control": "no-store" });
}

export async function adminStats(env: Env): Promise<Response> {
  const count = async (sql: string): Promise<number> => {
    const row = await env.DB.prepare(sql).first<{ n: number }>();
    return row?.n ?? 0;
  };

  const [
    lists,
    series,
    volumes,
    covers,
    corrections,
    reports,
    volume_reports,
    series_reports,
    cover_suggestions,
  ] = await Promise.all([
    count(`SELECT COUNT(*) AS n FROM lists`),
    count(`SELECT COUNT(*) AS n FROM series`),
    count(`SELECT COUNT(*) AS n FROM volumes`),
    count(`SELECT COUNT(*) AS n FROM covers`),
    count(`SELECT COUNT(*) AS n FROM series_correction`),
    count(`SELECT COUNT(*) AS n FROM reports`),
    count(`SELECT COUNT(*) AS n FROM volume_report`),
    count(`SELECT COUNT(*) AS n FROM series_report`),
    count(`SELECT COUNT(*) AS n FROM cover_suggestion`),
  ]);

  return json(
    {
      // dev=true のとき管理 UI が開発用の「DB初期化」を表示する。DEV_TOOLS を立てた本番でも
      // true になる（認証は別途 requireAdmin が担保）。無効環境では false で UI にも出さない。
      dev: devToolsEnabled(env),
      stats: {
        lists,
        series,
        volumes,
        covers,
        corrections,
        reports,
        volume_reports,
        series_reports,
        cover_suggestions,
      },
    },
    200,
    { "cache-control": "no-store" }
  );
}

// 開発ツールが有効か。DEV_TOOLS="true"（開発期間中は本番 vars にも置ける）か、ローカル
// dev の ADMIN_DEV_BYPASS="true" のどちらかで有効。ADMIN_DEV_BYPASS と違い DEV_TOOLS は
// 認証をバイパスしない（この関数は requireAdmin の配下）ので、本番でも管理者だけが使える。
function devToolsEnabled(env: Env): boolean {
  return env.DEV_TOOLS === "true" || env.ADMIN_DEV_BYPASS === "true";
}

// 開発用: マスターデータ (MADB 由来の series / volumes / meta) 以外の全テーブルを
// 空にして DB を初期状態へ戻す破壊的操作。ユーザ生成データ (lists)・各種キャッシュ
// (covers / book_meta / series_supplement)・通報/修正キュー・監査ログをまとめて消す。
// devToolsEnabled が false の環境では fail-closed で拒否する。
// テーブル名は固定のリテラル配列（外部入力を混ぜない）なので SQL インジェクションの余地はない。
const DEV_RESET_TABLES = [
  "lists",
  "list_item_events",
  "covers",
  "book_meta",
  "series_supplement",
  "series_correction",
  "volume_report",
  "volume_hidden",
  "series_report",
  "series_name_override",
  "series_merge",
  "series_merge_request",
  "series_merge_dismissed",
  "volume_title_report",
  "volume_title_override",
  "cover_suggestion",
  "reports",
  "publish_audit",
];

// R2 のトリム済み表紙（yahoo/*.jpg）を全消去し、消した件数を返す。D1 の covers を
// 消しても R2 に残ったトリム結果があると /cover が再トリムせず R2 ヒットで配信して
// しまうため、クリーン再テスト用に covers キャッシュとセットで消す。list は最大
// 1000 件/ページなので truncated の間 cursor で回す。binding 未設定なら 0。
async function purgeCoverStore(env: Env): Promise<number> {
  if (!env.COVERS) return 0;
  let removed = 0;
  let cursor: string | undefined;
  do {
    const listed = await env.COVERS.list({ prefix: "yahoo/", limit: 1000, cursor });
    if (listed.objects.length) {
      await env.COVERS.delete(listed.objects.map((o) => o.key));
      removed += listed.objects.length;
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return removed;
}

export async function adminDevReset(env: Env): Promise<Response> {
  if (!devToolsEnabled(env)) {
    return json({ error: "開発用機能はこの環境では無効です" }, 403, { "cache-control": "no-store" });
  }
  const deleted: Record<string, number> = {};
  const skipped: string[] = [];
  for (const table of DEV_RESET_TABLES) {
    // ローカルの schema がまだ古く当該テーブルが無い（開発中に後から足したテーブル等）
    // ケースで全体を中断させないよう、テーブル単位で失敗を握り潰して続行する。
    try {
      const res = await env.DB.prepare(`DELETE FROM ${table}`).run();
      deleted[table] = res.meta?.changes ?? 0;
    } catch {
      skipped.push(table);
    }
  }
  const r2Covers = await purgeCoverStore(env);
  return json({ ok: true, deleted, skipped, r2Covers }, 200, { "cache-control": "no-store" });
}

export async function adminGetList(env: Env, slug: string): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT slug, edit_token, owner_name, bio, items_json, created_at, updated_at
       FROM lists WHERE slug = ?`
  )
    .bind(slug)
    .first<{
      slug: string;
      edit_token: string;
      owner_name: string | null;
      bio: string | null;
      items_json: string;
      created_at: number;
      updated_at: number;
    }>();
  if (!row) return notFound("リストが見つかりません");

  let stored: StoredListItem[] = [];
  try {
    stored = JSON.parse(row.items_json) as StoredListItem[];
  } catch {
    stored = [];
  }
  const items = await resolveListItems(env, stored);

  // 管理用途なので公開APIと違い edit_token も返す（運営者が編集リンクを再取得できる）。
  return json(
    {
      list: {
        slug: row.slug,
        edit_token: row.edit_token,
        owner_name: row.owner_name ?? "",
        bio: row.bio ?? "",
        items,
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
    },
    200,
    { "cache-control": "no-store" }
  );
}

export async function adminDeleteList(env: Env, slug: string): Promise<Response> {
  const res = await env.DB.prepare(`DELETE FROM lists WHERE slug = ?`).bind(slug).run();
  const deleted = res.meta?.changes ?? 0;
  if (!deleted) return notFound("リストが見つかりません");
  // ランキングが消えたリストを数え続けないよう、追加イベントも掃除する (src/ranking.ts)。
  await env.DB.prepare(`DELETE FROM list_item_events WHERE slug = ?`).bind(slug).run();
  return json({ ok: true, slug });
}

interface AdminCorrectionRow {
  series_id: string;
  isbn: string;
  volume_number: string;
  vol_sort: number;
  cover_url: string;
  created_at: number;
  reviewed_at: number;
  series_name: string | null;
  series_creator: string | null;
}

/** ユーザ投稿の巻の修正一覧。reviewed=false ならレビュー待ち（reviewed_at = 0）、true なら
 *  管理者が「確定(承認)」済み（reviewed_at > 0）を新しい確定順に返す。確定済みは公開を維持
 *  したままレビューキューから外れた履歴なので、後から何を承認したか振り返れるようにする。 */
export async function adminListCorrections(
  env: Env,
  opts: PageOpts,
  reviewed = false
): Promise<Response> {
  const where = reviewed ? `c.reviewed_at > 0` : `c.reviewed_at = 0`;
  const order = reviewed ? `c.reviewed_at DESC` : `c.created_at DESC`;
  const total = await countRows(env, `SELECT COUNT(*) AS n FROM series_correction c WHERE ${where}`);
  const { results } = await env.DB.prepare(
    `SELECT c.series_id, c.isbn, c.volume_number, c.vol_sort, c.cover_url, c.created_at, c.reviewed_at,
            s.name AS series_name, s.creator AS series_creator
       FROM series_correction c
       LEFT JOIN series s ON s.id = c.series_id
      WHERE ${where}
      ORDER BY ${order} LIMIT ? OFFSET ?`
  )
    .bind(opts.per, opts.offset)
    .all<AdminCorrectionRow>();

  const corrections = (results ?? []).map((r) => ({
    series_id: r.series_id,
    isbn: r.isbn,
    volume_number: r.volume_number,
    vol_sort: r.vol_sort,
    cover_url: r.cover_url,
    created_at: r.created_at,
    reviewed_at: r.reviewed_at ?? 0,
    series_name: r.series_name ?? "",
    series_creator: r.series_creator ?? "",
  }));

  return json({ corrections, total, page: opts.page, per: opts.per }, 200, { "cache-control": "no-store" });
}

export async function adminDeleteCorrection(
  env: Env,
  seriesId: string,
  isbn: string
): Promise<Response> {
  const res = await env.DB.prepare(
    `DELETE FROM series_correction WHERE series_id = ? AND isbn = ?`
  )
    .bind(seriesId, isbn)
    .run();
  const deleted = res.meta?.changes ?? 0;
  if (!deleted) return notFound("修正が見つかりません");
  return json({ ok: true, series_id: seriesId, isbn });
}

/** 巻の修正を「確定(承認)」: 正しいユーザ投稿としてレビュー済みにする。巻はそのまま
 *  公開を維持し、admin のレビュー待ちキューからは外れる（reviewed_at にタイムスタンプ）。 */
export async function adminApproveCorrection(
  env: Env,
  seriesId: string,
  isbn: string
): Promise<Response> {
  const res = await env.DB.prepare(
    `UPDATE series_correction SET reviewed_at = ? WHERE series_id = ? AND isbn = ?`
  )
    .bind(Date.now(), seriesId, isbn)
    .run();
  const changed = res.meta?.changes ?? 0;
  if (!changed) return notFound("修正が見つかりません");
  return json({ ok: true, series_id: seriesId, isbn });
}

interface AdminVolumeReportRow {
  series_id: string;
  isbn: string;
  volume_number: string;
  report_count: number;
  first_reported_at: number;
  last_reported_at: number;
  series_name: string | null;
  series_creator: string | null;
  is_correction: number; // 1 = 対応する series_correction 行がある（パージ可能）
  cover_url: string | null; // 表紙: 投稿修正の cover_url、無ければ covers キャッシュ
}

export async function adminListVolumeReports(env: Env, opts: PageOpts): Promise<Response> {
  // 「間違っています」通報を件数の多い順に。source を問わず全ての巻が対象。対応する
  // series_correction 行があればユーザ投稿（パージ削除可）、無ければマスター/補完由来
  // （上流データの疑い）と区別できるよう is_correction を返す。表紙は投稿修正の cover_url、
  // 無ければ covers キャッシュから引き、管理者が実物を目視確認できるようにする。
  const total = await countRows(env, `SELECT COUNT(*) AS n FROM volume_report`);
  const { results } = await env.DB.prepare(
    `SELECT r.series_id, r.isbn, r.volume_number, r.report_count,
            r.first_reported_at, r.last_reported_at,
            s.name AS series_name, s.creator AS series_creator,
            CASE WHEN c.isbn IS NOT NULL THEN 1 ELSE 0 END AS is_correction,
            COALESCE(NULLIF(c.cover_url, ''), cov.cover_url, '') AS cover_url
       FROM volume_report r
       LEFT JOIN series s ON s.id = r.series_id
       LEFT JOIN series_correction c ON c.series_id = r.series_id AND c.isbn = r.isbn
       LEFT JOIN covers cov ON cov.isbn = r.isbn
      ORDER BY r.report_count DESC, r.last_reported_at DESC LIMIT ? OFFSET ?`
  )
    .bind(opts.per, opts.offset)
    .all<AdminVolumeReportRow>();

  const reports = (results ?? []).map((r) => ({
    series_id: r.series_id,
    isbn: r.isbn,
    volume_number: r.volume_number ?? "",
    report_count: r.report_count ?? 0,
    first_reported_at: r.first_reported_at ?? 0,
    last_reported_at: r.last_reported_at ?? 0,
    series_name: r.series_name ?? "",
    series_creator: r.series_creator ?? "",
    is_correction: (r.is_correction ?? 0) === 1,
    cover_url: r.cover_url ?? "",
  }));

  return json({ reports, total, page: opts.page, per: opts.per }, 200, { "cache-control": "no-store" });
}

/** 通報を却下（誤報として volume_report 行だけ削除）。巻データ自体は消さない。 */
export async function adminDismissVolumeReport(
  env: Env,
  seriesId: string,
  isbn: string
): Promise<Response> {
  const res = await env.DB.prepare(
    `DELETE FROM volume_report WHERE series_id = ? AND isbn = ?`
  )
    .bind(seriesId, isbn)
    .run();
  const deleted = res.meta?.changes ?? 0;
  if (!deleted) return notFound("通報が見つかりません");
  return json({ ok: true, series_id: seriesId, isbn });
}

/** 通報を「確定」: その巻を全体で非表示にする。source を問わず volume_hidden に記録し、
 *  getSeriesVolumes が全閲覧者に対して除外する。対応するユーザ投稿(series_correction)が
 *  あればデータも削除し、通報行(volume_report)も片付ける。マスター/補完の巻は元データを
 *  消せない（再取り込みで復活する）ため、volume_hidden による抑制で全体非表示を実現する。 */
export async function adminConfirmVolumeReport(
  env: Env,
  seriesId: string,
  isbn: string
): Promise<Response> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO volume_hidden (series_id, isbn, created_at) VALUES (?, ?, ?)`
  )
    .bind(seriesId, isbn, now)
    .run();
  await env.DB.prepare(`DELETE FROM series_correction WHERE series_id = ? AND isbn = ?`)
    .bind(seriesId, isbn)
    .run();
  await env.DB.prepare(`DELETE FROM volume_report WHERE series_id = ? AND isbn = ?`)
    .bind(seriesId, isbn)
    .run();
  return json({ ok: true, series_id: seriesId, isbn });
}

interface AdminHiddenVolumeRow {
  series_id: string;
  isbn: string;
  created_at: number;
  volume_number: string | null;
  series_name: string | null;
  series_creator: string | null;
  cover_url: string | null;
}

/** 通報を「確定」して全体から非表示にした巻の履歴（volume_hidden）。新しい非表示順。
 *  確定するとキューからも元データからも消えて追跡できなくなるため、ここで何を隠したかを
 *  振り返れるようにする。巻ラベル・表紙は残っているマスター(volumes)/キャッシュ(covers)から
 *  引いて実物を確認できるようにする（確定時に series_correction は削除済みのことがある）。 */
export async function adminListHiddenVolumes(env: Env, opts: PageOpts): Promise<Response> {
  const total = await countRows(env, `SELECT COUNT(*) AS n FROM volume_hidden`);
  const { results } = await env.DB.prepare(
    `SELECT h.series_id, h.isbn, h.created_at,
            COALESCE(v.volume_number, c.volume_number, '') AS volume_number,
            s.name AS series_name, s.creator AS series_creator,
            COALESCE(NULLIF(c.cover_url, ''), cov.cover_url, '') AS cover_url
       FROM volume_hidden h
       LEFT JOIN series s ON s.id = h.series_id
       LEFT JOIN series_correction c ON c.series_id = h.series_id AND c.isbn = h.isbn
       LEFT JOIN volumes v ON v.isbn = h.isbn
       LEFT JOIN covers cov ON cov.isbn = h.isbn
      ORDER BY h.created_at DESC LIMIT ? OFFSET ?`
  )
    .bind(opts.per, opts.offset)
    .all<AdminHiddenVolumeRow>();

  const hidden = (results ?? []).map((r) => ({
    series_id: r.series_id,
    isbn: r.isbn,
    created_at: r.created_at,
    volume_number: r.volume_number ?? "",
    series_name: r.series_name ?? "",
    series_creator: r.series_creator ?? "",
    cover_url: r.cover_url ?? "",
  }));

  return json({ hidden, total, page: opts.page, per: opts.per }, 200, { "cache-control": "no-store" });
}

interface AdminSeriesReportRow {
  series_id: string;
  reported_name: string;
  suggested_name: string;        // 通報者が任意で添えた正しい名前の提案（最新の非空値）
  report_count: number;
  first_reported_at: number;
  last_reported_at: number;
  current_name: string | null;   // series.name の現値（再取り込みで snapshot と食い違う場合の確認用）
  name_kana: string | null;      // かな読み（正しいタイトルのヒント）
  vol_title: string | null;      // 収録巻に載る title（正しいタイトルのヒント。多くは series 名と一致）
  override_name: string | null;  // 既に修正済みなら series_name_override.name
}

/** シリーズ名の通報一覧。件数の多い順。管理者が正しい名前を判断できるよう、現在の
 *  series.name・かな読み・収録巻の title・既存の上書き名をヒントとして併記する。 */
export async function adminListSeriesReports(env: Env, opts: PageOpts): Promise<Response> {
  const total = await countRows(env, `SELECT COUNT(*) AS n FROM series_report`);
  const { results } = await env.DB.prepare(
    `SELECT r.series_id, r.reported_name, r.suggested_name, r.report_count,
            r.first_reported_at, r.last_reported_at,
            s.name AS current_name, s.name_kana AS name_kana,
            (SELECT v.title FROM volumes v
              WHERE v.series_id = r.series_id AND v.title <> '' LIMIT 1) AS vol_title,
            o.name AS override_name
       FROM series_report r
       LEFT JOIN series s ON s.id = r.series_id
       LEFT JOIN series_name_override o ON o.series_id = r.series_id
      ORDER BY r.report_count DESC, r.last_reported_at DESC LIMIT ? OFFSET ?`
  )
    .bind(opts.per, opts.offset)
    .all<AdminSeriesReportRow>();

  const reports = (results ?? []).map((r) => ({
    series_id: r.series_id,
    reported_name: r.reported_name ?? "",
    suggested_name: r.suggested_name ?? "",
    report_count: r.report_count ?? 0,
    first_reported_at: r.first_reported_at ?? 0,
    last_reported_at: r.last_reported_at ?? 0,
    current_name: r.current_name ?? "",
    name_kana: r.name_kana ?? "",
    vol_title: r.vol_title ?? "",
    override_name: r.override_name ?? "",
  }));

  return json({ reports, total, page: opts.page, per: opts.per }, 200, { "cache-control": "no-store" });
}

/** シリーズ名の通報を却下（誤報として series_report 行だけ削除）。名前は変更しない。 */
export async function adminDismissSeriesReport(env: Env, seriesId: string): Promise<Response> {
  const res = await env.DB.prepare(`DELETE FROM series_report WHERE series_id = ?`)
    .bind(seriesId)
    .run();
  const deleted = res.meta?.changes ?? 0;
  if (!deleted) return notFound("通報が見つかりません");
  return json({ ok: true, series_id: seriesId });
}

/** シリーズ名を修正（上書き）。正しい名前を series_name_override に記録し、read 時に
 *  COALESCE で全ユーザの検索/詳細表示へ反映する（再取り込みでマスター名が戻っても残る）。
 *  併せて対応する通報行を片付ける。空文字は上書きにならないので拒否する。 */
export async function adminOverrideSeriesName(
  request: Request,
  env: Env,
  seriesId: string
): Promise<Response> {
  const meta = await env.DB.prepare(`SELECT id FROM series WHERE id = ?`)
    .bind(seriesId)
    .first<{ id: string }>();
  if (!meta) return notFound("シリーズが見つかりません");

  const body = (await readJsonObject(request)) as { name?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return json({ ok: false, error: "名前を指定してください" }, 400);
  if (name.length > 200) return json({ ok: false, error: "名前が長すぎます" }, 400);

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO series_name_override (series_id, name, created_at) VALUES (?, ?, ?)
     ON CONFLICT (series_id) DO UPDATE SET name = excluded.name, created_at = excluded.created_at`
  )
    .bind(seriesId, name, now)
    .run();
  await env.DB.prepare(`DELETE FROM series_report WHERE series_id = ?`).bind(seriesId).run();
  return json({ ok: true, series_id: seriesId, name });
}

interface AdminNameOverrideRow {
  series_id: string;
  name: string;
  created_at: number;
  current_name: string | null; // series.name の現値（再取り込みでマスターに戻った名前）
}

/** シリーズ名の通報を「名前修正」で確定した履歴（series_name_override）。新しい修正順。
 *  read 時に COALESCE で全閲覧者へ反映される上書き名なので、何をどう直したか（上書き名と
 *  現在のマスター名）を後から確認できるようにする。 */
export async function adminListNameOverrides(env: Env, opts: PageOpts): Promise<Response> {
  const total = await countRows(env, `SELECT COUNT(*) AS n FROM series_name_override`);
  const { results } = await env.DB.prepare(
    `SELECT o.series_id, o.name, o.created_at, s.name AS current_name
       FROM series_name_override o
       LEFT JOIN series s ON s.id = o.series_id
      ORDER BY o.created_at DESC LIMIT ? OFFSET ?`
  )
    .bind(opts.per, opts.offset)
    .all<AdminNameOverrideRow>();

  const overrides = (results ?? []).map((r) => ({
    series_id: r.series_id,
    name: r.name,
    created_at: r.created_at,
    current_name: r.current_name ?? "",
  }));

  return json({ overrides, total, page: opts.page, per: opts.per }, 200, { "cache-control": "no-store" });
}

interface AdminVolumeTitleReportRow {
  isbn: string;
  series_id: string;
  reported_title: string;
  report_count: number;
  first_reported_at: number;
  last_reported_at: number;
  volume_number: string | null; // マスター巻ラベル（どの巻か確認用）
  current_title: string | null; // 現在の master volumes.title
  series_name: string | null;   // 所属シリーズ名（series_name_override 適用後）
  common_title: string | null;  // そのシリーズで最多の巻タイトル（「揃える」候補）
  override_title: string | null; // 既に修正済みなら volume_title_override.title
  cover_url: string | null;
}

/** 本のタイトルの通報一覧。件数の多い順。管理者が正しいタイトルを判断できるよう、現在の
 *  master タイトル・所属シリーズ名・そのシリーズで最多の巻タイトル（「揃える」候補）・既存の
 *  上書きを併記する。表紙は covers キャッシュから引いて実物を目視確認できるようにする。 */
export async function adminListVolumeTitleReports(env: Env, opts: PageOpts): Promise<Response> {
  const total = await countRows(env, `SELECT COUNT(*) AS n FROM volume_title_report`);
  const { results } = await env.DB.prepare(
    `SELECT r.isbn, r.series_id, r.reported_title, r.report_count,
            r.first_reported_at, r.last_reported_at,
            v.volume_number AS volume_number, v.title AS current_title,
            COALESCE(so.name, s.name) AS series_name,
            (SELECT v2.title FROM volumes v2
              WHERE v2.series_id = r.series_id AND v2.title <> ''
              GROUP BY v2.title
              ORDER BY COUNT(*) DESC, LENGTH(v2.title) DESC, v2.title LIMIT 1) AS common_title,
            o.title AS override_title,
            cov.cover_url AS cover_url
       FROM volume_title_report r
       LEFT JOIN volumes v ON v.isbn = r.isbn
       LEFT JOIN series s ON s.id = r.series_id
       LEFT JOIN series_name_override so ON so.series_id = r.series_id
       LEFT JOIN volume_title_override o ON o.isbn = r.isbn
       LEFT JOIN covers cov ON cov.isbn = r.isbn
      ORDER BY r.report_count DESC, r.last_reported_at DESC LIMIT ? OFFSET ?`
  )
    .bind(opts.per, opts.offset)
    .all<AdminVolumeTitleReportRow>();

  const reports = (results ?? []).map((r) => ({
    isbn: r.isbn,
    series_id: r.series_id ?? "",
    reported_title: r.reported_title ?? "",
    report_count: r.report_count ?? 0,
    first_reported_at: r.first_reported_at ?? 0,
    last_reported_at: r.last_reported_at ?? 0,
    volume_number: r.volume_number ?? "",
    current_title: r.current_title ?? "",
    series_name: r.series_name ?? "",
    common_title: r.common_title ?? "",
    override_title: r.override_title ?? "",
    cover_url: r.cover_url ?? "",
  }));

  return json({ reports, total, page: opts.page, per: opts.per }, 200, { "cache-control": "no-store" });
}

/** 本のタイトルの通報を却下（誤報として volume_title_report 行だけ削除）。タイトルは変更しない。 */
export async function adminDismissVolumeTitleReport(env: Env, isbn: string): Promise<Response> {
  const res = await env.DB.prepare(`DELETE FROM volume_title_report WHERE isbn = ?`)
    .bind(isbn)
    .run();
  const deleted = res.meta?.changes ?? 0;
  if (!deleted) return notFound("通報が見つかりません");
  return json({ ok: true, isbn });
}

/** 本のタイトルを手動で修正（上書き）。正しいタイトルを volume_title_override に記録し、
 *  getSeriesVolumes の read 時に全巻へ反映する（再取り込みでマスター名が戻っても残る）。
 *  併せて対応する通報行を片付ける。空文字は上書きにならないので拒否する。 */
export async function adminOverrideVolumeTitle(
  request: Request,
  env: Env,
  isbn: string
): Promise<Response> {
  const body = (await readJsonObject(request)) as { title?: unknown };
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return json({ ok: false, error: "タイトルを指定してください" }, 400);
  if (title.length > 200) return json({ ok: false, error: "タイトルが長すぎます" }, 400);

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO volume_title_override (isbn, title, created_at) VALUES (?, ?, ?)
     ON CONFLICT (isbn) DO UPDATE SET title = excluded.title, created_at = excluded.created_at`
  )
    .bind(isbn, title, now)
    .run();
  await env.DB.prepare(`DELETE FROM volume_title_report WHERE isbn = ?`).bind(isbn).run();
  return json({ ok: true, isbn, title });
}

/** 本のタイトルをそのシリーズで最多の巻タイトルに「揃える」。series_id は通報行から、
 *  無ければ master volumes から解決し、getMostCommonVolumeTitle で最多タイトルを求めて
 *  volume_title_override に記録する。シリーズ未特定や巻が無い場合は揃えられないので拒否。 */
export async function adminApplyCommonTitleToVolume(env: Env, isbn: string): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(NULLIF(r.series_id, ''), v.series_id) AS series_id
       FROM volume_title_report r
       LEFT JOIN volumes v ON v.isbn = r.isbn
      WHERE r.isbn = ?`
  )
    .bind(isbn)
    .first<{ series_id: string | null }>();
  const seriesId =
    row?.series_id ??
    (await env.DB.prepare(`SELECT series_id FROM volumes WHERE isbn = ?`)
      .bind(isbn)
      .first<{ series_id: string | null }>())?.series_id ??
    "";
  if (!seriesId) return json({ ok: false, error: "シリーズを特定できません" }, 400);

  const common = await getMostCommonVolumeTitle(env, seriesId);
  if (!common) return json({ ok: false, error: "シリーズに巻がありません" }, 400);

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO volume_title_override (isbn, title, created_at) VALUES (?, ?, ?)
     ON CONFLICT (isbn) DO UPDATE SET title = excluded.title, created_at = excluded.created_at`
  )
    .bind(isbn, common.title, now)
    .run();
  await env.DB.prepare(`DELETE FROM volume_title_report WHERE isbn = ?`).bind(isbn).run();
  return json({ ok: true, isbn, title: common.title });
}

interface AdminVolumeTitleOverrideRow {
  isbn: string;
  title: string;
  created_at: number;
  volume_number: string | null;
  current_title: string | null; // 現在の master volumes.title（再取り込みで戻った値）
  series_id: string | null;
  series_name: string | null;
  cover_url: string | null;
}

/** 本のタイトルを修正した履歴（volume_title_override）。新しい修正順。read 時に全巻へ
 *  反映される上書きなので、何をどう直したか（上書きタイトルと現在の master タイトル）を
 *  後から確認できるようにする。 */
export async function adminListVolumeTitleOverrides(env: Env, opts: PageOpts): Promise<Response> {
  const total = await countRows(env, `SELECT COUNT(*) AS n FROM volume_title_override`);
  const { results } = await env.DB.prepare(
    `SELECT o.isbn, o.title, o.created_at,
            v.volume_number AS volume_number, v.title AS current_title,
            v.series_id AS series_id,
            COALESCE(so.name, s.name) AS series_name,
            cov.cover_url AS cover_url
       FROM volume_title_override o
       LEFT JOIN volumes v ON v.isbn = o.isbn
       LEFT JOIN series s ON s.id = v.series_id
       LEFT JOIN series_name_override so ON so.series_id = v.series_id
       LEFT JOIN covers cov ON cov.isbn = o.isbn
      ORDER BY o.created_at DESC LIMIT ? OFFSET ?`
  )
    .bind(opts.per, opts.offset)
    .all<AdminVolumeTitleOverrideRow>();

  const overrides = (results ?? []).map((r) => ({
    isbn: r.isbn,
    title: r.title,
    created_at: r.created_at,
    volume_number: r.volume_number ?? "",
    current_title: r.current_title ?? "",
    series_id: r.series_id ?? "",
    series_name: r.series_name ?? "",
    cover_url: r.cover_url ?? "",
  }));

  return json({ overrides, total, page: opts.page, per: opts.per }, 200, { "cache-control": "no-store" });
}

export async function adminCoverSummary(env: Env): Promise<Response> {
  // cover_url = '' は「どこにも書影が無い」と確定してキャッシュした行。削除すると
  // 次回アクセス時に再探索される（新しく書影が追加された本の拾い直しに使う）。
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN cover_url = '' THEN 1 ELSE 0 END) AS empty
       FROM covers`
  ).first<{ total: number; empty: number | null }>();
  const total = row?.total ?? 0;
  const empty = row?.empty ?? 0;
  return json(
    { summary: { total, empty, with_cover: total - empty } },
    200,
    { "cache-control": "no-store" }
  );
}

// R2 のトリム済み表紙（yahoo/*.jpg）の件数と合計サイズ。D1 の covers キャッシュとは
// 別軸の「R2 に materialise 済みの画像」を可視化するための子機能。binding 未設定の
// 環境では bound:false で返す（画面側は「未設定」と表示）。
export async function adminCoverR2Summary(env: Env): Promise<Response> {
  if (!env.COVERS) {
    return json({ r2: { bound: false, count: 0, bytes: 0 } }, 200, { "cache-control": "no-store" });
  }
  let count = 0;
  let bytes = 0;
  let cursor: string | undefined;
  do {
    const listed = await env.COVERS.list({ prefix: "yahoo/", limit: 1000, cursor });
    for (const o of listed.objects) {
      count++;
      bytes += o.size;
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return json({ r2: { bound: true, count, bytes } }, 200, { "cache-control": "no-store" });
}

// R2 のトリム済み表紙だけを全消去（D1 の covers キャッシュは残す）。covers を消さず
// R2 だけ消すと、次回アクセス時に同じ元 URL を再トリムして R2 に入れ直す挙動の確認に
// 使える。全キャッシュ削除（D1+R2）とは別の、R2 単独のクリーン操作。
export async function adminPurgeCoverR2(env: Env): Promise<Response> {
  if (!env.COVERS) {
    return json({ error: "R2 バケット（COVERS）がこの環境では未設定です" }, 400, {
      "cache-control": "no-store",
    });
  }
  const r2Covers = await purgeCoverStore(env);
  return json({ ok: true, r2Covers }, 200, { "cache-control": "no-store" });
}

export async function adminDeleteCover(env: Env, isbn: string): Promise<Response> {
  const res = await env.DB.prepare(`DELETE FROM covers WHERE isbn = ?`).bind(isbn).run();
  const deleted = res.meta?.changes ?? 0;
  if (!deleted) return notFound("表紙キャッシュが見つかりません");
  return json({ ok: true, isbn });
}

export async function adminPurgeCovers(request: Request, env: Env): Promise<Response> {
  const body = (await readJsonObject(request)) as { mode?: unknown };
  const mode = body.mode;
  if (mode !== "empty" && mode !== "all") {
    return json({ error: "mode は 'empty' か 'all' を指定してください" }, 400);
  }
  const sql = mode === "empty" ? `DELETE FROM covers WHERE cover_url = ''` : `DELETE FROM covers`;
  const res = await env.DB.prepare(sql).run();
  // 全削除時は R2 のトリム済み表紙も消す。残すと /cover が再トリムせず R2 ヒットで
  // 配信してしまい、クリーン再テストにならない。empty（No Image 行）は R2 に実体が
  // 無いのでパージ不要。
  const r2Covers = mode === "all" ? await purgeCoverStore(env) : 0;
  return json({ ok: true, mode, deleted: res.meta?.changes ?? 0, r2Covers });
}

interface AdminCoverSuggestionRow {
  isbn: string;
  cover_url: string;
  old_cover_url: string;
  suggest_count: number;
  first_at: number;
  last_at: number;
  resolved_at: number;
  resolution: string;
  title: string | null;   // volumes から引けた場合の作品名（無ければ null）
  creator: string | null;
  series_id: string | null;      // 巻一覧モーダルを開くための C-id（無ければ null）
  volume_number: string | null;  // 該当巻の巻数ラベル（無ければ null）
}

/** 表紙の修正キュー: リスト編集の「表紙を変更」で、ユーザがキャッシュと違う表紙を選んだもの。
 *  提案表紙・提案時点のキャッシュ表紙・件数を新旧並べて返し、管理者が承認すれば covers を上書き
 *  して全体反映する。作品名は volumes（マスタ）から引けた場合のみ併記（判断材料）。 */
export async function adminListCoverSuggestions(
  env: Env,
  opts: PageOpts,
  resolved = false
): Promise<Response> {
  const where = resolved ? "cs.resolved_at > 0" : "cs.resolved_at = 0";
  const total = await countRows(
    env,
    `SELECT COUNT(*) AS n FROM cover_suggestion cs WHERE ${where}`
  );
  const order = resolved
    ? "cs.resolved_at DESC, cs.last_at DESC"
    : "cs.suggest_count DESC, cs.last_at DESC";
  const { results } = await env.DB.prepare(
    `SELECT cs.isbn, cs.cover_url, cs.old_cover_url, cs.suggest_count,
            cs.first_at, cs.last_at, cs.resolved_at, cs.resolution,
            v.title, v.creator, v.series_id, v.volume_number
       FROM cover_suggestion cs
       LEFT JOIN volumes v ON v.isbn = cs.isbn
      WHERE ${where}
      ORDER BY ${order} LIMIT ? OFFSET ?`
  )
    .bind(opts.per, opts.offset)
    .all<AdminCoverSuggestionRow>();

  const suggestions = (results ?? []).map((r) => ({
    isbn: r.isbn,
    cover_url: r.cover_url,
    old_cover_url: r.old_cover_url ?? "",
    suggest_count: r.suggest_count ?? 0,
    first_at: r.first_at ?? 0,
    last_at: r.last_at ?? 0,
    resolved_at: r.resolved_at ?? 0,
    resolution: r.resolution ?? "",
    title: r.title ?? "",
    creator: r.creator ?? "",
    series_id: r.series_id ?? "",
    volume_number: r.volume_number ?? "",
  }));

  return json({ suggestions, total, page: opts.page, per: opts.per }, 200, { "cache-control": "no-store" });
}

/** 表紙の修正を承認: 提案表紙を covers キャッシュへ上書き（INSERT OR REPLACE）し、全リスト/
 *  シリーズ閲覧へ波及させる。承認したら、その ISBN の提案は全て解決済みとして削除する。 */
export async function adminApproveCoverSuggestion(
  request: Request,
  env: Env,
  isbn: string
): Promise<Response> {
  const body = (await readJsonObject(request)) as { cover_url?: unknown };
  const coverUrl = typeof body.cover_url === "string" ? body.cover_url.trim() : "";
  if (!/^https?:\/\//i.test(coverUrl)) return json({ error: "表紙URLが不正です" }, 400);

  const row = await env.DB.prepare(
    `SELECT 1 FROM cover_suggestion WHERE isbn = ? AND cover_url = ? AND resolved_at = 0`
  )
    .bind(isbn, coverUrl)
    .first();
  if (!row) return notFound("表紙の修正が見つかりません");

  const now = Date.now();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO covers (isbn, cover_url, checked_at) VALUES (?, ?, ?)`
  )
    .bind(isbn, coverUrl, now)
    .run();
  // 承認したら同 ISBN の未解決の提案は全て片付ける。採用した候補は approved、
  // 採用しなかった候補は superseded として解決済みに倒す（履歴として残す）。
  await env.DB.prepare(
    `UPDATE cover_suggestion SET resolved_at = ?, resolution = 'approved'
       WHERE isbn = ? AND cover_url = ? AND resolved_at = 0`
  )
    .bind(now, isbn, coverUrl)
    .run();
  await env.DB.prepare(
    `UPDATE cover_suggestion SET resolved_at = ?, resolution = 'superseded'
       WHERE isbn = ? AND cover_url <> ? AND resolved_at = 0`
  )
    .bind(now, isbn, coverUrl)
    .run();

  return json({ ok: true, isbn, cover_url: coverUrl });
}

/** 表紙の修正を却下: その (isbn, cover_url) の提案行だけ解決済み(dismissed)に倒す。covers は触らない。 */
export async function adminDismissCoverSuggestion(
  request: Request,
  env: Env,
  isbn: string
): Promise<Response> {
  const body = (await readJsonObject(request)) as { cover_url?: unknown };
  const coverUrl = typeof body.cover_url === "string" ? body.cover_url.trim() : "";
  if (!coverUrl) return json({ error: "cover_url を指定してください" }, 400);

  const res = await env.DB.prepare(
    `UPDATE cover_suggestion SET resolved_at = ?, resolution = 'dismissed'
       WHERE isbn = ? AND cover_url = ? AND resolved_at = 0`
  )
    .bind(Date.now(), isbn, coverUrl)
    .run();
  if (!(res.meta?.changes ?? 0)) return notFound("表紙の修正が見つかりません");
  return json({ ok: true, isbn });
}

export async function adminSupplementSummary(env: Env): Promise<Response> {
  // volumes_json = '[]' は「ライブMADBを引いたが追加巻は無かった」と確定キャッシュした行。
  // 削除すると次回アクセス時に再度 SPARQL を引き直す（上流に巻が追加された時の拾い直し）。
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN volumes_json = '[]' THEN 1 ELSE 0 END) AS empty
       FROM series_supplement`
  ).first<{ total: number; empty: number | null }>();
  const total = row?.total ?? 0;
  const empty = row?.empty ?? 0;
  return json(
    { summary: { total, empty, with_vols: total - empty } },
    200,
    { "cache-control": "no-store" }
  );
}

interface AdminSupplementRow {
  series_id: string;
  volumes_json: string;
  checked_at: number;
  series_name: string | null;
  series_creator: string | null;
}

export async function adminListSupplements(env: Env, opts: PageOpts): Promise<Response> {
  const total = await countRows(env, `SELECT COUNT(*) AS n FROM series_supplement`);
  const { results } = await env.DB.prepare(
    `SELECT sp.series_id, sp.volumes_json, sp.checked_at,
            s.name AS series_name, s.creator AS series_creator
       FROM series_supplement sp
       LEFT JOIN series s ON s.id = sp.series_id
      ORDER BY sp.checked_at DESC LIMIT ? OFFSET ?`
  )
    .bind(opts.per, opts.offset)
    .all<AdminSupplementRow>();

  const supplements = (results ?? []).map((r) => {
    let volumes: unknown[] = [];
    try {
      const parsed = JSON.parse(r.volumes_json);
      if (Array.isArray(parsed)) volumes = parsed;
    } catch {
      volumes = [];
    }
    return {
      series_id: r.series_id,
      series_name: r.series_name ?? "",
      series_creator: r.series_creator ?? "",
      vol_count: volumes.length,
      checked_at: r.checked_at,
      volumes,
    };
  });

  return json({ supplements, total, page: opts.page, per: opts.per }, 200, { "cache-control": "no-store" });
}

export async function adminDeleteSupplement(env: Env, seriesId: string): Promise<Response> {
  const res = await env.DB.prepare(`DELETE FROM series_supplement WHERE series_id = ?`)
    .bind(seriesId)
    .run();
  if (!(res.meta?.changes ?? 0)) return notFound("補完キャッシュが見つかりません");
  return json({ ok: true, series_id: seriesId });
}

export async function adminPurgeSupplements(request: Request, env: Env): Promise<Response> {
  const body = (await readJsonObject(request)) as { mode?: unknown };
  const mode = body.mode;
  if (mode !== "empty" && mode !== "all") {
    return json({ error: "mode は 'empty' か 'all' を指定してください" }, 400);
  }
  const sql =
    mode === "empty"
      ? `DELETE FROM series_supplement WHERE volumes_json = '[]'`
      : `DELETE FROM series_supplement`;
  const res = await env.DB.prepare(sql).run();
  return json({ ok: true, mode, deleted: res.meta?.changes ?? 0 });
}

export async function adminBookMetaSummary(env: Env): Promise<Response> {
  // caption = '' は「楽天にエントリはあったが、あらすじ(itemCaption)が無かった」と確定して
  // キャッシュした行。削除すると次回詳細ポップアップを開いた時に楽天を引き直す
  // （後からあらすじが追加された本の拾い直しに使う）。See src/book.ts。
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN caption = '' THEN 1 ELSE 0 END) AS empty
       FROM book_meta`
  ).first<{ total: number; empty: number | null }>();
  const total = row?.total ?? 0;
  const empty = row?.empty ?? 0;
  return json(
    { summary: { total, empty, with_caption: total - empty } },
    200,
    { "cache-control": "no-store" }
  );
}

interface AdminBookMetaRow {
  isbn: string;
  authors: string;
  publisher: string;
  pubdate: string;
  caption: string;
  checked_at: number;
  title: string | null;        // マスター volumes から引けた作品名
  series_id: string | null;    // 巻一覧モーダルを開くための C-id
  volume_number: string | null; // 該当巻の巻数ラベル
  cover_url: string | null;    // covers キャッシュの表紙（実物の目視確認用）
}

/** 楽天データ（book_meta）キャッシュ一覧。あらすじ・作者・出版社・発行日を新しい確認順で返す。
 *  作品名・巻数・表紙は covers / volumes から引いて、どの本のキャッシュか目視確認できるようにする。
 *  q 指定時は ISBN・作者・出版社・作品名（volumes.title）を部分一致で絞り込む。 */
export async function adminListBookMeta(env: Env, opts: PageOpts, q = ""): Promise<Response> {
  const term = q.trim();
  // LIKE のワイルドカード（% _）をエスケープして部分一致検索。ESCAPE '\' を併用する。
  const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const where = term
    ? `WHERE bm.isbn LIKE ?1 ESCAPE '\\' OR bm.authors LIKE ?1 ESCAPE '\\'
          OR bm.publisher LIKE ?1 ESCAPE '\\' OR v.title LIKE ?1 ESCAPE '\\'`
    : "";

  const countSql = term
    ? `SELECT COUNT(*) AS n FROM book_meta bm LEFT JOIN volumes v ON v.isbn = bm.isbn ${where}`
    : `SELECT COUNT(*) AS n FROM book_meta`;
  const total = term ? await countRows(env, countSql, [like]) : await countRows(env, countSql);

  const listSql =
    `SELECT bm.isbn, bm.authors, bm.publisher, bm.pubdate, bm.caption, bm.checked_at,
            v.title AS title, v.series_id AS series_id, v.volume_number AS volume_number,
            cov.cover_url AS cover_url
       FROM book_meta bm
       LEFT JOIN volumes v ON v.isbn = bm.isbn
       LEFT JOIN covers cov ON cov.isbn = bm.isbn
      ${where}
      ORDER BY bm.checked_at DESC LIMIT ?2 OFFSET ?3`;
  const stmt = term
    ? env.DB.prepare(listSql).bind(like, opts.per, opts.offset)
    : env.DB.prepare(
        `SELECT bm.isbn, bm.authors, bm.publisher, bm.pubdate, bm.caption, bm.checked_at,
                v.title AS title, v.series_id AS series_id, v.volume_number AS volume_number,
                cov.cover_url AS cover_url
           FROM book_meta bm
           LEFT JOIN volumes v ON v.isbn = bm.isbn
           LEFT JOIN covers cov ON cov.isbn = bm.isbn
          ORDER BY bm.checked_at DESC LIMIT ? OFFSET ?`
      ).bind(opts.per, opts.offset);
  const { results } = await stmt.all<AdminBookMetaRow>();

  const books = (results ?? []).map((r) => ({
    isbn: r.isbn,
    authors: r.authors ? r.authors.split("/") : [],
    publisher: r.publisher ?? "",
    pubdate: r.pubdate ?? "",
    caption: r.caption ?? "",
    checked_at: r.checked_at ?? 0,
    title: r.title ?? "",
    series_id: r.series_id ?? "",
    volume_number: r.volume_number ?? "",
    cover_url: r.cover_url ?? "",
  }));

  return json({ books, total, page: opts.page, per: opts.per, q: term }, 200, { "cache-control": "no-store" });
}

export async function adminDeleteBookMeta(env: Env, isbn: string): Promise<Response> {
  const res = await env.DB.prepare(`DELETE FROM book_meta WHERE isbn = ?`).bind(isbn).run();
  const deleted = res.meta?.changes ?? 0;
  if (!deleted) return notFound("楽天データキャッシュが見つかりません");
  return json({ ok: true, isbn });
}

export async function adminPurgeBookMeta(request: Request, env: Env): Promise<Response> {
  const body = (await readJsonObject(request)) as { mode?: unknown };
  const mode = body.mode;
  if (mode !== "empty" && mode !== "all") {
    return json({ error: "mode は 'empty' か 'all' を指定してください" }, 400);
  }
  const sql =
    mode === "empty" ? `DELETE FROM book_meta WHERE caption = ''` : `DELETE FROM book_meta`;
  const res = await env.DB.prepare(sql).run();
  return json({ ok: true, mode, deleted: res.meta?.changes ?? 0 });
}

interface ReportRow {
  id: number;
  slug: string;
  target_type: string;
  position: number;
  reported_text: string;
  report_count: number;
  first_at: number;
  last_at: number;
  resolved_at: number;
  resolution: string;
  owner_name: string | null;
  bio: string | null;
  items_json: string | null;
}

/** 自由入力の通報一覧。resolved=false なら未処理（resolved_at = 0）、true なら処理済み
 *  （却下/伏字。resolved_at > 0）を新しい処理順に返す。却下・伏字はソフトデリートなので、
 *  後からどの通報をどう処理したか（resolution）を振り返れる。 */
export async function adminListReports(
  env: Env,
  opts: PageOpts,
  resolved = false
): Promise<Response> {
  // 通報時点のスナップショット（reported_text）と、現在のリストの当該テキストを両方返す。
  // 既に作成者が直していれば current_text が変わっている / リスト削除済みなら list_exists=false。
  const where = resolved ? `r.resolved_at > 0` : `r.resolved_at = 0`;
  const order = resolved ? `r.resolved_at DESC` : `r.last_at DESC`;
  const total = await countRows(env, `SELECT COUNT(*) AS n FROM reports r WHERE ${where}`);
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.slug, r.target_type, r.position, r.reported_text,
            r.report_count, r.first_at, r.last_at, r.resolved_at, r.resolution,
            l.owner_name, l.bio, l.items_json
       FROM reports r
       LEFT JOIN lists l ON l.slug = r.slug
      WHERE ${where}
      ORDER BY ${order} LIMIT ? OFFSET ?`
  )
    .bind(opts.per, opts.offset)
    .all<ReportRow>();

  // Item titles / covers are site-wide: resolve every referenced item's ISBN at once.
  const itemOf = (r: ReportRow): StoredListItem | undefined => {
    if (!r.items_json || r.target_type === "owner_name" || r.target_type === "bio") return undefined;
    let items: StoredListItem[] = [];
    try {
      items = JSON.parse(r.items_json) as StoredListItem[];
    } catch {
      items = [];
    }
    return items.find((i) => i.position === r.position) ?? items[r.position - 1];
  };
  const rowItems = (results ?? []).map(itemOf);
  const books = await resolveBooks(env, rowItems.map((i) => i?.isbn ?? ""));

  const reports = (results ?? []).map((r, k) => {
    const listExists = r.items_json !== null || r.owner_name !== null;
    let currentText = "";
    let itemTitle = "";
    if (r.target_type === "owner_name") {
      currentText = r.owner_name ?? "";
    } else if (r.target_type === "bio") {
      currentText = r.bio ?? "";
    } else if (r.items_json) {
      const item = rowItems[k];
      const book = item ? books.get(toIsbn13(item.isbn)) : undefined;
      currentText = r.target_type === "cover" ? (book?.cover_url ?? "") : (item?.comment ?? "");
      itemTitle = book?.title ?? "";
    }
    return {
      id: r.id,
      slug: r.slug,
      target_type: r.target_type,
      position: r.position,
      reported_text: r.reported_text,
      current_text: currentText,
      item_title: itemTitle,
      report_count: r.report_count,
      first_at: r.first_at,
      last_at: r.last_at,
      resolved_at: r.resolved_at ?? 0,
      resolution: r.resolution ?? "",
      list_exists: listExists,
    };
  });

  return json({ reports, total, page: opts.page, per: opts.per }, 200, { "cache-control": "no-store" });
}

interface PublishAuditRow {
  id: number;
  slug: string;
  action: string;
  owner_name: string | null;
  ip: string | null;
  user_agent: string | null;
  country: string | null;
  created_at: number;
}

// 公開の監査ログ（誰がいつ公開/更新したか）。新しい順。特定のリストだけ見たいときは
// slug で絞り込める。追記専用テーブルなので削除系は用意しない。See src/lists.ts。
export async function adminListPublishAudit(
  env: Env,
  opts: PageOpts,
  slug?: string
): Promise<Response> {
  const total = slug
    ? await countRows(env, `SELECT COUNT(*) AS n FROM publish_audit WHERE slug = ?`, [slug])
    : await countRows(env, `SELECT COUNT(*) AS n FROM publish_audit`);

  const stmt = slug
    ? env.DB.prepare(
        `SELECT id, slug, action, owner_name, ip, user_agent, country, created_at
           FROM publish_audit WHERE slug = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`
      ).bind(slug, opts.per, opts.offset)
    : env.DB.prepare(
        `SELECT id, slug, action, owner_name, ip, user_agent, country, created_at
           FROM publish_audit ORDER BY created_at DESC LIMIT ? OFFSET ?`
      ).bind(opts.per, opts.offset);

  const { results } = await stmt.all<PublishAuditRow>();

  const audit = (results ?? []).map((r) => ({
    id: r.id,
    slug: r.slug,
    action: r.action,
    owner_name: r.owner_name ?? "",
    ip: r.ip ?? "",
    user_agent: r.user_agent ?? "",
    country: r.country ?? "",
    created_at: r.created_at,
  }));

  return json({ audit, total, page: opts.page, per: opts.per }, 200, { "cache-control": "no-store" });
}

// 却下（誤報）。行は消さずソフトデリート: resolved_at に処理時刻、resolution='dismissed'。
// 未処理（resolved_at = 0）のものだけを対象にする。
export async function adminDismissReport(env: Env, id: number): Promise<Response> {
  const res = await env.DB.prepare(
    `UPDATE reports SET resolved_at = ?, resolution = 'dismissed' WHERE id = ? AND resolved_at = 0`
  )
    .bind(Date.now(), id)
    .run();
  if (!(res.meta?.changes ?? 0)) return notFound("通報が見つかりません");
  return json({ ok: true, id });
}

// 通報対象のテキストだけを消す（リスト・作品自体は残す）。owner_name / bio は空文字に、comment は
// 当該作品の comment を空文字にする。処理後、通報行はソフトデリート（resolved_at + resolution）
// で残し、処理済み履歴から辿れるようにする。未処理（resolved_at = 0）のものだけを対象にする。
export async function adminRedactReport(env: Env, id: number): Promise<Response> {
  const rep = await env.DB.prepare(
    `SELECT id, slug, target_type, position, reported_text FROM reports WHERE id = ? AND resolved_at = 0`
  )
    .bind(id)
    .first<{ id: number; slug: string; target_type: string; position: number; reported_text: string }>();
  if (!rep) return notFound("通報が見つかりません");

  const now = Date.now();
  const list = await env.DB.prepare(`SELECT owner_name, items_json FROM lists WHERE slug = ?`)
    .bind(rep.slug)
    .first<{ owner_name: string | null; items_json: string }>();
  if (!list) {
    // リストが既に無いなら伏字にする対象も無いので、却下としてソフトデリートするだけ。
    await env.DB.prepare(
      `UPDATE reports SET resolved_at = ?, resolution = 'dismissed' WHERE id = ?`
    )
      .bind(now, id)
      .run();
    return json({ ok: true, id, redacted: false, note: "リストは既に削除済みです" });
  }

  if (rep.target_type === "owner_name") {
    await env.DB.prepare(`UPDATE lists SET owner_name = '', updated_at = ? WHERE slug = ?`)
      .bind(now, rep.slug)
      .run();
  } else if (rep.target_type === "bio") {
    await env.DB.prepare(`UPDATE lists SET bio = '', updated_at = ? WHERE slug = ?`)
      .bind(now, rep.slug)
      .run();
  } else if (rep.target_type === "comment" || rep.target_type === "cover") {
    let items: StoredListItem[] = [];
    try {
      items = JSON.parse(list.items_json) as StoredListItem[];
    } catch {
      items = [];
    }
    const idx = items.findIndex((i) => i.position === rep.position);
    const target = idx >= 0 ? items[idx] : items[rep.position - 1];
    if (rep.target_type === "cover") {
      // Covers are site-wide, so redacting a reported cover clears that image for
      // everyone — on every ISBN carrying it, since a list falls back to a sibling
      // ISBN's cover (src/listItems.ts). "" = confirmed no cover, which auto-resolution
      // never re-probes; users can fill it again from store images (suggestCover).
      // The image is also recorded as 'redacted' in cover_suggestion so suggestCover
      // refuses to put it back through an unreviewed fill.
      if (rep.reported_text) {
        const holders = await env.DB.prepare(`SELECT isbn FROM covers WHERE cover_url = ?`)
          .bind(rep.reported_text)
          .all<{ isbn: string }>();
        const isbns = new Set((holders.results ?? []).map((r) => r.isbn));
        if (target && toIsbn13(target.isbn)) isbns.add(toIsbn13(target.isbn));
        await env.DB.batch([
          env.DB.prepare(`UPDATE covers SET cover_url = '', checked_at = ? WHERE cover_url = ?`).bind(
            now,
            rep.reported_text
          ),
          ...[...isbns].map((isbn) =>
            env.DB.prepare(
              `INSERT INTO cover_suggestion
                 (isbn, cover_url, old_cover_url, suggest_count, first_at, last_at, resolved_at, resolution)
               VALUES (?, ?, ?, 0, ?, ?, ?, 'redacted')
               ON CONFLICT (isbn, cover_url) DO UPDATE SET
                 resolved_at = excluded.resolved_at, resolution = 'redacted'`
            ).bind(isbn, rep.reported_text, rep.reported_text, now, now, now)
          ),
        ]);
      }
    } else {
      if (target) target.comment = "";
      await env.DB.prepare(`UPDATE lists SET items_json = ?, updated_at = ? WHERE slug = ?`)
        .bind(JSON.stringify(items), now, rep.slug)
        .run();
    }
  }

  await env.DB.prepare(
    `UPDATE reports SET resolved_at = ?, resolution = 'redacted' WHERE id = ?`
  )
    .bind(now, id)
    .run();
  return json({ ok: true, id, redacted: true });
}
