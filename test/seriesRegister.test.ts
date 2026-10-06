import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  adminDismissRegisterRequest,
  adminListRegisterRequests,
  adminRegisterCandidates,
  adminRegisterSeries,
  requestSeriesRegister,
} from "../src/seriesRegister";
import { adminDeleteMasterFix } from "../src/masterFix";
import { masterPubdate } from "../src/rakuten";
import { APPLY_LINKS_SQL } from "../src/groups";
import { turnstileAction } from "../src/turnstile";
import type { Env } from "../src/types";

// マスタ（MADB）に丸ごと無い作品をシリーズとして登録する仕組み（src/seriesRegister.ts）。
// 実例そのまま: 9784758061780『このこここのこ』1 巻（藤こよみ / 一迅社 IDコミックス REXコミックス /
// 全 3 巻）は MADB に 1 行も無く、楽天ブックスだけが 3 巻とも持っている。
//
// テスト環境は楽天・Yahoo の鍵が空（vitest.config.mts）なので外部 API は 1 回も呼ばれない。
// 候補集めは「鍵が無いときに何を返すか」まで、確定から先は D1 だけで完結するので全部見る。

const adminEnv = env as unknown as Env;
const page = { page: 1, per: 100, offset: 0 };

const V1 = "9784758061780";
const V2 = "9784758061957";
const V3 = "9784758062251";
const NAME = "このこここのこ";

// 月次取り込みのあとに載せ直す文（scripts/ingest.mjs）。node 側にしか無く import できないので
// 写して検査する。順序も本物と同じ（紐付け → マスタ行の修正の順で、後者が最終の値）。
const APPLY_MASTER_FIX_SQL =
  "INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, subtitle, title_search, " +
  "creator, creators, creators_norm, publisher, label, pubdate, is_adult) " +
  "SELECT isbn, series_id, volume_number, vol_sort, title, subtitle, title_search, " +
  "creator, creators, creators_norm, publisher, label, pubdate, is_adult FROM volume_master_fix";

