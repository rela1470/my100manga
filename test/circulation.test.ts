import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  computeCirculation,
  refreshCirculation,
  suggestCirculationLinks,
  type CirculationEntry,
} from "../src/circulation";
import { warmNext } from "../src/warm";
import { normTitle } from "../src/util";
import { edgeCacheKey } from "../src/edgeCache";
import { makeIsbns } from "./helpers";

// 発行部数ランキング（src/circulation.ts）と、そこを起点にしたキャッシュ暖機（src/warm.ts）。
// 外部 API は叩かない: テストの bindings は RAKUTEN_APP_ID / YAHOO_APP_ID が空で GOOGLE_ENABLED も
// 無いので、resolveCovers はどの取得元も使えず即座に「表紙なし」（covers に空文字）で確定する。
// 暖機のテストは、どの ISBN を対象に選ぶかと cursor の進み方だけを見る。

let nextIsbn = 0;

/** マスタのシリーズと巻を作る。巻数 = num_items。 */
async function seedSeries(id: string, name: string, volumes: number): Promise<string[]> {
  const isbns = makeIsbns(volumes, (nextIsbn += 1000));
  await env.DB.prepare(
    `INSERT INTO series (id, name, name_norm, creator, publisher, num_items) VALUES (?, ?, ?, '作者', '出版社', ?)`
  )
    .bind(id, name, normTitle(name), volumes)
    .run();
  await env.DB.batch(
    isbns.map((isbn, i) =>
      env.DB.prepare(
        `INSERT INTO volumes (isbn, series_id, volume_number, vol_sort, title, creator, publisher)
         VALUES (?, ?, ?, ?, ?, '作者', '出版社')`
      ).bind(isbn, id, String(i + 1), i + 1, name)
    )
  );
  return isbns;
}

async function seedCirculation(rows: Array<{ title: string; copies: number; as_of?: string }>): Promise<void> {
  await env.DB.batch(
    rows.map((r, i) =>
      env.DB.prepare(
        `INSERT INTO circulation (article, title_ja, title_en, author, publisher, copies, as_of, updated_at)
         VALUES (?, ?, ?, 'Author', 'Publisher', ?, ?, 1)`
      ).bind(`article-${i}`, r.title, `Title ${i}`, r.copies, r.as_of ?? "2026-01")
    )
  );
}

const titles = (entries: CirculationEntry[]) => entries.map((e) => e.title);

