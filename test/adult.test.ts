import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { ADULT_BLOCK_MESSAGE, findAdultIsbns } from "../src/adult";
import type { Env } from "../src/types";
import { BROWSER_UA, createList, items, updateList } from "./helpers";

// 成年向けとして取り込みから外した巻（adult_volumes, scripts/ingest.mjs）を、検索・手動追加・公開で
// 「成年向けの作品は、こちら側のサイトでは追加できません。」と明示して止める（src/adult.ts）。

const ADULT_ISBN = "9784814801381"; // 『パーガトリー』（ジーオーティー, contentRating 成年コミック）

beforeAll(async () => {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR REPLACE INTO adult_volumes (isbn, title, title_norm, series_name) VALUES (?, ?, ?, ?)`
    ).bind(ADULT_ISBN, "パーガトリー", "パーガトリー", "パーガトリー"),
    // 一般向けのシリーズ（成年向けと同じ語を含む書名で、通常の結果は返り続けることを見る）。
    env.DB.prepare(
      `INSERT OR REPLACE INTO series (id, name, name_norm, name_search, creator) VALUES (?, ?, ?, ?, ?)`
    ).bind("C900001", "パーガトリー戦記", "パーガトリー戦記", "パーガトリー戦記", "作者"),
    env.DB.prepare(
      `INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, title_search, creator)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind("9784000000002", "C900001", "1", 1, "パーガトリー戦記", "パーガトリー戦記", "作者"),
  ]);
});

async function search(q: string) {
  const res = await SELF.fetch(`https://example.com/api/search?q=${encodeURIComponent(q)}`, {
    headers: { "user-agent": BROWSER_UA },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    results: { series_id: string }[];
    blocked?: { reason: string; message: string };
    adult_hits?: boolean;
    adult_message?: string;
    isbn_miss?: boolean;
  };
}

describe("成年向けの作品の追加拒否", () => {
  it("findAdultIsbns は adult_volumes にある ISBN だけを書名付きで返す", async () => {
    const hit = await findAdultIsbns(env as unknown as Env, [ADULT_ISBN, "9784000000002", ""]);
    expect([...hit]).toEqual([[ADULT_ISBN, "パーガトリー"]]);
  });

  it("ISBN 検索は結果なし＋blocked（見つからない扱いにしない）", async () => {
    for (const q of [ADULT_ISBN, "978-4-8148-0138-1"]) {
      const data = await search(q);
      expect(data.results).toEqual([]);
      expect(data.isbn_miss).toBeUndefined();
      expect(data.blocked?.reason).toBe("adult");
      expect(data.blocked?.message).toContain(ADULT_BLOCK_MESSAGE);
    }
  });

  it("書名検索は通常の結果を返しつつ adult_hits を立てる", async () => {
    const data = await search("パーガトリー");
    expect(data.results.map((r) => r.series_id)).toContain("C900001");
    expect(data.adult_hits).toBe(true);
    expect(data.adult_message).toBe(ADULT_BLOCK_MESSAGE);
  });

  it("成年向けに当たらない書名検索には adult_hits を付けない", async () => {
    const data = await search("まったく関係ない書名");
    expect(data.adult_hits).toBeUndefined();
  });

  it("成年向けの ISBN を含むリストは公開できない", async () => {
    const list = items();
    list[10] = { isbn: ADULT_ISBN, comment: "", spoiler: false };
    const res = await SELF.fetch("https://example.com/api/lists", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": BROWSER_UA },
      body: JSON.stringify({ owner_name: "テスト", items: list }),
    });
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain(ADULT_BLOCK_MESSAGE);
    expect(error).toContain("パーガトリー");
  });

  it("更新公開でも成年向けの ISBN は弾く", async () => {
    const { slug, edit_token } = await createList();
    const list = items();
    list[0] = { isbn: ADULT_ISBN, comment: "", spoiler: false };
    const res = await updateList(slug, { edit_token, items: list });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(ADULT_BLOCK_MESSAGE);
  });

  it("シリーズへの手動追加（抜け巻）でも成年向けの ISBN は弾く", async () => {
    const res = await SELF.fetch("https://example.com/api/series/C900001/corrections", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": BROWSER_UA },
      body: JSON.stringify({ isbn: ADULT_ISBN, volume_number: "2" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(ADULT_BLOCK_MESSAGE);
    const row = await env.DB.prepare(`SELECT 1 FROM series_correction WHERE isbn = ?`).bind(ADULT_ISBN).first();
    expect(row).toBeNull();
  });
});
