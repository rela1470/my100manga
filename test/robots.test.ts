import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { robotsTxt, sitemapXml, SITEMAP_PATHS } from "../src/robots";

// robots.txt と sitemap.xml は静的ファイルではなく Worker が配信時のオリジンから組む
// （本家と R18版で同じコードを使うため。src/robots.ts）。

describe("robots.txt / sitemap.xml", () => {
  it("robots.txt の Sitemap 行はリクエストのオリジンを指す", async () => {
    const res = await SELF.fetch("https://example.com/robots.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("Sitemap: https://example.com/sitemap.xml");
    expect(body).toContain("Disallow: /admin");
    expect(body).toContain("Disallow: /api/");
    expect(body).not.toContain("my100manga.com");
  });

  it("sitemap.xml は公開ページをリクエストのオリジンで並べる", async () => {
    const res = await SELF.fetch("https://example.com/sitemap.xml");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("xml");
    const body = await res.text();
    for (const p of SITEMAP_PATHS) expect(body).toContain(`<loc>https://example.com${p}</loc>`);
    expect(body).toContain("<loc>https://example.com/circulation</loc>");
    expect(body).not.toContain("my100manga.com");
  });

  it("別のホストで引けばそのホストで返る（R18版は別ドメインの同じコード）", async () => {
    const [robots, sitemap] = await Promise.all([
      SELF.fetch("https://r18.example.com/robots.txt").then((r) => r.text()),
      SELF.fetch("https://r18.example.com/sitemap.xml").then((r) => r.text()),
    ]);
    expect(robots).toContain("Sitemap: https://r18.example.com/sitemap.xml");
    expect(sitemap).toContain("<loc>https://r18.example.com/</loc>");
  });
});

describe("R18版の robots.txt", () => {
  it("全年齢のデータ源によるランキングは sitemap に載せない", () => {
    const xml = sitemapXml("https://r18.example.com", { SITE_VARIANT: "adult" });
    expect(xml).toContain("<loc>https://r18.example.com/lists</loc>");
    expect(xml).not.toContain("/sales-ranking");
    expect(xml).not.toContain("/circulation");
    expect(sitemapXml("https://my100manga.test", { SITE_VARIANT: "general" })).toContain("/circulation");
  });

  it("年齢確認ゲートの画面は拾わせない（本家には出ない行）", () => {
    const adult = { SITE_VARIANT: "adult" };
    expect(robotsTxt("https://r18.example.com", adult)).toContain("Disallow: /age-gate");
    expect(robotsTxt("https://my100manga.test", { SITE_VARIANT: "general" })).not.toContain("/age-gate");
  });
});
