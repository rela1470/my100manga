import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { BROWSER_UA, makeIsbns } from "./helpers";

// 管理者が確定で非表示にした巻（volume_hidden）は ISBN 単位で効く。巻一覧は同じ巻番号の ISBN を
// 1 巻にまとめるが、隠した ISBN だけを外し、残りの ISBN があればその巻は出す。巻ごと消していた
// ときは、新装版だけを隠したつもりが元の版の巻まで消え、手動追加で足し直しても（マスタにある
// ISBN なので）出てこなかった（C340152 魔法使いの嫁 10・15・19 巻）。

const NAME = "ヒヒョウジシケン";
const isbns = makeIsbns(20, 820000);
let seq = 0;

/** 1 巻（通常版 A・新装版 B）と 2 巻（C のみ）のシリーズを作る。巻一覧はエッジキャッシュに
 *  乗るので、ケースごとに新しい ID にする。 */
async function newSeries() {
  const id = `CH${String(++seq).padStart(3, "0")}`;
  const [a, b, c] = isbns.slice(seq * 3, seq * 3 + 3);
  await env.DB.prepare(
    `INSERT OR REPLACE INTO series (id, name, name_norm, name_search, creator) VALUES (?, ?, ?, ?, '作者')`
  )
    .bind(id, NAME + seq, NAME + seq, NAME + seq)
    .run();
  const vol = env.DB.prepare(
    `INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, title_search, creator, label, pubdate)
     VALUES (?, ?, ?, ?, ?, ?, '作者', ?, ?)`
  );
  await env.DB.batch([
    vol.bind(a, id, "1", 1, NAME + seq, NAME + seq, "元のレーベル", "2014-04"),
    vol.bind(b, id, "1", 1, NAME + seq, NAME + seq, "新装版レーベル", "2010-01"),
    vol.bind(c, id, "2", 2, NAME + seq, NAME + seq, "元のレーベル", "2014-09"),
  ]);
  return { id, a, b, c };
}

async function hide(id: string, isbn: string) {
  await env.DB.prepare(`INSERT INTO volume_hidden (series_id, isbn, created_at) VALUES (?, ?, ?)`)
    .bind(id, isbn, Date.now())
    .run();
}

async function volumes(id: string) {
  const res = await SELF.fetch(`https://example.com/api/series/${id}/volumes`, {
    headers: { "user-agent": BROWSER_UA },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { volumes: { isbn: string; isbns: string[]; volume_number: string; label: string }[] })
    .volumes;
}

describe("巻の非表示（volume_hidden）は ISBN 単位", () => {
  it("隠した ISBN だけが外れ、同じ巻の残りの ISBN で巻が出る", async () => {
    const { id, a, b } = await newSeries();
    await hide(id, b);
    const vols = await volumes(id);
    expect(vols.map((v) => v.volume_number)).toEqual(["1", "2"]);
    // 代表も残った ISBN になり、レーベルは隠した版のものを使わない。
    expect(vols[0]).toMatchObject({ isbn: a, isbns: [a], label: "元のレーベル" });
  });

  it("巻の全ての ISBN を隠すとその巻は消える", async () => {
    const { id, a, b, c } = await newSeries();
    await hide(id, a);
    await hide(id, b);
    const vols = await volumes(id);
    expect(vols.map((v) => v.isbn)).toEqual([c]);
  });
});
