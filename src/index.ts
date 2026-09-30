import { handleSearch, handleLiveSearch } from "./search";
import { getSeriesVolumes } from "./series";
import { addCorrection, reportVolume, reportSeriesName, suggestCover } from "./corrections";
import { coverCandidates, volumeCandidates } from "./candidates";
import { resolveCovers } from "./covers";
import { createList, getList, getListData, updateList } from "./lists";
import {
  adminCoverSummary,
  adminListCoverSuggestions,
  adminApproveCoverSuggestion,
  adminDismissCoverSuggestion,
  adminDeleteCorrection,
  adminDeleteCover,
  adminDeleteList,
  adminDismissReport,
  adminApproveCorrection,
  adminConfirmVolumeReport,
  adminDismissVolumeReport,
  adminListHiddenVolumes,
  adminGetList,
  adminListCorrections,
  adminListLists,
  adminListPublishAudit,
  adminListReports,
  adminListVolumeReports,
  adminListSeriesReports,
  adminDismissSeriesReport,
  adminOverrideSeriesName,
  adminListNameOverrides,
  adminListSupplements,
  adminPurgeCovers,
  adminPurgeSupplements,
  adminDeleteSupplement,
  adminRedactReport,
  adminSupplementSummary,
  adminStats,
  parsePage,
} from "./admin";
import { addReport } from "./reports";
import { requireAdmin } from "./adminAuth";
import { handleRanking } from "./ranking";
import { bumpPopularity } from "./popularity";
import { Env, MangaList } from "./types";
import { rateLimit } from "./ratelimit";
import { escapeHtml, json, notFound } from "./util";

