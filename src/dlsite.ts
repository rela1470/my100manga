import { site } from "./site";
import { Env } from "./types";
import { API_TIMEOUT_MS, awaitSlot, type Priority } from "./ratelimiter";

// DLsite 成年コミック（フロア `books`）を R18版の表紙と購入リンクの源にする。DMM の審査が落ちた
// 代わり（2026-10-15）。調査と実測は docs/dlsite.md、計測ツールは scripts/dlsite-probe.mjs。
//
// 公開の商品 API は無く、作品ページにも ISBN が無い。公開の検索ページを書名で引き、
//   書名  DLsite の題名が MADB のシリーズ名で始まる（DLsite は副題や版の名前を足していることが多い）
//   巻    シリーズ名の後の最初の数字が巻数と一致（巻数なしなら数字なしか 1）
//   著者  著者のどれかが一致（MADB に著者が無ければ出版社の一致で代える）
// の 3 つが揃ったものを確定とする（成年向けランダム 60 巻で 58%）。書名だけ一致したものは誤りが
// 混ざる（同人の音声作品・別作品）ので自動では使わず、管理画面の表紙候補に積む。
//
// 画像の条件（DLsite のアフィリエイトガイド）: 商業コミックの画像はダウンロードして使えず、
// 紹介画像への直リンクのみ。改変も不可（縦横比を保った拡大縮小は可）。なので表紙は
// img.dlsite.jp の URL をそのまま covers に入れてブラウザに直接読ませ、/cover・R2・トリム・
// X シェア画像には通さない（src/shareImage.ts、public/cover-fit.js は DLsite を素通し）。
//
// 速度: llms.txt が毎秒 2 リクエスト・毎分 120 リクエストまでと言っているので、リミッタの
// "dlsite" インスタンス（1 秒 1 件弱）で絞る。検索ページは 1 日キャッシュする（同じシリーズの
// 巻は同じ検索結果を使い回すので、2 巻目以降は作品情報の 1 件だけで済む）。

const BASE = "https://www.dlsite.com/books";
const UA = "Mozilla/5.0 (compatible; My100Shunga/1.0; +https://my100shunga.com/about)";
// 検索結果・作品情報のキャッシュ（Cache API。データセンターごと）。DLsite の掲載は日単位でしか
// 変わらないので 1 日で足りる。
const CACHE_TTL_S = 86400;

/** R18版で DLsite を使うか（src/site.ts の dlsite）。 */
export function dlsiteReady(env: Env): boolean {
  return site(env).dlsite;
}

/** DLsite の表紙 URL か。covers に入っている URL のうち、/cover やシェア画像に通してはいけないもの。 */
export function isDlsiteCover(url: string): boolean {
  try {
    return new URL(url).hostname === "img.dlsite.jp";
  } catch {
    return false;
  }
}

/** 照合に使う巻の書誌（volumes ＋ series）。 */
export interface DlsiteVolume {
  isbn: string;
  series: string; // シリーズ名（シリーズ無しの巻は巻の書名）
  volume_number: string;
  creators_norm: string;
  publisher: string;
}

interface Item {
  id: string;
  title: string;
  maker: string;
  authors: string[];
  img: string;
}

export interface DlsiteMatch {
  /** 確定: 書名・巻・著者（出版社）が一致し、アフィリエイト可。表紙 URL。 */
  cover: string;
  /** 書名だけ一致（自動では使わない。管理画面の候補に積む）。表紙 URL。 */
  titleOnly: string;
}

const SMALL: Record<string, string> = { ァ: "ア", ィ: "イ", ゥ: "ウ", ェ: "エ", ォ: "オ", ャ: "ヤ", ュ: "ユ", ョ: "ヨ", ッ: "ツ", ヮ: "ワ" };
const norm = (s: string): string =>
  String(s || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ァィゥェォャュョッヮ]/g, (c) => SMALL[c])
    .replace(/[\s・:：!！?？、。,.\-－ー〜~()（）「」『』【】\[\]〈〉《》☆★♡♥]/g, "");
