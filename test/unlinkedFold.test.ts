import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { getSeriesVolumes } from "../src/series";
import { makeIsbns } from "./helpers";

// シリーズ名には無い別名を巻の schema:name だけが持つ作品（series.name「東京卍リベンジャーズ」に
// 対し巻は「東京卍リベンジャーズ = Tokyo Revengers」）で、同じ書名の迷子巻（series_id NULL）が
// 巻一覧に混ざること。シリーズ名での完全一致でも、シリーズ名の基本書名でも引けない形。
// 寄せてよいかの判定は groups.attributeTitles（検索・本の詳細の寄せ先）と同じ（src/series.ts）。

const CREATOR = "試験作者";

async function addVolume(
  isbn: string,
  seriesId: string | null,
  volume: string,
  title: string
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO volumes (isbn, series_id, volume_number, vol_sort, title, title_search, creator, publisher, label, pubdate)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(isbn, seriesId, volume, Number(volume), title, title, CREATOR, "試験社", "試験コミックス", "2018-0" + volume)
    .run();
}

async function addSeries(id: string, name: string): Promise<void> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO series (id, name, name_norm, name_search, creator) VALUES (?, ?, ?, ?, ?)`
  )
    .bind(id, name, name, name, CREATOR)
    .run();
}

async function volumes(id: string): Promise<{ isbn: string; isbns: string[]; volume_number: string }[]> {
  const res = await getSeriesVolumes(env as never, id);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { volumes: { isbn: string; isbns: string[]; volume_number: string }[] };
  return body.volumes;
}

const SERIES = "C920001";
const NAME = "試験転生記";
const VOL_TITLE = `${NAME} = Test Tenseiki`; // 巻だけが名乗る別名付きの書名
const SPINOFF_TITLE = `${NAME} : 試験外伝`; // 基本書名は同じだが別作品
const [V1, V2, V3, V4, SPIN3] = makeIsbns(5, 920000);

// 同じ書名を名乗る別シリーズがある場合（寄せ先が決められないので混ぜない）。
const AMBIG = "C920011";
const AMBIG_NAME = "試験魔導書";
const AMBIG_VOL_TITLE = `${AMBIG_NAME} = Test Madosho`;
const OWNER = "C920012"; // その書名そのものを名乗る別シリーズ
const [A1, A2, A3] = makeIsbns(3, 920100);

beforeAll(async () => {
  await addSeries(SERIES, NAME);
  await addVolume(V1, SERIES, "1", VOL_TITLE);
  await addVolume(V2, SERIES, "2", VOL_TITLE);
  await addVolume(V4, SERIES, "4", VOL_TITLE);
  await addVolume(V3, null, "3", VOL_TITLE); // 迷子の 3 巻（isPartOf が落ちた巻）
  await addVolume(SPIN3, null, "3", SPINOFF_TITLE); // 別作品の 3 巻

  await addSeries(AMBIG, AMBIG_NAME);
  await addSeries(OWNER, AMBIG_VOL_TITLE);
  await addVolume(A1, AMBIG, "1", AMBIG_VOL_TITLE);
  await addVolume(A2, AMBIG, "2", AMBIG_VOL_TITLE);
  await addVolume(A3, null, "3", AMBIG_VOL_TITLE); // 迷子だが寄せ先が 2 通りある
});

describe("巻一覧の迷子巻の取り込み", () => {
  it("シリーズ名に別名が無くても、巻が名乗っている書名で迷子巻を拾う", async () => {
    const out = await volumes(SERIES);
    expect(out.map((v) => v.volume_number)).toEqual(["1", "2", "3", "4"]);
    expect(out[2].isbn).toBe(V3);
  });

  it("基本書名が同じだけの別作品は混ぜない", async () => {
    const out = await volumes(SERIES);
    expect(out.flatMap((v) => v.isbns)).not.toContain(SPIN3);
  });

  it("同じ書名を名乗る別シリーズがあるときは混ぜない", async () => {
    const out = await volumes(AMBIG);
    expect(out.map((v) => v.volume_number)).toEqual(["1", "2"]);
  });
});
