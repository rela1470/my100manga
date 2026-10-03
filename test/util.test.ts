import { describe, expect, it } from "vitest";
import { clientIp, escapeHtml, isValidIsbn, normalizeCustomSlug, toIsbn13 } from "../src/util";
import { rateKeyIp } from "../src/ratelimit";
import { parseStoredItems } from "../src/listItems";
import { headerLinksHtml } from "../src/header";

describe("toIsbn13", () => {
  it("ISBN-13 はそのまま、ハイフンは除く", () => {
    expect(toIsbn13("978-4-08-872509-3")).toBe("9784088725093");
  });
  it("ISBN-10 を ISBN-13 に変換する", () => {
    expect(toIsbn13("4088725093")).toBe("9784088725093");
    expect(toIsbn13("406319349X")).toMatch(/^978406319349\d$/);
  });
  it("ISBN でなければ空文字", () => {
    expect(toIsbn13("")).toBe("");
    expect(toIsbn13("abc")).toBe("");
    expect(toIsbn13("12345")).toBe("");
  });
});

// 外部 API（楽天・Yahoo）へ渡す前の入口チェック。でたらめな ISBN で優先レーンを埋められたり、
// 空の covers / book_meta 行を溜められたりしないように、チェックディジットまで見る。
describe("isValidIsbn", () => {
  it("チェックディジットまで正しい ISBN-13 / ISBN-10 を通す", () => {
    expect(isValidIsbn("9784088725093")).toBe(true);
    expect(isValidIsbn("4088725093")).toBe(true);
    expect(isValidIsbn("007462542X")).toBe(true); // 末尾 X
  });
  it("チェックディジット違い・桁違い・ハイフン入り・978/979 以外は通さない", () => {
    expect(isValidIsbn("9784088725094")).toBe(false);
    expect(isValidIsbn("1234567890123")).toBe(false);
    expect(isValidIsbn("978-4-08-872509-3")).toBe(false);
    expect(isValidIsbn("4088725094")).toBe(false);
    expect(isValidIsbn("")).toBe(false);
    expect(isValidIsbn("abc")).toBe(false);
  });
});

describe("normalizeCustomSlug", () => {
  it("英数字・ハイフン・アンダースコアの 1〜15 文字を通す（前後の空白は除く）", () => {
    expect(normalizeCustomSlug(" my-best_100 ")).toBe("my-best_100");
  });
  it("長すぎる・使えない文字・文字列以外は null", () => {
    expect(normalizeCustomSlug("a".repeat(16))).toBeNull();
    expect(normalizeCustomSlug("日本語")).toBeNull();
    expect(normalizeCustomSlug("a/b")).toBeNull();
    expect(normalizeCustomSlug("")).toBeNull();
    expect(normalizeCustomSlug(123)).toBeNull();
  });
});

describe("clientIp", () => {
  it("cf-connecting-ip を優先し、無ければ x-forwarded-for の先頭", () => {
    expect(clientIp(new Request("https://x/", { headers: { "cf-connecting-ip": "1.1.1.1", "x-forwarded-for": "2.2.2.2" } }))).toBe("1.1.1.1");
    expect(clientIp(new Request("https://x/", { headers: { "x-forwarded-for": "2.2.2.2, 3.3.3.3" } }))).toBe("2.2.2.2");
    expect(clientIp(new Request("https://x/"))).toBe("");
  });
});

// IPv6 は利用者ごとに /64 が割り当てられ、その中のアドレスは自由に替えられるので、
// /64 に丸めて 1 人として数える（さもないと IPv6 からはレート制限が素通しになる）。
describe("rateKeyIp", () => {
  it("IPv4 はそのまま", () => {
    expect(rateKeyIp("203.0.113.1")).toBe("203.0.113.1");
    expect(rateKeyIp("")).toBe("");
  });
  it("IPv6 は /64 に丸める（同じ /64 の別アドレスは同じキー）", () => {
    const a = rateKeyIp("2001:0db8:1234:5678:aaaa:bbbb:cccc:dddd");
    expect(a).toBe("2001:db8:1234:5678::/64");
    expect(rateKeyIp("2001:db8:1234:5678::1")).toBe(a);
    expect(rateKeyIp("2001:db8:1234:5679::1")).not.toBe(a);
  });
  it(":: の省略を展開してから丸める（ゾーン識別子は落とす）", () => {
    expect(rateKeyIp("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(rateKeyIp("::1")).toBe("0:0:0:0::/64");
    expect(rateKeyIp("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });

  it("IPv4 射影・ポート付きは IPv4 として扱う", () => {
    // /64 に丸めると射影アドレスが全部同じキーになり、無関係な利用者が巻き添えで 429 になる。
    expect(rateKeyIp("::ffff:203.0.113.1")).toBe("203.0.113.1");
    expect(rateKeyIp("::ffff:198.51.100.9")).toBe("198.51.100.9");
    // ポートまでキーに入れると、ポートを変えるだけで制限が素通しになる。
    expect(rateKeyIp("203.0.113.1:54321")).toBe("203.0.113.1");
  });
});

describe("escapeHtml", () => {
  it("HTML の特殊文字をエスケープする", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).not.toMatch(/[<>"]/);
  });
});

describe("parseStoredItems", () => {
  it("配列の JSON を読む", () => {
    expect(parseStoredItems(`[{"position":1,"isbn":"9784088725093","comment":"","spoiler":false}]`)).toHaveLength(1);
  });
  it("壊れた JSON・配列以外・null は空配列", () => {
    expect(parseStoredItems("{")).toEqual([]);
    expect(parseStoredItems(`{"a":1}`)).toEqual([]);
    expect(parseStoredItems(null)).toEqual([]);
  });
});

describe("headerLinksHtml", () => {
  it("みんなのリスト・人気ランキング・売上ランキング・発行部数ランキングへのボタンを出す", () => {
    const html = headerLinksHtml({ SITE_VARIANT: "general" });
    expect(html).toContain(`href="/lists"`);
    expect(html).toContain(`href="/ranking"`);
    expect(html).toContain(`href="/sales-ranking"`);
    expect(html).toContain(`href="/circulation"`);
    expect(html.match(/class="header-link"/g)).toHaveLength(4);
  });

  it("R18版は全年齢のデータ源によるランキングを出さない（売上・発行部数）", () => {
    const html = headerLinksHtml({ SITE_VARIANT: "adult" });
    expect(html).toContain(`href="/lists"`);
    expect(html).toContain(`href="/ranking"`);
    expect(html).not.toContain(`href="/sales-ranking"`);
    expect(html).not.toContain(`href="/circulation"`);
    expect(html.match(/class="header-link"/g)).toHaveLength(2);
  });
});
