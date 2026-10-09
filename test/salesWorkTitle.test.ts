import { describe, expect, it } from "vitest";
import { salesVolumeNumber, salesWorkTitle } from "../src/salesRanking";

describe("salesWorkTitle", () => {
  it("空白・括弧の巻数を 1 つ除く", () => {
    expect(salesWorkTitle("名探偵コナン 108")).toBe("名探偵コナン");
    expect(salesWorkTitle("金色のガッシュ!! 2（7）")).toBe("金色のガッシュ!! 2");
    expect(salesWorkTitle("ゴルゴ13 220")).toBe("ゴルゴ13");
  });
  it("和文の直後にくっついた巻数も除く", () => {
    expect(salesWorkTitle("ブレイド＆バスタード9")).toBe("ブレイド＆バスタード");
    expect(salesWorkTitle("デスマーチからはじまる異世界狂想曲20")).toBe("デスマーチからはじまる異世界狂想曲");
    expect(salesWorkTitle("【楽天ブックス限定特典】管狐のモナカ2(オリジナルステッカー)")).toBe("管狐のモナカ");
  });
  it("英数字の続きは書名の一部として残す", () => {
    expect(salesWorkTitle("らんま1/2")).toBe("らんま1/2");
  });
  it("先頭の「〜付き」の特典表記を除く", () => {
    expect(salesWorkTitle("ミニクリアファイル付き　転生したらスライムだった件（33）　特装版")).toBe("転生したらスライムだった件");
  });
});

describe("salesVolumeNumber", () => {
  it("salesWorkTitle が除いた巻数を返す", () => {
    expect(salesVolumeNumber("ミニクリアファイル付き　転生したらスライムだった件（33）　特装版")).toBe(33);
    expect(salesVolumeNumber("名探偵コナン 108")).toBe(108);
    expect(salesVolumeNumber("金色のガッシュ!! 2（7）")).toBe(7);
    expect(salesVolumeNumber("ブレイド＆バスタード９")).toBe(9);
    expect(salesVolumeNumber("ONE PIECE 第111巻")).toBe(111);
  });
  it("巻数の無い書名は null", () => {
    expect(salesVolumeNumber("らんま1/2")).toBeNull();
    expect(salesVolumeNumber("ルックバック")).toBeNull();
  });
});
