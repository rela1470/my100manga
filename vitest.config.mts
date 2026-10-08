import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// テストは Workers ランタイム (Miniflare) 上で動かし、D1 はテストファイルごとに空のローカル DB を使う。
// 設定はリポジトリに入っている wrangler.jsonc.sample を読む（個人値入りの wrangler.jsonc は
// gitignore されていて手元にしか無いため）。拡張子で形式を判定するので .jsonc の名前で置き直す。
// DB には db/schema.sql を流す（test/setup.ts）。
const TEST_COMPAT_DATE = "2026-08-22";

export default defineConfig(async () => {
  // vitest-pool-workers 同梱の workerd は本番より古い compatibility_date までしか動かせない
  // ことがあるので、テスト用の写しでは日付を TEST_COMPAT_DATE に下げる。
  const configPath = resolve("wrangler.test.jsonc");
  writeFileSync(
    configPath,
    readFileSync("wrangler.jsonc.sample", "utf8").replace(
      /"compatibility_date":\s*"[^"]+"/,
      `"compatibility_date": "${TEST_COMPAT_DATE}"`
    )
  );
  const dir = mkdtempSync(join(tmpdir(), "my100manga-schema-"));
  cpSync("db/schema.sql", join(dir, "0000_schema.sql"));
  const schema = await readD1Migrations(dir);

  // サジェストの索引を作る SQL は、Worker（src/suggest.ts）・月次取り込み（scripts/ingest.mjs）・
  // migration（db/add-series-suggest.sql）の 3 か所に同じものがある。テストは Workers ランタイムで
  // 動いて node:fs が無いので、ここで読んで渡し、test/suggest.test.ts が突き合わせる。
  const { SUGGEST_SQL } = await import("./scripts/ingest.mjs");

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath },
        miniflare: {
          // .dev.vars の個人の鍵は使わない（外部 API を叩かない・Turnstile なし・admin バイパスなし）。
          bindings: {
            TEST_SCHEMA: schema,
            TEST_SUGGEST_SQL_INGEST: SUGGEST_SQL,
            TEST_SUGGEST_SQL_FILE: readFileSync("db/add-series-suggest.sql", "utf8"),
            RAKUTEN_APP_ID: "",
            RAKUTEN_ACCESS_KEY: "",
            YAHOO_APP_ID: "",
            GOOGLE_CLIENT_ID: "",
            GOOGLE_CLIENT_SECRET: "",
            TURNSTILE_SITE_KEY: "",
            TURNSTILE_SECRET: "",
            ADMIN_DEV_BYPASS: "",
            VIEW_HASH_SECRET: "test-view-hash-secret",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/setup.ts"],
    },
  };
});
