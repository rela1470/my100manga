import { Env } from "./types";

export type PopularityKind = "list" | "series" | "supplement";

// 人気傾向の計測イベントを 1 件打つ。Analytics Engine の writeDataPoint はノンブロッキング
// （await 不要・subrequest 数にも数えない）ので、応答経路を一切遅らせない。サンプリングは
// AE が書き込み負荷に応じて自動でかけるため、こちら側での間引きは不要。集計時は
// SUM(_sample_interval) で推定値に戻す。
//
// index1 にランキング対象キー（slug / series_id）、blob1 に種別、blob2 に表示用の名前を入れる。
// 名前は分かる場合だけ（list の owner_name 等）。無ければ空文字で、集計時に D1 と JOIN すればよい。
// バインディング未設定（AE 無しのローカル等）では黙って no-op。
export function bumpPopularity(
  env: Env,
  kind: PopularityKind,
  key: string,
  name = ""
): void {
  if (!env.POPULARITY || !key) return;
  env.POPULARITY.writeDataPoint({
    indexes: [key],
    blobs: [kind, name],
    doubles: [1],
  });
}
