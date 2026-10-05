// レーベルのタグ付け（廉価版・文庫版）。
//
// MADB のマスタには「コンビニ廉価版か」「文庫版か」を表す列が無いが、レーベル名
// （schema:brand。series.label / volumes.label）を見れば分かるものが多い
// （「KPC」「講談社プラチナコミックス」= 廉価版、「講談社漫画文庫」「小学館文庫」= 文庫版）。
// 管理画面の「レーベル管理」でレーベルにタグを付けると、そのレーベルのシリーズ全部の
// 検索カード・巻一覧に印が出る（src/search.ts / src/series.ts / public/app.js）。
//
// タグは series.id ではなく **レーベル名そのもの** を鍵にした別表 label_tag に持つ。
// series / volumes は月次の取り込みで表ごと作り直されるので（scripts/ingest.mjs SWAP_SQL）、
// マスタ側に印を書くと毎月消えるため。db/add-label-tag.sql。
import type { PageOpts } from "./admin";
import { Env } from "./types";
import { badRequest, json, notFound, escapeLikeClamped, readJsonObject, LIKE_MAX_BYTES, seriesNameSql } from "./util";

/** レーベルに付けられるタグ。増やすときはここに足すだけでよい（管理画面の選択肢・検索の
 *  絞り込み・表示は全部この配列から作る。DB の tag は素の TEXT なので migration も要らない）。
 *  表示文字列がそのまま DB に入る。
 *
 *  傑作選 … 連載から数話を選んで再編集した本（「ジャンプコミックスセレクション」
 *  「少年サンデーコミックスビジュアルセレクション」「YKベスト」など）。巻を順に読める
 *  通常のコミックスとは別物なので、1 冊目に薦められない。 */
export const LABEL_TAGS = ["廉価版", "文庫版", "傑作選"] as const;
export type LabelTag = (typeof LABEL_TAGS)[number];

function isLabelTag(v: unknown): v is LabelTag {
  return typeof v === "string" && (LABEL_TAGS as readonly string[]).includes(v);
}

/** label_tag の鍵として使えるレーベル名か。マスタの値をそのまま鍵にするので正規化はしない
 *  （前後の空白だけ落とす）。長すぎる値は弾く。 */
function normLabel(v: unknown): string {
  return typeof v === "string" ? v.trim().slice(0, 200) : "";
}

/** シリーズに実際に出すタグの SQL 片。シリーズ個別の上書き（series_tag）があればそれ、
 *  無ければレーベルのタグ（label_tag）。`alias` は series 表の別名。
 *
 *  series_tag.tag = '' は「タグ無し」を明示する上書きなので、COALESCE がそれを拾って
 *  レーベルのタグを打ち消す（行が無いときだけ NULL になってレーベル側に落ちる）。
 *  どちらも主キー 1 本の索引引きなので、呼び出し側のクエリに畳み込めば D1 の往復は増えない。 */
export function effectiveTagSql(alias: string): string {
  return `COALESCE((SELECT st.tag FROM series_tag st WHERE st.series_id = ${alias}.id),
                   (SELECT lt.tag FROM label_tag lt WHERE lt.label = ${alias}.label))`;
}

// D1 の 1 文へのバインド上限に収まる分割幅。
const IN_CHUNK = 100;

/** 一覧が 1 回に返すレーベルの上限。管理画面はページ送りをせず、絞り込んだ結果を 1 画面に
 *  出して「全選択 → まとめて設定」する作りなので、ページャーの代わりにこれで頭を押さえる。
 *  実測で「文庫」が 426 件・70ms、絞り込み無しの全 7,808 件で 900ms なので、現実的な検索は
 *  まず当たらない。超えたときは件数を添えて「絞り込んでください」と返す。 */
const MAX_ROWS = 1000;

/** 1 回のまとめて設定で受けるレーベルの上限。一覧の上限と同じにしてあるので、
 *  画面に出ている分は必ず一度に設定できる。 */
