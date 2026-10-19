import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { formatPubdate, INDEX_MIN_VOLUMES, PageVolume, seriesAnswer, volumeLabel } from "../src/seriesPage";
import { BROWSER_UA, makeIsbns } from "./helpers";

// シリーズの個別ページ（/s/<id>）。「〇〇は全何巻？」の答えを <title>・本文・JSON-LD に書く。
// src/seriesPage.ts

const ENDED = "C840001"; // 1〜3 巻、最後の巻は 2015 年（「全3巻」）
const ONGOING = "C840002"; // 1〜2 巻、最後の巻は今月（「既刊2巻」）
const BUNKO = "C840003"; // ENDED と同名の文庫版（2 巻）
const SINGLE = "C840004"; // 1 巻物（検索に載せない）
const ABSORBED = "C840005"; // ENDED に結合された側
const LONG = "C840006"; // INDEX_MIN_VOLUMES 巻（検索に載せる）
const FEATURED = "C840007"; // 2 巻だが発行部数ランキングに出ている（検索に載せる）
const ISBNS = makeIsbns(40, 340000);

const thisMonth = new Date().toISOString().slice(0, 7);

async function seedSeries(id: string, name: string, label: string, numItems: number) {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO series (id, name, name_norm, name_search, creator, creators, publisher, label, num_items)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, name, name, name, "作者いち", "原作：作者いち、作画：作者に", "テスト社", label, numItems)
    .run();
}
async function seedVolume(isbn: string, seriesId: string, vol: number, title: string, pubdate: string) {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, title_search, creator, pubdate)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(isbn, seriesId, String(vol), vol, title, title, "作者いち", pubdate)
    .run();
}
async function page(path: string) {
  return SELF.fetch(`https://example.com${path}`, { headers: { "user-agent": BROWSER_UA }, redirect: "manual" });
}
function ldJson(html: string): any {
  const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  return m ? JSON.parse(m[1]) : null;
}

