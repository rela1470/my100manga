import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { findAdultIsbns, hasAdultTitleMatch, sparqlNotAdult } from "../src/adult";
import { applySiteIdentity } from "../src/analytics";
import { edgeCacheKey } from "../src/edgeCache";
import { footerHtml } from "../src/footer";
import { affIds, analyticsTags } from "../src/analytics";
import { rakutenReady } from "../src/rakuten";
import { yahooReady } from "../src/yahoo";
import { rankSwitchHtml } from "../src/rankSwitch";
import { brandHtml, commerceEnabled, site, siteVariant } from "../src/site";
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

  it("要素で割れた見出しのブランド表記も差し替える", () => {
    // public/*.html の <h1> は My <span class="accent">100</span> Manga の形で直書きしてある。
    const html = `<html lang="ja"><h1><a class="site-logo" href="/">My <span class="accent">100</span> Manga</a></h1>`;
    const out = applySiteIdentity(html, adult, "https://r18.example.com");
    expect(out).toContain(`My <span class="accent">100</span> Shunga`);
    expect(out).not.toContain("Manga");
    // 本家は素通り。
    expect(applySiteIdentity(html, general, "https://example.com")).toContain(
      `My <span class="accent">100</span> Manga`
    );
    // 数字だけがアクセント色。
    expect(brandHtml("My 100 Shunga")).toBe(`My <span class="accent">100</span> Shunga`);
  });

  it("配信される全ページの見出しに本家のブランド表記が残らない", async () => {
    for (const path of ["/", "/about", "/books-guide", "/terms", "/privacy", "/operator", "/lists", "/ranking"]) {
      const res = await SELF.fetch(`https://example.com${path}`);
      const adultHtml = applySiteIdentity(await res.text(), adult, "https://my100shunga.com");
      expect(adultHtml, path).not.toContain(brandHtml("My 100 Manga"));
      expect(adultHtml, path).not.toContain("My 100 Manga");
    }
  });

  it("R18 版は問い合わせ窓口の mailto も差し替える", () => {
    const html =
      `<html lang="ja"><a href="mailto:info@my100manga.com">info@my100manga.com</a>` +
      `<a href="mailto:abuse@my100manga.com">abuse@my100manga.com</a>`;
    // 窓口は配信オリジンではなく mailDomain（dev でも本番ドメイン）。
    const out = applySiteIdentity(html, adult, "https://dev.my100shunga.com");
    expect(out).toContain(`href="mailto:info@${site(adult).mailDomain}"`);
    expect(out).toContain(`href="mailto:abuse@${site(adult).mailDomain}"`);
    expect(out).not.toContain("my100manga.com");
    expect(out).not.toContain("@dev.my100shunga.com");
    // 本家は素通り。
    expect(applySiteIdentity(html, general, "https://example.com")).toContain("mailto:info@my100manga.com");
  });

  it("配信される利用規約・プライバシー・運営者に本家の窓口が残らない", async () => {
    for (const path of ["/terms", "/privacy", "/operator"]) {
      const res = await SELF.fetch(`https://example.com${path}`);
      const adultHtml = applySiteIdentity(await res.text(), adult, "https://my100shunga.com");
      expect(adultHtml, path).not.toContain("my100manga.com");
      expect(adultHtml, path).toContain(`@${site(adult).mailDomain}`);
    }
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
    expect(html).toContain(
      `window.__SITE__={"variant":"general","name":"My 100 Manga","hashtag":"my100manga","commerce":true,"adultOnlySearch":false}`
    );
  });
});

describe("R18 版は外部ストアの API・アフィリエイトを使わない（commerce: false）", () => {
  // 鍵が入っていても呼ばない、を確かめたいので env に値を足した版で見る。
  const withKeys = {
    RAKUTEN_APP_ID: "x",
    RAKUTEN_ACCESS_KEY: "y",
    YAHOO_APP_ID: "z",
    AMAZON_ASSOCIATE_TAG: "tag-22",
    RAKUTEN_AFFILIATE_ID: "rid",
    MERCARI_AFID: "mid",
    YAHOO_VC_SID: "sid",
    YAHOO_VC_PID: "pid",
  };
  const generalKeys = { ...general, ...withKeys } as Env;
  const adultKeys = { ...adult, ...withKeys } as Env;

  it("表紙ソース（楽天 / Yahoo）は鍵があっても R18 版では無効", () => {
    expect(commerceEnabled(general)).toBe(true);
    expect(commerceEnabled(adult)).toBe(false);
    expect(rakutenReady(generalKeys)).toBe(true);
    expect(yahooReady(generalKeys)).toBe(true);
    expect(rakutenReady(adultKeys)).toBe(false);
    expect(yahooReady(adultKeys)).toBe(false);
  });

  it("アフィリエイト ID を配らない", () => {
    expect(affIds(generalKeys).amazon).toBe("tag-22");
    expect(Object.values(affIds(adultKeys)).every((v) => v === "")).toBe(true);
  });

  it("フッターから楽天 / Yahoo のクレジットと PR 注記が消え、MADB の加工表記が残る", () => {
    const base = footerHtml(general, true);
    const r18 = footerHtml(adult, true);
    expect(base).toContain("Supported by Rakuten Developers");
    expect(base).toContain("Webサービス by Yahoo! JAPAN");
    expect(base).toContain("アフィリエイト広告（PR）");
    expect(r18).not.toContain("Rakuten");
    expect(r18).not.toContain("Yahoo");
    expect(r18).not.toContain("アフィリエイト");
    expect(r18).not.toContain("書影");
    // MADB の利用規約が求める「加工して作成」は両方に出す。
    for (const html of [base, r18]) {
      expect(html).toContain("メディア芸術データベース（国立アートリサーチセンター）を加工して作成");
    }
  });

  it("window.__SITE__ に commerce を載せる（public/affiliate.js が見る）", () => {
    expect(analyticsTags(adult)).toContain('"commerce":false');
    expect(analyticsTags(general)).toContain('"commerce":true');
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