const MAX_BULK = MAX_ROWS;

/** まとめて設定を D1 に流すときの 1 バッチの文数。1,000 文を 1 バッチにはしない。 */
const WRITE_CHUNK = 100;

/** 一覧の検索語を AND の語に割る上限。これ以上は落とす（LIKE の本数を青天井にしない）。 */
const MAX_TERMS = 6;

/** 検索語を空白（半角・全角）で割り、LIKE パターンとして安全な形にして返す。
 *  LIKE のパターン長の上限は語ごとに掛かるので、語に割るほど切り詰めは起きにくい。 */
function searchTerms(q: string): string[] {
  return q
    .split(/[\s\u3000]+/)
    .filter(Boolean)
    .slice(0, MAX_TERMS)
    .map((t) => escapeLikeClamped(t, LIKE_MAX_BYTES))
    .filter(Boolean);
}

/** 指定したレーベル名に付いているタグ（レーベル名 → タグ）。付いていないものは入らない。
 *
 *  シリーズのカード・巻一覧は、タグを series 行と同じ 1 本の SQL で引いている
 *  （src/search.ts SERIES_COLS / src/series.ts）。これを使うのは、引くものが series 行では
 *  なく巻（シリーズ無しの巻のまとまり）で畳み込めない経路だけ: 検索の standalone カードと、
 *  ISBN 検索・G-id の巻一覧。いずれも D1 の往復が 1 本増えるので、呼ぶ前に対象が空でないか
 *  （standalone が 0 件でないか）を確かめること。 */
export async function tagsForLabels(env: Env, labels: Iterable<string>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniq = [...new Set([...labels].filter(Boolean))];
  if (!uniq.length) return out;
  try {
    for (let i = 0; i < uniq.length; i += IN_CHUNK) {
      const chunk = uniq.slice(i, i + IN_CHUNK);
      const res = await env.DB.prepare(
        `SELECT label, tag FROM label_tag WHERE label IN (${chunk.map(() => "?").join(",")})`
      )
        .bind(...chunk)
        .all<{ label: string; tag: string }>();
      for (const r of res.results ?? []) out.set(r.label, r.tag);
    }
  } catch (err) {
    // この経路（まとまりのカード）は印が出ないだけで成立させる。なお検索・巻一覧の本道は
    // シリーズ行と同じ SQL で引くので、表が無ければそちらは落ちる（db/MIGRATIONS.md）。
    console.error("label tags lookup failed", err);
  }
  return out;
}

// ── 管理画面 ────────────────────────────────────────────────────────────────

// レーベルの一覧は series をレーベルでまとめたもの（idx_series_label）。それに、シリーズを
// 1 つも持たないのにタグだけ付いているレーベル（シリーズ無しの巻にしか出ないレーベルを
// 「レーベル名を指定して付ける」で直接タグ付けした場合）を足す。足さないと、付けたタグが
// 一覧から消えて外せなくなる。
const LABEL_GROUPS = `WITH g(label, series_count) AS (
    SELECT label, COUNT(*) FROM series WHERE COALESCE(label, '') <> '' GROUP BY label
    UNION ALL
    SELECT t.label, 0 FROM label_tag t
     WHERE NOT EXISTS (SELECT 1 FROM series s WHERE s.label = t.label)
  )`;

interface LabelRow {
  label: string;
  series_count: number;
  tag: string | null;
  samples: string | null;
  publisher: string | null;    // そのレーベルで一番多い出版社
  publisher_n: number;         // そのレーベルに出てくる出版社の数（1 より多ければ「ほかN社」）
  years: string | null;        // "1994-12/2018-12"（巻の発行年の最小/最大）。NULL = 1 冊も日付が無い
}

/** そのレーベルの巻が持つ発行年の範囲。「文庫」で引くと、判型ではなく叢書の意味で
 *  「〜文庫」と名乗っていた昭和の貸本・児童書の線が 188 レーベル混ざる（『おもしろ漫画文庫』
 *  『あり文庫』…）。それらはマスタに発行年が 1 つも無いので、ここが空なら一括付与から
 *  外す、という判断に使える。 */