beforeAll(async () => {
  await seedSeries(ENDED, "おわったまんが", "テストコミックス", 3);
  for (let i = 1; i <= 3; i++) await seedVolume(ISBNS[i - 1], ENDED, i, "おわったまんが", `2015-0${i}`);
  await seedSeries(ONGOING, "つづくまんが", "テストコミックス", 2);
  await seedVolume(ISBNS[3], ONGOING, 1, "つづくまんが", "2024-01");
  await seedVolume(ISBNS[4], ONGOING, 2, "つづくまんが", thisMonth);
  await seedSeries(BUNKO, "おわったまんが", "テスト文庫", 2);
  for (let i = 1; i <= 2; i++) await seedVolume(ISBNS[4 + i], BUNKO, i, "おわったまんが", `2018-0${i}`);
  await seedSeries(SINGLE, "いっかんもの", "テストコミックス", 1);
  await seedVolume(ISBNS[7], SINGLE, 1, "いっかんもの", "2016-05");
  // 巻は持たせない（持たせると残す側の巻一覧に足されて巻数が変わる）。
  await seedSeries(ABSORBED, "すわれたまんが", "テストコミックス", 0);
  await env.DB.prepare(`INSERT OR REPLACE INTO series_merge (absorbed_id, target_id, created_at) VALUES (?, ?, ?)`)
    .bind(ABSORBED, ENDED, Date.now())
    .run();
  await seedSeries(LONG, "ながいまんが", "テストコミックス", INDEX_MIN_VOLUMES);
  for (let i = 1; i <= INDEX_MIN_VOLUMES; i++) await seedVolume(ISBNS[11 + i], LONG, i, "ながいまんが", "2012-01");
  await seedSeries(FEATURED, "うれてるまんが", "テストコミックス", 2);
  for (let i = 1; i <= 2; i++) await seedVolume(ISBNS[29 + i], FEATURED, i, "うれてるまんが", "2025-01");
  // 発行部数ランキングの集計（src/circulation.ts の meta。v は PAYLOAD_VERSION）に FEATURED を出す。
  await env.DB.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('circulation_ranking_json', ?)`)
    .bind(JSON.stringify({ entries: [{ rank: 1, title: "うれてるまんが", series_id: FEATURED }], source: null, computed_at: Date.now(), v: 2 }))
    .run();
  // 同じ作品の別の版は series_stats から引くので、巻一覧を一度組んで埋めておく。
  for (const id of [ENDED, ONGOING, BUNKO, SINGLE, LONG, FEATURED]) {
    await (await page(`/api/series/${id}/volumes`)).arrayBuffer();
  }
});

describe("答えの文（seriesAnswer）", () => {
  const vol = (n: number, pubdate: string): PageVolume => ({
    isbn: `isbn${n}`,
    volume_number: String(n),
    vol_sort: n,
    title: "",
    subtitle: "",
    pubdate,
    cover_url: "",
  });
  const now = Date.UTC(2026, 9, 19);

  it("最後の巻から 3 年以上新刊が無ければ「全N巻」", () => {
    const a = seriesAnswer("X", [vol(1, "2020-01"), vol(2, "2023-10")], now, now);
    expect(a.ended).toBe(true);
    expect(a.headline).toBe("全2巻");
    expect(a.sentence).toBe("『X』は全2巻です。第1巻から第2巻まで刊行され、第2巻（2023年10月発売）を最後に新刊は出ていません。");
  });

  it("新しい巻があれば「既刊N巻（YYYY年M月時点）」", () => {
    const a = seriesAnswer("X", [vol(1, "2020-01"), vol(2, "2023-11")], now, Date.UTC(2026, 8, 1));
    expect(a.ended).toBe(false);
    expect(a.headline).toBe("既刊2巻");
    expect(a.sentence).toBe("『X』は既刊2巻です（2026年9月時点）。最新刊は第2巻（2023年11月発売）です。");
  });

  it("巻番号が欠けていれば「第1巻から第N巻まで」とは書かない", () => {
    const a = seriesAnswer("X", [vol(1, "2010-01"), vol(3, "2011-01")], now, now);
    expect(a.complete).toBe(false);
    expect(a.sentence).toBe("『X』は全2巻です。第3巻（2011年1月発売）を最後に新刊は出ていません。");
  });

  it("発売日の無い新しい巻が後ろにあれば、その巻を最新刊にして「全」と言い切らない", () => {
    const a = seriesAnswer("X", [vol(1, "2015-01"), vol(2, "2016-01"), vol(3, "")], now, Date.UTC(2026, 8, 1));
    expect(a.ended).toBe(false);
    expect(a.headline).toBe("既刊3巻");
    expect(a.last?.volume_number).toBe("3");
    expect(a.sentence).toBe("『X』は既刊3巻です（2026年9月時点）。最新刊は第3巻です。");
  });

  it("発売日と巻の見出しの整形", () => {
    expect(formatPubdate("2021-10")).toBe("2021年10月");
    expect(formatPubdate("2000-08-16")).toBe("2000年8月");
    expect(formatPubdate("1977")).toBe("1977年");
    expect(formatPubdate("")).toBe("");
    expect(volumeLabel({ volume_number: "巻ノ二十七", subtitle: "" })).toBe("第27巻");
    expect(volumeLabel({ volume_number: "外伝", subtitle: "" })).toBe("外伝");
    expect(volumeLabel({ volume_number: "", subtitle: "総集編" })).toBe("総集編");
  });
});

describe("GET /s/<id>", () => {
  it("<title>・本文・JSON-LD に「全N巻」が入る", async () => {
    const res = await page(`/s/${ENDED}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<title>おわったまんがは全何巻？全3巻・最終巻は2015年3月発売 | My 100 Manga</title>");
    expect(html).toContain(`<h1 class="sp-q">『おわったまんが』は全何巻？</h1>`);
    expect(html).toContain("『おわったまんが』は全3巻です。");
    expect(html).toContain(`<link rel="canonical" href="https://example.com/s/${ENDED}">`);
    expect(html).not.toMatch(/<!--(SERIES_HEAD|SERIES_BODY|HEADER_LINKS|FOOTER_AFF|ANALYTICS|GTM_BODY|AFF_DATA)-->/);

    const ld = ldJson(html);
    const series = ld["@graph"].find((g: any) => g["@type"] === "BookSeries");
    expect(series.name).toBe("おわったまんが");
    expect(series.author.map((a: any) => a.name)).toEqual(["作者いち", "作者に"]);
    expect(series.hasPart).toHaveLength(3);
    expect(series.endDate).toBe("2015-03");
    const faq = ld["@graph"].find((g: any) => g["@type"] === "FAQPage");
    expect(faq.mainEntity[0].name).toBe("『おわったまんが』は全何巻？");
    expect(faq.mainEntity[0].acceptedAnswer.text).toContain("全3巻");
  });

  it("同名の別の版へリンクし、巻数の少ない版はレーベルを添えて見分ける", async () => {
    const main = await (await page(`/s/${ENDED}`)).text();
    expect(main).toContain(`<a href="/s/${BUNKO}">おわったまんが（テスト文庫）</a>（2巻）`);
    const bunko = await (await page(`/s/${BUNKO}`)).text();
    expect(bunko).toContain("<title>おわったまんが（テスト文庫）は全何巻？");
    expect(bunko).toContain(`<a href="/s/${ENDED}">おわったまんが（テストコミックス）</a>（3巻）`);
  });

  it("シェアボタン: X は本文・URL・ハッシュタグを分けて、ほかは本文にまとめて渡す", async () => {
    const html = await (await page(`/s/${ENDED}`)).text();
    const x = /href="(https:\/\/twitter\.com\/intent\/tweet\?[^"]+)"/.exec(html);
    expect(x).not.toBeNull();
    const q = new URL(x![1].replace(/&amp;/g, "&")).searchParams;
    expect(q.get("text")).toBe("『おわったまんが』は全3巻");
    expect(q.get("url")).toBe(`https://example.com/s/${ENDED}`);
    expect(q.get("hashtags")).toBe("my100manga");
    const line = /href="https:\/\/line\.me\/R\/share\?text=([^"]+)"/.exec(html);
    expect(decodeURIComponent(line![1])).toBe(`『おわったまんが』は全3巻 https://example.com/s/${ENDED} #my100manga`);
    expect(html).toContain(`class="sp-copy" data-url="https://example.com/s/${ENDED}"`);
  });

  it("新刊が出ているシリーズは「既刊N巻」", async () => {
    const html = await (await page(`/s/${ONGOING}`)).text();
    expect(html).toContain("つづくまんがは全何巻？既刊2巻・最新刊は");
    expect(html).toContain("『つづくまんが』は既刊2巻です");
    expect(html).not.toContain("全2巻");
  });

  it(`${INDEX_MIN_VOLUMES} 巻未満は検索に載せない`, async () => {
    for (const id of [SINGLE, ENDED]) {
      const res = await page(`/s/${id}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-robots-tag")).toBe("noindex");
      expect(await res.text()).toContain(`<meta name="robots" content="noindex">`);
    }
  });

  it(`${INDEX_MIN_VOLUMES} 巻以上と、ランキングに出ている作品は検索に載せる`, async () => {
    for (const id of [LONG, FEATURED]) {
      const res = await page(`/s/${id}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-robots-tag")).toBeNull();
      expect(await res.text()).not.toContain(`<meta name="robots" content="noindex">`);
    }
  });

  it("結合で吸収された側は残す側へ 301", async () => {
    const res = await page(`/s/${ABSORBED}`);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`https://example.com/s/${ENDED}`);
  });

  it("無いシリーズは 404、まとまり（G-id）は個別ページを持たない", async () => {
    expect((await page("/s/C849999")).status).toBe(404);
    expect((await page(`/s/G${ISBNS[0]}`)).status).toBe(404);
  });

  it("シリーズ名は HTML にエスケープして入る", async () => {
    await seedSeries("C840009", `<b>"あぶない"</b>`, "テストコミックス", 2);
    await seedVolume(ISBNS[9], "C840009", 1, `<b>"あぶない"</b>`, "2015-01");
    await seedVolume(ISBNS[10], "C840009", 2, `<b>"あぶない"</b>`, "2015-02");
    const html = await (await page("/s/C840009")).text();
    expect(html).not.toContain(`<b>"あぶない"</b>`);
    expect(html).toContain("&lt;b&gt;&quot;あぶない&quot;&lt;/b&gt;");
    // JSON-LD の中でも </script> にならない
    expect(ldJson(html)["@graph"][0].name).toBe(`<b>"あぶない"</b>`);
  });
});

