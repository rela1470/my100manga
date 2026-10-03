import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("共通ヘッダー", () => {
  for (const path of ["/", "/ranking", "/sales-ranking", "/lists", "/about", "/terms", "/privacy", "/operator", "/books-guide"]) {
    it(`${path} にみんなのリスト・売上ランキングのボタンが入り、プレースホルダが残らない`, async () => {
      const res = await SELF.fetch(`https://example.com${path}`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(`href="/lists"`);
      expect(html).toContain(`href="/sales-ranking"`);
      expect(html).not.toMatch(/<!--(HEADER_LINKS|RANK_SWITCH|FOOTER|FOOTER_AFF|ANALYTICS|GTM_BODY)-->/);
    });
  }

  it("ランキングのタブが差し込まれ、現在地に active が付く", async () => {
    const html = await (await SELF.fetch("https://example.com/ranking")).text();
    expect(html).toContain(`class="rank-switch"`);
    expect(html).toContain(`<a href="/ranking" class="active">`);
    expect(html).toContain(`href="/circulation"`);
  });

  it("管理画面には差し込まない（内部ツール）", async () => {
    const res = await SELF.fetch("https://example.com/admin.html");
    expect(await res.text()).not.toContain(`class="header-link"`);
  });
});