function yearRange(years: string | null): { from: string; to: string } {
  const [from = "", to = ""] = (years ?? "").split("/");
  return { from: from.slice(0, 4), to: to.slice(0, 4) };
}

/** そのレーベルの巻が 1 冊でも発行年を持つか。EXISTS なので 1 件見つかれば止まる。 */
const HAS_YEAR = `EXISTS (SELECT 1 FROM volumes v
                           WHERE v.series_id IN (SELECT id FROM series WHERE label = g.label)
                             AND v.pubdate > '')`;

/** GET /api/admin/labels — レーベルの一覧（シリーズ数の多い順、ページ送り無し）。
 *  ?q= レーベル名（空白区切りで AND）/ ?filter= untagged | tagged | <タグ名> /
 *  ?era= dated（発行年あり）| undated（発行年なし）。 */
export async function adminListLabels(
  env: Env,
  q: string,
  filter: string,
  era: string
): Promise<Response> {
  const where: string[] = [];
  const binds: unknown[] = [];
  // 空白区切りは AND。同じレーベルがマスタ上で何通りにも表記されている（「ジャンプコミックス
  // セレクション」「ジャンプ コミックス セレクション」「ジャンプ・コミックス・セレクション」…）
  // ので、1 本の LIKE だと「ジャンプ セレクション」がどれにも当たらない。語ごとに分けて AND を
  // 取ると 8 通りまとめて拾えて、そのままチェックして一括でタグを付けられる。
  for (const term of searchTerms(q)) {
    where.push(`g.label LIKE ? ESCAPE '\\'`);
    binds.push(`%${term}%`);
  }
  if (filter === "untagged") {
    where.push(`NOT EXISTS (SELECT 1 FROM label_tag t WHERE t.label = g.label)`);
  } else if (filter === "tagged") {
    where.push(`EXISTS (SELECT 1 FROM label_tag t WHERE t.label = g.label)`);
  } else if (isLabelTag(filter)) {
    where.push(`EXISTS (SELECT 1 FROM label_tag t WHERE t.label = g.label AND t.tag = ?)`);
    binds.push(filter);
  }
  // 発行年の有無。「文庫」を一括で付けるときに、昭和の貸本・児童書の線（発行年なし）を
  // まとめて外す／そこだけ見る、のに使う。
  if (era === "dated") where.push(HAS_YEAR);
  else if (era === "undated") where.push(`NOT ${HAS_YEAR}`);
  const cond = where.length ? ` WHERE ${where.join(" AND ")}` : "";

  const totalRow = await env.DB.prepare(`${LABEL_GROUPS} SELECT COUNT(*) AS n FROM g${cond}`)
    .bind(...binds)
    .first<{ n: number }>();
  const total = totalRow?.n ?? 0;

  // 代表作品・出版社・発行年の範囲は、レーベルごとに別途引く列。
  // **並べ替えと LIMIT を内側の p で終わらせてから引くこと。** 相関サブクエリを LIMIT と同じ
  // SELECT に置くと、SQLite は ORDER BY のソートに載せる時点で全行ぶん評価する（7,808 レーベル
  // = series 13 万行ぶんの読み直し）。内側に押し込めば実際に返す行だけで済む。
  const { results } = await env.DB.prepare(
    `${LABEL_GROUPS},
     p AS (SELECT g.label, g.series_count FROM g${cond}
            ORDER BY g.series_count DESC, g.label
            LIMIT ?)
     SELECT p.label, p.series_count,
            (SELECT t.tag FROM label_tag t WHERE t.label = p.label) AS tag,
            (SELECT group_concat(name, ' / ') FROM
               (SELECT ${seriesNameSql("s2", "o2")} AS name FROM series s2
                  LEFT JOIN series_name_override o2 ON o2.series_id = s2.id
                 WHERE s2.label = p.label
                 ORDER BY COALESCE(s2.num_items, 0) DESC, s2.id LIMIT 3)) AS samples,
            (SELECT s3.publisher FROM series s3
               WHERE s3.label = p.label AND COALESCE(s3.publisher, '') <> ''
               GROUP BY s3.publisher ORDER BY COUNT(*) DESC, s3.publisher LIMIT 1) AS publisher,
            (SELECT COUNT(DISTINCT s4.publisher) FROM series s4
               WHERE s4.label = p.label AND COALESCE(s4.publisher, '') <> '') AS publisher_n,
            -- MIN と MAX を 1 本のサブクエリで取る（スカラーなので連結して返し、受け側で割る）。
            (SELECT MIN(v.pubdate) || '/' || MAX(v.pubdate) FROM volumes v
               WHERE v.series_id IN (SELECT id FROM series WHERE label = p.label)
                 AND v.pubdate > '') AS years
       FROM p
      ORDER BY p.series_count DESC, p.label`
  )
    .bind(...binds, MAX_ROWS)
    .all<LabelRow>();

  // タグごとの付与件数（label_tag は数十〜数百行なので全部数えてよい）。
  const counts = await env.DB.prepare(`SELECT tag, COUNT(*) AS n FROM label_tag GROUP BY tag`).all<{
    tag: string;
    n: number;
  }>();
  const byTag: Record<string, number> = {};
  for (const t of LABEL_TAGS) byTag[t] = 0;
  for (const r of counts.results ?? []) byTag[r.tag] = r.n;

  const rows = results ?? [];
  return json(
    {
      tags: LABEL_TAGS,
      labels: rows.map((r) => {
        const { from, to } = yearRange(r.years);
        return {
          label: r.label,
          series_count: r.series_count,
          tag: r.tag ?? "",
          samples: r.samples ?? "",
          publisher: r.publisher ?? "",
          publisher_n: r.publisher_n ?? 0,
          year_from: from,
          year_to: to,
        };
      }),
      total,
      // 上限で切れたか。切れたときだけクライアントが「絞り込んでください」を出す。
      shown: rows.length,
      truncated: total > rows.length,
      limit: MAX_ROWS,
      by_tag: byTag,
      tagged: Object.values(byTag).reduce((a, b) => a + b, 0),
    },
    200,
    { "cache-control": "no-store" }
  );
}

