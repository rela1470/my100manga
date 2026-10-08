import type { RakutenRateLimiter } from "./ratelimiter";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  // Per-deploy version stamp (Cloudflare version_metadata binding). `id` changes on
  // every deploy; we surface it to the HTML (script `?v=` + <meta app-version>) and
  // /api/version so an open SPA tab can detect a new deploy and prompt a reload.
  // Optional so local/misconfigured envs degrade to an unversioned "dev" stamp.
  CF_VERSION?: { id: string; tag?: string };
  // Trimmed-cover store. /cover materialises Yahoo square covers (white bars cut)
  // here once, keyed by a hash of the source URL, so every later view is served
  // from R2/edge instead of re-trimming. Optional so envs without the binding
  // degrade to serving the original (untrimmed) image.
  COVERS?: R2Bucket;
  // Global 1 req/s coordinator. A generic spacer DO (named historically after
  // Rakuten); src/yahoo.ts reuses it under a separate "yahoo" instance so the two
  // APIs pace independently. Optional so local tests / misconfigured envs degrade
  // to "no pacing" rather than crashing.
  RAKUTEN_LIMITER?: DurableObjectNamespace<RakutenRateLimiter>;
  // Rakuten Books (楽天ブックス書籍検索API) — cover fallback when Google has none.
  // APP_ID/ACCESS_KEY are secrets (.dev.vars locally, `wrangler secret put` in prod);
  // the fallback is skipped when they are unset. REFERER must match the site URL
  // registered in the Rakuten app (the new openapi gateway rejects other referrers).
  RAKUTEN_APP_ID?: string;
  RAKUTEN_ACCESS_KEY?: string;
  RAKUTEN_REFERER?: string;
  // Yahoo!ショッピング 商品検索API の Client ID (appid). Tier 2 cover source behind
  // Rakuten: exact-ISBN via jan_code, free, no sales gate. Secret (.dev.vars locally,
  // `wrangler secret put` in prod); the fallback is skipped when unset. See src/yahoo.ts.
  YAHOO_APP_ID?: string;
  // Google Books cover source toggle. Off unless "true"/"1" — Rakuten is primary;
  // Google stays implemented but dormant. See covers.ts googleEnabled.
  GOOGLE_ENABLED?: string;
  // User-submitted cover URL toggle. Off unless "true"/"1". The "表紙を変更 →
  // 画像URLを直接指定" flow lets an accountless visitor post an arbitrary image URL
  // into the admin review queue (and, on approve, the global covers cache) — too
  // high a vandalism risk, so it's dormant by default. Code stays wired up for a
  // possible later re-enable. See corrections.ts coverSuggestionsEnabled.
  COVER_SUGGESTIONS_ENABLED?: string;
  // Affiliate identifiers for the "購入" links on the view page. Public (they
  // show up in the outbound URLs), so they live in wrangler.jsonc vars, not
  // secrets. Empty/unset → links are built without a referral tag.
  AMAZON_ASSOCIATE_TAG?: string;
  RAKUTEN_AFFILIATE_ID?: string;
  // メルカリアンバサダーの afid。中古（絶版）の受け皿として検索リンクに付ける。
  MERCARI_AFID?: string;
  // Yahoo!ショッピング（バリューコマース）の自由テキストリンクの sid / pid。
  // ck.jp.ap.valuecommerce.com/servlet/referral?sid=…&pid=…&vc_url=<商品URL> で包む。
  YAHOO_VC_SID?: string;
  YAHOO_VC_PID?: string;
  // 人気傾向の計測（Analytics Engine）。writeDataPoint はノンブロッキングで課金も安く、
  // サンプリングは AE 側が自動でやる。バインディング未設定でも落ちないよう optional。
  // 集計は Cloudflare の SQL API 経由（管理画面表示は後で実装）。see src/popularity.ts
  POPULARITY?: AnalyticsEngineDataset;
  // admin 認証（Cloudflare Access）。src/adminAuth.ts で /admin・/api/admin/* をガード。
  // TEAM_DOMAIN は "xxx.cloudflareaccess.com"（スキームなし）、AUD は Access アプリの
  // Application Audience タグ、ADMIN_EMAILS は許可メール（カンマ区切り）。未設定なら
  // fail-closed で 403。ADMIN_DEV_BYPASS は .dev.vars のみで "true"、ローカル dev 用の抜け道。
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ADMIN_EMAILS?: string;
  ADMIN_DEV_BYPASS?: string;
  // ユーザの Google ログイン（任意、src/auth.ts）。Google Cloud の OAuth クライアント
  // （ウェブアプリ）の値。リダイレクト URI は <origin>/auth/google/callback を登録する。
  // secret で注入し、未設定ならログインボタンを出さない（匿名作成はそのまま使える）。
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  // 開発ツール（admin 画面の「DB初期化」）の有効化フラグ。"true" で有効。ADMIN_DEV_BYPASS
  // とは別物で認証はバイパスしない（エンドポイントは requireAdmin の配下のまま）ので、本番で
  // も管理者だけが使える。開発期間中のみ本番 vars に "true" を置き、正式リリース時に外す想定。
  // ローカル dev では ADMIN_DEV_BYPASS="true" でも有効になる（下の devToolsEnabled 参照）。
  DEV_TOOLS?: string;
  // CSP の効かせ方（src/util.ts cspMode）。未設定 = enforce。本番で広告や計測が止まったとき
  // すぐ巻き戻せるよう、var ではなく secret で入れる想定:
  //   echo report | npx wrangler secret put CSP_MODE   … Report-Only（ブロックしない）
  //   echo off    | npx wrangler secret put CSP_MODE   … 最小の CSP に戻す
  CSP_MODE?: string;
  // Google タグ（src/analytics.ts）。HTML ページの <!--ANALYTICS-->（head）と
  // <!--GTM_BODY-->（body 冒頭の noscript）に注入する。ADSENSE_CLIENT は AdSense の
  // パブリッシャ ID（"ca-pub-..."）、GTM_CONTAINER_ID は Google タグマネージャの
  // コンテナ ID（"GTM-..."）。どちらも公開値なので secret ではなく wrangler.jsonc vars。
  // 空/未設定ならそのタグは出力しない（admin はプレースホルダ無しで常に素通り）。
  ADSENSE_CLIENT?: string;
  GTM_CONTAINER_ID?: string;
  // ボット確認（Cloudflare Turnstile, src/turnstile.ts）。SITE_KEY は公開値なので vars、
  // SECRET は secret で注入する。両方未設定なら無効（ローカル dev 等）、片方だけなら fail-closed。
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
  // 公開書き込み系の濫用よけ（src/ratelimit.ts）。RL_WRITE は POST/PUT の書き込み全般、
  // RL_COVERS は外部 API や重いクエリを叩くもの用、RL_HEAVY はさらに重いもの（/api/live-search）用。
  // binding 未設定なら fail-open。
  RL_WRITE?: RateLimit;
  RL_COVERS?: RateLimit;
  RL_HEAVY?: RateLimit;
  // 閲覧ビーコン（src/publicLists.ts）のキュー。consumer が 100 件ずつまとめて D1 に書く。
  // 未設定（ローカル・キュー未作成）ならビーコンのたびにその場で書く。
  VIEW_QUEUE?: Queue<ViewJob>;
  // 共有画像（src/shareImage.ts）の事前生成キュー。リストの作成/更新で {slug, host} を積み、
  // consumer（src/index.ts queue）が full/q1–q4 を 1 枚ずつ R2 に描いておく（og は公開時に
  // waitUntil で描く）。未設定（ローカル・キュー未作成）なら og だけ。
  SHARE_QUEUE?: Queue<ShareJob>;
  // サイトの種別（src/site.ts）。"general"（本家・既定）か "adult"（R18版）。公開値なので vars。
  // 未設定・不明な値は本家扱い（成年向けを除外する側に倒す）。
  SITE_VARIANT?: string;
  // 日次 Cron で売上ランキングを取るか（src/index.ts salesRankingCronEnabled）。"true" のときだけ。
  // vars は env に継承されないので、本家の本番の vars にだけ書く。
  SALES_RANKING_CRON?: string;
}