export { RakutenRateLimiter } from "./ratelimiter";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // 公開書き込み系の濫用よけ。ルート照合の前に IP 単位でレート制限をかける。
      // /api/covers は外部 API を叩くので別枠（RL_COVERS）、それ以外の書き込みは RL_WRITE。
      // /api/admin/* は Cloudflare Access で守られているので対象外。binding 未設定なら通す。
      if (request.method === "POST" || request.method === "PUT") {
        if (path === "/api/covers") {
          const limited = await rateLimit(request, env.RL_COVERS, "covers");
          if (limited) return limited;
        } else if (path.startsWith("/api/") && !path.startsWith("/api/admin/")) {
          const limited = await rateLimit(request, env.RL_WRITE, "write");
          if (limited) return limited;
        }
      }
      // --- API ---
      if (path === "/api/search" && request.method === "GET") {
        return await handleSearch(request, env);
      }
      // 本が追加されている回数ランキング (累計 / 過去30日 / 7日 / 24時間)。
      if (path === "/api/ranking" && request.method === "GET") {
        return await handleRanking(env);
      }
      // Keyword discovery against live MADB for works missing from the master.
      if (path === "/api/live-search" && request.method === "GET") {
        return await handleLiveSearch(request, env);
      }
      const seriesMatch = path.match(/^\/api\/series\/([A-Za-z0-9]+)\/volumes$/);
      if (seriesMatch && request.method === "GET") {
        bumpPopularity(env, "series", seriesMatch[1]);
        return await getSeriesVolumes(env, seriesMatch[1]);
      }
      // Button-triggered live-MADB supplement probe (see src/series.ts). Kept out
      // of the GET above so browsing never blocks on the SPARQL round-trip.
      const supplementMatch = path.match(/^\/api\/series\/([A-Za-z0-9]+)\/supplement$/);
      if (supplementMatch && request.method === "POST") {
        bumpPopularity(env, "supplement", supplementMatch[1]);
        return await getSeriesVolumes(env, supplementMatch[1], true);
      }
      const correctionReportMatch = path.match(/^\/api\/series\/([A-Za-z0-9]+)\/corrections\/report$/);
      if (correctionReportMatch && request.method === "POST") {
        return await reportVolume(request, env, correctionReportMatch[1]);
      }
      const correctionMatch = path.match(/^\/api\/series\/([A-Za-z0-9]+)\/corrections$/);
      if (correctionMatch && request.method === "POST") {
        return await addCorrection(request, env, correctionMatch[1]);
      }
      // Flag a corrupt series NAME (collect-only; admin fixes via override). Placed
      // after the /corrections/report route above so the more specific path wins.
      const seriesReportMatch = path.match(/^\/api\/series\/([A-Za-z0-9]+)\/report$/);
      if (seriesReportMatch && request.method === "POST") {
        return await reportSeriesName(request, env, seriesReportMatch[1]);
      }
      if (path === "/api/cover-candidates" && request.method === "GET") {
        return await coverCandidates(request, env);
      }
      if (path === "/api/cover-suggestions" && request.method === "POST") {
        return await suggestCover(request, env);
      }
      if (path === "/api/volume-candidates" && request.method === "GET") {
        return await volumeCandidates(request, env);
      }
      if (path === "/api/covers" && request.method === "POST") {
        return await resolveCoversApi(request, env);
      }
      if (path === "/api/lists" && request.method === "POST") {
        return await createList(request, env);
      }
      const reportMatch = path.match(/^\/api\/lists\/([A-Za-z0-9_-]+)\/reports$/);
      if (reportMatch && request.method === "POST") {
        return await addReport(request, env, reportMatch[1]);
      }
      const listMatch = path.match(/^\/api\/lists\/([A-Za-z0-9_-]+)$/);
      if (listMatch) {
        const slug = listMatch[1];
        if (request.method === "GET") return await getList(env, slug);
        if (request.method === "PUT") return await updateList(request, env, slug);
        return new Response("Method Not Allowed", { status: 405 });
      }

      // --- Admin ---
      // Cloudflare Access + Worker 側 JWT 検証でガード（src/adminAuth.ts）。
      // 管理 UI（/admin・/admin.html）と全 /api/admin/* を対象にする。UI を無認証で
      // 開けても中身は API が閉じていれば無害だが、多重防御として HTML も塞ぐ。
      // これらのパスは assets.run_worker_first（wrangler.jsonc）で Worker が先に走る。
      // 認証を通したら末尾の env.ASSETS.fetch(request) が /admin → admin.html を配信する。
      if (
        path.startsWith("/api/admin/") ||
        path === "/admin" ||
        path === "/admin.html"
      ) {
        const denied = await requireAdmin(request, env);
        if (denied) return denied;
      }
      if (path === "/api/admin/stats" && request.method === "GET") {
        return await adminStats(env);
      }
      if (path === "/api/admin/lists" && request.method === "GET") {
        return await adminListLists(env, parsePage(url));
      }
      const adminListMatch = path.match(/^\/api\/admin\/lists\/([A-Za-z0-9_-]+)$/);
      if (adminListMatch) {
        const slug = adminListMatch[1];
        if (request.method === "GET") return await adminGetList(env, slug);
        if (request.method === "DELETE") return await adminDeleteList(env, slug);
        return new Response("Method Not Allowed", { status: 405 });
      }
      if (path === "/api/admin/corrections" && request.method === "GET") {
        // ?reviewed=1 で確定(承認)済みの履歴、無ければレビュー待ちキュー。
        return await adminListCorrections(env, parsePage(url), url.searchParams.get("reviewed") === "1");
      }
      const adminCorrApproveMatch = path.match(
        /^\/api\/admin\/corrections\/([A-Za-z0-9]+)\/([0-9]+)\/approve$/
      );
      if (adminCorrApproveMatch && request.method === "POST") {
        return await adminApproveCorrection(env, adminCorrApproveMatch[1], adminCorrApproveMatch[2]);
      }
      const adminCorrMatch = path.match(/^\/api\/admin\/corrections\/([A-Za-z0-9]+)\/([0-9]+)$/);
      if (adminCorrMatch && request.method === "DELETE") {
        return await adminDeleteCorrection(env, adminCorrMatch[1], adminCorrMatch[2]);
      }
      if (path === "/api/admin/volume-reports" && request.method === "GET") {
        return await adminListVolumeReports(env, parsePage(url));
      }
      // 確定して全体から非表示にした巻の履歴（volume_hidden）。
      if (path === "/api/admin/volume-hidden" && request.method === "GET") {
        return await adminListHiddenVolumes(env, parsePage(url));
      }
      const adminVolReportMatch = path.match(
        /^\/api\/admin\/volume-reports\/([A-Za-z0-9]+)\/([0-9]+)$/
      );
      if (adminVolReportMatch && request.method === "DELETE") {
        // ?confirm=1 で全体非表示に確定（volume_hidden へ記録＋ユーザ投稿なら削除）、
        // 無ければ通報だけ却下。
        if (url.searchParams.get("confirm") === "1") {
          return await adminConfirmVolumeReport(
            env,
            adminVolReportMatch[1],
            adminVolReportMatch[2]
          );
        }
        return await adminDismissVolumeReport(env, adminVolReportMatch[1], adminVolReportMatch[2]);
      }
      if (path === "/api/admin/series-reports" && request.method === "GET") {
        return await adminListSeriesReports(env, parsePage(url));
      }
      // 名前修正で確定したシリーズ名上書きの履歴（series_name_override）。
      if (path === "/api/admin/series-overrides" && request.method === "GET") {
        return await adminListNameOverrides(env, parsePage(url));
      }
      const adminSeriesReportMatch = path.match(/^\/api\/admin\/series-reports\/([A-Za-z0-9]+)$/);
      if (adminSeriesReportMatch && request.method === "POST") {
        // 名前修正（上書き）: body の name を series_name_override に記録し read 時反映。
        return await adminOverrideSeriesName(request, env, adminSeriesReportMatch[1]);
      }
      if (adminSeriesReportMatch && request.method === "DELETE") {
        // 却下: 通報行だけ削除。名前は変更しない。
        return await adminDismissSeriesReport(env, adminSeriesReportMatch[1]);
      }
      if (path === "/api/admin/cover-suggestions" && request.method === "GET") {
        // ?resolved=1 で処理済み(承認/却下/差し替え)の履歴、無ければレビュー待ちキュー。
        return await adminListCoverSuggestions(env, parsePage(url), url.searchParams.get("resolved") === "1");
      }
      const adminCoverSuggestApproveMatch = path.match(
        /^\/api\/admin\/cover-suggestions\/([0-9Xx]+)\/approve$/
      );
      if (adminCoverSuggestApproveMatch && request.method === "POST") {
        return await adminApproveCoverSuggestion(request, env, adminCoverSuggestApproveMatch[1]);
      }
      const adminCoverSuggestDismissMatch = path.match(
        /^\/api\/admin\/cover-suggestions\/([0-9Xx]+)\/dismiss$/
      );
      if (adminCoverSuggestDismissMatch && request.method === "POST") {
        return await adminDismissCoverSuggestion(request, env, adminCoverSuggestDismissMatch[1]);
      }
      if (path === "/api/admin/covers/summary" && request.method === "GET") {
        return await adminCoverSummary(env);
      }
      if (path === "/api/admin/covers/purge" && request.method === "POST") {
        return await adminPurgeCovers(request, env);
      }
      const adminCoverMatch = path.match(/^\/api\/admin\/covers\/([0-9Xx]+)$/);
      if (adminCoverMatch && request.method === "DELETE") {
        return await adminDeleteCover(env, adminCoverMatch[1]);
      }
      if (path === "/api/admin/supplements" && request.method === "GET") {
        return await adminListSupplements(env, parsePage(url));
      }
      if (path === "/api/admin/supplements/summary" && request.method === "GET") {
        return await adminSupplementSummary(env);
      }
      if (path === "/api/admin/supplements/purge" && request.method === "POST") {
        return await adminPurgeSupplements(request, env);
      }
      const adminSupMatch = path.match(/^\/api\/admin\/supplements\/([A-Za-z0-9]+)$/);
      if (adminSupMatch && request.method === "DELETE") {
        return await adminDeleteSupplement(env, adminSupMatch[1]);
      }
      if (path === "/api/admin/reports" && request.method === "GET") {
        // ?resolved=1 で処理済み(却下/伏字)の履歴、無ければレビュー待ちキュー。
        return await adminListReports(env, parsePage(url), url.searchParams.get("resolved") === "1");
      }
      // 公開の監査ログ。?slug=xxx で特定リストだけに絞り込める。
      if (path === "/api/admin/publish-audit" && request.method === "GET") {
        return await adminListPublishAudit(
          env,
          parsePage(url),
          url.searchParams.get("slug") ?? undefined
        );
      }
      const adminReportRedactMatch = path.match(/^\/api\/admin\/reports\/([0-9]+)\/redact$/);
      if (adminReportRedactMatch && request.method === "POST") {
        return await adminRedactReport(env, Number(adminReportRedactMatch[1]));
      }
      const adminReportMatch = path.match(/^\/api\/admin\/reports\/([0-9]+)$/);
      if (adminReportMatch && request.method === "DELETE") {
        return await adminDismissReport(env, Number(adminReportMatch[1]));
      }

      // --- Public view page with OGP meta ---
      const viewMatch = path.match(/^\/l\/([A-Za-z0-9_-]+)$/);
      if (viewMatch && request.method === "GET") {
        return await renderViewPage(env, viewMatch[1], url.origin);
      }
    } catch (err) {
      console.error("request failed", err);
      if (path.startsWith("/api/")) return json({ error: "サーバエラーが発生しました" }, 500);
      return new Response("Internal Server Error", { status: 500 });
    }

    // --- Static assets (editor, css, js, view.html template, etc.) ---
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