/** POST /api/admin/labels — レーベルにタグを付ける / 外す。
 *  body: { label | labels: string[], tag: "廉価版" | "文庫版" | "" }（"" は解除）。
 *  まとめて付けられるようにしてあるのは、「文庫」で絞って一括で付ける使い方のため。 */
export async function adminSetLabelTags(env: Env, body: Record<string, unknown>): Promise<Response> {
  const raw = Array.isArray(body.labels) ? body.labels : [body.label];
  // 重複を落とす前に生の長さで弾く（本文は 256KB まで通るので、数万件を並べて
  // 正規化だけ走らせることができてしまう）。
  if (raw.length > MAX_BULK) return badRequest(`一度に指定できるレーベルは ${MAX_BULK} 件までです`);
  const labels = [...new Set(raw.map(normLabel).filter(Boolean))];
  if (!labels.length) return badRequest("レーベルを指定してください");

  const tag = typeof body.tag === "string" ? body.tag.trim() : "";
  if (tag && !isLabelTag(tag)) return badRequest("不明なタグです");

  const now = Date.now();
  const stmts = labels.map((label) =>
    tag
      ? env.DB.prepare(
          `INSERT INTO label_tag (label, tag, created_at, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(label) DO UPDATE SET tag = excluded.tag, updated_at = excluded.updated_at`
        ).bind(label, tag, now, now)
      : env.DB.prepare(`DELETE FROM label_tag WHERE label = ?`).bind(label)
  );
  // 1,000 件を 1 バッチにはしない。途中で落ちても入った分はそのまま有効で、同じ操作を
  // やり直せば残りが入る（どちらも冪等な upsert / delete なので）。
  for (let i = 0; i < stmts.length; i += WRITE_CHUNK) {
    await env.DB.batch(stmts.slice(i, i + WRITE_CHUNK));
  }

  return json({ ok: true, updated: labels.length, tag }, 200, { "cache-control": "no-store" });
}

