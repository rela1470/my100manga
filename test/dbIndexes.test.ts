import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { resolveBooks } from "../src/listItems";
import { readMaterialized } from "../src/metaCache";
import { ADULT_RATING } from "../src/adult";
import { makeIsbns } from "./helpers";

async function supplementIsbns(seriesId?: string): Promise<string[]> {
  const res = seriesId
    ? await env.DB.prepare(`SELECT isbn FROM series_supplement_isbn WHERE series_id = ? ORDER BY isbn`).bind(seriesId).all<{ isbn: string }>()
    : await env.DB.prepare(`SELECT isbn FROM series_supplement_isbn ORDER BY isbn`).all<{ isbn: string }>();
  return res.results.map((r) => r.isbn);
}

function vol(isbns: string[], volume: string) {
  return { isbn: isbns[0], isbns, volume_number: volume, vol_sort: Number(volume), title: "テスト作品", author: "作者", publisher: "", pubdate: "" };
}

describe("series_supplement_isbn（補完の ISBN 逆引き、トリガで保つ）", () => {
  beforeEach(async () => {
    await env.DB.batch([env.DB.prepare(`DELETE FROM series_supplement`), env.DB.prepare(`DELETE FROM meta`)]);
  });

  const [a, b, c, d] = makeIsbns(4, 9000);

  it("INSERT / INSERT OR REPLACE / UPDATE / DELETE に追従する", async () => {
    await env.DB.prepare(`INSERT INTO series_supplement (series_id, volumes_json, checked_at) VALUES ('C1', ?, 1)`)
      .bind(JSON.stringify([vol([a, b], "10"), vol([c], "11")]))
      .run();
    expect(await supplementIsbns("C1")).toEqual([a, b, c].sort());

    // src/madbLive.ts と同じ INSERT OR REPLACE（REPLACE は DELETE トリガを起こさない）
    await env.DB.prepare(`INSERT OR REPLACE INTO series_supplement (series_id, volumes_json, checked_at) VALUES ('C1', ?, 2)`)
      .bind(JSON.stringify([vol([d], "12")]))
      .run();
    expect(await supplementIsbns("C1")).toEqual([d]);

    // 取り込みの prune と同じ UPDATE
    await env.DB.prepare(`UPDATE series_supplement SET volumes_json = '[]' WHERE series_id = 'C1'`).run();
    expect(await supplementIsbns("C1")).toEqual([]);

    await env.DB.prepare(`UPDATE series_supplement SET volumes_json = ? WHERE series_id = 'C1'`)
      .bind(JSON.stringify([vol([a], "10")]))
      .run();
    expect(await supplementIsbns("C1")).toEqual([a]);

    // 管理画面の削除
    await env.DB.prepare(`DELETE FROM series_supplement WHERE series_id = 'C1'`).run();
    expect(await supplementIsbns()).toEqual([]);
  });

  it("壊れた JSON でも書き込み自体は失敗させない", async () => {
    await env.DB.prepare(`INSERT INTO series_supplement (series_id, volumes_json, checked_at) VALUES ('C2', 'not json', 1)`).run();
    expect(await supplementIsbns("C2")).toEqual([]);
  });

  it("checked_at だけの更新では逆引きを作り直さない（markSupplementProbed）", async () => {
    await env.DB.prepare(`INSERT INTO series_supplement (series_id, volumes_json, checked_at) VALUES ('C3', ?, 1)`)
      .bind(JSON.stringify([vol([a], "10")]))
      .run();
    await env.DB.prepare(
      `INSERT INTO series_supplement (series_id, volumes_json, checked_at) VALUES ('C3', '[]', 5)
         ON CONFLICT(series_id) DO UPDATE SET checked_at = excluded.checked_at`
    ).run();
    expect(await supplementIsbns("C3")).toEqual([a]);
  });

  it("リストの ISBN 解決は逆引き表から補完の巻を引く", async () => {
    await env.DB.prepare(`INSERT INTO series_supplement (series_id, volumes_json, checked_at) VALUES ('C9', ?, 1)`)
      .bind(JSON.stringify([vol([a, b], "10")]))
      .run();
    const books = await resolveBooks(env, [b, c]);
    expect(books.get(b)?.title).toBe("テスト作品 10");
    expect(books.get(b)?.series_id).toBe("C9");
    expect(books.get(c)?.title).toBe(""); // どこにも無い ISBN
  });
});

describe("readMaterialized（meta への materialize）", () => {
  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM meta`).run();
  });
  const keys = { json: "t_json", at: "t_at" };

  it("TTL 内は再計算しない", async () => {
    let n = 0;
    const compute = async () => ({ v: ++n });
    expect(await readMaterialized(env, keys, 60_000, compute)).toEqual({ v: 1 });
    expect(await readMaterialized(env, keys, 60_000, compute)).toEqual({ v: 1 });
    expect(n).toBe(1);
  });

  it("TTL 切れに同時に来ても再計算するのは 1 件だけで、他は古い結果を返す", async () => {
    let n = 0;
    await readMaterialized(env, keys, 60_000, async () => ({ v: ++n }));
    await env.DB.prepare(`UPDATE meta SET value = '1' WHERE key = ?`).bind(keys.at).run(); // 大昔に計算した扱い
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = async () => {
      await gate;
      return { v: ++n };
    };
    const first = readMaterialized(env, keys, 60_000, slow);
    // first が計算時刻の行を取ってから 2 件目を出す
    await new Promise((r) => setTimeout(r, 50));
    const second = await readMaterialized(env, keys, 60_000, slow);
    expect(second).toEqual({ v: 1 }); // 古い結果
    release();
    expect(await first).toEqual({ v: 2 });
    expect(n).toBe(2);
  });

  it("再計算に失敗したら古い結果を返す", async () => {
    await readMaterialized(env, keys, 60_000, async () => ({ v: 1 }));
    await env.DB.prepare(`UPDATE meta SET value = '1' WHERE key = ?`).bind(keys.at).run();
    const res = await readMaterialized(env, keys, 60_000, async () => {
      throw new Error("boom");
    });
    expect(res).toEqual({ v: 1 });
  });
});

describe("ADULT_RATING（MADB の成年コミック判定）", () => {
  it("contentRating の成年向け表記だけを拾い、未成年や空は拾わない", () => {
    for (const s of ["成年コミック", "成年コミックス", "成人コミック", "成年向けコミックス"]) expect(ADULT_RATING.test(s)).toBe(true);
    for (const s of ["", "無", "有", "未成年", "28"]) expect(ADULT_RATING.test(s)).toBe(false);
  });
});
