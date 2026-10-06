import { Env } from "./types";
import { badRequest, json, readJsonObject } from "./util";
import { rakutenReady, rakutenResolveFull, RakutenBookFull } from "./rakuten";
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

// 並べ替え（/api/sort-keys）で一度に引ける ISBN 数。public/app.js MAX_ITEMS と揃える。
const MAX_SORT_KEY_ISBNS = 1000;

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

// POST /api/sort-keys — 編集中リストの並べ替え（出版日順・作者順）用に、ISBN →
// {date, author} をまとめて返す。リストの項目は発行日を持たず、古い項目は作者も空なので、
// 並べ替えが押されたときだけ引く。
// 出所の優先順は /api/book と同じでマスタ（volumes）が先。マスタに無い巻は book_meta の
// キャッシュ、それも無ければライブ補完（series_supplement, 抜け巻の Yahoo 由来など）。
// ISBN は RESOLVE_SQL と同じく json_each で 1 パラメータに畳む（100 冊でも 1 往復）。
// D1 のどこにも無かった巻（ISBN 検索から足した本など、マスタにも book_meta にも行が無い）は
// 詳細ポップアップ（/api/book）と同じ楽天の exact-ISBN で引き直す。ポップアップには出るのに
// 並べ替えだけ「分からない」になるのを無くすため。結果は book_meta に残すので、次からは
// D1 読みだけで済む。body.field は並べ替えに使う値（既定は発行日）で、その値が埋まらない
// 巻だけを楽天に回す。
export async function handleSortKeys(request: Request, env: Env): Promise<Response> {
  const body = (await readJsonObject(request)) as { isbns?: unknown; field?: unknown };
  const field = body.field === "author" ? "author" : "date";
  const isbns = Array.isArray(body.isbns)
    ? [
        ...new Set(
          body.isbns
            .filter((x): x is string => typeof x === "string")
            .filter((x) => isValidIsbn(x))
            .map((x) => toIsbn13(x))
        ),
      ].slice(0, MAX_SORT_KEY_ISBNS)
    : [];
  if (!isbns.length) return json({ keys: {} }, 200, { "cache-control": "no-store" });

  const res = await env.DB.prepare(
    `WITH want(isbn) AS (SELECT DISTINCT value FROM json_each(?1))
     SELECT w.isbn,
            v.pubdate AS v_date, v.creator AS v_author,
            m.pubdate AS m_date, m.authors AS m_author,
            -- 補完の巻は 1 件だけ取り出して、発行日と作者は JS 側で読む（同じ相関
            -- サブクエリを 2 回書かないため）。逆引き（si）は PK、sp は series_id で引く。
            (SELECT j.value FROM series_supplement_isbn si
               JOIN series_supplement sp ON sp.series_id = si.series_id
               JOIN json_each(sp.volumes_json) j
               JOIN json_each(j.value, '$.isbns') ji ON ji.value = w.isbn
              WHERE si.isbn = w.isbn LIMIT 1) AS s_vol
       FROM want w
       LEFT JOIN volumes v ON v.isbn = w.isbn
       LEFT JOIN book_meta m ON m.isbn = w.isbn`
  )
    .bind(JSON.stringify(isbns))
    .all<{
      isbn: string;
      v_date: string | null;
      v_author: string | null;
      m_date: string | null;
      m_author: string | null;
      s_vol: string | null;
    }>();

  const keys: Record<string, { date: string; author: string }> = {};
  for (const r of res.results ?? []) {
    const supp = parseSupplementVolume(r.s_vol);
    const date = isoPubdate(r.v_date) || isoPubdate(r.m_date) || isoPubdate(supp.pubdate);
    // book_meta.authors は "/" つなぎ。表示（編集ポップアップ）に合わせて読点でつなぐ。
    const author = (r.v_author || splitAuthors(r.m_author) || supp.author || "").trim();
    if (date || author) keys[r.isbn] = { date, author };
  }

  await fillSortKeysFromRakuten(env, isbns, field, keys);
  return json({ keys }, 200, { "cache-control": "no-store" });
}

