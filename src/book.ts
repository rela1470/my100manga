import { Env } from "./types";
import { badRequest, json } from "./util";
import { rakutenResolveFull, RakutenBookFull } from "./rakuten";

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
}

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

  // refresh=1 … ユーザが編集ポップアップの「本データを再取得」で明示的に押したとき。
  // キャッシュ（空あらすじで固まった行など）を無視して Rakuten を叩き直し、結果で上書きする。
  // 外部 API を叩くので index.ts 側で RL_COVERS によるレート制限をかけている。
  const refresh = (url.searchParams.get("refresh") ?? "") === "1";

  if (!refresh) {
    const cached = await readBookMeta(env, isbn);
    if (cached) return json({ ...cached, status: "ok" }, 200, { "cache-control": "no-store" });
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
  if (rk !== null) await writeBookMeta(env, result);

  // The same Rakuten response also carried the cover (already HEAD-checked). When
  // it's a real cover, fill the covers cache if absent so a later list render skips
  // re-resolving this ISBN. INSERT OR IGNORE never clobbers an admin-corrected
  // cover; an empty/undetermined result is left alone so resolveCovers' full
  // Rakuten+Google tiering still runs later.
  if (res.cover) {
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
  return json({ ...result, status }, 200, { "cache-control": "no-store" });
}

async function readBookMeta(env: Env, isbn: string): Promise<BookMeta | null> {
  const row = await env.DB.prepare(
    `SELECT authors, publisher, pubdate, caption FROM book_meta WHERE isbn = ?`
  )
    .bind(isbn)
    .first<BookMetaRow>();
  if (!row) return null;
  return {
    isbn,
    authors: row.authors ? row.authors.split("/") : [],
    publisher: row.publisher,
    pubdate: row.pubdate,
    caption: row.caption,
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
