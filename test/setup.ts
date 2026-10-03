import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";

// テストファイルごとに空の D1 へ db/schema.sql を流す（vitest.config.mts が TEST_SCHEMA に渡す）。
await applyD1Migrations(env.DB, env.TEST_SCHEMA);

// 同じファイル内のテストは D1 を共有するので、リスト関連のユーザデータは毎回空にする。
beforeEach(async () => {
  await env.DB.batch(
    ["lists", "list_views", "list_view_seen", "list_item_events", "publish_audit"].map((t) => env.DB.prepare(`DELETE FROM ${t}`))
  );
});
