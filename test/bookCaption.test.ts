import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { BROWSER_UA, makeIsbns } from "./helpers";

// あらすじ（楽天 itemCaption = 出版社の内容紹介文）は全文を返さない。/api/book は冒頭
// 100 字までに切り、切ったことを caption_truncated で伝える（クライアントは続きを楽天
// ブックスへ送る。public/book-detail.js）。D1 のキャッシュは全文のまま持つ。
// 全文転載は引用（著作権法32条）の主従関係を満たさないので、返す側で切るのが要件。

const [LONG, SHORT] = makeIsbns(2, 940000);
// 切る対象は「文字」数（コードポイント）。全角でも 100 字で切れること。
const LONG_CAPTION = "あ".repeat(250);
const SHORT_CAPTION = "短いあらすじ。";

async function book(isbn: string) {
  const res = await SELF.fetch(`https://example.com/api/book?isbn=${isbn}`, {
    headers: { "user-agent": BROWSER_UA },
  });
  expect(res.status).toBe(200);
  return res.json<{ caption: string; caption_truncated: boolean }>();
}

beforeAll(async () => {
  // caption が空でないキャッシュ行は楽天を引かずにそのまま返る経路（handleBook の最初の
  // return）。実運用でいちばん通る道なので、ここで切れていることを確かめる。
  for (const [isbn, caption] of [
    [LONG, LONG_CAPTION],
    [SHORT, SHORT_CAPTION],
  ] as const) {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO book_meta (isbn, authors, publisher, pubdate, caption, checked_at)
       VALUES (?, '試験作者', '試験社', '2020年1月1日', ?, ?)`
    )
      .bind(isbn, caption, Date.now())
      .run();
  }
});

describe("GET /api/book のあらすじ", () => {
  it("100 字を超えるあらすじは切って caption_truncated を立てる", async () => {
    const b = await book(LONG);
    expect(b.caption).toBe("あ".repeat(100) + "…");
    expect(b.caption_truncated).toBe(true);
  });

  it("100 字以下のあらすじはそのまま返す", async () => {
    const b = await book(SHORT);
    expect(b.caption).toBe(SHORT_CAPTION);
    expect(b.caption_truncated).toBe(false);
  });

  it("D1 のキャッシュは全文のまま持つ（取り直しの判定に使うので切らない）", async () => {
    const row = await env.DB.prepare(`SELECT caption FROM book_meta WHERE isbn = ?`)
      .bind(LONG)
      .first<{ caption: string }>();
    expect(row?.caption).toBe(LONG_CAPTION);
  });
});
