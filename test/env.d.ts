import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_SCHEMA: D1Migration[];
    }
  }
}
