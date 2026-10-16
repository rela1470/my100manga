import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { BROWSER_UA, makeIsbns } from "./helpers";

// 書名一致の補完（SPARQL, series_supplement）は schema:isPartOf を見ないので、上流が別シリーズの
// 巻にシリーズと同じ書名を付けていると新刊として拾ってしまう（C339943 ログ・ホライズン に
// C339944 西風の旅団の 9〜11 巻）。マスタが別のシリーズの巻としている ISBN は補完から外す。

const NAME = "ホカンタシリーズシケン";
const SERIES = "C830001";
const OTHER = "C830002";
const [OWN1, OTHER9, OTHER10, NEW10, NEW11] = makeIsbns(5, 830000);

beforeAll(async () => {
  const series = env.DB.prepare(
    `INSERT OR REPLACE INTO series (id, name, name_norm, name_search, creator) VALUES (?, ?, ?, ?, '作者')`
  );
  const vol = env.DB.prepare(
    `INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, title_search, creator)
     VALUES (?, ?, ?, ?, ?, ?, '作者')`
  );
  await env.DB.batch([
    series.bind(SERIES, NAME, NAME, NAME),
    series.bind(OTHER, NAME + " 外伝", NAME + " 外伝", NAME + " 外伝"),
    vol.bind(OWN1, SERIES, "1", 1, NAME, NAME),
    // 別シリーズの巻なのに、書名がこのシリーズと同じ（上流の付け方）。
    vol.bind(OTHER9, OTHER, "9", 9, NAME, NAME),
    vol.bind(OTHER10, OTHER, "10", 10, NAME, NAME),
  ]);
  // 前に取得ボタンで貯まった補完。9 巻は丸ごと別シリーズの巻、10 巻は別シリーズの ISBN と
  // 新しい ISBN の両方、11 巻は新しい ISBN だけ。
  const vols = [
    { isbn: OTHER9, isbns: [OTHER9], volume_number: "9", vol_sort: 9, title: NAME, author: "作者", publisher: "", pubdate: "" },
    { isbn: OTHER10, isbns: [OTHER10, NEW10], volume_number: "10", vol_sort: 10, title: NAME, author: "作者", publisher: "", pubdate: "" },
    { isbn: NEW11, isbns: [NEW11], volume_number: "11", vol_sort: 11, title: NAME, author: "作者", publisher: "", pubdate: "" },
  ];
  await env.DB.prepare(`INSERT OR REPLACE INTO series_supplement (series_id, volumes_json, checked_at) VALUES (?, ?, ?)`)
    .bind(SERIES, JSON.stringify(vols), Date.now())
    .run();
});

describe("補完から別シリーズの巻の ISBN を外す", () => {
  it("巻一覧に別シリーズの ISBN は出ず、他の ISBN が残る巻は出る", async () => {
    const res = await SELF.fetch(`https://example.com/api/series/${SERIES}/volumes`, {
      headers: { "user-agent": BROWSER_UA },
    });
    expect(res.status).toBe(200);
    const vols = ((await res.json()) as { volumes: { volume_number: string; isbn: string; isbns: string[] }[] }).volumes;
    expect(vols.map((v) => [v.volume_number, v.isbn, v.isbns])).toEqual([
      ["1", OWN1, [OWN1]],
      ["10", NEW10, [NEW10]],
      ["11", NEW11, [NEW11]],
    ]);
  });
});