// ── シリーズ個別のタグ ──────────────────────────────────────────────────────

/** 申請・設定で受け取れるタグ値。LABEL_TAGS に加えて '' （タグ無しを明示する上書き）。 */
function parseSeriesTag(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" || isLabelTag(t) ? t : null;
}

/** そのシリーズがマスタに在るか（C-id / U-id は series、まとまりは G + ISBN13）。
 *  存在しない ID で申請の行を作られないようにする。 */
async function seriesExists(env: Env, id: string): Promise<boolean> {
  if (/^G\d{13}$/.test(id)) {
    const v = await env.DB.prepare(`SELECT 1 AS hit FROM volumes WHERE isbn = ? LIMIT 1`)
      .bind(id.slice(1))
      .first<{ hit: number }>();
    return !!v;
  }
  const s = await env.DB.prepare(`SELECT 1 AS hit FROM series WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<{ hit: number }>();
  return !!s;
}

/** POST /api/series/:id/tag-request — 「このシリーズは廉価版です」等の申請。
 *  body: { tag }（LABEL_TAGS のいずれか、または "" = ついているタグを外してほしい）。
 *
 *  シリーズ名の通報・結合依頼・分離依頼と同じ collect-only。ここでは件数を積むだけで、
 *  全体への反映は管理者が確定したときだけ（src/labels.ts adminConfirmSeriesTag）。
 *  端末ごとの二重申請の抑止はクライアントの localStorage に任せる（他の依頼と同じ）。 */
export async function requestSeriesTag(request: Request, env: Env, seriesId: string): Promise<Response> {
  const body = await readJsonObject(request);
  const tag = parseSeriesTag(body.tag);
  if (tag === null) return badRequest("不明なタグです");
  const id = seriesId.toUpperCase();
  if (!(await seriesExists(env, id))) return notFound("シリーズが見つかりません");

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO series_tag_request (series_id, tag, report_count, first_reported_at, last_reported_at)
     VALUES (?, ?, 1, ?, ?)
     ON CONFLICT (series_id, tag) DO UPDATE SET
       report_count = report_count + 1,
       last_reported_at = excluded.last_reported_at`
  )
    .bind(id, tag, now, now)
    .run();
  return json({ ok: true }, 200, { "cache-control": "no-store" });
}

// ── シリーズ個別のタグ: 管理画面 ────────────────────────────────────────────

interface TagRequestRow {
  series_id: string;
  tag: string;
  report_count: number;
  first_reported_at: number;
  last_reported_at: number;
  name: string | null;
  creator: string | null;
  label: string | null;
  current_tag: string | null;
  label_tag: string | null;
}

