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
    const res = await fetchSiteAsset(new Request("https://my100shunga.test/about"), adult, "/about");
    expect(res.status).toBe(200);
    expect((await res.text()).toLowerCase()).toContain("<!doctype html>");
  });

  it("/adult/… は直接引けない（URL を 1 本に保つ）", async () => {
    const res = await SELF.fetch("https://example.com/adult/terms");
    expect(res.status).toBe(404);
  });
});
