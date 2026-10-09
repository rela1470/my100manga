import { Env } from "./types";
import { site } from "./site";

// 運用アラートの Slack 通知（Incoming Webhook）。個別のアラート（例外・Cron 失敗・外部 API の
// 異常など）はここの notify / notifyError を呼ぶだけにして、送り方・抑止・書式はここに集める。
//
//   notify(env, ctx, { level: "warning", title: "楽天 API が 429 を返し続けている", fields: { ... } })
//   notifyError(env, ctx, "sales snapshot", err)
//
// - 送り先は secret の SLACK_WEBHOOK_URL。未設定の env（ローカル・テストなど）では何もしない。
// - 見出しに vars の ALERT_ENV（prod / dev / r18 / r18dev）を付ける。1 つのチャンネルに全 env を流す前提。
// - 同じ throttleKey（既定は level + title）は throttleSec の間 1 回だけ送る。例外が連発しても
//   Slack を埋めない（Webhook 側も 1 秒 1 通程度で 429 になる）。抑止の記録は Cache API
//   （caches.default）でデータセンタ単位なので、別の colo からは重ねて届くことがある。
// - 送信の失敗は console.error に出すだけで投げない。アラートのせいで本処理を落とさない。

export type AlertLevel = "info" | "warning" | "error";

export interface Alert {
  level: AlertLevel;
  /** 1 行の見出し。抑止キーの既定にも使うので、slug や件数など毎回変わる値は fields に入れる。 */
  title: string;
  /** 本文（任意）。Slack の mrkdwn として送るので、コードやスタックは ``` で囲む。 */
  text?: string;
  /** 対応する画面へのリンク（例: 管理画面の該当ページ）。attachment の見出しリンクとして出す。 */
  link?: { url: string; label: string };
  /** 付記する key/value。undefined / null の項目は省く。 */
  fields?: Record<string, string | number | boolean | null | undefined>;
  /** 抑止のキー。省略時は level + title。 */
  throttleKey?: string;
  /** 同じキーを抑止する秒数。省略時は DEFAULT_THROTTLE_SEC、0 で抑止しない。 */
  throttleSec?: number;
}

const DEFAULT_THROTTLE_SEC = 600;
const WEBHOOK_TIMEOUT_MS = 5000;
// Slack の attachment text は長すぎると切られる。スタックを貼っても読める範囲に収める。
const MAX_TEXT = 2800;
const MAX_FIELD = 500;
const THROTTLE_ORIGIN = "https://alert-throttle.invalid";

const COLORS: Record<AlertLevel, string> = { info: "#2f80ed", warning: "#f2a900", error: "#d0021b" };
const ICONS: Record<AlertLevel, string> = { info: ":information_source:", warning: ":warning:", error: ":rotating_light:" };

/** 送信して、送れたら true。未設定・抑止・失敗は false（投げない）。完了を待ちたいとき（Cron の最後など）用。 */
export async function sendAlert(env: Env, alert: Alert): Promise<boolean> {
  const url = env.SLACK_WEBHOOK_URL;
  if (!url) return false;
  try {
    const throttleSec = alert.throttleSec ?? DEFAULT_THROTTLE_SEC;
    const key = alert.throttleKey ?? `${alert.level}:${alert.title}`;
    if (throttleSec > 0 && !(await claimThrottle(env, key, throttleSec))) return false;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildSlackPayload(env, alert)),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error("slack alert failed", res.status, (await res.text().catch(() => "")).slice(0, 200));
      return false;
    }
    return true;
  } catch (err) {
    console.error("slack alert failed", err);
    return false;
  }
}

/** 応答を待たずに送る（ctx.waitUntil）。リクエスト処理・Cron・キューのどこからでも呼べる。 */
export function notify(env: Env, ctx: Pick<ExecutionContext, "waitUntil">, alert: Alert): void {
  if (!env.SLACK_WEBHOOK_URL) return;
  ctx.waitUntil(sendAlert(env, alert));
}

/** 管理画面のページ（public/admin.js の PAGES、#以降）への URL。SITE_ORIGIN が無い env では undefined。 */
export function adminUrl(env: Env, page: string): string | undefined {
  const origin = env.SITE_ORIGIN?.replace(/\/+$/, "");
  return origin ? `${origin}/admin#${page}` : undefined;
}

/** 例外を error レベルで送る。where は「どこで落ちたか」の見出し（抑止キーにもなる）。 */
export function notifyError(
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  where: string,
  err: unknown,
  fields?: Alert["fields"]
): void {
  notify(env, ctx, { level: "error", title: where, text: formatError(err), fields });
}

/** 例外を Slack に貼る形にする。Error ならメッセージとスタック（先頭だけ）、それ以外は文字列化。 */
export function formatError(err: unknown): string {
  if (err instanceof Error) {
    const head = `${err.name}: ${err.message}`;
    const stack = (err.stack ?? "").split("\n").slice(1, 11).join("\n").trim();
    return stack ? `${head}\n\`\`\`${stack}\`\`\`` : head;
  }
  return String(err);
}

/** Slack の Incoming Webhook に送る JSON。テストから見るため export。 */
export function buildSlackPayload(env: Env, alert: Alert): unknown {
  const label = env.ALERT_ENV || "unknown";
  const title = `${ICONS[alert.level]} [${label}] ${escapeSlack(alert.title)}`;
  const fields = Object.entries(alert.fields ?? {})
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => ({ title: k, value: truncate(escapeSlack(String(v)), MAX_FIELD), short: String(v).length <= 40 }));
  const version = env.CF_VERSION?.id ? ` · ${env.CF_VERSION.id.slice(0, 8)}` : "";
  return {
    // 通知（プッシュ・サイドバー）に出る 1 行。attachments だけだと空の通知になる。
    text: title,
    attachments: [
      {
        color: COLORS[alert.level],
        title: alert.link ? escapeSlack(alert.link.label) : undefined,
        title_link: alert.link?.url,
        text: alert.text ? truncate(escapeSlack(alert.text), MAX_TEXT) : undefined,
        fields: fields.length ? fields : undefined,
        footer: `${site(env).name} · ${label}${version}`,
        ts: Math.floor(Date.now() / 1000),
        mrkdwn_in: ["text"],
      },
    ],
  };
}

// Slack の mrkdwn で制御文字になる 3 つだけ逃がす（https://api.slack.com/reference/surfaces/formatting#escaping）。
function escapeSlack(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// 抑止の枠を取れたら true（= 送ってよい）。Cache API が無い環境では抑止せずに送る。
// match → put は原子的ではないので、同時に来た数件は重ねて届くことがある（許容）。
async function claimThrottle(env: Env, key: string, ttlSec: number): Promise<boolean> {
  const cache = typeof caches !== "undefined" && caches.default ? caches.default : null;
  if (!cache) return true;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${env.ALERT_ENV ?? ""}\n${key}`));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const req = new Request(`${THROTTLE_ORIGIN}/${hex}`);
  if (await cache.match(req)) return false;
  await cache.put(req, new Response("1", { headers: { "cache-control": `max-age=${ttlSec}` } }));
  return true;
}