/** VIEW_QUEUE のメッセージ（閲覧ビーコン 1 件）。visitor は IP + 日付のハッシュ、userId は
 *  ログイン中の閲覧者（所有者本人を数えないための照合用）。 */
export interface ViewJob {
  slug: string;
  day: string;
  visitor: string;
  userId: string | null;
}

/** SHARE_QUEUE のメッセージ。host は画像のヘッダーに印字するリスト URL のホスト。 */
export interface ShareJob {
  slug: string;
  host: string;
  /** 積んだ時点のリストの updated_at。consumer はこれより新しい版があれば捨てる（後続のメッセージが描く）。
   *  押した人が待っている要求時生成（/api/share-prepare）では付けない（捨てられると誰も描き直さない）。 */
  updated_at?: number;
  /** 描く variant（src/shareImage.ts の ShareVariant）。省略時は全部。 */
  variants?: string[];
}

export interface Book {
  isbn: string;
  title: string;
  author: string;
  publisher: string;
  pubdate: string;
  cover_url: string;
}

/** What lists.items_json stores per book: only the owner's own input. Title, author
 *  and cover are site-wide data looked up by ISBN on read (src/listItems.ts). */
export interface StoredListItem {
  position: number;
  isbn: string; // ISBN13
  comment: string;
  spoiler: boolean;
}

/** A list item as served (API / view page): the stored item plus the resolved book. */
export interface ListItem extends StoredListItem {
  title: string;
  author: string;
  cover_url: string;
  series_title?: string; // シリーズの表示名（シリーズに属さない本は ""）
}

export interface MangaList {
  slug: string;
  owner_name: string;
  bio: string;
  items: ListItem[];
  unlisted: boolean;  // 限定公開: noindex にし、運営からの紹介対象にもしない (URL を知っていれば見られる)
  created_at: number;
  updated_at: number;
}
