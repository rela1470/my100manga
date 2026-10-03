#!/usr/bin/env node
// 表紙・書誌キャッシュの暖機ドライバ。/api/admin/warm を「次の数件を温める」単位で
// 繰り返し叩くだけのループ（本体は src/warm.ts）。
//
// 楽天 OpenAPI の枠が Worker 全体で約 1 req/s なので、どう並べても約 0.9 ISBN/秒が上限。
// 発行部数ランキング 200 作品ぶん（約 6 千巻）でおよそ 2 時間かかる。途中で止めても、
// 温め済みかどうかは covers 表で判断するので、同じコマンドで続きから再開できる。
//
// 認証: /api/admin/* は Cloudflare Access の背後にある（src/adminAuth.ts）。Worker 側は
// JWT の email を ADMIN_EMAILS と照合するので、サービストークンではなく人のログインが要る。
// ブラウザで https://my100manga.com/admin を開いてログインし、その Cookie の
// CF_Authorization の値を環境変数で渡す（有効期限は Access アプリの設定どおり）。
//
// Usage:
//   # ローカル（wrangler dev + ローカル D1。ADMIN_DEV_BYPASS=true が要る）
//   node scripts/warm-cache.mjs --local
//
//   # dev / 本番（CF_Authorization Cookie を渡す）
//   CF_AUTHORIZATION=xxxxx node scripts/warm-cache.mjs --base https://my100manga.com
//
// Flags:
//   --base <url>     対象のオリジン（既定: http://localhost:8787）
//   --local          --base http://localhost:8787 と同じ
//   --scope <name>   circulation（既定） / sales / series。順に温めたいときは繰り返し指定
//   --limit <n>      1 要求で温める ISBN 数（既定 8。これ以上増やしても枠で頭打ち）
//   --max <n>        温める ISBN 数の上限（既定: 無制限）。試すときに
//   --cursor <s>     途中から（前回の出力の cursor を渡す）
//   --status         現在の埋まり具合だけ出して終わる

const DEFAULTS = { base: "http://localhost:8787", limit: 8 };
// 進みが無い要求が続いたら止める（楽天が落ちている・枠が取れない・Access が切れた等）。
const MAX_IDLE = 5;
// 要求のあいだに置く休み。resolveCovers が枠を待つので普段は不要だが、空振り（温め済みを
// 読み飛ばすだけ）のときに連打しないよう少しだけ空ける。
const IDLE_PAUSE_MS = 500;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(name);
const args = (name) =>
  process.argv.reduce((out, a, i) => (a === name && process.argv[i + 1] ? [...out, process.argv[i + 1]] : out), []);

const base = (has("--local") ? "http://localhost:8787" : arg("--base", DEFAULTS.base)).replace(/\/$/, "");
const cookie = process.env.CF_AUTHORIZATION ? `CF_Authorization=${process.env.CF_AUTHORIZATION}` : "";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "–");
const hhmm = (sec) => `${Math.floor(sec / 3600)}h${String(Math.round((sec % 3600) / 60)).padStart(2, "0")}m`;

async function call(path, init = {}) {
  const res = await fetch(base + path, {
    ...init,
    headers: {
      ...(cookie ? { cookie } : {}),
      // adminCsrfOk が状態を変える要求に Origin の一致を求める。
      ...(init.method && init.method !== "GET" ? { origin: base } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    const hint =
      res.status === 401 || res.status === 403
        ? "（Cloudflare Access の認証。CF_AUTHORIZATION を入れ直すか、ローカルなら ADMIN_DEV_BYPASS=true を確認）"
        : "";
    throw new Error(`${init.method ?? "GET"} ${path} → ${res.status} ${text.slice(0, 200)} ${hint}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path} の応答が JSON ではない: ${text.slice(0, 200)}`);
  }
}

function printStatus(s) {
  process.stdout.write(
    `キャッシュ: covers ${s.covers}/${s.volumes}（表紙あり ${s.covers_found}） / book_meta ${s.book_meta}\n`
  );
  for (const [name, v] of Object.entries(s.scopes ?? {})) {
    process.stdout.write(`  ${name}: ${v.series} シリーズ / ${v.warmed}/${v.volumes} 巻 (${pct(v.warmed, v.volumes)})\n`);
  }
}

async function warmScope(scope, limit, max, startCursor) {
  let cursor = startCursor ?? "";
  let cached = 0;
  let attempted = 0;
  let idle = 0;
  const started = Date.now();

  process.stdout.write(`\n[${scope}] 開始${cursor ? `（cursor ${cursor}）` : ""}\n`);
  for (;;) {
    const q = new URLSearchParams({ scope, limit: String(limit) });
    if (cursor) q.set("cursor", cursor);
    const r = await call(`/api/admin/warm?${q}`, { method: "POST" });

    cached += r.cached;
    attempted += r.attempted;
    cursor = r.cursor ?? "";

    if (r.done) {
      process.stdout.write(`[${scope}] 完了: ${cached} 件を新たにキャッシュ\n`);
      return { cached, attempted, cursor: null };
    }
    if (max && cached >= max) {
      process.stdout.write(`[${scope}] --max ${max} に達したので終了（cursor ${cursor}）\n`);
      return { cached, attempted, cursor };
    }

    if (r.attempted === 0) {
      // 温める対象が無いチャンクを読み飛ばしただけ。cursor が進んでいれば空振りではない。
      idle = r.chunks > 0 && cursor ? 0 : idle + 1;
    } else if (r.cached === 0) {
      idle++; // 温めようとしたのに 1 件も入らなかった（枠が取れない・API エラー）
    } else {
      idle = 0;
    }
    if (idle >= MAX_IDLE) {
      process.stdout.write(`[${scope}] 進まなくなったので中断（cursor ${cursor}）。時間をおいて同じコマンドで再開できます\n`);
      return { cached, attempted, cursor };
    }

    const sec = (Date.now() - started) / 1000;
    const rate = cached / Math.max(1, sec);
    process.stdout.write(
      `\r  ${cached} 件 / ${hhmm(sec)} (${rate.toFixed(2)} 件/秒) cursor=${cursor || "-"}        `
    );
    if (r.attempted === 0) await sleep(IDLE_PAUSE_MS);
  }
}

async function main() {
  const status = await call("/api/admin/warm");
  printStatus(status);
  if (has("--status")) return;

  const scopes = args("--scope").length ? args("--scope") : ["circulation"];
  const limit = Number(arg("--limit", DEFAULTS.limit)) || DEFAULTS.limit;
  const max = Number(arg("--max", 0)) || 0;
  const startCursor = arg("--cursor", "");

  let total = 0;
  for (const [i, scope] of scopes.entries()) {
    const r = await warmScope(scope, limit, max ? max - total : 0, i === 0 ? startCursor : "");
    total += r.cached;
    if (max && total >= max) break;
  }
  process.stdout.write(`\n合計 ${total} 件を新たにキャッシュしました\n`);
  printStatus(await call("/api/admin/warm"));
}

main().catch((err) => {
  process.stderr.write("\n" + String(err?.message ?? err) + "\n");
  process.exit(1);
});
