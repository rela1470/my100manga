import { Env } from "./types";
import { json, plainVolumeNumber } from "./util";
import { readPayload, salesVolumeNumber, workKey, type SalesWindow } from "./salesRanking";
import { getSeriesVolumes, getMasterUpdatedAt } from "./series";
import { getGroupVolumes } from "./groups";
import { sendAlert } from "./alert";

// 売上ランキングのリンク先の点検。ランキングの作品は楽天の書名から作品名で寄せ先（シリーズ /
// まとまり）を決める（src/salesRanking.ts resolveTargets）ので、同名の別版（文庫版・総集編）や
// 巻の足りないシリーズに寄っていても気付けない。そこで「楽天で何巻まで出ているか」と「寄せ先の
// 巻一覧に何巻あるか」を突き合わせる。
//
//   例: 1 位「転生したらスライムだった件（33）」→ 寄せ先の巻一覧に 1〜33 巻のうち 32 巻以上あれば正常。
//
// 楽天側の巻数は、その作品としてスナップショットに載った書名の巻数の最大（salesVolumeNumber）。
// 最新巻は予約中・発売直後でマスタ（MADB）にまだ無いのが普通なので、1 巻足りないのは許す。
// 巻一覧は閲覧者が見るのと同じ関数（getSeriesVolumes / getGroupVolumes）で組み立てるので、迷子巻の
// 寄せ・補完・手動追加・結合・非表示がそのまま効く。
//
// 巻一覧 1 本で D1 を 20 本前後引くので（src/warm.ts SERIES_PER_REQUEST と同じ事情）、Worker 1 回の
// D1 クエリ上限（1000）に収まるよう STEP 件ずつ区切る。Cron からは自動暖機と同じ WARM_QUEUE に
// 「1 歩」のメッセージを積んで連鎖させ、管理画面からは画面が歩を繰り返し呼ぶ。終わったら、前回の
// 点検に無かった問題だけを Slack に送る（src/alert.ts）。

const META_KEY = "sales_link_health";
const STEP = 20; // 1 歩で巻一覧を組み立てる作品数
const TOLERANCE = 1; // 足りなくてよい巻数（最新巻はマスタにまだ無いのが普通）
const MAX_MISSING_SHOWN = 20;
const ALERT_LINES = 15;
const WINDOWS: SalesWindow[] = ["day", "d7", "d30", "year"];

/** WARM_QUEUE に積む点検の 1 歩。自動暖機の歩（WarmJob）とは kind で見分ける。 */
export interface LinkHealthJob {
  kind: "link-health";
  run: string;
}

export const isLinkHealthJob = (body: unknown): body is LinkHealthJob =>
  typeof body === "object" && body !== null && (body as { kind?: unknown }).kind === "link-health";

interface Target {
  work: string;
  series_id: string;
  rank: number; // 窓をまたいだ最高順位
  window: SalesWindow; // その順位の窓
}

export type ProblemKind =
  | "broken" // 巻一覧が開けない（寄せ先が消えた）
  | "empty" // 巻一覧に 1 冊も無い
  | "short" // 楽天の巻数まで届いていない（最新の巻が無い・別版に寄っている）
  | "gaps"; // 最新の巻はあるが途中が抜けている

export interface LinkProblem {
  kind: ProblemKind;
  work: string;
  series_id: string;
  series_title: string;
  rank: number;
  window: SalesWindow;
  expected: number | null; // 楽天で出ている巻数（最大）。巻数の無い作品は null
  rakuten_title: string; // expected の巻の楽天の書名
  have: number; // 巻一覧にある、1〜expected の巻の数（巻番号の無い一覧は巻の総数）
  max_vol: number | null; // 巻一覧の最大の巻番号
  total: number; // 巻一覧の巻の総数
  missing: number[]; // 抜けている巻番号（先頭から MAX_MISSING_SHOWN 件）
}

export interface LinkHealthState {
  run: string;
  state: "running" | "done";
  trigger: string;
  day: string; // 点検した集計の最新日
  targets: Target[];
  cursor: number; // targets のうち点検済みの数
  problems: LinkProblem[]; // この点検で見つかった問題（running の間は点検済みの分だけ）
  prev_problems: LinkProblem[]; // 前回の点検の問題。新しく出た問題を見分けるのに使う
  new_problems: number; // 前回の点検に無かった問題の数（done のとき）
  started_at: number;
  updated_at: number;
}

