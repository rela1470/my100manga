import { Env } from "./types";
import type { PageOpts } from "./admin";
import {
  badRequest,
  isValidIsbn,
  json,
  normTitle,
  notFound,
  readJsonObject,
  seriesNameSql,
  toIsbn13,
} from "./util";
import { adultBlockMessage, findAdultIsbns } from "./adult";
import { createCustomSeriesStmts, nextCustomSeriesId } from "./groups";
import { buildMasterRow, masterFixStmts } from "./masterFix";
import {
  masterPubdate,
  rakutenComicByIsbn,
  rakutenReady,
  rakutenSeriesPage,
  type RakutenCandidate,
} from "./rakuten";
import { yahooReady, yahooVolumeIsbns } from "./yahoo";
import { salesWorkTitle } from "./salesRanking";
import { readCachedCovers } from "./covers";

// マスタ（MADB）に丸ごと無い作品を、シリーズとして登録する。
//
// MADB に 1 巻も載っていない作品は、ISBN 検索で楽天ブックス由来の 1 冊ライブカード
// （src/search.ts rakutenCard、series_id が "rakuten<ISBN>" の擬似 ID）にしかならない。
// リストには入れられるが、シリーズとして開く・全巻まとめて追加する・書名で検索して当てる・
// 結合／分離／名前修正／タグの導線に乗せる、がどれもできない。
// 例: 9784758061780『このこここのこ』1 巻（藤こよみ / 一迅社 IDコミックス REXコミックス /
// 全 3 巻）は MADB に 1 行も無く、楽天ブックスだけが 3 巻とも持っている。
//
// 作りは既にある 3 つの仕組みの組み合わせで、新しい読み出し経路は増やさない:
//   1. custom_series … 独自シリーズ（U-id）。取り込み後も APPLY_LINKS_SQL が series へ載せ直す。
//   2. volume_master_fix … 「直した（または足した）マスタ行そのもの」。prev_json が NULL の行が
//      「上流に無い巻を足した」もので、取り込み後は APPLY_MASTER_FIX_SQL が載せ直す（src/masterFix.ts）。
//   3. 楽天ブックスのタイトル検索（+ 絶版巻の保険に Yahoo）… 残りの巻の ISBN を集める。
// できあがるのは「普通のシリーズ 1 件と、普通のマスタ巻 n 行」なので、巻一覧・検索・リスト表示・
// 詳細はこの仕組みを一切知らなくていい。
//
// 利用者からは「登録してほしい」という依頼だけを受け、全体反映は管理者の確定まで行わない
// （series_report / series_merge_request / cover_suggestion と同じ collect-only 方針）。
// 依頼が運ぶのは ISBN 1 つだけで、書名・著者はサーバが自分の控え（live_volumes / book_meta）から
// 引く。利用者の自由入力を 1 文字も受けないので、通報・伏字の対象になる文字列は表に入らない。
//
// 取り消しは管理画面「マスタ行の修正」の取り消し（prev_json が NULL なので volumes から消える）。
// 巻が 1 つも残らなくなった独自シリーズは adminUnlinkVolumes と同じ規則で片付ける
// （src/merge.ts の孤児判定は volumes を見るので、巻がある限り消えない）。

const NO_STORE = { "cache-control": "no-store" } as const;

// 未処理の依頼の上限。これを超えたら新しい ISBN の依頼は数えるのをやめる（既にある依頼の
// 回数更新は通す）。cover_suggestion の上限と同じ趣旨の、表を無限に太らせないための蓋。
const MAX_PENDING = 500;
// 候補集めで送る楽天のページ数の上限。実際に効くのはレートリミッタ（高優先レーンの待ち上限が
// 4 秒 = 枠は 3〜4 個）なので、これはその外側の保険（src/gapFill.ts と同じ考え方）。
const MAX_PAGES = 4;
// 楽天が落とした巻を Yahoo で拾う回数の上限（1 巻 1 リクエスト）。
const MAX_YAHOO_PROBES = 6;
// 1 回の確定で登録できる巻数の上限。
const MAX_VOLUMES = 200;

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