describe("GET /b/<isbn>（巻のページ）", () => {
  it("その巻を見出しにし、canonical はシリーズのページ、og:url と共有は巻のページ", async () => {
    const res = await page(`/b/${ISBNS[1]}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<title>おわったまんが 第2巻（2015年2月発売） | My 100 Manga</title>");
    expect(html).toContain(`<link rel="canonical" href="https://example.com/s/${ENDED}">`);
    expect(html).toContain(`<meta property="og:url" content="https://example.com/b/${ISBNS[1]}">`);
    expect(html).toContain(`<h1 class="sp-focus-title">第2巻</h1>`);
    expect(html).toContain(`<h2 class="sp-q">『おわったまんが』は全何巻？</h2>`);
    const x = /href="(https:\/\/twitter\.com\/intent\/tweet\?[^"]+)"/.exec(html);
    const q = new URL(x![1].replace(/&amp;/g, "&")).searchParams;
    expect(q.get("text")).toBe("『おわったまんが』第2巻");
    expect(q.get("url")).toBe(`https://example.com/b/${ISBNS[1]}`);
    expect(html).toContain(`class="slot view sp-vol sp-vol-focus" data-isbn="${ISBNS[1]}"`);
  });

  it("シリーズのページの巻のタイルは巻のページへリンクする", async () => {
    const html = await (await page(`/s/${ENDED}`)).text();
    expect(html).toContain(`<a class="sp-vol-link" href="/b/${ISBNS[0]}">`);
  });

  it("ISBN-10・ハイフン付きは ISBN13 の URL へ 301", async () => {
    const isbn10 = ISBNS[1].slice(3, 12) + "0"; // チェックディジットは toIsbn13 が付け直す
    const res = await page(`/b/${isbn10}`);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`https://example.com/b/${ISBNS[1]}`);
    const hy = await page(`/b/${ISBNS[1].slice(0, 3)}-${ISBNS[1].slice(3)}`);
    expect(hy.status).toBe(301);
  });

  it("知らない ISBN・ISBN でないものは 404", async () => {
    expect((await page("/b/9784000000000")).status).toBe(404);
    expect((await page("/b/12345678901")).status).toBe(404);
  });

  it("巻のページは sitemap に載せない", async () => {
    const series = await (await page("/sitemap-series-1.xml")).text();
    expect(series).not.toContain("/b/");
  });
});

