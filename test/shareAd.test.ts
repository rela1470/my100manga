import { describe, expect, it } from "vitest";
import { AD_IMAGE_SIZE, creditLine, SHARE_IMAGE_SIZE } from "../src/shareImage";
import type { MangaList } from "../src/types";

// X広告用の 4 枚画像（src/shareImage.ts の AD_VARIANTS）。
describe("X広告用画像", () => {
  it("X の 4 枚投稿のタイル比（16:9）で描く", () => {
    expect(AD_IMAGE_SIZE).toEqual({ width: 1200, height: 675 });
    // 公開側の 4 枚版は縦長のまま（広告用を足しても変わらない）。
    expect(SHARE_IMAGE_SIZE.q1.height).toBeGreaterThan(SHARE_IMAGE_SIZE.q1.width);
  });

  it("各枚は 4 枚版と同じ 25 冊を受け持つ（出典クレジットが一致する）", () => {
    const items = Array.from({ length: 100 }, (_, i) => ({
      position: i + 1,
      cover_url: i < 25 ? "https://thumbnail.image.rakuten.co.jp/@0_mall/book/x.jpg" : "https://item-shopping.c.yimg.jp/i/x.jpg",
    }));
    const list = { slug: "s", owner_name: "", items } as unknown as MangaList;
    for (const n of [1, 2, 3, 4] as const) {
      expect(creditLine(list, `a${n}`)).toBe(creditLine(list, `q${n}`));
    }
    expect(creditLine(list, "a1")).toContain("楽天ブックス");
    expect(creditLine(list, "a2")).not.toContain("楽天ブックス");
  });
});