// 楽天を引くのは 1 度に 1 秒 1 件（サイト全体の枠）なので、1 回の並べ替えで待たせる上限を
// 決めておく。resolveCovers と同じ考え方で、間に合わなかった巻は分からないまま末尾へ回り、
// 次に並べ替えを押したときに続きを引く。
const SORT_KEY_LIVE_BUDGET_MS = 6000;
// 枠の消化速度は同時数を上げても変わらない（covers.ts の実測）が、往復の待ちは重ねられる。
const SORT_KEY_LIVE_CONCURRENCY = 2;

/** D1 のどこにも無かった巻を楽天の exact-ISBN で引き、keys を埋めつつ book_meta に残す。
 *  楽天の鍵が無い環境・枠が取れなかった巻では何もしない（分からないまま）。 */
async function fillSortKeysFromRakuten(
  env: Env,
  isbns: string[],
  field: "date" | "author",
  keys: Record<string, { date: string; author: string }>
): Promise<void> {
  const missing = isbns.filter((isbn) => !keys[isbn]?.[field]);
  if (!missing.length || !rakutenReady(env)) return;

  const deadline = Date.now() + SORT_KEY_LIVE_BUDGET_MS;
  const metaWrites: D1PreparedStatement[] = [];
  for (let i = 0; i < missing.length; i += SORT_KEY_LIVE_CONCURRENCY) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break; // 時間切れ — 残りは次に押したときに引く
    const batch = missing.slice(i, i + SORT_KEY_LIVE_CONCURRENCY);
    const got = await Promise.all(batch.map((isbn) => rakutenResolveFull(env, isbn, "low", remaining)));
    batch.forEach((isbn, j) => {
      const meta = got[j].meta;
      if (!meta?.title) return; // 枠が取れなかった（null）か、楽天にも無い巻
      const stmt = bookMetaInsertFromRakuten(env, meta);
      if (stmt) metaWrites.push(stmt);
      const cur = keys[isbn] ?? { date: "", author: "" };
      // マスタ由来の値の方が確かなので、空いているところだけ埋める。
      keys[isbn] = {
        date: cur.date || isoPubdate(meta.pubdate),
        author: cur.author || splitAuthors(meta.author),
      };
      if (!keys[isbn].date && !keys[isbn].author) delete keys[isbn];
    });
  }
  if (metaWrites.length) await env.DB.batch(metaWrites);
}

/** "/" つなぎの著者（book_meta.authors / 楽天の author）を表示と同じ読点つなぎにする。 */
function splitAuthors(raw: string | null | undefined): string {
  return (raw ?? "").split("/").filter(Boolean).join("、");
}

/** 補完（series_supplement.volumes_json）の 1 巻分。中身はサーバが書いた JSON だが、
 *  形が変わっても並べ替えが落ちないよう緩く読む。 */
function parseSupplementVolume(raw: string | null): { pubdate: string; author: string } {
  if (!raw) return { pubdate: "", author: "" };
  try {
    const v = JSON.parse(raw) as { pubdate?: unknown; author?: unknown };
    return {
      pubdate: typeof v.pubdate === "string" ? v.pubdate : "",
      author: typeof v.author === "string" ? v.author : "",
    };
  } catch {
    return { pubdate: "", author: "" };
  }
}

/** 発行日を比較できる形（"2015-08-04" / "2015-08" / "2015"）に揃える。マスタは ISO だが、
 *  book_meta は表示用に整形済み（"2015年8月4日"）、補完は出所によってまちまち。分からない
 *  ものは "" を返す（呼び出し側が末尾に回す）。 */
export function isoPubdate(raw?: string | null): string {
  const m = (raw ?? "").trim().match(/^(\d{4})\D{0,2}(\d{1,2})?\D{0,2}(\d{1,2})?/);
  if (!m) return "";
  let out = m[1];
  if (m[2]) out += "-" + m[2].padStart(2, "0");
  if (m[2] && m[3]) out += "-" + m[3].padStart(2, "0");
  return out;
}
