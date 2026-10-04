import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { findSiblingVolumes, PresentVolume } from "../src/siblingVolumes";

// 抜け巻が「別シリーズ」「どのシリーズにも属さない迷子」に在るときの名指し
// （src/siblingVolumes.ts）。D1 だけで完結し、データは書き換えない。

const SELF = "C910001"; // 大判版 1〜3, 6（4,5 が抜け）
const SIB = "C910002"; // 同名・同著者の別 C-id。大判版の 4 巻が紛れている
const OTHER_ED = "C910003"; // 同名・同著者だが別の版（新装版）。ISBN ブロックが違う
const NAME = "試験作品";
const CREATOR = "試験作者";

// 大判版: 9784900000xxx の連番
const SELF_ISBNS = ["9784900000015", "9784900000022", "9784900000039", "9784900000060"];
const SIB_V4 = "9784900000046"; // 別シリーズに紛れた 4 巻
const LOOSE_V5 = "9784900000053"; // どのシリーズにも属さない 5 巻
// 新装版: ISBN ブロックが違う（先頭 9 桁までしか一致しない）
const NEW_ED_V4 = "9784901111145";

async function addVolume(
  isbn: string,
  seriesId: string | null,
  volume: string,
  pubdate: string
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, title_search, creator, publisher, label, pubdate)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(isbn, seriesId, volume, Number(volume), NAME, NAME, CREATOR, "試験社", "試験コミックス", pubdate)
    .run();
}

beforeAll(async () => {
  for (const id of [SELF, SIB, OTHER_ED]) {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO series (id, name, name_norm, name_search, creator) VALUES (?, ?, ?, ?, ?)`
    )
      .bind(id, NAME, NAME, NAME, CREATOR)
      .run();
  }
  await addVolume(SELF_ISBNS[0], SELF, "1", "2017-01");
  await addVolume(SELF_ISBNS[1], SELF, "2", "2017-02");
  await addVolume(SELF_ISBNS[2], SELF, "3", "2017-03");
  await addVolume(SELF_ISBNS[3], SELF, "6", "2017-06");
  await addVolume(SIB_V4, SIB, "4", "2017-04"); // 別シリーズに紛れた同じ版の 4 巻
  await addVolume(LOOSE_V5, null, "5", "2017-05"); // 迷子の 5 巻
});

const present = (): PresentVolume[] => [
  { vol_sort: 1, isbns: [SELF_ISBNS[0]], pubdate: "2017-01" },
  { vol_sort: 2, isbns: [SELF_ISBNS[1]], pubdate: "2017-02" },
  { vol_sort: 3, isbns: [SELF_ISBNS[2]], pubdate: "2017-03" },
  { vol_sort: 6, isbns: [SELF_ISBNS[3]], pubdate: "2017-06" },
];

const input = () => ({
  seriesId: SELF,
  members: [SELF],
  name: NAME,
  nameNorm: NAME,
  creator: CREATOR,
  titles: [NAME],
  present: present(),
});

describe("findSiblingVolumes", () => {
  it("別シリーズに紛れた巻と迷子の巻を、どちらも名指しする", async () => {
    const out = await findSiblingVolumes(env as never, input());
    expect(out.map((v) => v.vol_sort)).toEqual([4, 5]);
    expect(out[0]).toMatchObject({ isbn: SIB_V4, series_id: SIB });
    // どのシリーズにも属していない巻は series_id が null（＝結合依頼の相手が迷子側）。
    expect(out[1]).toMatchObject({ isbn: LOOSE_V5, series_id: null });
  });

  it("ISBN ブロックが違う別の版は出さない", async () => {
    await addVolume(NEW_ED_V4, OTHER_ED, "4", "2017-04");
    const out = await findSiblingVolumes(env as never, input());
    expect(out.map((v) => v.isbn)).not.toContain(NEW_ED_V4);
    expect(out.map((v) => v.isbn)).toContain(SIB_V4); // 同じ版の方は残る
    await env.DB.prepare(`DELETE FROM volumes WHERE isbn = ?`).bind(NEW_ED_V4).run();
  });

  it("前後の巻の発行日から外れた巻は出さない（原版の穴に新装版を出さない）", async () => {
    // ISBN ブロックは同じだが、刊行が 30 年後＝別の版の重版。
    const late = "9784900000077";
    await addVolume(late, OTHER_ED, "4", "2047-04");
    await env.DB.prepare(`DELETE FROM volumes WHERE isbn = ?`).bind(SIB_V4).run();
    const out = await findSiblingVolumes(env as never, input());
    expect(out.map((v) => v.vol_sort)).toEqual([5]); // 4 巻は日付で落ちる
    await env.DB.prepare(`DELETE FROM volumes WHERE isbn = ?`).bind(late).run();
    await addVolume(SIB_V4, SIB, "4", "2017-04");
  });

  it("結合済みの member の巻は「別シリーズ」扱いしない", async () => {
    const out = await findSiblingVolumes(env as never, { ...input(), members: [SELF, SIB] });
    expect(out.map((v) => v.vol_sort)).toEqual([5]); // SIB は自分なので 4 巻は候補から外れる
  });

  it("番号付きの巻が 1 つ以下、または抜けが無ければ何も返さない", async () => {
    const one = await findSiblingVolumes(env as never, {
      ...input(),
      present: [{ vol_sort: 1, isbns: [SELF_ISBNS[0]], pubdate: "2017-01" }],
    });
    expect(one).toEqual([]);
    const dense = await findSiblingVolumes(env as never, {
      ...input(),
      present: present().slice(0, 3), // 1,2,3 で間が無い
    });
    expect(dense).toEqual([]);
  });

  it("シリーズ名と違う書名を名乗る迷子巻も、巻が名乗っている書名で拾う", async () => {
    // 大判『三国志』（C367640）と同じ形。シリーズ名は「三国志」なのに巻の書名が
    // 「大判三国志 = Three Kingdoms」で、同じ書名の迷子巻が取り残されている。
    const VARIANT = `大判${NAME} = Variant`;
    const looseV4 = "9784900000084";
    await env.DB.prepare(`DELETE FROM volumes WHERE isbn = ?`).bind(SIB_V4).run();
    await addVolume(looseV4, null, "4", "2017-04");
    await env.DB.prepare(`UPDATE volumes SET title = ? WHERE isbn = ?`).bind(VARIANT, looseV4).run();

    // シリーズ名だけを鍵にすると拾えない。
    const nameOnly = await findSiblingVolumes(env as never, input());
    expect(nameOnly.map((v) => v.vol_sort)).toEqual([5]);

    // 自分の巻が名乗っている書名を渡すと拾える。
    const withTitles = await findSiblingVolumes(env as never, { ...input(), titles: [NAME, VARIANT] });
    expect(withTitles.map((v) => v.vol_sort)).toEqual([4, 5]);
    expect(withTitles[0].isbn).toBe(looseV4);

    await env.DB.prepare(`DELETE FROM volumes WHERE isbn = ?`).bind(looseV4).run();
    await addVolume(SIB_V4, SIB, "4", "2017-04");
  });

  it("著者が分からないシリーズでは判定しない（同名他作品と区別できない）", async () => {
    expect(await findSiblingVolumes(env as never, { ...input(), creator: "" })).toEqual([]);
  });
});
