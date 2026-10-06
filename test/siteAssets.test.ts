import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { adultAssetPath, fetchSiteAsset, overridable } from "../src/siteAssets";
import type { Env } from "../src/types";

// R18版の静的ファイル差し替え（public/adult/、src/siteAssets.ts）。テストの Worker は本家で
// 動くので、R18版は env を差し替えて関数単位で見る。

const general = env as unknown as Env;
const adult = { ...general, SITE_VARIANT: "adult" } as Env;

describe("R18版の静的ファイル差し替え", () => {
  it("本家では差し替えない", () => {
    for (const path of ["/", "/terms", "/about.html", "/og-default.png"]) {
      expect(adultAssetPath(general, path)).toBeNull();
    }
  });

  it("R18版は HTML と顔まわりの画像だけ public/adult/ を見る", () => {
    expect(adultAssetPath(adult, "/")).toBe("/adult/index.html");
    expect(adultAssetPath(adult, "/terms")).toBe("/adult/terms");
    expect(adultAssetPath(adult, "/about.html")).toBe("/adult/about.html");
    expect(adultAssetPath(adult, "/og-default.png")).toBe("/adult/og-default.png");
    expect(adultAssetPath(adult, "/favicon.ico")).toBe("/adult/favicon.ico");
    // 種別で変わらないもの（css/js/フォント/画像）は余計に引かない。拡張子を持たないパスは
    // 差し替え対象になるが、/cover のような Worker のルートはここへ来る前に処理される。
    for (const path of ["/styles.css", "/app.js", "/fonts/NotoSansJP-Bold-subset.otf", "/operator-cats.jpg"]) {
      expect(overridable(path)).toBe(false);
      expect(adultAssetPath(adult, path)).toBeNull();
    }
    // 差し替え先を二重に辿らない
    expect(adultAssetPath(adult, "/adult/terms")).toBeNull();
  });

  it("public/adult/ に無ければ本家のファイルを返す", async () => {
    // /operator は本文がほぼ同じなので差し替えを置いていない（docs/r18.md 4 節）。
    const res = await fetchSiteAsset(new Request("https://r18.example.com/operator"), adult, "/operator");
    expect(res.status).toBe(200);
    expect((await res.text()).toLowerCase()).toContain("<!doctype html>");
  });

  it("public/adult/ にあれば R18版の本文を返す", async () => {
    for (const path of ["/about", "/terms", "/privacy", "/books-guide"]) {
      const res = await fetchSiteAsset(new Request(`https://r18.example.com${path}`), adult, path);
      expect(res.status, path).toBe(200);
      const html = await res.text();
      // 購入リンク・アフィリエイト・外部ストアの表紙は R18版には無い（src/site.ts commerce: false）。
      expect(html, path).not.toContain("楽天");
      expect(html, path).not.toContain("バリューコマース");
      expect(html, path).not.toContain("メルカリ");
      // 本家の同じパスには残っている（差し替えが効いていることの裏取り）。
      const base = await fetchSiteAsset(new Request(`https://my100manga.test${path}`), general, path);
      expect(await base.text(), path).toContain("アフィリエイト");
    }
  });

  it("R18版は成年向けを登録できると書いてある（本家は禁止と書いてある）", async () => {
    const r18 = await (await fetchSiteAsset(new Request("https://x.test/books-guide"), adult, "/books-guide")).text();
    const base = await (await fetchSiteAsset(new Request("https://y.test/books-guide"), general, "/books-guide")).text();
    expect(r18).toContain("成年向け（成人向け）のマンガ単行本も対象です");
    expect(r18).not.toContain("登録・掲載できません");
    expect(base).toContain("登録・掲載できません");
  });

  it("/adult/… は直接引けない（URL を 1 本に保つ）", async () => {
    const res = await SELF.fetch("https://example.com/adult/terms");
    expect(res.status).toBe(404);
  });
});