// ── 利用者からの依頼（collect-only）──────────────────────────────────────────

/** POST /api/series-register-requests  { isbn }
 *  受け取るのは ISBN 1 つだけ。書名・著者はサーバが live_volumes / book_meta から引く。 */
export async function requestSeriesRegister(request: Request, env: Env): Promise<Response> {
  const body = await readJsonObject(request);
  const isbn = toIsbn13(str(body.isbn, 20));
  if (!isValidIsbn(isbn)) return badRequest("ISBN を正しく指定してください");

  // 成年向けとして取り込みから外した巻は、本家の volumes に 1 行も入れない（src/adult.ts）。
  // 依頼として溜めても確定できないので、その場で理由を返す。
  const adultTitle = (await findAdultIsbns(env, [isbn])).get(isbn);
  if (adultTitle !== undefined) return badRequest(adultBlockMessage(adultTitle));

  // 既にマスタに居る＝検索でシリーズ（かシリーズ無しのまとまり）として開けるので依頼は要らない。
  const inMaster = await env.DB.prepare(`SELECT 1 AS x FROM volumes WHERE isbn = ?`).bind(isbn).first();
  if (inMaster) return json({ ok: true, queued: false, already: true }, 200, NO_STORE);

  // 控えから引ける範囲の書誌。ライブカードを開いた時点で live_volumes には入っている
  // （src/search.ts rememberLiveVolumes）。引けなくても依頼自体は受ける。
  const known = await env.DB.prepare(
    `SELECT lv.title AS title, lv.author AS author, COALESCE(bm.publisher, '') AS publisher
       FROM live_volumes lv
       LEFT JOIN book_meta bm ON bm.isbn = lv.isbn
      WHERE lv.isbn = ?`
  )
    .bind(isbn)
    .first<{ title: string; author: string; publisher: string }>();

  const existing = await env.DB.prepare(`SELECT 1 AS x FROM series_register_request WHERE isbn = ?`)
    .bind(isbn)
    .first();
  if (!existing) {
    const pending = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM series_register_request WHERE resolved_at = 0`
    ).first<{ n: number }>();
    if ((pending?.n ?? 0) >= MAX_PENDING) return json({ ok: true, queued: false }, 200, NO_STORE);
  }

  // 同じ ISBN の再依頼は回数を増やすだけ。処理済み（却下・登録済み）の行は開き直す:
  // ここまで来たということは今もマスタに無いので、繰り返し求められているなら見直す価値がある。
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO series_register_request (isbn, title, creator, publisher, report_count, first_reported_at, last_reported_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT (isbn) DO UPDATE SET
       report_count = report_count + 1,
       last_reported_at = excluded.last_reported_at,
       title     = CASE WHEN excluded.title     <> '' THEN excluded.title     ELSE series_register_request.title     END,
       creator   = CASE WHEN excluded.creator   <> '' THEN excluded.creator   ELSE series_register_request.creator   END,
       publisher = CASE WHEN excluded.publisher <> '' THEN excluded.publisher ELSE series_register_request.publisher END,
       resolved_at = 0,
       resolution = '',
       series_id = ''`
  )
    .bind(isbn, known?.title ?? "", known?.author ?? "", known?.publisher ?? "", now, now)
    .run();

  return json({ ok: true, queued: true }, 200, NO_STORE);
}

// ── 管理画面: 依頼のキュー ───────────────────────────────────────────────────

interface AdminRequestRow {
  isbn: string;
  title: string;
  creator: string;
  publisher: string;
  report_count: number;
  first_reported_at: number;
  last_reported_at: number;
  resolved_at: number;
  resolution: string;
  series_id: string;
  series_name: string | null;
  cover_url: string | null;
  in_master: number;
}