beforeEach(async () => {
  // /api/circulation はエッジ（caches.default）にも載る。キャッシュはテストファイル内で
  // 共有されるので、前のテストの結果を引かないよう消してから始める。
  await caches.default.delete(edgeCacheKey(env, "/api/circulation"));
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM circulation`),
    env.DB.prepare(`DELETE FROM circulation_link`),
    env.DB.prepare(`DELETE FROM series_merge`),
    env.DB.prepare(`DELETE FROM volumes`),
    env.DB.prepare(`DELETE FROM series`),
    env.DB.prepare(`DELETE FROM covers`),
    env.DB.prepare(`DELETE FROM meta`),
  ]);
});

describe("発行部数ランキングの集計", () => {
  it("取り込みが空なら空の集計を返す（キャッシュさせない）", async () => {
    const res = await SELF.fetch("https://example.com/api/circulation");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(((await res.json()) as { entries: unknown[] }).entries).toEqual([]);
  });

  it("部数の多い順に並べ、同名のシリーズへリンクを付ける", async () => {
    await seedSeries("C1", "テスト作品A", 3);
    await seedSeries("C2", "テスト作品B", 2);
    await seedCirculation([
      { title: "テスト作品B", copies: 20_000_000 },
      { title: "テスト作品A", copies: 500_000_000 },
    ]);

    const payload = await computeCirculation(env);
    expect(titles(payload.entries)).toEqual(["テスト作品A", "テスト作品B"]);
    expect(payload.entries[0].rank).toBe(1);
    expect(payload.entries[0].series_id).toBe("C1");
    expect(payload.entries[1].series_id).toBe("C2");
    // 寄せ先があるときは検索語を出さない（公開ページは巻一覧へリンクする）。
    expect(payload.entries[0].search_q).toBe("");
  });

  it("マスタに無い作品も順位には出し、検索語を添える", async () => {
    await seedCirculation([{ title: "マスタに無い作品", copies: 30_000_000 }]);

    const payload = await computeCirculation(env);
    expect(payload.entries).toHaveLength(1);
    expect(payload.entries[0].series_id).toBeNull();
    expect(payload.entries[0].search_q).toBe("マスタに無い作品");
  });

  it("表紙がキャッシュに無ければ、寄せ先の最新巻の ISBN を返す（閲覧側が引く）", async () => {
    const isbns = await seedSeries("C1", "テスト作品A", 3);
    await seedCirculation([{ title: "テスト作品A", copies: 100_000_000 }]);

    const payload = await computeCirculation(env);
    expect(payload.entries[0].cover_url).toBe("");
    expect(payload.entries[0].cover_isbn).toBe(isbns[2]); // 最新巻

    await env.DB.prepare(`INSERT INTO covers (isbn, cover_url, checked_at) VALUES (?, 'https://example.com/c.jpg', 1)`)
      .bind(isbns[2])
      .run();
    const again = await computeCirculation(env);
    expect(again.entries[0].cover_url).toBe("https://example.com/c.jpg");
    expect(again.entries[0].cover_isbn).toBe("");
  });

  it("GET /api/circulation は集計と出典を返す", async () => {
    await seedSeries("C1", "テスト作品A", 1);
    await seedCirculation([{ title: "テスト作品A", copies: 100_000_000, as_of: "2026-03" }]);
    await env.DB.prepare(`INSERT INTO meta (key, value) VALUES ('circulation_source', ?)`)
      .bind(JSON.stringify({ url: "https://en.wikipedia.org/wiki/Special:PermanentLink/1", license: "CC BY-SA 4.0" }))
      .run();

    const res = await SELF.fetch("https://example.com/api/circulation");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: CirculationEntry[]; source: { license: string } | null };
    expect(titles(body.entries)).toEqual(["テスト作品A"]);
    expect(body.entries[0].as_of).toBe("2026-03");
    // 帰属表示はこの source から公開ページが組み立てる（public/circulation.js）。
    expect(body.source?.license).toBe("CC BY-SA 4.0");
  });

});

describe("寄せ先の指定（circulation_link）", () => {
  async function link(article: string, seriesId: string, source = "manual"): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO circulation_link (article, series_id, source, created_at) VALUES (?, ?, ?, 1)`
    )
      .bind(article, seriesId, source)
      .run();
  }

  it("指定があれば自動照合より優先する", async () => {
    await seedSeries("C1", "テスト作品A", 3);
    await seedSeries("C2", "まったく別の作品", 2);
    await seedCirculation([{ title: "テスト作品A", copies: 100_000_000 }]);
    // 自動なら C1 に寄るところを、C2 に指定する。
    await link("article-0", "C2");

    const payload = await computeCirculation(env);
    expect(payload.entries[0].series_id).toBe("C2");
  });

  it("series_id が '' なら寄せない（自動照合もしない）", async () => {
    await seedSeries("C1", "テスト作品A", 3);
    await seedCirculation([{ title: "テスト作品A", copies: 100_000_000 }]);
    await link("article-0", "");

    const payload = await computeCirculation(env);
    expect(payload.entries[0].series_id).toBeNull();
    expect(payload.entries[0].search_q).toBe("テスト作品A");
  });

  it("指定先が結合されていたら結合先へ追従する", async () => {
    await seedSeries("C1", "テスト作品A", 3);
    await seedSeries("C2", "テスト作品A 文庫版", 2);
    await seedCirculation([{ title: "テスト作品A", copies: 100_000_000 }]);
    await link("article-0", "C2");
    // C2 を C1 に吸収させる。
    await env.DB.prepare(`INSERT INTO series_merge (absorbed_id, target_id, created_at) VALUES ('C2', 'C1', 1)`).run();

    const payload = await computeCirculation(env);
    expect(payload.entries[0].series_id).toBe("C1");
  });

  it("指定先がマスタから消えていたら、勝手に別のシリーズへ寄せない", async () => {
    await seedSeries("C1", "テスト作品A", 3);
    await seedCirculation([{ title: "テスト作品A", copies: 100_000_000 }]);
    await link("article-0", "C-gone");

    const payload = await computeCirculation(env);
    // 自動照合なら C1 に寄るが、管理者の判断を黙って覆さない。
    expect(payload.entries[0].series_id).toBeNull();
  });

  it("サジェストの取り込みは手動の指定を上書きしない", async () => {
    await seedSeries("C1", "テスト作品A", 3);
    await seedSeries("C2", "テスト作品B", 2);
    await seedCirculation([
      { title: "テスト作品A", copies: 100_000_000 },
      { title: "テスト作品B", copies: 50_000_000 },
    ]);
    await link("article-0", "C2"); // A をあえて B のシリーズに手動指定

    const first = await suggestCirculationLinks(env, false);
    expect(first.added).toBe(1); // 指定の無い B だけ埋まる
    expect(first.kept).toBe(1);

    // overwrite でも 'manual' は残る。
    await suggestCirculationLinks(env, true);
    const payload = await computeCirculation(env);
    expect(payload.entries[0].series_id).toBe("C2"); // 手動のまま
    expect(payload.entries[1].series_id).toBe("C2"); // B は自動で C2
  });

  it("寄せ先が見つからない作品には行を作らない（あとで拾えるように）", async () => {
    await seedCirculation([{ title: "マスタに無い作品", copies: 30_000_000 }]);
    const r = await suggestCirculationLinks(env, false);
    expect(r.added).toBe(0);
    const rows = await env.DB.prepare(`SELECT COUNT(*) AS n FROM circulation_link`).first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });
});