// DLsite は筆名の後ろに括弧書きで別名を付ける: 「月下冴喜(若宮参太)」。
const normAuthor = (s: string): string => norm(String(s || "").normalize("NFKC").replace(/\([^)]*\)/g, ""));
// MADB の出版社には「[発売]オークス」のような役割が付く。
const normPub = (s: string): string => norm(String(s || "").replace(/\[[^\]]*\]|\([^)]*\)/g, ""));
// コロンの後の副題と、括弧の読みを外す: 「私が全裸になった理由(ワケ)」→「私が全裸になった理由」。
const mainTitle = (s: string): string =>
  String(s || "")
    .split(/\s*[:：]\s*/)[0]
    .replace(/[(（〈][^)）〉]*[)）〉]/g, "")
    .trim();
const numbers = (s: string): number[] => (String(s || "").normalize("NFKC").match(/\d+/g) || []).map(Number);

const decode = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** 検索結果の HTML から作品を拾う。構造が変わると 0 件になる（＝「無い」と区別できないので、
 *  呼び出し側は 0 件を確定扱いにする。壊れたら表紙が付かなくなるだけで、誤った表紙は付かない）。 */
export function parseResults(html: string): Item[] {
  return html
    .split('data-list_item_product_id="')
    .slice(1)
    .map((chunk) => {
      const id = chunk.slice(0, chunk.indexOf('"'));
      const title = (chunk.match(/<dd class="work_name">[\s\S]*?title="([^"]*)"/) || [])[1] || "";
      const maker = (chunk.match(/alt="[^"]*\[([^\]]*)\]"/) || [])[1] || "";
      const authorBlock = (chunk.match(/<span class="author">([\s\S]*?)<\/span>/) || [])[1] || "";
      const authors = [...authorBlock.matchAll(/>([^<]+)<\/a>/g)].map((m) => decode(m[1].trim()));
      const img = (chunk.match(/'(\/\/img\.dlsite\.jp\/modpub\/[^']*_img_main\.jpg)'/) || [])[1] || "";
      return { id, title: decode(title), maker: decode(maker), authors, img: img && `https:${img}` };
    })
    // 成年コミックの作品 ID は BJ。同人（RJ・音声作品など）やゲーム（VJ）が混ざるので外す。
    .filter((it) => /^BJ\d+$/.test(it.id) && it.img);
}

/** 書名・巻・著者で照合する。strict = 3 つとも一致、titleOnly = 書名と巻だけ一致。 */
export function judge(v: DlsiteVolume, items: Item[]): { level: "strict" | "titleOnly"; hit: Item } | null {
  const base = mainTitle(v.series);
  const want = norm(base);
  if (!want) return null;
  const vol = numbers(v.volume_number)[0] ?? null;
  const authors = String(v.creators_norm || "").split("|").map(norm).filter(Boolean);
  const pub = normPub(v.publisher);
  const titled = items.filter((it) => {
    if (!norm(it.title).startsWith(want)) return false;
    const rest = numbers(it.title.normalize("NFKC").slice(base.normalize("NFKC").length));
    return vol == null ? rest.length === 0 || rest[0] === 1 : rest[0] === vol;
  });
  const who = (it: Item): boolean => {
    if (authors.length) return it.authors.some((a) => authors.includes(normAuthor(a)));
    const maker = normPub(it.maker);
    return !!pub && !!maker && (maker.includes(pub) || pub.includes(maker));
  };
  const strict = titled.find(who);
  if (strict) return { level: "strict", hit: strict };
  if (titled.length) return { level: "titleOnly", hit: titled[0] };
  return null;
}

/** キャッシュ越しに DLsite を GET する。キャッシュに無ければリミッタの枠を取ってから叩く。
 *  null = 未確定（枠が取れない・タイムアウト・HTTP エラー）。 */
async function cachedGet(env: Env, url: string, priority: Priority, maxWaitMs?: number): Promise<string | null> {
  const cache = (globalThis as any).caches?.default as Cache | undefined;
  const key = new Request(url);
  try {
    const hit = await cache?.match(key);
    if (hit) return await hit.text();
  } catch {
    // キャッシュの障害は素通り（取りに行く）。
  }
  if (!(await awaitSlot(env, "dlsite", priority, maxWaitMs))) return null;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "user-agent": UA, cookie: "adultchecked=1" },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  // llms.txt: 400/401/403/404 は再試行しない。404（検索語が URL として不正など）は「無い」で確定、
  // 403 は締め出しの可能性があるので未確定のまま（キャッシュに「無い」を残さない）。
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {});
    return "";
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  const text = await res.text().catch(() => null);
  if (text === null) return null;
  try {
    await cache?.put(key, new Response(text, { headers: { "cache-control": `public, max-age=${CACHE_TTL_S}` } }));
  } catch {
    // 入らなくても次に取り直すだけ。
  }
  return text;
}

