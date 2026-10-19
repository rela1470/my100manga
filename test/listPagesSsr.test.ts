import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { applyFill, copiesLabel, SSR_LIST_PATHS } from "../src/listPagesSsr";
import { purgePublicListsCache } from "../src/publicLists";
import { BROWSER_UA, createList } from "./helpers";

// 一覧系のページの中身をサーバで HTML に埋める（src/listPagesSsr.ts）。JS を動かさない
// クローラにも一覧が見えること。

async function page(path: string) {
  return SELF.fetch(`https://example.com${path}`, { headers: { "user-agent": BROWSER_UA } });
}

beforeAll(async () => {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO series (id, name, name_norm, name_search, creator, publisher, label, num_items)
     VALUES ('C850001', 'えすえすあーるまんが', 'えすえすあーるまんが', 'えすえすあーるまんが', '作者さん', 'テスト社', 'テストコミックス', 3)`
  ).run();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO series_stats (series_id, vol_count, complete_run, first_isbn, last_pubdate, computed_at)
     VALUES ('C850001', 3, 1, '', '2015-03', 0)`
  ).run();
  await env.DB.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('circulation_ranking_json', ?)`)
    .bind(
      JSON.stringify({
        entries: [{ rank: 1, title: "ぶすうのまんが", series_id: null, search_q: "ぶすうのまんが", copies: 157200000, as_of: "2026-03", cover_url: "", isbn: "" }],
        source: {
          url: "https://en.wikipedia.org/wiki/Special:PermanentLink/1",
          title: "List of best-selling manga",
          retrieved: "2026-10-01",
          license: "CC BY-SA 4.0",
          license_url: "https://creativecommons.org/licenses/by-sa/4.0/",
        },
        computed_at: Date.now(),
        v: 2,
      })
    )
    .run();
});

describe("一覧系のページ", () => {
  it("どのページも差し込み口を残さない", async () => {
    for (const path of SSR_LIST_PATHS) {
      const res = await page(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text(), path).not.toMatch(/<!--SSR_/);
    }
  });

  it("/series はシリーズを個別ページへのリンクで並べる", async () => {
    const html = await (await page("/series")).text();
    expect(html).toContain(`<a class="slot view rank-slot" href="/s/C850001"`);
    expect(html).toContain(`<div class="t">えすえすあーるまんが</div>`);
    expect(html).toMatch(/巻数の多い順に \d+ シリーズを表示中/);
  });

  it("/circulation は部数と出典を出す", async () => {
    const html = await (await page("/circulation")).text();
    expect(html).toContain(`<div class="t">ぶすうのまんが</div>`);
    expect(html).toContain("1億5720万部・2026年3月時点");
    expect(html).toContain(`href="https://en.wikipedia.org/wiki/Special:PermanentLink/1"`);
    expect(html).toContain("CC BY-SA 4.0 で利用できます");
  });

  it("/lists は公開リストのカードを出し、自己紹介はエスケープする", async () => {
    await createList({ owner_name: "えすえすあーる", bio: "<b>自己紹介</b>" });
    await purgePublicListsCache(env);
    const html = await (await page("/lists")).text();
    expect(html).toContain("えすえすあーるさんを構成する100の漫画");
    expect(html).toContain("&lt;b&gt;自己紹介&lt;/b&gt;");
    expect(html).toContain("公開された順（新しい順）");
  });
});

describe("applyFill / copiesLabel", () => {
  it("置換文字列の $ を特殊扱いしない", () => {
    expect(applyFill("<div><!--SSR_LIST--></div><p><!--SSR_NOTE--></p>", { list: "$&$1", note: "a<b" })).toBe(
      "<div>$&$1</div><p>a&lt;b</p>"
    );
  });
  it("部数の表記", () => {
    expect(copiesLabel(600000000)).toBe("6億部");
    expect(copiesLabel(20400000)).toBe("2040万部");
  });
});
