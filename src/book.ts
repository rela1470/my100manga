import { Env } from "./types";
import { badRequest, json } from "./util";
import { rakutenResolveFull, RakutenBookFull } from "./rakuten";
import { redactedCoverUrls } from "./covers";
import { resolveBooks } from "./listItems";
import { isValidIsbn, toIsbn13, workKeySql, seriesNameSql } from "./util";
import { attributeTitles } from "./groups";
import { resolveMergeTarget } from "./merge";

interface VolumeRow {
  title: string;
  creator: string | null;
  publisher: string | null;
  pubdate: string | null;
}

interface BookMeta {
  isbn: string;
  authors: string[];
  publisher: string;
  pubdate: string;
  caption: string;
}

interface BookMetaRow {
  authors: string;
  publisher: string;
  pubdate: string;
  caption: string;
  checked_at: number;
}

// あらすじが空のキャッシュを楽天から取り直す間隔（handleBook）。
const EMPTY_CAPTION_RETRY_MS = 24 * 60 * 60 * 1000;

// GET /api/book?isbn=<isbn> — enrich the view-page detail popup with metadata the
// stored list item doesn't carry. The master (volumes table) is authoritative for
// publisher/発行日/作者 and covers every book in the dump; Rakuten is layered on top
// for the あらすじ (itemCaption) and to split multi-author credits that MADB joins
// into one unsplittable string. Rakuten is best-effort — a missing/out-of-stock
// ISBN just means we return whatever the master has.
export async function handleBook(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const isbn = (url.searchParams.get("isbn") ?? "").trim().slice(0, 20);
  if (!isbn) return badRequest("isbn を指定してください");
  // チェックディジットまで正しい ISBN-13 / ISBN-10 だけ受ける。でたらめな値で楽天の高優先
  // レーンを埋められたり、空の book_meta 行を溜められたりしないように。
  if (!isValidIsbn(isbn)) return badRequest("isbn が不正です");

  // refresh=1 … ユーザが編集ポップアップの「本データを再取得」で明示的に押したとき。
  // キャッシュ（空あらすじで固まった行など）を無視して Rakuten を叩き直し、結果で上書きする。
  // 外部 API を叩くので index.ts 側で RL_COVERS によるレート制限をかけている。
  const refresh = (url.searchParams.get("refresh") ?? "") === "1";

  // The series this ISBN belongs to (merge-aware, admin name override applied), so the
  // detail popups can link to its volume list. Not cached in book_meta — it follows
  // series merges / renames live.
  const seriesP = bookSeries(env, isbn);
  // レーベル・巻番号・版違い ISBN（マスタ由来）。book_meta にはキャッシュせず毎回マスタから引く。
  const masterP = bookMaster(env, isbn);

  // あらすじが空のキャッシュは、最後に楽天を引いてから 1 日経っていれば取り直す。予約中の
  // 新刊（売上ランキングに多い）は楽天の商品説明がまだ空で、そのまま固まると発売後も
  // あらすじが出ないため。取り直しても空なら checked_at が進み、また 1 日後に試す。
  const cached = refresh ? null : await readBookMeta(env, isbn);
  if (cached && (cached.meta.caption || Date.now() - cached.checkedAt < EMPTY_CAPTION_RETRY_MS)) {
    return json({ ...cached.meta, ...(await masterP), series: await seriesP, status: "ok" }, 200, {
      "cache-control": "no-store",
    });
  }

  const [row, res] = await Promise.all([
    env.DB.prepare(
      `SELECT title, creator, publisher, pubdate FROM volumes WHERE isbn = ? LIMIT 1`
    )
      .bind(isbn)
      .first<VolumeRow>(),
    rakutenResolveFull(env, isbn, "high"),
  ]);
  const rk = res.meta;
  // 取り直し（あらすじ空の再試行）で楽天を引けなかった（レート制限）ときは、キャッシュの
  // 楽天由来の値（マスタに無い新刊の作者・出版社など）を落とさないようキャッシュを返す。
  if (rk === null && cached) {
    return json({ ...cached.meta, ...(await masterP), series: await seriesP, status: "ok" }, 200, {
      "cache-control": "no-store",
    });
  }

  const result: BookMeta = {
    isbn,
    authors: mergeAuthors(rk?.author, row?.creator),
    publisher: row?.publisher || rk?.publisher || "",
    pubdate: formatPubdate(row?.pubdate) || rk?.pubdate || "",
    caption: rk?.caption || "",
  };

  // Cache only when the Rakuten side was determinate (rk !== null). A
  // rate-limit-skipped lookup returns null and is left uncached so the あらすじ
  // can still be filled on a later open (same not-poisoning rule as covers).
  // Also skip when neither the master nor Rakuten knows the ISBN at all: that row would
  // be all-empty, and a well-formed but nonexistent ISBN (1 in 10 random 13-digit
  // strings passes the check digit) mustn't be able to grow book_meta.
  if (rk !== null && (row || rk.title)) await writeBookMeta(env, result);

  // The same Rakuten response also carried the cover (already HEAD-checked). When
  // it's a real cover, fill the covers cache if absent so a later list render skips
  // re-resolving this ISBN. INSERT OR IGNORE never clobbers an admin-corrected
  // cover; an empty/undetermined result is left alone so resolveCovers' full
  // Rakuten+Google tiering still runs later. A redacted image is never cached.
  if (res.cover && !(await redactedCoverUrls(env, [res.cover])).has(res.cover)) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO covers (isbn, cover_url, checked_at) VALUES (?, ?, ?)`
    )
      .bind(isbn, res.cover, Date.now())
      .run();
  }

  // status lets the client tell "Rakuten says this edition has no あらすじ" apart from
  // "Rakuten was rate-limited so we never got an answer" — the latter is retryable and
  // mustn't be shown as 見つかりませんでした. rk === null is the undetermined (skipped) case.
  const status = rk === null ? "unavailable" : "ok";
  return json({ ...result, ...(await masterP), series: await seriesP, status }, 200, {
    "cache-control": "no-store",
  });
}

interface BookMaster {
  label: string;
  volume_number: string;
  subtitle: string; // 巻の副題（「獄門塾殺人事件」）。巻番号が「上」「下」だけの作品の区別になる
  editions: string[]; // 同じシリーズ・同じ巻番号・同じ作品の別 ISBN（通常版/特装版/重版など）
}

async function bookMaster(env: Env, isbn: string): Promise<BookMaster> {
  const isbn13 = toIsbn13(isbn);
  const v = await env.DB.prepare(
    `SELECT series_id, volume_number, subtitle, label FROM volumes WHERE isbn = ? LIMIT 1`
  )
    .bind(isbn13)
    .first<{ series_id: string | null; volume_number: string | null; subtitle: string | null; label: string | null }>();
  if (!v) return { label: "", volume_number: "", subtitle: "", editions: [] };
  let editions: string[] = [];
  if (v.series_id && v.volume_number) {
    const res = await env.DB.prepare(
      // 同じ巻番号でも別の作品のことがある（金田一少年の事件簿の「下」は事件ごとに 5 冊）ので、
      // 書名＋副題（util.ts workKeySql）まで一致するものだけを「同じ巻の別 ISBN」とする。
      `SELECT isbn FROM volumes v WHERE v.series_id = ? AND v.volume_number = ? AND v.isbn != ?
         AND ${workKeySql("v.")} = (SELECT ${workKeySql("w.")} FROM volumes w WHERE w.isbn = ?)
        ORDER BY v.pubdate, v.isbn LIMIT 10`
    )
      .bind(v.series_id, v.volume_number, isbn13, isbn13)
      .all<{ isbn: string }>();
    editions = (res.results ?? []).map((r) => r.isbn);
  }
  return { label: v.label || "", volume_number: v.volume_number || "", subtitle: v.subtitle || "", editions };
}

async function bookSeries(env: Env, isbn: string): Promise<{ id: string; title: string } | null> {
  const isbn13 = toIsbn13(isbn);
  const b = (await resolveBooks(env, [isbn13])).get(isbn13);
  if (b?.series_id && b.series_title) return { id: b.series_id, title: b.series_title };

  // シリーズの無いマスタ巻: 既存シリーズに寄せられればそのシリーズ（巻一覧にもその条件で
  // 混ざる）、無ければ書名+著者のまとまり（G<ISBN>, src/groups.ts）へリンクする。
  // まとまりの正規 ID（G + まとまり内で最小の ISBN）も一緒に引く。まとまり全体を集める
  // groups.loadGroup はこの popup には重いので、同じ鍵（書名・著者・レーベル）の完全一致で
  // 近似する（idx_volumes_unlinked_title）。表記ゆれで外した場合も素の書名に戻るだけ。
  const v = await env.DB.prepare(
    `SELECT v.title,
            (SELECT MIN(w.isbn) FROM volumes w
              WHERE w.series_id IS NULL AND w.title = v.title
                AND w.creator IS v.creator AND w.label IS v.label) AS head
       FROM volumes v WHERE v.isbn = ? AND v.series_id IS NULL`
  )
    .bind(isbn13)
    .first<{ title: string; head: string | null }>();
  if (!v) return null;
  const owner = (await attributeTitles(env, [v.title])).get(v.title);
  if (!owner) {
    // 管理者がまとまりの名前を直していれば（series_name_override を G-id で記録、
    // src/groups.ts applyGroupNames）巻一覧と同じ名前でリンクする。
    const id = "G" + (v.head || isbn13);
    const o = await env.DB.prepare(`SELECT name FROM series_name_override WHERE series_id = ?`)
      .bind(id)
      .first<{ name: string }>();
    return { id, title: o?.name || v.title };
  }
  const id = await resolveMergeTarget(env, owner);
  const s = await env.DB.prepare(
    `SELECT ${seriesNameSql("s", "o")} AS name FROM series s
       LEFT JOIN series_name_override o ON o.series_id = s.id WHERE s.id = ?`
  )
    .bind(id)
    .first<{ name: string }>();
  return { id, title: s?.name || v.title };
}

async function readBookMeta(env: Env, isbn: string): Promise<{ meta: BookMeta; checkedAt: number } | null> {
  const row = await env.DB.prepare(
    `SELECT authors, publisher, pubdate, caption, checked_at FROM book_meta WHERE isbn = ?`
  )
    .bind(isbn)
    .first<BookMetaRow>();
  if (!row) return null;
  return {
    meta: {
      isbn,
      authors: row.authors ? row.authors.split("/") : [],
      publisher: row.publisher,
      pubdate: row.pubdate,
      caption: row.caption,
    },
    checkedAt: row.checked_at,
  };
}

async function writeBookMeta(env: Env, m: BookMeta): Promise<void> {
  await bookMetaInsert(env, m.isbn, m.authors.join("/"), m.publisher, m.pubdate, m.caption).run();
}

/** Prepared INSERT for the book_meta cache, batchable by the caller. */
function bookMetaInsert(
  env: Env,
  isbn: string,
  authors: string,
  publisher: string,
  pubdate: string,
  caption: string,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT OR REPLACE INTO book_meta (isbn, authors, publisher, pubdate, caption, checked_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(isbn, authors, publisher, pubdate, caption, Date.now());
}

/** Build a book_meta insert straight from a Rakuten record, for callers that already
 *  fetched one while resolving a cover (covers.ts). Returns null when the record is
 *  empty — Rakuten had no entry — so the popup's /api/book can still fill it by
 *  merging the MADB master instead of this being frozen as blank. */
export function bookMetaInsertFromRakuten(
  env: Env,
  rk: RakutenBookFull,
): D1PreparedStatement | null {
  if (!rk.title || !rk.isbn) return null;
  const authors = mergeAuthors(rk.author, null).join("/");
  return bookMetaInsert(env, rk.isbn, authors, rk.publisher, rk.pubdate, rk.caption);
}

/** Cache book_meta for a batch of Rakuten records (e.g. every hit of a title search,
 *  whose single API call already carries each book's author/publisher/発行日/あらすじ).
 *  Deduped by ISBN; empty records are skipped. The Rakuten call is the expensive part,
 *  so we persist everything it returned rather than paying again per book later. */
export async function cacheBookMetaBatch(env: Env, records: RakutenBookFull[]): Promise<void> {
  const stmts: D1PreparedStatement[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    if (seen.has(r.isbn)) continue;
    const stmt = bookMetaInsertFromRakuten(env, r);
    if (stmt) {
      seen.add(r.isbn);
      stmts.push(stmt);
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
}

/** Individual author names. Rakuten separates multiple contributors with "/", so
 *  prefer it when present; the MADB creator is already space-joined and can't be
 *  split reliably (a single name also contains a space), so it's kept as one entry. */
function mergeAuthors(rakutenAuthor?: string, madbCreator?: string | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (s: string) => {
    const t = s.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  };
  if (rakutenAuthor && rakutenAuthor.trim()) {
    rakutenAuthor.split("/").forEach(push);
  } else if (madbCreator) {
    push(madbCreator);
  }
  return out;
}

/** MADB datePublished is ISO but of varying precision ("2015-08-04", "2019-10",
 *  "2020"); render whatever parts are present in Japanese. Anything unrecognized
 *  (or empty) is returned untouched so the Rakuten fallback can take over. */
function formatPubdate(raw?: string | null): string {
  const s = (raw ?? "").trim();
  const m = s.match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/);
  if (!m) return s;
  let out = `${m[1]}年`;
  if (m[2]) out += `${Number(m[2])}月`;
  if (m[3]) out += `${Number(m[3])}日`;
  return out;
}
