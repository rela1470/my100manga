import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { dlsiteVolumes, isDlsiteCover, judge, parseResults, type DlsiteVolume } from "../src/dlsite";
import { coverSource } from "../src/shareImage";
import type { Env } from "../src/types";

// R18版の表紙・購入リンク源（src/dlsite.ts）。検索ページの HTML の読み取りと、書名・巻・著者の照合。
// 実際の DLsite は叩かない（docs/dlsite.md の実測で見た形を写した HTML で確かめる）。

function item(id: string, title: string, authors: string[], maker: string): string {
  const img = `//img.dlsite.jp/modpub/images2/work/books/${id.slice(0, 5)}000/${id}_img_main.jpg`;
  return (
    `<tr data-list_item_product_id="${id}">` +
    `<td><img src="${img}" alt="${title} [${maker}]" data-src='${img}'></td>` +
    `<dd class="work_name"><a href="#" title="${title}">${title}</a></dd>` +
    `<span class="author">${authors.map((a) => `<a href="#">${a}</a>`).join(" / ")}</span>` +
    `<img src='${img}'></tr>`
  );
}

const HTML =
  item("BJ01234567", "絶頂多発地帯 イキ地獄へようこそ", ["月下冴喜(若宮参太)"], "ワニマガジン社") +
  item("BJ01234568", "義理ですからっ 2【デジタル特装版】", ["作者A"], "コアマガジン") +
  item("RJ01234569", "メイドさんといっしょ", ["サークル"], "サークル") +
  item("BJ01234570", "淫乱天使と恋する少年", ["別の人"], "どこか");

const vol = (over: Partial<DlsiteVolume>): DlsiteVolume => ({
  isbn: "9784000000000",
  series: "",
  volume_number: "",
  creators_norm: "",
  publisher: "",
  ...over,
});

describe("parseResults", () => {
  it("BJ（成年コミック）だけを、題名・著者・出版社・表紙つきで拾う", () => {
    const items = parseResults(HTML);
    expect(items.map((i) => i.id)).toEqual(["BJ01234567", "BJ01234568", "BJ01234570"]);
    expect(items[0]).toMatchObject({
      title: "絶頂多発地帯 イキ地獄へようこそ",
      maker: "ワニマガジン社",
      authors: ["月下冴喜(若宮参太)"],
      img: "https://img.dlsite.jp/modpub/images2/work/books/BJ012000/BJ01234567_img_main.jpg",
    });
  });
});

describe("judge", () => {
  const items = parseResults(HTML);

  it("副題つきの題名と括弧書きの筆名でも、書名・巻・著者が揃えば確定", () => {
    const m = judge(vol({ series: "絶頂多発地帯", creators_norm: "月下冴喜" }), items);
    expect(m?.level).toBe("strict");
    expect(m?.hit.id).toBe("BJ01234567");
  });

  it("巻数が違えば外す", () => {
    expect(judge(vol({ series: "義理ですからっ", volume_number: "1", creators_norm: "作者a" }), items)).toBeNull();
    expect(judge(vol({ series: "義理ですからっ", volume_number: "2", creators_norm: "作者a" }), items)?.level).toBe("strict");
  });

  it("著者が違えば書名だけの一致（自動では使わない）", () => {
    const m = judge(vol({ series: "淫乱天使", creators_norm: "吉野志穂" }), items);
    expect(m?.level).toBe("titleOnly");
  });

  it("著者が無ければ出版社で代える", () => {
    const m = judge(vol({ series: "義理ですからっ", volume_number: "2", publisher: "[発売]コアマガジン" }), items);
    expect(m?.level).toBe("strict");
  });
});

describe("dlsiteVolumes", () => {
  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare(`INSERT OR REPLACE INTO series (id, name, name_norm) VALUES (?, ?, ?)`).bind(
        "C910001",
        "絶頂多発地帯",
        "絶頂多発地帯",
      ),
      env.DB.prepare(
        `INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, title, creators_norm, publisher, is_adult)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
      ).bind("9784000000017", "C910001", "1", "絶頂多発地帯", "月下冴喜", "ワニマガジン社"),
      env.DB.prepare(
        `INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, title, is_adult) VALUES (?, NULL, '3', ?, 0)`,
      ).bind("9784000000024", "全年齢の本"),
    ]);
  });

  it("成年向けの巻だけをシリーズ名つきで返す", async () => {
    const m = await dlsiteVolumes(env as unknown as Env, ["9784000000017", "9784000000024"]);
    expect([...m.keys()]).toEqual(["9784000000017"]);
    expect(m.get("9784000000017")).toMatchObject({ series: "絶頂多発地帯", volume_number: "1", creators_norm: "月下冴喜" });
  });
});

describe("DLsite の表紙はシェア画像に載せない", () => {
  it("判定と出典", () => {
    const url = "https://img.dlsite.jp/modpub/images2/work/books/BJ012000/BJ01234567_img_main.jpg";
    expect(isDlsiteCover(url)).toBe(true);
    expect(isDlsiteCover("https://thumbnail.image.rakuten.co.jp/@0_mall/book/cabinet/x.jpg")).toBe(false);
    expect(coverSource(url)).toBeNull();
  });
});

describe("POST /api/covers", () => {
  it("「表紙なし」で確定した巻も空文字で返す（取得ループが確定と数えられるように）", async () => {
    const { SELF } = await import("cloudflare:test");
    const { BROWSER_UA } = await import("./helpers");
    await env.DB.batch([
      env.DB.prepare(`INSERT OR REPLACE INTO covers (isbn, cover_url, checked_at) VALUES (?, '', 1)`).bind("9784000000031"),
      env.DB.prepare(`INSERT OR REPLACE INTO covers (isbn, cover_url, checked_at) VALUES (?, ?, 1)`).bind(
        "9784000000048",
        "https://img.dlsite.jp/modpub/images2/work/books/BJ012000/BJ01234567_img_main.jpg",
      ),
    ]);
    const res = await SELF.fetch("https://example.com/api/covers", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": BROWSER_UA },
      body: JSON.stringify({ isbns: ["9784000000031", "9784000000048"] }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { covers: Record<string, string> };
    expect(data.covers["9784000000031"]).toBe("");
    expect(data.covers["9784000000048"]).toContain("img.dlsite.jp");
  });
});