/** GET /api/admin/series-tag-requests — 申請のキュー（新しい順）。 */
export async function adminListSeriesTagRequests(env: Env, opts: PageOpts): Promise<Response> {
  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM series_tag_request`
  ).first<{ n: number }>();

  const { results } = await env.DB.prepare(
    `SELECT r.series_id, r.tag, r.report_count, r.first_reported_at, r.last_reported_at,
            ${seriesNameSql("s", "o")} AS name, s.creator, s.label,
            (SELECT st.tag FROM series_tag st WHERE st.series_id = r.series_id) AS current_tag,
            (SELECT lt.tag FROM label_tag lt WHERE lt.label = s.label) AS label_tag
       FROM series_tag_request r
       LEFT JOIN series s ON s.id = r.series_id
       LEFT JOIN series_name_override o ON o.series_id = r.series_id
      ORDER BY r.last_reported_at DESC, r.series_id
      LIMIT ? OFFSET ?`
  )
    .bind(opts.per, opts.offset)
    .all<TagRequestRow>();

  return json(
    {
      tags: LABEL_TAGS,
      requests: (results ?? []).map((r) => ({
        series_id: r.series_id,
        tag: r.tag,
        report_count: r.report_count,
        first_reported_at: r.first_reported_at,
        last_reported_at: r.last_reported_at,
        name: r.name ?? "",
        creator: r.creator ?? "",
        label: r.label ?? "",
        // 今そのシリーズに出ているタグ（個別の上書きが無ければレーベル由来）と、その出どころ。
        current_tag: r.current_tag ?? r.label_tag ?? "",
        current_from: r.current_tag !== null ? "series" : r.label_tag ? "label" : "",
      })),
      total: totalRow?.n ?? 0,
    },
    200,
    { "cache-control": "no-store" }
  );
}

/** そのシリーズのタグを確定して、申請の行を片付ける。 */
async function writeSeriesTag(env: Env, seriesId: string, tag: string): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO series_tag (series_id, tag, created_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(series_id) DO UPDATE SET tag = excluded.tag, updated_at = excluded.updated_at`
    ).bind(seriesId, tag, now, now),
    // 同じシリーズへの申請は、どのタグのものも処理済みとして消す。
    env.DB.prepare(`DELETE FROM series_tag_request WHERE series_id = ?`).bind(seriesId),
  ]);
}

/** POST /api/admin/series-tag-requests/:id/confirm — 申請を確定する。body: { tag }。 */
export async function adminConfirmSeriesTagRequest(
  env: Env,
  seriesId: string,
  body: Record<string, unknown>
): Promise<Response> {
  const tag = parseSeriesTag(body.tag);
  if (tag === null) return badRequest("不明なタグです");
  await writeSeriesTag(env, seriesId, tag);
  return json({ ok: true, series_id: seriesId, tag }, 200, { "cache-control": "no-store" });
}

/** DELETE /api/admin/series-tag-requests/:id — 却下（そのシリーズの申請を全部消す）。
 *  series_tag は書かないので、表示は今までどおり（レーベル由来のまま）。 */
export async function adminDismissSeriesTagRequest(env: Env, seriesId: string): Promise<Response> {
  const res = await env.DB.prepare(`DELETE FROM series_tag_request WHERE series_id = ?`)
    .bind(seriesId)
    .run();
  return json({ ok: true, deleted: res.meta.changes ?? 0 }, 200, { "cache-control": "no-store" });
}

/** POST /api/admin/series-tags — 申請を経由せず直接設定する。
 *  body: { series_id, tag }。tag が null（キー自体が無い）なら上書きを外してレーベルに戻す。 */
export async function adminSetSeriesTag(env: Env, body: Record<string, unknown>): Promise<Response> {
  const seriesId = typeof body.series_id === "string" ? body.series_id.trim().toUpperCase() : "";
  if (!seriesId) return badRequest("シリーズ ID を指定してください");
  if (!(await seriesExists(env, seriesId))) return notFound("シリーズが見つかりません");

  // tag を省略 = 上書きを消してレーベルのタグに戻す。'' は「タグ無し」を明示する上書き。
  if (body.tag === undefined || body.tag === null) {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM series_tag WHERE series_id = ?`).bind(seriesId),
      env.DB.prepare(`DELETE FROM series_tag_request WHERE series_id = ?`).bind(seriesId),
    ]);
    return json({ ok: true, series_id: seriesId, tag: null }, 200, { "cache-control": "no-store" });
  }
  const tag = parseSeriesTag(body.tag);
  if (tag === null) return badRequest("不明なタグです");
  await writeSeriesTag(env, seriesId, tag);
  return json({ ok: true, series_id: seriesId, tag }, 200, { "cache-control": "no-store" });
}
