import { describe, expect, it } from "vitest";
import { clientIp, escapeHtml, normalizeCustomSlug, toIsbn13 } from "../src/util";
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
  it("みんなのリスト・人気ランキング・売上ランキングへのボタンを出す", () => {
    const html = headerLinksHtml();
    expect(html).toContain(`href="/lists"`);
    expect(html).toContain(`href="/ranking"`);
    expect(html).toContain(`href="/sales-ranking"`);
    expect(html.match(/class="header-link"/g)).toHaveLength(3);
  });
});
