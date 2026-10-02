import { Env, StoredListItem } from "./types";
import { resolveBooks } from "./listItems";
import { badRequest, json, notFound, readJsonObject } from "./util";

// 自由入力（owner_name / bio / item.comment）に対する一般ユーザからの通報。アカウント無しの
// 公開書き込みなので、テキストはクライアントから受け取らず必ずサーバ保存値をスナップ
// ショットする。同じ対象への連投は report_count を増やすだけ（行は増やさない）。

interface ListRow {
  owner_name: string | null;
  bio: string | null;
  items_json: string;
}

function parseItems(json: string): StoredListItem[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as StoredListItem[]) : [];
  } catch {
    return [];
  }
}

export async function addReport(request: Request, env: Env, slug: string): Promise<Response> {
  const row = await env.DB.prepare(`SELECT owner_name, bio, items_json FROM lists WHERE slug = ?`)
    .bind(slug)
    .first<ListRow>();
  if (!row) return notFound("リストが見つかりません");

  const body = (await readJsonObject(request)) as {
    target?: unknown;
    position?: unknown;
  };
  const target = body.target;

  let targetType: "owner_name" | "bio" | "comment" | "cover";
  let position = 0;
  let reportedText = "";

  if (target === "owner_name") {
    targetType = "owner_name";
    reportedText = (row.owner_name ?? "").trim();
    if (!reportedText) return badRequest("通報できるユーザー名がありません");
  } else if (target === "bio") {
    targetType = "bio";
    reportedText = (row.bio ?? "").trim();
    if (!reportedText) return badRequest("通報できるひとことがありません");
  } else if (target === "comment") {
    targetType = "comment";
    const pos = typeof body.position === "number" ? body.position : Number(body.position);
    if (!Number.isInteger(pos) || pos < 1) return badRequest("対象の位置が不正です");
    const items = parseItems(row.items_json);
    const item = items.find((i) => i.position === pos) ?? items[pos - 1];
    reportedText = (item?.comment ?? "").trim();
    if (!reportedText) return badRequest("通報できるコメントがありません");
    position = pos;
  } else if (target === "cover") {
    targetType = "cover";
    const pos = typeof body.position === "number" ? body.position : Number(body.position);
    if (!Number.isInteger(pos) || pos < 1) return badRequest("対象の位置が不正です");
    const items = parseItems(row.items_json);
    const item = items.find((i) => i.position === pos) ?? items[pos - 1];
    // Covers are site-wide (one per ISBN), so snapshot the cover this book shows now.
    const book = item?.isbn ? (await resolveBooks(env, [item.isbn])).values().next().value : undefined;
    reportedText = (book?.cover_url ?? "").trim();
    if (!reportedText) return badRequest("通報できる表紙画像がありません");
    position = pos;
  } else {
    return badRequest("通報対象が不正です");
  }

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO reports (slug, target_type, position, reported_text, report_count, first_at, last_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(slug, target_type, position) DO UPDATE SET
       report_count = report_count + 1,
       reported_text = excluded.reported_text,
       last_at = excluded.last_at,
       resolved_at = 0,
       resolution = ''`
  )
    .bind(slug, targetType, position, reportedText, now, now)
    .run();

  return json({ ok: true }, 200, { "cache-control": "no-store" });
}