export async function readLinkHealth(env: Env): Promise<LinkHealthState | null> {
  try {
    const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = ?`)
      .bind(META_KEY)
      .first<{ value: string }>();
    return row ? (JSON.parse(row.value) as LinkHealthState) : null;
  } catch {
    return null;
  }
}

async function writeState(env: Env, s: LinkHealthState): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
    .bind(META_KEY, JSON.stringify(s))
    .run();
}

/** 点検を（走っていれば頭から）始める。queue があれば最初の歩を積む。前回の点検の問題は
 *  prev_problems に持ち越す（途中で起動し直されたときは、その前に終わった点検のものを引き継ぐ）。 */
export async function startLinkHealth(
  env: Env,
  trigger: string,
  queue: boolean,
  now = Date.now()
): Promise<LinkHealthState> {
  const payload = await readPayload(env);
  const best = new Map<string, Target>();
  for (const w of WINDOWS) {
    for (const e of payload?.windows[w] ?? []) {
      if (!e.series_id) continue;
      const cur = best.get(e.work);
      if (!cur || e.rank < cur.rank) best.set(e.work, { work: e.work, series_id: e.series_id, rank: e.rank, window: w });
    }
  }
  const prev = await readLinkHealth(env);
  const state: LinkHealthState = {
    run: crypto.randomUUID(),
    state: "running",
    trigger,
    day: payload?.latest_day ?? "",
    targets: [...best.values()].sort((a, b) => a.rank - b.rank || WINDOWS.indexOf(a.window) - WINDOWS.indexOf(b.window)),
    cursor: 0,
    problems: [],
    prev_problems: !prev ? [] : prev.state === "done" ? prev.problems : (prev.prev_problems ?? []),
    new_problems: 0,
    started_at: now,
    updated_at: now,
  };
  await writeState(env, state);
  if (queue && env.WARM_QUEUE) await env.WARM_QUEUE.send({ kind: "link-health", run: state.run });
  return state;
}

/** 点検の 1 歩（STEP 件）。古い run・終わった run には何もしない。続きがあり queue なら次の歩を積む。 */
export async function runLinkHealthStep(
  env: Env,
  run: string,
  queue: boolean,
  now = Date.now()
): Promise<LinkHealthState | null> {
  const state = await readLinkHealth(env);
  if (!state || state.run !== run || state.state !== "running") return state;

  const batch = state.targets.slice(state.cursor, state.cursor + STEP);
  const volumes = new Map<string, Displayed | null>(); // 同じ寄せ先に複数の作品が寄ることがある
  const problems = [...state.problems];
  for (const t of batch) {
    if (!volumes.has(t.series_id)) volumes.set(t.series_id, await displayedVolumes(env, t.series_id));
    const p = judge(t, volumes.get(t.series_id) ?? null, await rakutenVolume(env, t.work));
    if (p) problems.push(p);
  }
  const cursor = state.cursor + batch.length;
  const done = cursor >= state.targets.length;

  if (!done) {
    await writeState(env, { ...state, cursor, problems, updated_at: now });
    if (queue && env.WARM_QUEUE) await env.WARM_QUEUE.send({ kind: "link-health", run });
    return await readLinkHealth(env);
  }

  const prevKeys = new Set(state.prev_problems.map(problemKey));
  const fresh = problems.filter((p) => !prevKeys.has(problemKey(p)));
  const final: LinkHealthState = { ...state, state: "done", cursor, problems, new_problems: fresh.length, updated_at: now };
  await writeState(env, final);
  if (fresh.length) await alertProblems(env, final, fresh);
  return final;
}

const problemKey = (p: LinkProblem): string => `${p.series_id}\n${p.work}\n${p.kind}`;

interface Displayed {
  title: string;
  numbers: number[]; // 巻番号の付いた巻の番号（重複なし）
  total: number;
}

async function displayedVolumes(env: Env, id: string): Promise<Displayed | null> {
  const res = id.startsWith("G")
    ? await getGroupVolumes(env, id, (sid) => getSeriesVolumes(env, sid), () => getMasterUpdatedAt(env))
    : await getSeriesVolumes(env, id);
  if (!res.ok) return null;
  const data = await res.json<{ title?: string; volumes?: Array<{ volume_number: string; vol_sort: number }> }>();
  const vols = data.volumes ?? [];
  const numbers = new Set<number>();
  for (const v of vols) {
    // 素の巻番号でない表記（黒執事の「1　／　Ⅰ」）は並び順のキー（先頭の数字）で読む。部ごとの
    // 番号（「24億脱出編4」→ 24004）と数字の無い表記（「上」→ 0）は巻番号として数えない。
    const n = plainVolumeNumber(v.volume_number ?? "") ?? (v.vol_sort > 0 && v.vol_sort < 1000 ? v.vol_sort : null);
    if (n !== null) numbers.add(n);
  }
  return { title: data.title ?? "", numbers: [...numbers].sort((a, b) => a - b), total: vols.length };
}

/** 作品としてスナップショットに載った書名のうち、巻数の最大とその書名。 */
async function rakutenVolume(env: Env, work: string): Promise<{ vol: number | null; title: string }> {
  const r = await env.DB.prepare(`SELECT DISTINCT title FROM sales_snapshot WHERE work_norm = ?`)
    .bind(workKey(work))
    .all<{ title: string }>();
  let best: { vol: number | null; title: string } = { vol: null, title: r.results?.[0]?.title ?? "" };
  for (const { title } of r.results ?? []) {
    const vol = salesVolumeNumber(title);
    if (vol !== null && (best.vol === null || vol > best.vol)) best = { vol, title };
  }
  return best;
}

/** 1 作品の判定。正常なら null。 */
export function judge(
  t: Target,
  d: Displayed | null,
  rakuten: { vol: number | null; title: string }
): LinkProblem | null {
  const base = {
    work: t.work,
    series_id: t.series_id,
    series_title: d?.title ?? "",
    rank: t.rank,
    window: t.window,
    expected: rakuten.vol,
    rakuten_title: rakuten.title,
    max_vol: d?.numbers.length ? d.numbers[d.numbers.length - 1] : null,
    total: d?.total ?? 0,
  };
  if (!d) return { ...base, kind: "broken", have: 0, missing: [] };
  if (!d.total) return { ...base, kind: "empty", have: 0, missing: [] };
  const n = rakuten.vol;
  if (n === null) return null; // 巻数の無い作品は、巻一覧が開けて 1 冊でもあればよい

  // 巻番号の無い一覧（「上」「下」・部ごとの番号など）は総数で数える。
  const inRange = d.numbers.filter((x) => x >= 1 && x <= n);
  const have = d.numbers.length ? inRange.length : Math.min(d.total, n);
  if (have >= n - TOLERANCE) return null;

  const present = new Set(inRange);
  const missing: number[] = [];
  for (let i = 1; i <= n && missing.length < MAX_MISSING_SHOWN; i++) if (!present.has(i)) missing.push(i);
  const reached = base.max_vol !== null && base.max_vol >= n - TOLERANCE;
  return { ...base, kind: d.numbers.length && reached ? "gaps" : "short", have, missing: d.numbers.length ? missing : [] };
}

const KIND_LABEL: Record<ProblemKind, string> = {
  broken: "巻一覧が開けない",
  empty: "巻一覧が空",
  short: "巻が足りない",
  gaps: "途中の巻が抜けている",
};
const WINDOW_LABEL: Record<SalesWindow, string> = { day: "日次", d7: "7日", d30: "30日", year: "年間" };

export function describeProblem(p: LinkProblem): string {
  const where = `${WINDOW_LABEL[p.window]}${p.rank}位「${p.work}」→ ${p.series_id}${p.series_title ? `「${p.series_title}」` : ""}`;
  if (p.kind === "broken" || p.kind === "empty") return `${where}: ${KIND_LABEL[p.kind]}`;
  return `${where}: ${KIND_LABEL[p.kind]}（楽天 ${p.expected} 巻 / 巻一覧 ${p.have} 巻${
    p.missing.length ? `、抜け ${p.missing.join(",")}${p.missing.length >= MAX_MISSING_SHOWN ? "…" : ""}` : ""
  }）`;
}

async function alertProblems(env: Env, s: LinkHealthState, fresh: LinkProblem[]): Promise<void> {
  const lines = fresh.slice(0, ALERT_LINES).map((p) => `• ${describeProblem(p)}`);
  if (fresh.length > ALERT_LINES) lines.push(`…ほか ${fresh.length - ALERT_LINES} 件`);
  await sendAlert(env, {
    level: "warning",
    title: "売上ランキングのリンク先に巻の足りないシリーズがある",
    text: lines.join("\n"),
    fields: { 集計日: s.day, 新しい問題: fresh.length, 問題の総数: s.problems.length, 点検した作品: s.targets.length },
    throttleKey: `sales-link-health:${s.run}`,
  });
}

/** GET /api/admin/sales-ranking/link-health。最後の点検の状態と結果。 */
export async function adminLinkHealth(env: Env): Promise<Response> {
  const s = await readLinkHealth(env);
  return json(s ? publicState(s) : null, 200, { "cache-control": "no-store" });
}

/** POST /api/admin/sales-ranking/link-health。?run= が無ければ点検を始め、あれば続きの 1 歩を
 *  進める。管理画面は state が done になるまで run を付けて繰り返し呼ぶ（キューは使わない）。 */
export async function adminLinkHealthStep(env: Env, run: string | null): Promise<Response> {
  const started = run ? null : await startLinkHealth(env, "admin", false);
  const s = await runLinkHealthStep(env, run ?? started!.run, false);
  return json(s ? publicState(s) : null, 200, { "cache-control": "no-store" });
}

// 管理画面に返す形。targets は件数だけ、前回の問題は出さない（どちらも長い）。running の間は
// 前回の点検の結果を見せたいので、problems は前回のものにしておく。
function publicState(s: LinkHealthState) {
  const { targets, prev_problems, problems, ...rest } = s;
  return { ...rest, total: targets.length, problems: s.state === "done" ? problems : prev_problems };
}
