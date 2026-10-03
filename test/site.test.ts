import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { findAdultIsbns, hasAdultTitleMatch, sparqlNotAdult } from "../src/adult";
import { applySiteIdentity } from "../src/analytics";
import { edgeCacheKey } from "../src/edgeCache";
import { footerHtml } from "../src/footer";
import { rankSwitchHtml } from "../src/rankSwitch";
import { site, siteVariant } from "../src/site";
import type { Env } from "../src/types";

// サイト種別（本家 / R18版, src/site.ts）の切り替え。テストの Worker は本家（SITE_VARIANT="general"）で
// 動くので、R18 版は env を差し替えて関数単位で見る。

const general = env as unknown as Env;
const adult = { ...general, SITE_VARIANT: "adult" } as Env;
const ADULT_ISBN = "9784814801381";

beforeAll(async () => {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO adult_volumes (isbn, title, title_norm, series_name) VALUES (?, ?, ?, ?)`
  )
    .bind(ADULT_ISBN, "パーガトリー", "パーガトリー", "パーガトリー")
    .run();
});

describe("サイト種別", () => {
  it("未設定・不明な値は本家（成年向けを除外する側）", () => {
    for (const v of [undefined, "", "r18", "ADULT"]) {
      expect(siteVariant({ SITE_VARIANT: v })).toBe("general");
      expect(site({ SITE_VARIANT: v }).excludeAdult).toBe(true);
    }
    expect(site(adult).variant).toBe("adult");
    expect(site(adult).excludeAdult).toBe(false);
  });

  it("本家の HTML は data-site だけ付き、表記は変えない", () => {
    const html = `<html lang="ja"><title>X | My 100 Manga</title><link rel="canonical" href="https://my100manga.com/about">`;
    const out = applySiteIdentity(html, general, "https://example.com");
    expect(out).toBe(html.replace(`<html lang="ja">`, `<html data-site="general" lang="ja">`));
  });

  it("R18 版はサイト名と本家ドメインを差し替える", () => {
    const html = `<html lang="ja"><title>X | My 100 Manga</title><link rel="canonical" href="https://my100manga.com/about">`;
    const out = applySiteIdentity(html, adult, "https://r18.example.com");
    expect(out).toContain(`<html data-site="adult" lang="ja">`);
    expect(out).toContain(`<title>X | ${site(adult).name}</title>`);
    expect(out).toContain(`href="https://r18.example.com/about"`);
    expect(out).not.toContain("my100manga.com");
  });

  it("フッターのサイト名が種別に従う", () => {
    expect(footerHtml(general)).toContain("© 2026 My 100 Manga");
    expect(footerHtml(adult)).toContain(`© 2026 ${site(adult).name}`);
  });

  it("エッジキャッシュのキーは種別ごとに分かれる", () => {
    expect(edgeCacheKey(general, "/api/search", { q: "a" }).url).not.toBe(
      edgeCacheKey(adult, "/api/search", { q: "a" }).url
    );
  });

  it("配信される HTML に data-site と window.__SITE__ が入る", async () => {
    const html = await (await SELF.fetch("https://example.com/about")).text();
    expect(html).toContain(`<html data-site="general"`);
    expect(html).toContain(`window.__SITE__={"variant":"general","name":"My 100 Manga","hashtag":"my100manga"}`);
  });
});

describe("R18 版では成年向けを拒否しない", () => {
  it("adult_volumes にあっても findAdultIsbns / hasAdultTitleMatch は何も返さない", async () => {
    expect((await findAdultIsbns(general, [ADULT_ISBN])).size).toBe(1);
    expect((await findAdultIsbns(adult, [ADULT_ISBN])).size).toBe(0);
    expect(await hasAdultTitleMatch(general, "%パーガトリー%")).toBe(true);
    expect(await hasAdultTitleMatch(adult, "%パーガトリー%")).toBe(false);
  });

  it("SPARQL の成年向けフィルタを外せる", () => {
    expect(sparqlNotAdult("?book")).toContain("FILTER NOT EXISTS");
    expect(sparqlNotAdult("?book", false)).toBe("");
  });
});

describe("ランキングのタブ（rank-switch）", () => {
  it("本家は 3 本、現在地に active が付く", () => {
    const html = rankSwitchHtml(general, "/sales-ranking");
    expect(html).toContain(`href="/ranking"`);
    expect(html).toContain(`<a href="/sales-ranking" class="active">`);
    expect(html).toContain(`href="/circulation"`);
    expect(html.match(/<a /g)).toHaveLength(3);
    // 拡張子付きで配信されても現在地が分かる
    expect(rankSwitchHtml(general, "/ranking.html")).toContain(`<a href="/ranking" class="active">`);
    // どのタブでもないパス（404 など）は active 無しで出すだけ
    expect(rankSwitchHtml(general, "/sales-rankings")).not.toContain("active");
    expect(rankSwitchHtml(general, "")).not.toContain("active");
  });

  it("R18版は全年齢のランキングが消えて 1 本になるので nav ごと出さない", () => {
    expect(rankSwitchHtml(adult, "/ranking")).toBe("");
  });
});
