// 公序良俗・誹謗中傷に該当する自由入力（owner_name / item.comment）を弾くための
// NG ワードフィルタ。文脈判断が要る本格的な検閲は AI（Workers AI の Llama Guard）に
// 寄せる想定だが、まずは正規表現ベースの単純な語句照合で運用する。
//
// TODO(検閲): 取りこぼし・誤検知が増えてきたら Workers AI @cf/meta/llama-guard-3-8b に
//   移行する。維持費は 1 日 1 万 Neuron まで無料 ≒ 1 日 450 投稿までは実質 0 円。

// 照合する語句。全角/半角・大文字小文字・区切り文字の違いは normalize() が吸収するので、
// ここには代表的な表記を 1 つ入れれば足りる。運用しながら随時足していく。
const NG_WORDS: string[] = [
  // 誹謗中傷・侮辱
  "死ね",
  "殺す",
  "殺害",
  "自殺しろ",
  "消えろ",
  "きもい",
  "気持ち悪い",
  "うざい",
  "ブス",
  "デブ",
  "馬鹿",
  "アホ",
  "クズ",
  "ゴミ",
  "カス",
  "無能",
  "低能",
  // 差別・ヘイト
  "きちがい",
  "気違い",
  "土人",
  // 性的・卑猥（公序良俗）
  "セックス",
  "セフレ",
  "ちんこ",
  "ちんぽ",
  "まんこ",
  // 英字だけの入力欄（独自 URL の slug）向けのローマ字・英語表記。
  "fuck",
  "chinko",
  "chinpo",
  "manko",
  "kichigai",
];

// NFKC で全角→半角を寄せ、英字は小文字化、カタカナ→ひらがなに寄せ、そのうえで区切りに
// 使われがちな空白・中黒・記号を除去する。「き も い」「ｷﾓｲ」「キモイ」「k i m o i」の
// ような回避をある程度潰すため。NFKC を先にかけることで半角カナも全角カタカナに揃い、
// katakanaToHiragana でひらがなに寄る。
function katakanaToHiragana(text: string): string {
  return text.replace(/[ァ-ヶ]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0x60)
  );
}

function normalize(text: string): string {
  return katakanaToHiragana(text.normalize("NFKC").toLowerCase()).replace(
    /[\s　・･.,、。!！?？\-_~=+*"'`|/\\()\[\]{}<>@#$%^&:;]/g,
    ""
  );
}

const NORMALIZED_NG_WORDS = NG_WORDS.map(normalize).filter((w) => w.length > 0);

/** 最初に一致した NG ワード（正規化前の表記）を返す。無ければ null。 */
export function findNgWord(text: string): string | null {
  if (!text) return null;
  const normalized = normalize(text);
  for (let i = 0; i < NORMALIZED_NG_WORDS.length; i++) {
    if (normalized.includes(NORMALIZED_NG_WORDS[i])) return NG_WORDS[i];
  }
  return null;
}

/** owner_name・ひとこと（bio）と各コメントを走査し、NG ワードを含む場合は日本語のエラーメッセージを返す。
 *  問題なければ null。NG ワード自体はエラー文に含めない（画面にそのまま出さない）。 */
export function checkListContent(
  owner_name: string,
  bio: string,
  comments: string[]
): string | null {
  if (findNgWord(owner_name)) return "お名前に不適切な表現が含まれています";
  if (findNgWord(bio)) return "ひとことに不適切な表現が含まれています";
  for (let i = 0; i < comments.length; i++) {
    if (findNgWord(comments[i])) {
      return `${i + 1}番目の作品のコメントに不適切な表現が含まれています`;
    }
  }
  return null;
}