describe("キャッシュ暖機", () => {
  it("発行部数ランキングの寄せ先から、まだ covers に無い巻を選ぶ", async () => {
    const isbnsA = await seedSeries("C1", "テスト作品A", 3);
    await seedCirculation([{ title: "テスト作品A", copies: 100_000_000 }]);
    await refreshCirculation(env);

    const r = await warmNext(env, "circulation", "", 8);
    expect(r.attempted).toBe(3); // そのシリーズの 3 巻が対象
    expect(r.done).toBe(false);
    // 対象が見つかったチャンクで止まる（残りがあるうちは cursor を進めない）。
    expect(r.cursor).toBe("");
    const warmed = await env.DB.prepare(`SELECT isbn FROM covers ORDER BY isbn`).all<{ isbn: string }>();
    expect(warmed.results?.map((x) => x.isbn)).toEqual([...isbnsA].sort());
  });

  it("温め済みのシリーズは読み飛ばして終わる", async () => {
    const isbns = await seedSeries("C1", "テスト作品A", 3);
    await seedCirculation([{ title: "テスト作品A", copies: 100_000_000 }]);
    await refreshCirculation(env);
    await env.DB.batch(
      isbns.map((isbn) =>
        env.DB.prepare(`INSERT INTO covers (isbn, cover_url, checked_at) VALUES (?, '', 1)`).bind(isbn)
      )
    );

    const r = await warmNext(env, "circulation", "", 8);
    expect(r.attempted).toBe(0);
    expect(r.done).toBe(true);
    expect(r.cursor).toBeNull();
  });

  it("寄せ先が無ければ暖機する対象も無い", async () => {
    await seedCirculation([{ title: "マスタに無い作品", copies: 30_000_000 }]);
    await refreshCirculation(env);

    const r = await warmNext(env, "circulation", "", 8);
    expect(r.done).toBe(true);
    expect(r.attempted).toBe(0);
  });

  it("series は巻数の多いシリーズから順に進み、cursor で続きから再開できる", async () => {
    await seedSeries("C1", "巻の多い作品", 5);
    await seedSeries("C2", "巻の少ない作品", 2);

    const first = await warmNext(env, "series", "", 8);
    // 1 チャンク（60 シリーズ）に両方入るので、巻数順に 7 件すべてが候補になる。
    expect(first.attempted).toBe(7);
    expect(first.cursor).toBe("");

    // cursor を渡すと、その続き（= 巻数がそれ以下のシリーズ）だけを見る。1 回目で covers が
    // 埋まっているので、対象の選ばれ方だけを見るために消してから確かめる。
    await env.DB.prepare(`DELETE FROM covers`).run();
    const rest = await warmNext(env, "series", "5:C1", 8);
    expect(rest.attempted).toBe(2);
  });
});
