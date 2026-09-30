import type { RakutenRateLimiter } from "./ratelimiter";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  // Global 1 req/s coordinator for Rakuten API calls. Optional so local tests /
  // misconfigured envs degrade to "no pacing" rather than crashing.
  RAKUTEN_LIMITER?: DurableObjectNamespace<RakutenRateLimiter>;
  // Rakuten Books (楽天ブックス書籍検索API) — cover fallback when Google has none.
  // APP_ID/ACCESS_KEY are secrets (.dev.vars locally, `wrangler secret put` in prod);
  // the fallback is skipped when they are unset. REFERER must match the site URL
  // registered in the Rakuten app (the new openapi gateway rejects other referrers).
  RAKUTEN_APP_ID?: string;
  RAKUTEN_ACCESS_KEY?: string;
  RAKUTEN_REFERER?: string;
  // Google Books cover source toggle. Off unless "true"/"1" — Rakuten is primary;
  // Google stays implemented but dormant. See covers.ts googleEnabled.
  GOOGLE_ENABLED?: string;
  // Affiliate identifiers for the "購入" links on the view page. Public (they
  // show up in the outbound URLs), so they live in wrangler.jsonc vars, not
  // secrets. Empty/unset → links are built without a referral tag.
  AMAZON_ASSOCIATE_TAG?: string;
  RAKUTEN_AFFILIATE_ID?: string;
  // メルカリアンバサダーの afid。中古（絶版）の受け皿として検索リンクに付ける。
  MERCARI_AFID?: string;
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
  // 公開書き込み系の濫用よけ（src/ratelimit.ts）。RL_WRITE は POST/PUT の書き込み全般、
  // RL_COVERS は表紙解決（外部 API を叩く /api/covers）用。binding 未設定なら fail-open。
  RL_WRITE?: RateLimit;
  RL_COVERS?: RateLimit;
}

export interface Book {
  isbn: string;
  title: string;
  author: string;
  publisher: string;
  pubdate: string;
  cover_url: string;
}

export interface ListItem {
  position: number;
  isbn: string;
  title: string;
  author: string;
  cover_url: string;
  comment: string;
  spoiler: boolean;
}

export interface MangaList {
  slug: string;
  owner_name: string;
  items: ListItem[];
  created_at: number;
  updated_at: number;
}