function requestOf(body: Record<string, unknown>, path: string): Request {
  return new Request(`https://example.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const askRequest = (body: Record<string, unknown>) => requestOf(body, "/api/series-register-requests");
const saveRequest = (body: Record<string, unknown>) => requestOf(body, "/api/admin/series-register");

function candidatesUrl(isbn: string, extra: Record<string, string> = {}): URL {
  const u = new URL("https://example.com/api/admin/series-register/candidates");
  u.searchParams.set("isbn", isbn);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  return u;
}

function listUrl(resolved = false): URL {
  const u = new URL("https://example.com/api/admin/series-register-requests");
  if (resolved) u.searchParams.set("resolved", "1");
  return u;
}

/** 1 冊ライブカードを開いた直後の状態（src/search.ts rakutenCard が live_volumes に控える）。 */
async function seedLiveVolume(): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO live_volumes (isbn, title, volume_number, author, fetched_at)
     VALUES (?, 'このこここのこ（1）', '1', '藤こよみ', ?)`
  )
    .bind(V1, Date.now())
    .run();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO book_meta (isbn, authors, publisher, pubdate, caption, checked_at)
     VALUES (?, '藤こよみ', '一迅社', '2009年12月', '', ?)`
  )
    .bind(V1, Date.now())
    .run();
}

/** 管理画面の確定フォームが送る形。 */
function registerBody(extra: Record<string, unknown> = {}) {
  return {
    isbn: V1,
    name: NAME,
    creator: "藤こよみ",
    publisher: "一迅社",
    label: "IDコミックス　REXコミックス",
    note: "楽天ブックスで 3 巻とも確認",
    volumes: [
      { isbn: V1, volume_number: "1", pubdate: "2009-12" },
      { isbn: V2, volume_number: "2", pubdate: "2010-05" },
      { isbn: V3, volume_number: "3", pubdate: "2010-11" },
    ],
    ...extra,
  };
}

async function body(res: Response): Promise<any> {
  return res.json();
}

describe("シリーズの新規登録（マスタに丸ごと無い作品）", () => {
  beforeEach(async () => {
    await env.DB.batch(
      [
        "series_register_request",
        "volume_master_fix",
        "custom_series",
        "volume_series_link",
        "volumes",
        "series",
        "live_volumes",
        "book_meta",
        "adult_volumes",
        "covers",
      ].map((t) => env.DB.prepare(`DELETE FROM ${t}`))
    );
  });

  describe("利用者からの依頼（collect-only）", () => {
    it("ISBN だけを受け取り、書名・著者・出版社はサーバが自分の控えから引く", async () => {
      await seedLiveVolume();
      // 利用者が書名を詐称しても通らない: title を送っても無視される。
      const res = await requestSeriesRegister(askRequest({ isbn: V1, title: "<script>悪意</script>" }), adminEnv);
      expect(await body(res)).toMatchObject({ ok: true, queued: true });

      const row = await env.DB.prepare(`SELECT * FROM series_register_request WHERE isbn = ?`)
        .bind(V1)
        .first<Record<string, unknown>>();
      expect(row).toMatchObject({
        isbn: V1,
        title: "このこここのこ（1）", // live_volumes の控え
        creator: "藤こよみ",
        publisher: "一迅社", // book_meta の控え
        report_count: 1,
        resolved_at: 0,
        resolution: "",
      });
    });

    it("控えが無くても依頼は受ける（書名は空のまま）", async () => {
      const res = await requestSeriesRegister(askRequest({ isbn: V1 }), adminEnv);
      expect(await body(res)).toMatchObject({ queued: true });
      const row = await env.DB.prepare(`SELECT title, creator FROM series_register_request WHERE isbn = ?`)
        .bind(V1)
        .first<{ title: string; creator: string }>();
      expect(row).toEqual({ title: "", creator: "" });
    });

    it("同じ ISBN の再依頼は回数を増やすだけ（行は増えない）", async () => {
      await requestSeriesRegister(askRequest({ isbn: V1 }), adminEnv);
      await requestSeriesRegister(askRequest({ isbn: V1 }), adminEnv);
      const row = await env.DB.prepare(
        `SELECT COUNT(*) AS rows, MAX(report_count) AS n FROM series_register_request`
      ).first<{ rows: number; n: number }>();
      expect(row).toEqual({ rows: 1, n: 2 });
    });

    it("却下した依頼も、また求められたら開き直る（今もマスタに無いので）", async () => {
      await requestSeriesRegister(askRequest({ isbn: V1 }), adminEnv);
      await adminDismissRegisterRequest(adminEnv, V1);
      await requestSeriesRegister(askRequest({ isbn: V1 }), adminEnv);
      const row = await env.DB.prepare(
        `SELECT resolved_at, resolution, report_count FROM series_register_request WHERE isbn = ?`
      )
        .bind(V1)
        .first<{ resolved_at: number; resolution: string; report_count: number }>();
      expect(row).toEqual({ resolved_at: 0, resolution: "", report_count: 2 });
    });

    it("マスタが既に持っている巻は依頼にならない（already）", async () => {
      await env.DB.prepare(
        `INSERT INTO volumes (isbn, series_id, volume_number, vol_sort, title) VALUES (?, 'C1', '1', 1, ?)`
      )
        .bind(V1, NAME)
        .run();
      const res = await requestSeriesRegister(askRequest({ isbn: V1 }), adminEnv);
      expect(await body(res)).toMatchObject({ queued: false, already: true });
      expect(
        await env.DB.prepare(`SELECT COUNT(*) AS n FROM series_register_request`).first<{ n: number }>()
      ).toEqual({ n: 0 });
    });

    it("成年向けとして取り込みから外した巻は、理由を返して受け付けない", async () => {
      await env.DB.prepare(`INSERT INTO adult_volumes (isbn, title, title_norm) VALUES (?, ?, ?)`).bind(V1, NAME, NAME).run();
      const res = await requestSeriesRegister(askRequest({ isbn: V1 }), adminEnv);
      expect(res.status).toBe(400);
      expect((await body(res)).error).toContain("成年向け");
    });

    it("ISBN が不正なら 400", async () => {
      expect((await requestSeriesRegister(askRequest({ isbn: "12345" }), adminEnv)).status).toBe(400);
      // チェックディジットが合わない ISBN も通さない
      expect((await requestSeriesRegister(askRequest({ isbn: "9784758061781" }), adminEnv)).status).toBe(400);
    });

    it("ボット確認（Turnstile）の対象に入っている", () => {
      expect(turnstileAction("POST", "/api/series-register-requests")).toBe("feedback");
      expect(turnstileAction("GET", "/api/series-register-requests")).toBeNull();
    });
  });

  describe("候補集め", () => {
    it("控えの書名から巻数表記を外して作品名にする", async () => {
      await seedLiveVolume();
      const res = await adminRegisterCandidates(adminEnv, candidatesUrl(V1));
      expect(res.status).toBe(200);
      const data = await body(res);
      // 「このこここのこ（1）」→「このこここのこ」
      expect(data.work_title).toBe(NAME);
      expect(data.creator).toBe("藤こよみ");
      // 鍵が無い環境なので外部からは 1 件も集まらない
      expect(data.candidates).toEqual([]);
      expect(data).toMatchObject({ rakuten: false, yahoo: false });
    });

    it("作品名を指定すれば、控えが無くても引き直せる", async () => {
      const res = await adminRegisterCandidates(adminEnv, candidatesUrl(V1, { title: NAME, creator: "藤こよみ" }));
      expect((await body(res)).work_title).toBe(NAME);
    });

    it("書名がどこからも分からなければ 400（作品名を指定してと言う）", async () => {
      const res = await adminRegisterCandidates(adminEnv, candidatesUrl(V1));
      expect(res.status).toBe(400);
      expect((await body(res)).error).toContain("作品名");
    });
  });

  describe("確定（独自シリーズ＋マスタ巻）", () => {
    it("独自シリーズを 1 件作り、選んだ巻をマスタ行として入れる", async () => {
      await seedLiveVolume();
      await requestSeriesRegister(askRequest({ isbn: V1 }), adminEnv);

      const res = await adminRegisterSeries(saveRequest(registerBody()), adminEnv);
      expect(res.status).toBe(200);
      const data = await body(res);
      expect(data).toMatchObject({ ok: true, series_id: "U000001", volumes: 3 });

      // custom_series と、即時反映のための series 行の両方ができる
      expect(
        await env.DB.prepare(`SELECT id, name, name_norm, creator, publisher, label FROM custom_series`).first()
      ).toMatchObject({ id: "U000001", name: NAME, name_norm: NAME, creator: "藤こよみ", publisher: "一迅社" });
      expect(await env.DB.prepare(`SELECT id, name FROM series WHERE id = 'U000001'`).first()).toMatchObject({
        name: NAME,
      });

      // 巻はマスタ行そのものとして入り、検索キー・並び順も作られる
      const vols = await env.DB.prepare(
        `SELECT isbn, series_id, volume_number, vol_sort, title, title_search, creator, creators_norm, label, pubdate
           FROM volumes ORDER BY vol_sort`
      ).all<Record<string, unknown>>();
      expect(vols.results.map((v) => v.isbn)).toEqual([V1, V2, V3]);
      expect(vols.results[0]).toMatchObject({
        series_id: "U000001",
        volume_number: "1",
        vol_sort: 1,
        title: NAME,
        title_search: NAME,
        creator: "藤こよみ",
        creators_norm: "藤こよみ",
        label: "IDコミックス　REXコミックス",
        pubdate: "2009-12",
      });

      // 取り消しの控えは取らない（上流に無い巻を足したので、取り消し＝削除）
      const fixes = await env.DB.prepare(`SELECT isbn, prev_json, note FROM volume_master_fix`).all<{
        isbn: string;
        prev_json: string | null;
        note: string;
      }>();
      expect(fixes.results).toHaveLength(3);
      expect(fixes.results.every((f) => f.prev_json === null)).toBe(true);
      expect(fixes.results[0].note).toBe("楽天ブックスで 3 巻とも確認");

      // 依頼は「登録済み」になり、作ったシリーズが分かる
      expect(
        await env.DB.prepare(`SELECT resolution, series_id FROM series_register_request WHERE isbn = ?`)
          .bind(V1)
          .first()
      ).toEqual({ resolution: "registered", series_id: "U000001" });
    });

    it("月次取り込みでマスタを作り直しても、載せ直しで元に戻る", async () => {
      await adminRegisterSeries(saveRequest(registerBody()), adminEnv);
      // 取り込み相当: series / volumes を上流のもので総入れ替え（この作品は上流に無いので消える）
      await env.DB.batch([env.DB.prepare(`DELETE FROM volumes`), env.DB.prepare(`DELETE FROM series`)]);
      for (const sql of [...APPLY_LINKS_SQL, APPLY_MASTER_FIX_SQL]) await env.DB.prepare(sql).run();

      expect(await env.DB.prepare(`SELECT name FROM series WHERE id = 'U000001'`).first()).toMatchObject({
        name: NAME,
      });
      const vols = await env.DB.prepare(
        `SELECT isbn, series_id, vol_sort FROM volumes ORDER BY vol_sort`
      ).all<{ isbn: string; series_id: string; vol_sort: number }>();
      expect(vols.results).toEqual([
        { isbn: V1, series_id: "U000001", vol_sort: 1 },
        { isbn: V2, series_id: "U000001", vol_sort: 2 },
        { isbn: V3, series_id: "U000001", vol_sort: 3 },
      ]);
    });

    it("「マスタ行の修正」の取り消しで、足した巻がマスタから消える", async () => {
      await adminRegisterSeries(saveRequest(registerBody()), adminEnv);
      const res = await adminDeleteMasterFix(adminEnv, V2);
      expect(res.status).toBe(200);
      expect(await body(res)).toMatchObject({ ok: true, restored: false });
      expect(await env.DB.prepare(`SELECT 1 AS x FROM volumes WHERE isbn = ?`).bind(V2).first()).toBeNull();
      // 残りの巻とシリーズはそのまま（孤児の判定は volumes を見る: src/merge.ts adminUnlinkVolumes）
      expect(
        await env.DB.prepare(`SELECT COUNT(*) AS n FROM volumes WHERE series_id = 'U000001'`).first()
      ).toEqual({ n: 2 });
    });

    it("マスタが既に持っている巻は登録できない（結合／マスタ行の修正の仕事）", async () => {
      await env.DB.prepare(
        `INSERT INTO volumes (isbn, series_id, volume_number, vol_sort, title) VALUES (?, 'C999', '2', 2, '別の作品')`
      )
        .bind(V2)
        .run();
      const res = await adminRegisterSeries(saveRequest(registerBody()), adminEnv);
      expect(res.status).toBe(400);
      expect((await body(res)).error).toContain(V2);
      // 1 冊でも駄目なら何も作らない
      expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM custom_series`).first()).toEqual({ n: 0 });
    });

    it("成年向けの巻が混ざっていたら登録しない", async () => {
      await env.DB.prepare(`INSERT INTO adult_volumes (isbn, title, title_norm) VALUES (?, ?, ?)`).bind(V3, NAME, NAME).run();
      const res = await adminRegisterSeries(saveRequest(registerBody()), adminEnv);
      expect(res.status).toBe(400);
      expect((await body(res)).error).toContain(V3);
      expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM volumes`).first()).toEqual({ n: 0 });
    });

    it("入力の検査: シリーズ名・巻・ISBN の重複・発行日の形", async () => {
      const bad = async (b: Record<string, unknown>, fragment: string) => {
        const res = await adminRegisterSeries(saveRequest(registerBody(b)), adminEnv);
        expect(res.status).toBe(400);
        expect((await body(res)).error).toContain(fragment);
      };
      await bad({ name: "" }, "シリーズ名");
      await bad({ volumes: [] }, "1 冊以上");
      await bad({ volumes: [{ isbn: "123" }] }, "ISBN");
      await bad({ volumes: [{ isbn: V1 }, { isbn: V1 }] }, "2 回");
      await bad({ volumes: [{ isbn: V1, pubdate: "2009/12" }] }, "発行日");
    });

    it("連番の独自シリーズ ID が振られる（既存の続きから）", async () => {
      await adminRegisterSeries(saveRequest(registerBody()), adminEnv);
      const res = await adminRegisterSeries(
        saveRequest(registerBody({ isbn: "", name: "別の作品", volumes: [{ isbn: "9784088725093", volume_number: "1" }] })),
        adminEnv
      );
      expect((await body(res)).series_id).toBe("U000002");
    });
  });

  describe("管理画面のキュー", () => {
    it("未処理と処理済みを分けて返し、作ったシリーズ名も添える", async () => {
      await seedLiveVolume();
      await requestSeriesRegister(askRequest({ isbn: V1 }), adminEnv);

      const pending = await body(await adminListRegisterRequests(adminEnv, page, listUrl()));
      expect(pending.total).toBe(1);
      expect(pending.requests[0]).toMatchObject({ isbn: V1, title: "このこここのこ（1）", in_master: false });
      expect(await body(await adminListRegisterRequests(adminEnv, page, listUrl(true)))).toMatchObject({ total: 0 });

      await adminRegisterSeries(saveRequest(registerBody()), adminEnv);
      expect(await body(await adminListRegisterRequests(adminEnv, page, listUrl()))).toMatchObject({ total: 0 });
      const done = await body(await adminListRegisterRequests(adminEnv, page, listUrl(true)));
      expect(done.requests[0]).toMatchObject({
        resolution: "registered",
        series_id: "U000001",
        series_name: NAME,
        in_master: true, // 登録したので今はマスタに居る
      });
    });

    it("却下は行を残す（履歴に出る）", async () => {
      await requestSeriesRegister(askRequest({ isbn: V1 }), adminEnv);
      expect((await adminDismissRegisterRequest(adminEnv, V1)).status).toBe(200);
      const done = await body(await adminListRegisterRequests(adminEnv, page, listUrl(true)));
      expect(done.requests[0]).toMatchObject({ isbn: V1, resolution: "dismissed", series_id: "" });
      // 2 回目は未処理が無いので 404
      expect((await adminDismissRegisterRequest(adminEnv, V1)).status).toBe(404);
    });
  });
});

describe("masterPubdate（楽天の発売日 → マスタの表記）", () => {
  it("年月日・年月・年だけを読み分ける", () => {
    expect(masterPubdate("2015年08月04日")).toBe("2015-08-04");
    expect(masterPubdate("2009年12月")).toBe("2009-12");
    expect(masterPubdate("2026年11月04日頃")).toBe("2026-11-04");
    expect(masterPubdate("2010年5月")).toBe("2010-05"); // 1 桁は 0 埋め
    expect(masterPubdate("1994年")).toBe("1994");
  });
  it("既にマスタの表記ならそのまま、読めなければ空", () => {
    expect(masterPubdate("2001-03")).toBe("2001-03");
    expect(masterPubdate("")).toBe("");
    expect(masterPubdate("発売日未定")).toBe("");
  });
});
