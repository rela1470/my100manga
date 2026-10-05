import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { BROWSER_UA, makeIsbns } from "./helpers";
import { adminDeleteNameOverride, adminListNameOverrides, adminOverrideSeriesName } from "../src/admin";
import { handleSearch } from "../src/search";
import { bumpViewEpoch } from "../src/viewSnapshot";
import type { Env } from "../src/types";

// 管理者が直したシリーズ名（series_name_override）を検索の鍵にもする仕組み。
//
// キーワード検索の本体はマスタの列（name_norm / name_search / name_kana_norm）だけを見るので、
// マスタが書名を壊している作品は正しい名前では 1 件も当たらない。実例が『Dr.スランプ』の
// ジャンプ・コミックス版 18 巻（G9784088511818）で、書名が「Dr」で入っているうえシリーズにも
// 属していない（＝読みも無い）。管理者が名前を直すと、その名前で検索に出て、完全一致なら
// 同名のマスタ行（『Dr.スランプ』は同名シリーズが 5 件ある）より先頭に出る。

const adminEnv = env as unknown as Env;
const CREATOR = "試験上書作者";
const LABEL = "試験ウワガキコミックス";

const BROKEN = "試験ドクタ";              // マスタが壊した書名＝まとまりの名前
const FIXED = "試験ドクタースランプ";      // 管理者が直した名前
const [G1, G2, G3] = makeIsbns(3, 961000); // まとまりの正規 ID は最小の G1
const GROUP_ID = "G" + G1;

// 同じ名前を名乗るマスタのシリーズ。まとまり（3 巻）より巻数が多いので、巻数だけで並べると
// こちらが先に出る ＝ 上書きの完全一致が 1 段上にあることを確かめられる。
const RIVAL = "CZ901";
const RIVAL_VOLS = 5;
const rivalIsbns = makeIsbns(RIVAL_VOLS, 962000);

// 名前を直した既存シリーズ（C-id）。マスタ名では当たらない名前で引けるようになる。
const RENAMED = "CZ902";
const RENAMED_MASTER = "試験コワレタナマエ";
const RENAMED_FIXED = "試験ナオシタナマエ";
const renamedIsbns = makeIsbns(2, 963000);

function overrideRequest(name: string): Request {
  return new Request("https://example.com/api/admin/series-reports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

async function search(q: string, offset = 0) {
  const res = await SELF.fetch(
    `https://example.com/api/search?q=${encodeURIComponent(q)}&offset=${offset}`,
    { headers: { "user-agent": BROWSER_UA } }
  );
  expect(res.status).toBe(200);
  return (await res.json()) as {
    results: { series_id: string; title: string; volume_count: number }[];
    next_offset: number | null;
  };
}

beforeAll(async () => {
  const stmts = [];
  // シリーズに属さない 3 巻（書名は壊れたまま）。
  [G1, G2, G3].forEach((isbn, i) => {
    stmts.push(
      env.DB.prepare(
        `INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, title_search, creator, publisher, label, pubdate)
         VALUES (?, NULL, ?, ?, ?, ?, ?, '試験社', ?, ?)`
      ).bind(isbn, String(i + 1), i + 1, BROKEN, BROKEN, CREATOR, LABEL, `1980-0${i + 1}`)
    );
  });
  // 直した名前と同名のマスタのシリーズ（巻数はまとまりより多い）。
  stmts.push(
    env.DB.prepare(
      `INSERT OR REPLACE INTO series (id, name, name_norm, name_search, creator, num_items) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(RIVAL, FIXED, FIXED, FIXED, CREATOR, RIVAL_VOLS)
  );
  rivalIsbns.forEach((isbn, i) => {
    stmts.push(
      env.DB.prepare(
        `INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, title_search, creator)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(isbn, RIVAL, String(i + 1), i + 1, FIXED, FIXED, CREATOR)
    );
  });
  // 名前が壊れた既存シリーズ。
  stmts.push(
    env.DB.prepare(
      `INSERT OR REPLACE INTO series (id, name, name_norm, name_search, creator, num_items) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(RENAMED, RENAMED_MASTER, RENAMED_MASTER, RENAMED_MASTER, CREATOR, 2)
  );
  renamedIsbns.forEach((isbn, i) => {
    stmts.push(
      env.DB.prepare(
        `INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, title_search, creator)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(isbn, RENAMED, String(i + 1), i + 1, RENAMED_MASTER, RENAMED_MASTER, CREATOR)
    );
  });
  await env.DB.batch(stmts);
});

