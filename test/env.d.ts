import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_SCHEMA: D1Migration[];
      // 3 か所に複製されているサジェスト構築 SQL の突き合わせ用（vitest.config.mts が読む）。
      TEST_SUGGEST_SQL_INGEST: string[];
      TEST_SUGGEST_SQL_FILE: string;
    }
  }
}