async function search(env: Env, keyword: string, priority: Priority, maxWaitMs?: number): Promise<Item[] | null> {
  // 空白は "+" で区切る（"%20" だと 403）。robots.txt が許しているのは page/1/ だけなので 1 ページ（100 件）。
  const kw = keyword.split(/\s+/).filter(Boolean).map(encodeURIComponent).join("+");
  if (!kw) return [];
  const html = await cachedGet(env, `${BASE}/fsr/=/language/jp/keyword/${kw}/per_page/100/page/1/`, priority, maxWaitMs);
  return html === null ? null : parseResults(html);
}

/** 作品がアフィリエイト可か（product/info/ajax の affiliate_deny）。null = 未確定。 */
async function affiliateAllowed(env: Env, id: string, priority: Priority, maxWaitMs?: number): Promise<boolean | null> {
  const text = await cachedGet(env, `${BASE}/product/info/ajax?product_id=${id}&cdn_cache_min=1`, priority, maxWaitMs);
  if (text === null) return null;
  try {
    const j = JSON.parse(text)?.[id];
    return !!j && Number(j.affiliate_deny) === 0;
  } catch {
    return null;
  }
}

/** 1 巻を DLsite で引く。
 *   - { cover: URL }      確定（書名・巻・著者が一致し、アフィリエイト可）
 *   - { titleOnly: URL }  書名だけ一致（管理画面の候補行き）
 *   - { cover: "", titleOnly: "" }  DLsite に無い（確定）
 *   - null                未確定（枠が取れない・エラー）。キャッシュしないこと。
 *  `deadline` は呼び出し全体の締め切り（epoch ms）。書名で引いて確定しなければ最初の著者名で
 *  引き直す（シリーズ名と DLsite の題名がずれている作品向け）ので、1 巻で最大 3 リクエスト。 */
export async function dlsiteResolve(
  env: Env,
  v: DlsiteVolume,
  priority: Priority,
  deadline: number,
): Promise<DlsiteMatch | null> {
  const left = (): number => deadline - Date.now();
  const none: DlsiteMatch = { cover: "", titleOnly: "" };
  const title = mainTitle(v.series);
  if (!title) return none;

  let items = await search(env, title, priority, left());
  if (items === null) return null;
  let m = judge(v, items);
  const firstAuthor = String(v.creators_norm || "").split("|")[0];
  if ((!m || m.level !== "strict") && firstAuthor) {
    items = await search(env, firstAuthor, priority, left());
    if (items === null) return null;
    const m2 = judge(v, items);
    if (m2 && (!m || m2.level === "strict")) m = m2;
  }
  if (!m) return none;
  if (m.level === "titleOnly") return { cover: "", titleOnly: m.hit.img };

  const ok = await affiliateAllowed(env, m.hit.id, priority, left());
  if (ok === null) return null;
  // アフィリエイト不可の作品は表紙も使わない（画像の利用はアフィリエイトの枠内で認められている）。
  return ok ? { cover: m.hit.img, titleOnly: "" } : none;
}

/** ISBN → 照合用の書誌。成年向けの巻だけ（DLsite の成年コミックのフロアに全年齢の作品は無いので、
 *  引いても枠を使うだけ）。返らなかった ISBN は DLsite に無いものとして扱ってよい。 */
export async function dlsiteVolumes(env: Env, isbns: string[]): Promise<Map<string, DlsiteVolume>> {
  const out = new Map<string, DlsiteVolume>();
  if (!isbns.length) return out;
  const res = await env.DB.prepare(
    `SELECT v.isbn, COALESCE(s.name, v.title) AS series, COALESCE(v.volume_number, '') AS volume_number,
            COALESCE(v.creators_norm, '') AS creators_norm, COALESCE(v.publisher, '') AS publisher
       FROM volumes v LEFT JOIN series s ON s.id = v.series_id
      WHERE v.is_adult = 1 AND v.isbn IN (SELECT value FROM json_each(?))`
  )
    .bind(JSON.stringify(isbns))
    .all<DlsiteVolume>();
  for (const r of res.results ?? []) out.set(r.isbn, r);
  return out;
}
