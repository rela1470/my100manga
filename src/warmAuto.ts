import { Env } from "./types";
import { warmNext, WarmScope } from "./warm";

// ランキング集計のあとの自動暖機。売上ランキングの日次スナップショット（Cron）と、発行部数
// ランキングの再集計・寄せ先の変更（管理画面）が終わったら、ランキングに載ったシリーズの巻を
// 温める（src/warm.ts）。
//
// 暖機は楽天の枠（サイト全体で約 1 件/秒）で律速されるので、新しく入ったシリーズが多いと何時間も
// かかり、Cron 1 回・要求 1 回の持ち時間には収まらない。そこで WARM_QUEUE に「1 歩ぶん」の
// メッセージを積み、consumer が warmNext を 1 回だけ実行して次の歩を積み直す連鎖にする。1 歩が
// 1 回の起動なので、D1 のクエリ数や外部要求数の上限も 1 歩ぶんで済む。
//
// 連鎖は run（ランダムな ID）で区別し、meta の warm_auto に今の run を持つ。新しい集計で起動し
// 直すと run が替わり、古い連鎖は次の歩で自分の run と違うのを見て止まる（二重に走らない）。
// 進捗は covers 表で判断する（src/warm.ts）ので、起動し直しても温め済みのシリーズは読み飛ばす
// だけ。管理画面で寄せ先を続けて直したときも、そのたびに頭から読み直すだけで済む。

/** 温める順。売上は毎日入れ替わるので先に、発行部数は変化が少ないので後に。 */
export const AUTO_WARM_SCOPES: WarmScope[] = ["sales", "circulation"];

const META_KEY = "warm_auto";
// 閲覧者が表紙を取得中で譲ったときに、次の歩まで空ける秒数。
const PAUSED_DELAY_SEC = 5;
// 温めようとして 1 件も入らなかった（枠が取れない・楽天が落ちている）ときの間隔と、続いたら諦める回数。
const IDLE_DELAY_SEC = 60;
const MAX_IDLE = 5;

/** WARM_QUEUE のメッセージ（連鎖の 1 歩）。 */
export interface WarmJob {
  run: string;
  scopes: WarmScope[];
  /** scopes のうち今温めている位置。 */
  i: number;
  cursor: string;
  /** 1 件も入らなかった歩が続いた回数。 */
  idle: number;
}

/** 管理画面に出す自動暖機の状態（meta warm_auto）。 */
export interface AutoWarmState {
  run: string;
  state: "running" | "done" | "gave_up";
  trigger: string;
  scope: WarmScope | null;
  cursor: string;
  cached: number;
  started_at: number;
  updated_at: number;
}

export async function readAutoWarmState(env: Env): Promise<AutoWarmState | null> {
  try {
    const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = ?`)
      .bind(META_KEY)
      .first<{ value: string }>();
    return row ? (JSON.parse(row.value) as AutoWarmState) : null;
  } catch {
    return null;
  }
}

async function writeState(env: Env, s: AutoWarmState): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
    .bind(META_KEY, JSON.stringify(s))
    .run();
}

/** 自動暖機を（走っていれば頭から）起動する。WARM_QUEUE が無い環境（ローカル・dev・
 *  R18版）では何もしない。trigger は管理画面の表示とログ用。 */
export async function startAutoWarm(env: Env, trigger: string, now = Date.now()): Promise<boolean> {
  if (!env.WARM_QUEUE) return false;
  const run = crypto.randomUUID();
  await writeState(env, {
    run,
    state: "running",
    trigger,
    scope: AUTO_WARM_SCOPES[0],
    cursor: "",
    cached: 0,
    started_at: now,
    updated_at: now,
  });
  const job: WarmJob = { run, scopes: AUTO_WARM_SCOPES, i: 0, cursor: "", idle: 0 };
  await env.WARM_QUEUE.send(job);
  return true;
}

/** 連鎖の 1 歩。warmNext を 1 回実行し、続きがあれば次の歩を積む。古い run の歩は何もしない。
 *  次の歩を積めなかったら投げる（呼び出し側が retry して、同じ歩をやり直す）。 */
export async function runWarmStep(env: Env, job: WarmJob, now = Date.now()): Promise<void> {
  const state = await readAutoWarmState(env);
  if (!state || state.run !== job.run || state.state !== "running") return; // 起動し直された
  const scope = job.scopes[job.i];
  if (!scope) return;

  const r = await warmNext(env, scope, job.cursor, 8);
  const save = (patch: Partial<AutoWarmState>) =>
    writeState(env, { ...state, cached: state.cached + r.cached, updated_at: now, ...patch });

  if (r.done) {
    const i = job.i + 1;
    if (i >= job.scopes.length) {
      await save({ state: "done", scope: null, cursor: "" });
      console.log("auto warm done", job.run, state.cached + r.cached);
      return;
    }
    await save({ scope: job.scopes[i], cursor: "" });
    await env.WARM_QUEUE!.send({ ...job, i, cursor: "", idle: 0 });
    return;
  }

  const cursor = r.cursor ?? "";
  if (r.paused) {
    // 閲覧者に枠を譲った。進捗ゼロとは数えず、少し待って同じところから。
    await save({ cursor });
    await env.WARM_QUEUE!.send({ ...job, cursor }, { delaySeconds: PAUSED_DELAY_SEC });
    return;
  }
  // 温め済みを読み飛ばしただけ（attempted 0）は進んでいる。温めようとして 0 件なら空振り。
  const idle = r.attempted > 0 && r.cached === 0 ? job.idle + 1 : 0;
  if (idle >= MAX_IDLE) {
    await save({ state: "gave_up", cursor });
    console.error("auto warm gave up", job.run, scope, cursor);
    return;
  }
  await save({ cursor });
  await env.WARM_QUEUE!.send({ ...job, cursor, idle }, idle ? { delaySeconds: IDLE_DELAY_SEC } : undefined);
}