describe("直した名前で検索に当てる（series_name_override）", () => {
  it("直す前は、正しい名前では 1 件も当たらない", async () => {
    const data = await search(FIXED);
    // マスタの同名シリーズだけ。壊れた書名のまとまりは影も形も無い。
    expect(data.results.map((r) => r.series_id)).toEqual([RIVAL]);
  });

  it("まとまりの名前を直すと、その名前で当たり、同名のマスタ行より先に出る", async () => {
    const res = await adminOverrideSeriesName(overrideRequest(FIXED), adminEnv, GROUP_ID);
    expect(res.status).toBe(200);
    await bumpViewEpoch(env); // 本番は admin の更新系 API 成功後に index.ts が上げる

    const data = await search(FIXED);
    const ids = data.results.map((r) => r.series_id);
    // 巻数は 3 対 5 で負けているが、上書きの完全一致は 1 段上なので先頭。
    expect(ids[0]).toBe(GROUP_ID);
    expect(ids).toContain(RIVAL);
    const card = data.results[0];
    expect(card.title).toBe(FIXED);
    expect(card.volume_count).toBe(3);
  });

  it("壊れたままのマスタの書名でも引き続き当たり、二重に出ない", async () => {
    const data = await search(BROKEN);
    const mine = data.results.filter((r) => r.series_id === GROUP_ID);
    // 直した名前（前方一致）とマスタの書名（discoverUnlinked）の両方で当たるが 1 枚だけ。
    expect(mine).toHaveLength(1);
    expect(mine[0].title).toBe(FIXED);
  });

  it("既存シリーズ（C-id）の名前も、直した名前で引けるようになる", async () => {
    const before = await search(RENAMED_FIXED);
    expect(before.results).toHaveLength(0);

    const res = await adminOverrideSeriesName(overrideRequest(RENAMED_FIXED), adminEnv, RENAMED);
    expect(res.status).toBe(200);
    await bumpViewEpoch(env);

    const after = await search(RENAMED_FIXED);
    expect(after.results.map((r) => r.series_id)).toEqual([RENAMED]);
    expect(after.results[0].title).toBe(RENAMED_FIXED);
    // マスタの名前でも従来どおり当たる。
    expect((await search(RENAMED_MASTER)).results.map((r) => r.series_id)).toEqual([RENAMED]);
  });

  it("2 ページ目には足さない（1 ページ目と重ねない）", async () => {
    const data = await search(FIXED, 30);
    expect(data.results.map((r) => r.series_id)).not.toContain(GROUP_ID);
  });
});

// R18版（SITE_VARIANT="adult"）の検索は既定で成年向け（is_adult = 1）だけを出す。直した名前での
// 照合にも同じ絞り込みを掛ける。テストの Worker は本家で動くので env を差し替えて直接呼ぶ。
describe("R18版では、直した名前での照合にも成年向けの絞り込みが効く", () => {
  const adultEnv = { ...(env as unknown as Env), SITE_VARIANT: "adult" } as Env;
  const FIXED_R18 = "試験セイネンドクター";
  const [ADULT_ISBN, GENERAL_ISBN] = makeIsbns(2, 964000);
  const ADULT_GROUP = "G" + ADULT_ISBN;
  const GENERAL_GROUP = "G" + GENERAL_ISBN;

  async function adultSearch(q: string, all = false) {
    const url = `https://example.com/api/search?q=${encodeURIComponent(q)}${all ? "&all=1" : ""}`;
    const res = await handleSearch(new Request(url, { headers: { "user-agent": BROWSER_UA } }), adultEnv);
    expect(res.status).toBe(200);
    return ((await res.json()) as { results: { series_id: string }[] }).results.map((r) => r.series_id);
  }

  beforeAll(async () => {
    // 成年向けのまとまりと全年齢のまとまりを 1 つずつ。どちらも書名はマスタが壊していて、
    // 管理者が同じ名前（検索語）に直してある。
    for (const [isbn, title, adult] of [
      [ADULT_ISBN, "試験セイネンコワレ", 1],
      [GENERAL_ISBN, "試験ゼンネンコワレ", 0],
    ] as [string, string, number][]) {
      await env.DB.prepare(
        `INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, title_search, creator, label, is_adult)
         VALUES (?, NULL, '1', 1, ?, ?, ?, ?, ?)`
      )
        .bind(isbn, title, title, CREATOR, LABEL + title, adult)
        .run();
    }
    await adminOverrideSeriesName(overrideRequest(FIXED_R18), adminEnv, ADULT_GROUP);
    await adminOverrideSeriesName(overrideRequest(FIXED_R18), adminEnv, GENERAL_GROUP);
    await bumpViewEpoch(env);
  });

  it("成年向けのまとまりは出て、全年齢のまとまりは出ない", async () => {
    const ids = await adultSearch(FIXED_R18);
    expect(ids).toContain(ADULT_GROUP);
    expect(ids).not.toContain(GENERAL_GROUP);
  });

  it("「全年齢の作品も含める」を付ければ両方出る", async () => {
    const ids = await adultSearch(FIXED_R18, true);
    expect(ids).toContain(ADULT_GROUP);
    expect(ids).toContain(GENERAL_GROUP);
  });
});

