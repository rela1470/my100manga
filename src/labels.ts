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
import { badRequest, escapeLikeClamped, json, LIKE_MAX_BYTES } from "./util";

/** レーベルに付けられるタグ。増やすときはここに足すだけでよい（管理画面の選択肢・検索の
 *  絞り込み・表示は全部この配列から作る）。表示文字列がそのまま DB に入る。 */
export const LABEL_TAGS = ["廉価版", "文庫版"] as const;
export type LabelTag = (typeof LABEL_TAGS)[number];

function isLabelTag(v: unknown): v is LabelTag {
  return typeof v === "string" && (LABEL_TAGS as readonly string[]).includes(v);
}

/** label_tag の鍵として使えるレーベル名か。マスタの値をそのまま鍵にするので正規化はしない
 *  （前後の空白だけ落とす）。長すぎる値は弾く。 */
function normLabel(v: unknown): string {
  return typeof v === "string" ? v.trim().slice(0, 200) : "";
}

// D1 の 1 文へのバインド上限に収まる分割幅。
const IN_CHUNK = 100;

/** 指定したレーベル名に付いているタグ（レーベル名 → タグ）。付いていないものは入らない。
 *  検索・巻一覧から呼ぶので、表がまだ無い DB（migration 前）でも落とさず空で返す。 */
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
    // db/add-label-tag.sql 未適用など。印が出ないだけで検索自体は成立させる。
    console.error("label tags lookup failed", err);
  }
  return out;
}

/** 検索カード・巻一覧のカードに label_tag を書き込む。レーベルの集合で 1 回だけ引く。 */
export async function attachLabelTags<T extends { label: string; label_tag?: string }>(
  env: Env,
  cards: T[]
): Promise<void> {
  if (!cards.length) return;
  const tags = await tagsForLabels(env, cards.map((c) => c.label));
  for (const c of cards) c.label_tag = tags.get(c.label) ?? "";
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
}

/** GET /api/admin/labels — レーベルの一覧（シリーズ数の多い順）。
 *  ?q= レーベル名の部分一致 / ?filter= untagged | tagged | <タグ名>。 */
export async function adminListLabels(
  env: Env,
  opts: PageOpts,
  q: string,
  filter: string
): Promise<Response> {
  const where: string[] = [];
  const binds: unknown[] = [];
  const like = escapeLikeClamped(q.trim(), LIKE_MAX_BYTES);
  if (like) {
    where.push(`g.label LIKE ? ESCAPE '\\'`);
    binds.push(`%${like}%`);
  }
  if (filter === "untagged") {
    where.push(`NOT EXISTS (SELECT 1 FROM label_tag t WHERE t.label = g.label)`);
  } else if (filter === "tagged") {
    where.push(`EXISTS (SELECT 1 FROM label_tag t WHERE t.label = g.label)`);
  } else if (isLabelTag(filter)) {
    where.push(`EXISTS (SELECT 1 FROM label_tag t WHERE t.label = g.label AND t.tag = ?)`);
    binds.push(filter);
  }
  const cond = where.length ? ` WHERE ${where.join(" AND ")}` : "";

  const totalRow = await env.DB.prepare(`${LABEL_GROUPS} SELECT COUNT(*) AS n FROM g${cond}`)
    .bind(...binds)
    .first<{ n: number }>();

  // 代表作品は「そのレーベルで巻数の多いシリーズ」を 3 つ。レーベル名だけでは何の廉価版か
  // 分からないことがあるので、判断材料として出す（1 ページ 50 件ぶんの小さな引き直し）。
  const { results } = await env.DB.prepare(
    `${LABEL_GROUPS}
     SELECT g.label, g.series_count,
            (SELECT t.tag FROM label_tag t WHERE t.label = g.label) AS tag,
            (SELECT group_concat(name, ' / ') FROM
               (SELECT s2.name FROM series s2 WHERE s2.label = g.label
                 ORDER BY COALESCE(s2.num_items, 0) DESC, s2.id LIMIT 3)) AS samples
       FROM g${cond}
      ORDER BY g.series_count DESC, g.label
      LIMIT ? OFFSET ?`
  )
    .bind(...binds, opts.per, opts.offset)
    .all<LabelRow>();

  // タグごとの付与件数（label_tag は数十〜数百行なので全部数えてよい）。
  const counts = await env.DB.prepare(`SELECT tag, COUNT(*) AS n FROM label_tag GROUP BY tag`).all<{
    tag: string;
    n: number;
  }>();
  const byTag: Record<string, number> = {};
  for (const t of LABEL_TAGS) byTag[t] = 0;
  for (const r of counts.results ?? []) byTag[r.tag] = r.n;

  return json(
    {
      tags: LABEL_TAGS,
      labels: (results ?? []).map((r) => ({
        label: r.label,
        series_count: r.series_count,
        tag: r.tag ?? "",
        samples: r.samples ?? "",
      })),
      total: totalRow?.n ?? 0,
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
  const labels = [...new Set(raw.map(normLabel).filter(Boolean))];
  if (!labels.length) return badRequest("レーベルを指定してください");
  if (labels.length > 200) return badRequest("一度に指定できるレーベルは 200 件までです");

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
  await env.DB.batch(stmts);

  return json({ ok: true, updated: labels.length, tag }, 200, { "cache-control": "no-store" });
}