// On-demand cover resolution (hits Google/Rakuten, caches results). The list
// endpoints return cache-only covers so they're instant; the client calls this
// to fill the gaps lazily. Returns isbn → cover URL for the ones that resolved.
async function resolveCoversApi(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { isbns?: unknown };
  const isbns = Array.isArray(body.isbns)
    ? body.isbns.filter((x): x is string => typeof x === "string").slice(0, 400)
    : [];
  if (isbns.length === 0) return json({ covers: {} }, 200, { "cache-control": "no-store" });
  const map = await resolveCovers(env, isbns);
  const covers: Record<string, string> = {};
  for (const [isbn, url] of map) if (url) covers[isbn] = url;
  return json({ covers }, 200, { "cache-control": "no-store" });
}

async function renderViewPage(env: Env, slug: string, origin: string): Promise<Response> {
  const data = await getListData(env, slug);
  if (!data) return notFound("リストが見つかりません");
  bumpPopularity(env, "list", slug, data.owner_name ?? "");

  const templateRes = await env.ASSETS.fetch(new Request(`${origin}/view.html`));
  let html = await templateRes.text();

  const meta = buildOgp(data, `${origin}/l/${slug}`);
  const aff = {
    amazon: env.AMAZON_ASSOCIATE_TAG ?? "",
    rakuten: env.RAKUTEN_AFFILIATE_ID ?? "",
    mercari: env.MERCARI_AFID ?? "",
  };
  const injected =
    `<script>window.__LIST__=${safeJson(data)};` +
    `window.__AFF__=${safeJson(aff)};</script>`;

  html = html
    .replace("<!--OGP_META-->", meta)
    .replace("<!--LIST_DATA-->", injected);

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function buildOgp(data: MangaList, pageUrl: string): string {
  const owner = data.owner_name ? `${data.owner_name}さん` : "誰か";
  const title = `${owner}を構成する100の漫画`;
  const titles = data.items
    .slice(0, 5)
    .map((i) => i.title)
    .filter(Boolean)
    .join("、");
  const desc = titles ? `${titles} など${data.items.length}作品` : `${data.items.length}作品のおすすめ漫画リスト`;
  const image = data.items.find((i) => i.cover_url)?.cover_url ?? "";

  const tags = [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="my100manga">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(desc)}">`,
    `<meta property="og:url" content="${escapeHtml(pageUrl)}">`,
    `<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}">`,
    `<meta name="twitter:title" content="${escapeHtml(title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(desc)}">`,
    `<meta name="description" content="${escapeHtml(desc)}">`,
  ];
  if (image) {
    tags.push(`<meta property="og:image" content="${escapeHtml(image)}">`);
    tags.push(`<meta name="twitter:image" content="${escapeHtml(image)}">`);
  }
  tags.push(`<title>${escapeHtml(title)} | my100manga</title>`);
  return tags.join("\n  ");
}

/** JSON safe for embedding inside a <script> tag. */
function safeJson(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