// 修正を外す（src/admin.ts adminDeleteNameOverride、管理画面の「修正を外す」）。タグ
// （廉価版・文庫版・傑作選）が版の違いを言えるようになり、修正名がタグと同じことしか
// 言っていないときの片付け。表示名はマスターの名前に戻り、直した名前での引き当ても消える。
describe("修正を外す（series_name_override の削除）", () => {
  const DROPPED = "CZ903";
  const DROPPED_MASTER = "試験ハズスマエノナマエ";
  const DROPPED_FIXED = "試験ハズスナオシタナマエ";
  const droppedIsbns = makeIsbns(2, 965000);

  // 本番は /api/admin/* ごと Cloudflare Access で守られていて SELF.fetch は 403 になるので、
  // 他の admin テストと同じくハンドラを直接呼ぶ。
  function drop(seriesId: string) {
    return adminDeleteNameOverride(adminEnv, seriesId);
  }

  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR REPLACE INTO series (id, name, name_norm, name_search, creator, num_items) VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(DROPPED, DROPPED_MASTER, DROPPED_MASTER, DROPPED_MASTER, CREATOR, 2),
      ...droppedIsbns.map((isbn, i) =>
        env.DB.prepare(
          `INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, title_search, creator)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(isbn, DROPPED, String(i + 1), i + 1, DROPPED_MASTER, DROPPED_MASTER, CREATOR)
      ),
    ]);
    await adminOverrideSeriesName(overrideRequest(DROPPED_FIXED), adminEnv, DROPPED);
    await bumpViewEpoch(env);
  });

  it("外すと表示名がマスターに戻り、直した名前では当たらなくなる", async () => {
    // 外す前: 直した名前で引けて、カードもその名前。
    expect((await search(DROPPED_FIXED)).results.map((r) => r.series_id)).toEqual([DROPPED]);

    const res = await drop(DROPPED);
    expect(res.status).toBe(200);
    await bumpViewEpoch(env);

    expect((await search(DROPPED_FIXED)).results).toHaveLength(0);
    const after = await search(DROPPED_MASTER);
    expect(after.results.map((r) => r.series_id)).toEqual([DROPPED]);
    expect(after.results[0].title).toBe(DROPPED_MASTER);
  });

  it("修正の無いシリーズを外そうとしたら 404", async () => {
    const res = await drop(DROPPED);
    expect(res.status).toBe(404);
  });

  it("まとまり（G-id）の修正も外せる", async () => {
    expect((await search(FIXED)).results.map((r) => r.series_id)[0]).toBe(GROUP_ID);

    const res = await drop(GROUP_ID);
    expect(res.status).toBe(200);
    await bumpViewEpoch(env);

    // 直した名前では当たらなくなり、壊れたままのマスタの書名では従来どおり当たる。
    expect((await search(FIXED)).results.map((r) => r.series_id)).not.toContain(GROUP_ID);
    const back = await search(BROKEN);
    expect(back.results.map((r) => r.series_id)).toContain(GROUP_ID);
    expect(back.results.find((r) => r.series_id === GROUP_ID)?.title).toBe(BROKEN);
  });
});

// 一覧に今のタグを添える（src/admin.ts adminListNameOverrides）。タグができる前の修正は
// 「○○ 文庫版」のように版の違いを名前へ書き込んでいるので、同じことをバッジが言っていれば
// 外せる、と管理画面の一覧の上で見分けられるようにしてある。
describe("修正の一覧に、今そのシリーズに出ているタグを添える", () => {
  const TAGGED = "CZ904";
  const TAGGED_LABEL = "試験ブンコレーベル";

  async function listedTag(seriesId: string) {
    const res = await adminListNameOverrides(adminEnv, { page: 1, per: 200, offset: 0 });
    const data = (await res.json()) as { overrides: { series_id: string; tag: string; label: string }[] };
    return data.overrides.find((o) => o.series_id === seriesId);
  }

  beforeAll(async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR REPLACE INTO series (id, name, name_norm, name_search, creator, label, num_items)
         VALUES (?, ?, ?, ?, ?, ?, 1)`
      ).bind(TAGGED, "試験タグツキ", "試験タグツキ", "試験タグツキ", CREATOR, TAGGED_LABEL),
      env.DB.prepare(
        `INSERT OR REPLACE INTO label_tag (label, tag, created_at, updated_at) VALUES (?, '文庫版', 1, 1)`
      ).bind(TAGGED_LABEL),
    ]);
    await adminOverrideSeriesName(overrideRequest("試験タグツキ 文庫版"), adminEnv, TAGGED);
  });

  it("レーベルのタグが出ている", async () => {
    const row = await listedTag(TAGGED);
    expect(row?.tag).toBe("文庫版");
    expect(row?.label).toBe(TAGGED_LABEL);
  });

  it("シリーズ個別の上書き（series_tag）はレーベルのタグより優先する", async () => {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO series_tag (series_id, tag, created_at, updated_at) VALUES (?, '廉価版', 1, 1)`
    )
      .bind(TAGGED)
      .run();
    expect((await listedTag(TAGGED))?.tag).toBe("廉価版");

    // tag = '' は「タグ無し」を明示する上書き。レーベルのタグを打ち消す。
    await env.DB.prepare(`UPDATE series_tag SET tag = '' WHERE series_id = ?`).bind(TAGGED).run();
    expect((await listedTag(TAGGED))?.tag).toBe("");
  });

  it("タグが無ければ空（修正を外すと版の違いを示すものが無くなる印）", async () => {
    expect((await listedTag(RENAMED))?.tag).toBe("");
  });
});
