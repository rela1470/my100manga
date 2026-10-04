import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { workKey } from "../src/util";
import { resolveBooks } from "../src/listItems";
import { BROWSER_UA, makeIsbns } from "./helpers";

// 巻の副題（volumes.subtitle、MADB の schema:alternateName）。MADB のシリーズには、巻番号が
// 「上」「下」しか無い別作品が並ぶことがある（金田一少年の事件簿は事件ごとに上下巻で、どれも
// schema:name が「金田一少年の事件簿」・volumeNumber が「上」「下」）。巻番号だけでまとめると
// 1 冊を残して巻一覧から消えてしまうので、作品の区別は書名＋副題で行う。
// 逆に、同じ巻でも刷りによって副題が付いたり付かなかったりする（七つの大罪の一部の刷りだけが
// 「the seven deadly sins」を持つ）ので、副題の無い行は同じ書名の巻に寄せる。

const SERIES = "C800900";
const FOLDED_SERIES = "C800901";
const [A_UP, A_LOW, B_UP, B_LOW, A_LOW_SP, D_ALIAS, D_PLAIN, C_FOLDED, C_SPLIT] = makeIsbns(9, 900000);

async function addVolume(
  seriesId: string,
  isbn: string,
  volumeNumber: string,
  title: string,
  subtitle: string | null
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, subtitle, title_search, creator, pubdate)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`
  )
    .bind(isbn, seriesId, volumeNumber, title, subtitle, title, "作者", "2006-11-17")
    .run();
}

async function addSeries(id: string, name: string): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO series (id, name, name_norm, name_search, creator) VALUES (?, ?, ?, ?, ?)`
  )
    .bind(id, name, name, name, "作者")
    .run();
}

async function volumes(
  id = SERIES
): Promise<{ isbn: string; isbns: string[]; volume_number: string; subtitle: string }[]> {
  const res = await SELF.fetch(`https://example.com/api/series/${id}/volumes`, {
    headers: { "user-agent": BROWSER_UA },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    volumes: { isbn: string; isbns: string[]; volume_number: string; subtitle: string }[];
  };
  return body.volumes;
}

beforeAll(async () => {
  await addSeries(SERIES, "副題試験");
  // 同じ「上」「下」で中身の違う 2 作品。
  await addVolume(SERIES, A_UP, "上", "副題試験", "最初の事件");
  await addVolume(SERIES, A_LOW, "下", "副題試験", "最初の事件");
  await addVolume(SERIES, B_UP, "上", "副題試験", "次の事件");
  await addVolume(SERIES, B_LOW, "下", "副題試験", "次の事件");
  // 「最初の事件 下」の特装版（同じ作品の別 ISBN）。
  await addVolume(SERIES, A_LOW_SP, "下", "副題試験", "最初の事件");
  // 同じ巻の別の刷り。片方だけシリーズの英語別名を alternateName に持っている。
  await addVolume(SERIES, D_ALIAS, "2", "副題試験", "The Subtitle Test");
  await addVolume(SERIES, D_PLAIN, "2", "副題試験", null);

  // 副題を書名に畳み込んである行と、副題を別に持つ行（MADB は両方の書き方をする）。
  await addSeries(FOLDED_SERIES, "畳み込み試験");
  await addVolume(FOLDED_SERIES, C_FOLDED, "1", "畳み込み試験 : 三つ目の事件", null);
  await addVolume(FOLDED_SERIES, C_SPLIT, "1", "畳み込み試験", "三つ目の事件");
});

describe("workKey", () => {
  it("書名に畳み込んだ副題と、分けて持つ副題を同じキーにする", () => {
    expect(workKey("世界一初恋 : 小野寺律の場合", null)).toBe(workKey("世界一初恋", "小野寺律の場合"));
  });
  it("副題が違えば別のキー", () => {
    expect(workKey("金田一少年の事件簿", "獄門塾殺人事件")).not.toBe(
      workKey("金田一少年の事件簿", "雪霊伝説殺人事件")
    );
  });
});

describe("GET /api/series/:id/volumes の副題", () => {
  it("同じ巻番号でも副題が違えば別の巻として並ぶ", async () => {
    const vols = await volumes();
    const lower = vols.filter((v) => v.volume_number === "下");
    expect(lower.map((v) => v.subtitle).sort()).toEqual(["最初の事件", "次の事件"]);
    // 消えていた方の ISBN も、どれかの巻から引ける。
    expect(vols.flatMap((v) => v.isbns)).toContain(B_LOW);
  });

  it("同じ副題の別 ISBN（特装版）は 1 つの巻にまとまる", async () => {
    const vols = await volumes();
    const first = vols.find((v) => v.volume_number === "下" && v.subtitle === "最初の事件");
    expect(first?.isbns.sort()).toEqual([A_LOW, A_LOW_SP].sort());
  });

  it("片方の刷りにしか副題が無いときは同じ巻として 1 行にする", async () => {
    const vols = await volumes();
    const fourth = vols.filter((v) => v.volume_number === "2");
    expect(fourth).toHaveLength(1);
    expect(fourth[0].isbns.sort()).toEqual([D_ALIAS, D_PLAIN].sort());
  });

  it("副題が書名に畳み込まれていても同じ巻にまとまる", async () => {
    const vols = await volumes(FOLDED_SERIES);
    expect(vols).toHaveLength(1);
    expect(vols[0].isbns.sort()).toEqual([C_FOLDED, C_SPLIT].sort());
  });

  it("リストに並べたときの本の名前にも副題が付く", async () => {
    const books = await resolveBooks(env, [A_LOW, B_LOW]);
    expect(books.get(A_LOW)?.title).toContain("最初の事件");
    expect(books.get(B_LOW)?.title).toContain("次の事件");
    // 書名・巻番号は今までどおり前に出る。
    expect(books.get(A_LOW)?.title.startsWith("副題試験 下")).toBe(true);
  });

  it("検索カードの巻数が巻一覧の行数と一致する", async () => {
    const res = await SELF.fetch("https://example.com/api/search?q=副題試験", {
      headers: { "user-agent": BROWSER_UA },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: { series_id: string; volume_count: number }[] };
    const card = body.results.find((r) => r.series_id === SERIES);
    expect(card?.volume_count).toBe((await volumes()).length);
  });
});
