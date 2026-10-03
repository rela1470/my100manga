import { Env } from "./types";

// 成年向け（アダルト）作品の除外。このサイトは全年齢向けなので、MADB 由来の巻（月次取り込み
// scripts/ingest.mjs・ライブ検索/補完 src/madbLive.ts）から成年コミックを外す。
//
// 判定は MADB の明示的なメタデータだけを使う（誤検出を避けるため保守的に）:
//   ・schema:contentRating … NDL 由来の「成年コミック」（ほかに「成年コミックス」「成人コミック」
//     「成年向けコミックス」の表記揺れ）。2026-09 のダンプで 40.4 万巻中 8,317 巻。
//   ・schema:description … 「… / 成年コミック」と末尾に書かれているもの（取り込みのみ。rating
//     が空で description にだけあるのは 3 巻）。
// 楽天・Yahoo・楽天市場の ADULT 正規表現（src/rakuten.ts 等）のような書名・出版社の文字列照合は
// MADB には使わない。書名に「成人」「官能」「R-18」「18禁」を含む巻は 137 件あったが、
// 『R-18』(Cheese!フラワーコミックス)『カノジョは官能小説家』(ヤングガンガン)『少年少女18禁』
// 『未成年』『平成人間博覧会』など一般向けが多く混ざるため。レーベル単位の推定（成年の比率が
// 高いレーベルを丸ごと外す）も、増えるのは 58 巻だけで一般向けと共用のレーベル名（Heart comics
// 等）を巻き込むので採らない。
// scripts/ingest.mjs の ADULT_RATING / ADULT_DESCRIPTION と揃えること（node から TS を読めないので複製）。

/** schema:contentRating の値が成年向けか。「未成年」は成年向けではない。 */
export const ADULT_RATING = /(?<!未)成年|成人/;

/** SPARQL の WHERE 内に置く、`book` 変数の巻が成年向けなら落とすフィルタ（ADULT_RATING と同じ判定）。 */
export function sparqlNotAdult(book: string): string {
  return `FILTER NOT EXISTS {
    ${book} schema:contentRating ?adultRating .
    FILTER((CONTAINS(STR(?adultRating), "成年") && !CONTAINS(STR(?adultRating), "未成年"))
           || CONTAINS(STR(?adultRating), "成人"))
  }`;
}

// ── 追加の拒否（adult_volumes）──────────────────────────────────────────────
// 取り込みで外した成年向けの巻は scripts/ingest.mjs が adult_volumes に記録する。検索で単に
// 「見つからない」にすると利用者が迷うので、ISBN 検索・巻の手動追加・公開ではこの表を引いて、
// 成年向けだから追加できないと明示する。

/** 成年向けの作品を追加しようとしたときの文言。成年向けは別サイトで扱う予定なので「こちら側のサイトでは」。
 *  検索結果の表示では public/app.js がこの部分を太字にする（ADULT_EMPHASIS と揃えること）。 */
export const ADULT_BLOCK_MESSAGE = "成年向けの作品は、こちら側のサイトでは追加できません。";

/** 書名を添えた拒否文言（「成年向けの作品は、こちら側のサイトでは追加できません。（『パーガトリー』）」）。
 *  基本の文言をそのまま先頭に置く（画面・テストで文言を照合できるように）。書名が無ければ基本の文言だけ。 */
export function adultBlockMessage(title?: string): string {
  const t = (title ?? "").trim();
  return t ? `${ADULT_BLOCK_MESSAGE}（『${t}』）` : ADULT_BLOCK_MESSAGE;
}

/** isbns（ISBN13）のうち adult_volumes にあるものを ISBN → 書名で返す。1 文で引く（ISBN 群は
 *  JSON の 1 パラメータ。D1 のバインド数上限に当たらない）。表が無い（db/add-adult-volumes.sql
 *  未適用）ときは空を返し、検索・公開そのものは止めない。 */
export async function findAdultIsbns(env: Env, isbns: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniq = [...new Set(isbns.filter(Boolean))];
  if (!uniq.length) return out;
  try {
    const res = await env.DB.prepare(
      `SELECT isbn, title FROM adult_volumes WHERE isbn IN (SELECT value FROM json_each(?))`
    )
      .bind(JSON.stringify(uniq))
      .all<{ isbn: string; title: string }>();
    for (const r of res.results ?? []) out.set(r.isbn, r.title);
  } catch (err) {
    console.error("adult_volumes lookup failed", err);
  }
  return out;
}

/** 正規化済みの検索語（searchKey）を書名に含む成年向けの巻があるか。'%q%' の LIKE で索引は
 *  効かないが、表は約 8 千行で 1 件見つかれば止まる。検索結果の下に注記を出すかの判定用。 */
export async function hasAdultTitleMatch(env: Env, likePattern: string): Promise<boolean> {
  try {
    const row = await env.DB.prepare(
      `SELECT 1 AS hit FROM adult_volumes WHERE title_norm LIKE ? ESCAPE '\\' LIMIT 1`
    )
      .bind(likePattern)
      .first<{ hit: number }>();
    return !!row;
  } catch (err) {
    console.error("adult_volumes title lookup failed", err);
    return false;
  }
}