/** GET /api/admin/series-register-requests?page=&per=&resolved=0|1 */
export async function adminListRegisterRequests(env: Env, opts: PageOpts, url: URL): Promise<Response> {
  const resolved = url.searchParams.get("resolved") === "1";
  const where = resolved ? "r.resolved_at > 0" : "r.resolved_at = 0";
  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM series_register_request r WHERE ${where}`
  ).first<{ n: number }>();

  const { results } = await env.DB.prepare(
    `SELECT r.isbn, r.title, r.creator, r.publisher, r.report_count,
            r.first_reported_at, r.last_reported_at, r.resolved_at, r.resolution, r.series_id,
            ${seriesNameSql("s", "so")} AS series_name,
            cov.cover_url AS cover_url,
            EXISTS(SELECT 1 FROM volumes v WHERE v.isbn = r.isbn) AS in_master
       FROM series_register_request r
       LEFT JOIN series s ON s.id = r.series_id
       LEFT JOIN series_name_override so ON so.series_id = r.series_id
       LEFT JOIN covers cov ON cov.isbn = r.isbn
      WHERE ${where}
      ORDER BY r.last_reported_at DESC, r.isbn
      LIMIT ? OFFSET ?`
  )
    .bind(opts.per, opts.offset)
    .all<AdminRequestRow>();

  const requests = (results ?? []).map((r) => ({
    isbn: r.isbn,
    title: r.title,
    creator: r.creator,
    publisher: r.publisher,
    report_count: r.report_count,
    first_reported_at: r.first_reported_at,
    last_reported_at: r.last_reported_at,
    resolved_at: r.resolved_at,
    resolution: r.resolution,
    series_id: r.series_id,
    series_name: r.series_name ?? "",
    cover_url: r.cover_url ?? "",
    // 依頼のあと（別経路の取り込み・結合・マスタ行の修正で）マスタに入った ISBN。
    // 確定の必要がもう無い合図として出す。
    in_master: r.in_master === 1,
  }));

  return json({ requests, total: totalRow?.n ?? 0, page: opts.page, per: opts.per }, 200, NO_STORE);
}

/** DELETE /api/admin/series-register-requests/:isbn … 却下（行は残す。再依頼で開き直る）。 */
export async function adminDismissRegisterRequest(env: Env, rawIsbn: string): Promise<Response> {
  const isbn = toIsbn13(rawIsbn);
  const res = await env.DB.prepare(
    `UPDATE series_register_request SET resolved_at = ?, resolution = 'dismissed', series_id = ''
      WHERE isbn = ? AND resolved_at = 0`
  )
    .bind(Date.now(), isbn)
    .run();
  if (!(res.meta?.changes ?? 0)) return notFound("未処理の依頼が見つかりません");
  return json({ ok: true, isbn }, 200, NO_STORE);
}

// ── 管理画面: 候補の巻を集める ───────────────────────────────────────────────

export interface RegisterCandidate {
  isbn: string;
  volume_number: string;
  vol_sort: number;
  title: string;
  publisher: string;
  label: string;
  pubdate: string;
  cover_url: string;
  source: "rakuten" | "yahoo";
  /** マスタが既に持っている巻（別シリーズの巻を横取りしないよう、選べない印として出す）。 */
  in_master: boolean;
  /** 成年向けとして取り込みから外した巻（本家では登録できない）。 */
  adult: boolean;
}

/** 候補 1 件に畳む。同名の別作品・セット商品・巻数の読めないものは呼び手が落とす。 */
function toCandidate(it: RakutenCandidate, workTitle: string): RegisterCandidate | null {
  if (!/^97[89]\d{10}$/.test(it.isbn) || !isValidIsbn(it.isbn)) return null;
  const vol = it.volume;
  return {
    isbn: it.isbn,
    volume_number: vol === null ? "" : String(vol),
    vol_sort: vol === null ? 0 : vol,
    title: workTitle,
    publisher: it.publisher,
    label: it.seriesName,
    pubdate: masterPubdate(it.pubdate),
    cover_url: /noimage/i.test(it.cover_url) ? "" : it.cover_url,
    source: "rakuten",
    in_master: false,
    adult: false,
  };
}

/** 楽天のタイトル検索を MAX_PAGES までページ送りして候補に足す。戻り値は 1 件でも足せたか。 */
async function collectRakuten(
  env: Env,
  q: { title: string; author?: string },
  workTitle: string,
  out: Map<string, RegisterCandidate>
): Promise<boolean> {
  const want = normTitle(workTitle);
  let added = false;
  let pageCount = 1;
  for (let page = 1; page <= MAX_PAGES && page <= pageCount; page++) {
    const res = await rakutenSeriesPage(env, q, page);
    if (!res) break; // 枠が取れない / HTTP エラー: ここで打ち切る
    pageCount = res.pageCount;
    for (const it of res.items) {
      // 「同じ作品か」は巻数・版の表記を除いた作品名の一致で見る（売上ランキングの集計単位と
      // 同じ salesWorkTitle）。同名の別作品まで寄せる危険はあるが、ここは管理者が目で見て
      // チェックを外す画面なので、取りこぼしより拾いすぎの方を選ぶ。
      if (normTitle(salesWorkTitle(it.title)) !== want) continue;
      const cand = toCandidate(it, workTitle);
      if (!cand || out.has(cand.isbn)) continue;
      out.set(cand.isbn, cand);
      added = true;
    }
  }
  return added;
}

/** GET /api/admin/series-register/candidates?isbn=&title=&creator=&publisher=
 *  代表 ISBN から作品を同定し、その作品の巻を楽天ブックス（+ 絶版巻は Yahoo）から集める。
 *  title / creator / publisher を渡すと、その値で引き直す（自動の同定が外したときの手動指定）。 */
export async function adminRegisterCandidates(env: Env, url: URL): Promise<Response> {
  const isbn = toIsbn13(url.searchParams.get("isbn") ?? "");
  if (!isValidIsbn(isbn)) return badRequest("ISBN を正しく指定してください");
  const overTitle = str(url.searchParams.get("title"), 200);
  const overCreator = str(url.searchParams.get("creator"), 200);
  const overPublisher = str(url.searchParams.get("publisher"), 200);

  // 代表の 1 冊。楽天ブックスの ISBN 直引き（検索の 1 冊カードと同じ経路）を第一に、
  // 落ちたら控え（live_volumes / 依頼の行）。
  const [seed, live, req] = await Promise.all([
    rakutenComicByIsbn(env, isbn).catch(() => null),
    env.DB.prepare(`SELECT title, volume_number, author FROM live_volumes WHERE isbn = ?`)
      .bind(isbn)
      .first<{ title: string; volume_number: string; author: string }>(),
    env.DB.prepare(`SELECT title, creator, publisher FROM series_register_request WHERE isbn = ?`)
      .bind(isbn)
      .first<{ title: string; creator: string; publisher: string }>(),
  ]);

  const seedTitle = seed?.title || live?.title || req?.title || "";
  const creator = overCreator || seed?.author || live?.author || req?.creator || "";
  const publisher = overPublisher || seed?.publisher || req?.publisher || "";
  const workTitle = overTitle || (seedTitle ? salesWorkTitle(seedTitle) : "");
  if (!workTitle) {
    return badRequest("この ISBN の書名が分かりませんでした。作品名を指定して引き直してください");
  }

  const found = new Map<string, RegisterCandidate>();
  if (rakutenReady(env)) {
    const ok = await collectRakuten(env, { title: workTitle, author: creator || undefined }, workTitle, found);
    // 著者で絞って空振りなら著者を外して引き直す（「さいとう・たかを」のような表記揺れで
    // 0 件になることがある。src/gapFill.ts と同じ）。
    if (!ok && creator) await collectRakuten(env, { title: workTitle }, workTitle, found);
  }

  // 代表の 1 冊はタイトル検索が落としても必ず候補に入れる（書名が巻数表記ごと違う等）。
  if (seed && !found.has(isbn)) {
    found.set(isbn, {
      isbn,
      volume_number: seed.volume || live?.volume_number || "",
      vol_sort: Number(seed.volume || live?.volume_number || 0) || 0,
      title: workTitle,
      publisher: seed.publisher,
      label: "",
      pubdate: masterPubdate(seed.pubdate),
      cover_url: seed.cover_url,
      source: "rakuten",
      in_master: false,
      adult: false,
    });
  }

  // 楽天が落とした巻を Yahoo の中古出品で拾う（新刊書店は絶版の古い巻を扱わない。
  // src/yahoo.ts yahooVolumeIsbns）。巻数が読めた候補の 1〜最大巻の間の穴だけ、上限付きで。
  let yahooCapped = false;
  if (yahooReady(env) && found.size) {
    const have = new Set([...found.values()].map((c) => c.vol_sort).filter((n) => n > 0));
    const maxVol = have.size ? Math.max(...have) : 0;
    let probes = 0;
    for (let n = 1; n <= maxVol; n++) {
      if (have.has(n)) continue;
      if (probes >= MAX_YAHOO_PROBES) { yahooCapped = true; break; }
      probes++;
      const isbns = await yahooVolumeIsbns(env, workTitle, n);
      if (isbns === null) { yahooCapped = true; break; } // 枠切れ: 以降は投げない
      // 同じ巻に複数の出品（通常版・特装版）が並ぶので 1 件だけ採る。別の版なら管理者が外す。
      const pick = isbns.find((i) => !found.has(i));
      if (!pick) continue;
      found.set(pick, {
        isbn: pick,
        volume_number: String(n),
        vol_sort: n,
        title: workTitle,
        publisher,
        label: "",
        pubdate: "",
        cover_url: "",
        source: "yahoo",
        in_master: false,
        adult: false,
      });
    }
  }

  // 既にマスタが持っている巻・成年向けの巻に印を付ける（確定側でも弾くが、画面で理由を見せる）。
  const isbns = [...found.keys()];
  const [owned, adult, covers] = await Promise.all([
    env.DB.prepare(`SELECT isbn FROM volumes WHERE isbn IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(isbns))
      .all<{ isbn: string }>(),
    findAdultIsbns(env, isbns),
    readCachedCovers(env, isbns),
  ]);
  for (const r of owned.results ?? []) {
    const c = found.get(r.isbn);
    if (c) c.in_master = true;
  }
  for (const i of adult.keys()) {
    const c = found.get(i);
    if (c) c.adult = true;
  }
  for (const c of found.values()) {
    if (!c.cover_url) c.cover_url = covers.get(c.isbn) ?? "";
  }

  // レーベルは候補のうち最も多い seriesName（「IDコミックス　REXコミックス」）。
  const labels = new Map<string, number>();
  for (const c of found.values()) if (c.label) labels.set(c.label, (labels.get(c.label) ?? 0) + 1);
  const label = [...labels.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "";

  const candidates = [...found.values()].sort((a, b) => a.vol_sort - b.vol_sort || a.isbn.localeCompare(b.isbn));

  return json(
    {
      isbn,
      work_title: workTitle,
      creator,
      publisher,
      label,
      candidates,
      // 画面に出す注記。上限で打ち切ったときは「これで全部とは限らない」と言えるように。
      yahoo_capped: yahooCapped,
      rakuten: rakutenReady(env),
      yahoo: yahooReady(env),
    },
    200,
    NO_STORE
  );
}