describe("シリーズの sitemap", () => {
  it(`sitemap.xml は索引で、シリーズの分は ${INDEX_MIN_VOLUMES} 巻以上・結合で吸収された側を除く`, async () => {
    const index = await (await page("/sitemap.xml")).text();
    expect(index).toContain("<sitemapindex");
    expect(index).toContain("<loc>https://example.com/sitemap-pages.xml</loc>");
    expect(index).toContain("<loc>https://example.com/sitemap-series-1.xml</loc>");
    expect(index).toContain("<loc>https://example.com/sitemap-featured.xml</loc>");
    const series = await (await page("/sitemap-series-1.xml")).text();
    expect(series).toContain(`<loc>https://example.com/s/${LONG}</loc>`);
    for (const id of [ENDED, BUNKO, SINGLE, ABSORBED, FEATURED]) expect(series).not.toContain(id);
    expect((await page("/sitemap-series-99.xml")).status).toBe(404);
  });

  it("ランキングに出ている巻数の少ない作品は sitemap-featured.xml に載せる", async () => {
    const featured = await (await page("/sitemap-featured.xml")).text();
    expect(featured).toContain(`<loc>https://example.com/s/${FEATURED}</loc>`);
    expect(featured).not.toContain(LONG);
    expect(featured).not.toContain(ENDED);
  });

  it("llms.txt にシリーズの個別ページの形を書く", async () => {
    const txt = await (await page("/llms.txt")).text();
    expect(txt).toContain("https://example.com/s/<シリーズID>");
  });
});
