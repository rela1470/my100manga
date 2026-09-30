import { Env, ListItem } from "./types";
import { json, notFound } from "./util";

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

  const lists: AdminListRow[] = (results ?? []).map((row) => {
    let items: ListItem[] = [];
    try {
      items = JSON.parse(row.items_json) as ListItem[];
    } catch {
      items = [];
    }
    return {
      slug: row.slug,
      owner_name: row.owner_name ?? "",
      item_count: items.length,
      cover_count: items.filter((i) => i && typeof i.cover_url === "string" && i.cover_url).length,
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

export async function adminGetList(env: Env, slug: string): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT slug, edit_token, owner_name, items_json, created_at, updated_at
       FROM lists WHERE slug = ?`
  )
    .bind(slug)
    .first<{
      slug: string;
      edit_token: string;
      owner_name: string | null;
      items_json: string;
      created_at: number;
      updated_at: number;
    }>();
  if (!row) return notFound("リストが見つかりません");

  let items: ListItem[] = [];
  try {
    items = JSON.parse(row.items_json) as ListItem[];
  } catch {
    items = [];
  }

  // 管理用途なので公開APIと違い edit_token も返す（運営者が編集リンクを再取得できる）。
  return json(
    {
      list: {
        slug: row.slug,
        edit_token: row.edit_token,
        owner_name: row.owner_name ?? "",
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
    `SELECT r.series_id, r.reported_name, r.report_count,
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

  const body = (await request.json().catch(() => ({}))) as { name?: unknown };
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

export async function adminDeleteCover(env: Env, isbn: string): Promise<Response> {
  const res = await env.DB.prepare(`DELETE FROM covers WHERE isbn = ?`).bind(isbn).run();
  const deleted = res.meta?.changes ?? 0;
  if (!deleted) return notFound("表紙キャッシュが見つかりません");
  return json({ ok: true, isbn });
}

export async function adminPurgeCovers(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { mode?: unknown };
  const mode = body.mode;
  if (mode !== "empty" && mode !== "all") {
    return json({ error: "mode は 'empty' か 'all' を指定してください" }, 400);
  }
  const sql = mode === "empty" ? `DELETE FROM covers WHERE cover_url = ''` : `DELETE FROM covers`;
  const res = await env.DB.prepare(sql).run();
  return json({ ok: true, mode, deleted: res.meta?.changes ?? 0 });
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
            cs.first_at, cs.last_at, cs.resolved_at, cs.resolution, v.title, v.creator
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
  const body = (await request.json().catch(() => ({}))) as { cover_url?: unknown };
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
  const body = (await request.json().catch(() => ({}))) as { cover_url?: unknown };
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
  const body = (await request.json().catch(() => ({}))) as { mode?: unknown };
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
            l.owner_name, l.items_json
       FROM reports r
       LEFT JOIN lists l ON l.slug = r.slug
      WHERE ${where}
      ORDER BY ${order} LIMIT ? OFFSET ?`
  )
    .bind(opts.per, opts.offset)
    .all<ReportRow>();

  const reports = (results ?? []).map((r) => {
    const listExists = r.items_json !== null || r.owner_name !== null;
    let currentText = "";
    let itemTitle = "";
    if (r.target_type === "owner_name") {
      currentText = r.owner_name ?? "";
    } else if (r.items_json) {
      let items: ListItem[] = [];
      try {
        items = JSON.parse(r.items_json) as ListItem[];
      } catch {
        items = [];
      }
      const item = items.find((i) => i.position === r.position) ?? items[r.position - 1];
      currentText = r.target_type === "cover" ? (item?.cover_url ?? "") : (item?.comment ?? "");
      itemTitle = item?.title ?? "";
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

// 通報対象のテキストだけを消す（リスト・作品自体は残す）。owner_name は空文字に、comment は
// 当該作品の comment を空文字にする。処理後、通報行はソフトデリート（resolved_at + resolution）
// で残し、処理済み履歴から辿れるようにする。未処理（resolved_at = 0）のものだけを対象にする。
export async function adminRedactReport(env: Env, id: number): Promise<Response> {
  const rep = await env.DB.prepare(
    `SELECT id, slug, target_type, position FROM reports WHERE id = ? AND resolved_at = 0`
  )
    .bind(id)
    .first<{ id: number; slug: string; target_type: string; position: number }>();
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
  } else if (rep.target_type === "comment" || rep.target_type === "cover") {
    let items: ListItem[] = [];
    try {
      items = JSON.parse(list.items_json) as ListItem[];
    } catch {
      items = [];
    }
    const idx = items.findIndex((i) => i.position === rep.position);
    const target = idx >= 0 ? items[idx] : items[rep.position - 1];
    if (target) {
      if (rep.target_type === "cover") target.cover_url = "";
      else target.comment = "";
    }
    await env.DB.prepare(`UPDATE lists SET items_json = ?, updated_at = ? WHERE slug = ?`)
      .bind(JSON.stringify(items), now, rep.slug)
      .run();
  }

  await env.DB.prepare(
    `UPDATE reports SET resolved_at = ?, resolution = 'redacted' WHERE id = ?`
  )
    .bind(now, id)
    .run();
  return json({ ok: true, id, redacted: true });
}