// ── 管理画面: 確定（独自シリーズを作って巻を登録する）──────────────────────

interface RegisterVolume {
  isbn: string;
  volume_number: string;
  title: string;
  subtitle: string;
  pubdate: string;
}

/** POST /api/admin/series-register
 *  { isbn?, name, creator, creators?, publisher, label, note?, volumes: [{isbn, volume_number, title?, subtitle?, pubdate?}] }
 *  custom_series を 1 行作り、選んだ巻を volume_master_fix 行として書いてその場で volumes へ当てる。 */
export async function adminRegisterSeries(request: Request, env: Env): Promise<Response> {
  const body = await readJsonObject(request);

  const name = str(body.name, 200);
  if (!name) return badRequest("シリーズ名を指定してください");
  const creator = str(body.creator, 200);
  const creators = str(body.creators, 400);
  const publisher = str(body.publisher, 200);
  const label = str(body.label, 200);
  const note = str(body.note, 500) || `シリーズの新規登録「${name}」`;
  // 依頼から開いたときの代表 ISBN（確定したらその依頼を処理済みにする）。無くてもよい。
  const reqIsbn = toIsbn13(str(body.isbn, 20));

  const raw = Array.isArray(body.volumes) ? body.volumes : [];
  if (!raw.length) return badRequest("登録する巻を 1 冊以上選んでください");
  if (raw.length > MAX_VOLUMES) return badRequest(`一度に登録できるのは ${MAX_VOLUMES} 冊までです`);

  const vols: RegisterVolume[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
    const vi = toIsbn13(str(o.isbn, 20));
    if (!isValidIsbn(vi)) return badRequest(`ISBN が正しくありません: ${str(o.isbn, 20) || "(空)"}`);
    if (seen.has(vi)) return badRequest(`同じ ISBN が 2 回選ばれています: ${vi}`);
    seen.add(vi);
    const pubdate = str(o.pubdate, 20);
    if (pubdate && !/^\d{4}(-\d{2}(-\d{2})?)?$/.test(pubdate)) {
      return badRequest(`発行日は 2001 / 2001-03 / 2001-03-16 の形で指定してください（${vi}）`);
    }
    vols.push({
      isbn: vi,
      volume_number: str(o.volume_number, 32),
      title: str(o.title, 200) || name,
      subtitle: str(o.subtitle, 200),
      pubdate,
    });
  }
  const isbns = [...seen];

  // 成年向けの巻は本家の volumes に 1 行も入れない（volume_master_fix と同じ規則、src/adult.ts）。
  const adult = await findAdultIsbns(env, isbns);
  if (adult.size) {
    return badRequest(`成年向けの巻は登録できません: ${[...adult.keys()].join(", ")}`);
  }

  // マスタが既に持っている ISBN は取らない。既存シリーズの巻を横取りしないため。
  // シリーズ無しのまとまりをシリーズにするのは「結合」、壊れた行を直すのは「マスタ行の修正」。
  const owned = await env.DB.prepare(
    `SELECT isbn FROM volumes WHERE isbn IN (SELECT value FROM json_each(?))`
  )
    .bind(JSON.stringify(isbns))
    .all<{ isbn: string }>();
  if (owned.results?.length) {
    return badRequest(
      `マスタが既に持っている巻は登録できません（結合、またはマスタ行の修正を使ってください）: ` +
        owned.results.map((r) => r.isbn).join(", ")
    );
  }

  const now = Date.now();
  const id = await nextCustomSeriesId(env);
  const stmts = createCustomSeriesStmts(env, id, { title: name, creator, publisher, label }, now);
  for (const v of vols) {
    const row = buildMasterRow({
      isbn: v.isbn,
      series_id: id,
      volume_number: v.volume_number,
      title: v.title,
      subtitle: v.subtitle,
      creator,
      creators,
      publisher,
      label,
      pubdate: v.pubdate,
    });
    // 上流に無い巻なので控え（prev_json）は無い＝取り消しで volumes から消える。
    stmts.push(...masterFixStmts(env, row, note, now, null));
  }
  if (reqIsbn) {
    stmts.push(
      env.DB.prepare(
        `UPDATE series_register_request SET resolved_at = ?, resolution = 'registered', series_id = ?
          WHERE isbn = ?`
      ).bind(now, id, reqIsbn)
    );
  }
  await env.DB.batch(stmts);

  return json({ ok: true, series_id: id, name, volumes: vols.length }, 200, NO_STORE);
}
