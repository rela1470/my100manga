import { handleSearch, handleLiveSearch } from "./search";
import { getSeriesVolumes, getMasterUpdatedAt, handleMasterInfo } from "./series";
import { getGroupVolumes } from "./groups";
import { addCorrection, reportVolume, reportSeriesName, reportVolumeTitle, suggestCover } from "./corrections";
import { coverCandidates, volumeCandidates } from "./candidates";
import {
  getMergeCandidates,
  requestSeriesMerge,
  requestSeriesSplit,
  adminListMergeRequests,
  adminDismissMergeRequest,
  adminListMergeCandidates,
  adminDismissMergeCandidate,
  adminMergeSeries,
  adminListMerges,
  adminUnmergeSeries,
  adminListLinks,
  adminSplitSourceVolumes,
  adminSplitSeries,
  adminListSplitRequests,
  adminDismissSplitRequest,
  adminUnlinkVolumes,
} from "./merge";
import { handleBook } from "./book";
import { readCachedCovers, resolveCovers } from "./covers";
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
  adminListVolumeTitleReports,
  adminDismissVolumeTitleReport,
  adminOverrideVolumeTitle,
  adminApplyCommonTitleToVolume,
  adminListVolumeTitleOverrides,
  adminListSupplements,
  adminPurgeCovers,
  adminCoverR2Summary,
  adminPurgeCoverR2,
  adminPurgeSupplements,
  adminDeleteSupplement,
  adminBookMetaSummary,
  adminListBookMeta,
  adminDeleteBookMeta,
  adminPurgeBookMeta,
  adminRedactReport,
  adminSupplementSummary,
  adminStats,
  adminTodo,
  adminDevReset,
  parsePage,
} from "./admin";
import { addReport } from "./reports";
import { requireAdmin } from "./adminAuth";
import { handleRanking } from "./ranking";
import { adminSalesSnapshot, adminSalesStatus, handleSalesRanking, runSalesSnapshot } from "./salesRanking";
import { handleSiteStats } from "./siteStats";
import { analyticsTags, gtmBody, injectAnalytics, appVersion, affIds } from "./analytics";
import { footerHtml } from "./footer";
import { bumpPopularity } from "./popularity";
import { Env, MangaList } from "./types";
import { rateLimit } from "./ratelimit";
import { trimShopFrame, trimWhitespace } from "./covertrim";
import { badRequest, escapeHtml, json, readJsonObject } from "./util";

export { RakutenRateLimiter } from "./ratelimiter";
import type { CoverQueue } from "./ratelimiter";

const COVER_CACHE = "public, max-age=31536000, immutable";

function coverHeaders(etag?: string): Headers {
  const h = new Headers();
  h.set("content-type", "image/jpeg");
  h.set("cache-control", COVER_CACHE);
  if (etag) h.set("etag", etag);
  return h;
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// もったいない本舗's 楽天 storefronts — their listing images frame the cover with a
// logo band and mascot (src/covertrim.ts trimShopFrame). Kept in sync with
// MOTTAINAI_RE in public/cover-fit.js.
const MOTTAINAI_PATH = /^\/@0_mall\/(comicset|mottainaihonpo|mottainaihonpo-omatome)\/cabinet\//;

// Serve a store cover with its baked-in framing trimmed: Yahoo's white bars
// (trimWhitespace) or もったいない本舗's logo frame (trimShopFrame). First hit decodes
// + trims (src/covertrim.ts) and persists the result to R2 keyed by a hash of the
// source URL; every later hit streams straight from R2. Whitelisted to *.yimg.jp and
// those shops' 楽天 cabinets so it can't be used as an open proxy. If trimming yields
// nothing, the original image is stored and served unchanged.
async function handleCover(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const u = new URL(request.url).searchParams.get("u") || "";
  let target: URL;
  try {
    target = new URL(u);
  } catch {
    return new Response("bad url", { status: 400 });
  }
  const yahoo = /(^|\.)yimg\.jp$/.test(target.hostname);
  const mottainai =
    target.hostname === "thumbnail.image.rakuten.co.jp" && MOTTAINAI_PATH.test(target.pathname);
  if (target.protocol !== "https:" || !(yahoo || mottainai)) {
    return new Response("forbidden host", { status: 403 });
  }

  const key = (yahoo ? "yahoo/" : "mottainai/") + (await sha256Hex(target.toString())) + ".jpg";

  if (env.COVERS) {
    const hit = await env.COVERS.get(key);
    if (hit) return new Response(hit.body, { status: 200, headers: coverHeaders(hit.httpEtag) });
  }

  const upstream = await fetch(target.toString(), {
    cf: { cacheEverything: true, cacheTtl: 86400 },
  });
  if (!upstream.ok) return new Response("upstream error", { status: 502 });
  const original = await upstream.arrayBuffer();

  let out: ArrayBuffer = original;
  try {
    const trimmed = yahoo ? await trimWhitespace(original) : await trimShopFrame(original);
    if (trimmed) out = trimmed;
  } catch {
    // decode/encode failure: fall back to the original bytes.
  }

  if (env.COVERS) {
    ctx.waitUntil(
      env.COVERS.put(key, out, {
        httpMetadata: { contentType: "image/jpeg", cacheControl: COVER_CACHE },
      }),
    );
  }
  return new Response(out, { status: 200, headers: coverHeaders() });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
      // ユーザが明示的に押す「本データを再取得」(/api/book?refresh=1) は Rakuten を叩き直す
      // ので、GET でも外部 API 枠（RL_COVERS）で濫用よけする。通常の /api/book はキャッシュ
      // 返却なので対象外。
      if (
        request.method === "GET" &&
        path === "/api/book" &&
        url.searchParams.get("refresh") === "1"
      ) {
        const limited = await rateLimit(request, env.RL_COVERS, "covers");
        if (limited) return limited;
      }
      // --- API ---
      if (path === "/api/search" && request.method === "GET") {
        return await handleSearch(request, env);
      }
      // 現在のデプロイ版を返す。開きっぱなしの SPA タブがこれを見て、自分が読み込んだ版
      // （<meta app-version>）と食い違ったら「新しい版」バナーを出す。see public/app.js
      if (path === "/api/version" && request.method === "GET") {
        return json({ version: appVersion(env) }, 200, { "cache-control": "no-store" });
      }
      // 本が追加されている回数ランキング (累計 / 過去30日 / 7日 / 24時間)。
      if (path === "/api/ranking" && request.method === "GET") {
        return await handleRanking(env);
      }
      // 売上ランキング（楽天ブックスの売れている順の日次スナップショットを作品単位で集計）。
      if (path === "/api/sales-ranking" && request.method === "GET") {
        return await handleSalesRanking(env);
      }
      // トップページの収録数（シリーズ / 巻 / 公開リスト）。
      if (path === "/api/site-stats" && request.method === "GET") {
        return await handleSiteStats(env);
      }
      // MADB master provenance (release tag/date + last import) for the about page.
      if (path === "/api/master-info" && request.method === "GET") {
        return await handleMasterInfo(env);
      }
      // Keyword discovery against live MADB for works missing from the master.
      if (path === "/api/live-search" && request.method === "GET") {
        return await handleLiveSearch(request, env);
      }
      // Trimmed Yahoo cover served from R2 (materialised on first hit). See
      // handleCover: strips the white bars baked into 正方形 seller images.
      if (path === "/cover" && request.method === "GET") {
        return await handleCover(request, env, ctx);
      }
      // シリーズに属さない巻のまとまり（G<ISBN>, see src/groups.ts）。巻一覧・取得ボタンは
      // グループの巻を返し、訂正/通報は C-id 前提なので受け付けない（結合依頼は merge.ts 側で対応）。
      const groupMatch = path.match(/^\/api\/series\/(G\d{13})\/(volumes|supplement|corrections|corrections\/report|report)$/);
      if (groupMatch) {
        if ((groupMatch[2] === "volumes" && request.method === "GET") ||
            (groupMatch[2] === "supplement" && request.method === "POST")) {
          return await getGroupVolumes(env, groupMatch[1], (id) => getSeriesVolumes(env, id), () => getMasterUpdatedAt(env));
        }
        return badRequest("このまとまりはシリーズに属していないため、この操作はできません");
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
      // シリーズの結合（分裂したシリーズ）: 候補の取得と結合依頼（collect-only; 管理者が確定）。
      const mergeCandMatch = path.match(/^\/api\/series\/([A-Za-z0-9]+)\/merge-candidates$/);
      if (mergeCandMatch && request.method === "GET") {
        return await getMergeCandidates(env, mergeCandMatch[1]);
      }
      // 「別の版が混ざっている？」: シリーズの分離の依頼（collect-only, see src/merge.ts）。
      const splitReqMatch = path.match(/^\/api\/series\/([A-Za-z0-9]+)\/split-request$/);
      if (splitReqMatch && request.method === "POST") {
        return await requestSeriesSplit(request, env, splitReqMatch[1]);
      }
      const mergeReqMatch = path.match(/^\/api\/series\/([A-Za-z0-9]+)\/merge-request$/);
      if (mergeReqMatch && request.method === "POST") {
        return await requestSeriesMerge(request, env, mergeReqMatch[1]);
      }
      if (path === "/api/cover-candidates" && request.method === "GET") {
        return await coverCandidates(request, env);
      }
      if (path === "/api/cover-suggestions" && request.method === "POST") {
        return await suggestCover(request, env);
      }
      // Flag a wrong VOLUME TITLE (本のタイトルが違う？). Collect-only; admin fixes via
      // override / snap-to-common. Keyed by ISBN, so no series id in the path.
      if (path === "/api/volume-title-reports" && request.method === "POST") {
        return await reportVolumeTitle(request, env);
      }
      if (path === "/api/volume-candidates" && request.method === "GET") {
        return await volumeCandidates(request, env);
      }
      // Metadata for the view-page detail popup (authors/publisher/発行日/あらすじ).
      if (path === "/api/book" && request.method === "GET") {
        return await handleBook(request, env);
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
      if (path === "/api/admin/todo" && request.method === "GET") {
        return await adminTodo(env);
      }
      // 売上ランキングの今日の分を Cron を待たずに取得・集計する（?recompute=1 は集計のみ）。
      if (path === "/api/admin/sales-ranking" && request.method === "GET") {
        return await adminSalesStatus(env);
      }
      if (path === "/api/admin/sales-ranking/snapshot" && request.method === "POST") {
        return await adminSalesSnapshot(env, url.searchParams.get("recompute") === "1");
      }
      // 開発用: マスターデータ以外を全削除して DB を初期化。dev（ADMIN_DEV_BYPASS）限定。
      if (path === "/api/admin/dev/reset" && request.method === "POST") {
        return await adminDevReset(env);
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
      // シリーズの結合: 依頼・自動検出候補・確定済みの一覧と、結合/却下/解除。
      if (path === "/api/admin/merge-requests" && request.method === "GET") {
        return await adminListMergeRequests(env, parsePage(url));
      }
      const adminMergeReqMatch = path.match(/^\/api\/admin\/merge-requests\/([A-Za-z0-9]+)\/([A-Za-z0-9]+)$/);
      if (adminMergeReqMatch && request.method === "DELETE") {
        return await adminDismissMergeRequest(env, adminMergeReqMatch[1], adminMergeReqMatch[2]);
      }
      if (path === "/api/admin/merge-candidates" && request.method === "GET") {
        return await adminListMergeCandidates(env, parsePage(url));
      }
      if (path === "/api/admin/merge-candidates/dismiss" && request.method === "POST") {
        return await adminDismissMergeCandidate(request, env);
      }
      if (path === "/api/admin/series-merges" && request.method === "GET") {
        return await adminListMerges(env, parsePage(url));
      }
      if (path === "/api/admin/series-merges" && request.method === "POST") {
        return await adminMergeSeries(request, env);
      }
      // シリーズに属さない巻の紐付け（グループの結合）の一覧と解除。
      if (path === "/api/admin/series-links" && request.method === "GET") {
        return await adminListLinks(env, parsePage(url));
      }
      // シリーズの分離（混ざった別の版を独自シリーズへ移す）。解除は上の紐付けの解除と同じ。
      const adminSplitMatch = path.match(/^\/api\/admin\/series-splits\/([A-Za-z0-9]+)\/volumes$/);
      if (adminSplitMatch && request.method === "GET") {
        return await adminSplitSourceVolumes(env, adminSplitMatch[1]);
      }
      if (path === "/api/admin/series-splits" && request.method === "POST") {
        return await adminSplitSeries(request, env);
      }
      if (path === "/api/admin/split-requests" && request.method === "GET") {
        return await adminListSplitRequests(env, parsePage(url));
      }
      const adminSplitReqMatch = path.match(/^\/api\/admin\/split-requests\/([A-Za-z0-9]+)$/);
      if (adminSplitReqMatch && request.method === "DELETE") {
        return await adminDismissSplitRequest(env, adminSplitReqMatch[1]);
      }
      const adminLinkMatch = path.match(/^\/api\/admin\/series-links\/([A-Za-z0-9]+)\/(\d+)$/);
      if (adminLinkMatch && request.method === "DELETE") {
        return await adminUnlinkVolumes(env, adminLinkMatch[1], Number(adminLinkMatch[2]));
      }
      const adminMergeMatch = path.match(/^\/api\/admin\/series-merges\/([A-Za-z0-9]+)$/);
      if (adminMergeMatch && request.method === "DELETE") {
        return await adminUnmergeSeries(env, adminMergeMatch[1]);
      }
      // 本のタイトルの通報（巻 ISBN 単位）。series-reports と同じ構成。
      if (path === "/api/admin/volume-title-reports" && request.method === "GET") {
        return await adminListVolumeTitleReports(env, parsePage(url));
      }
      // タイトル修正で確定した巻タイトル上書きの履歴（volume_title_override）。
      if (path === "/api/admin/volume-title-overrides" && request.method === "GET") {
        return await adminListVolumeTitleOverrides(env, parsePage(url));
      }
      const adminVolTitleCommonMatch = path.match(
        /^\/api\/admin\/volume-title-reports\/([0-9Xx]+)\/common$/
      );
      if (adminVolTitleCommonMatch && request.method === "POST") {
        // 「揃える」: そのシリーズで最多の巻タイトルを override として記録。
        return await adminApplyCommonTitleToVolume(env, adminVolTitleCommonMatch[1]);
      }
      const adminVolTitleReportMatch = path.match(
        /^\/api\/admin\/volume-title-reports\/([0-9Xx]+)$/
      );
      if (adminVolTitleReportMatch && request.method === "POST") {
        // タイトル修正（手動上書き）: body の title を volume_title_override に記録。
        return await adminOverrideVolumeTitle(request, env, adminVolTitleReportMatch[1]);
      }
      if (adminVolTitleReportMatch && request.method === "DELETE") {
        // 却下: 通報行だけ削除。タイトルは変更しない。
        return await adminDismissVolumeTitleReport(env, adminVolTitleReportMatch[1]);
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
      if (path === "/api/admin/covers/r2/summary" && request.method === "GET") {
        return await adminCoverR2Summary(env);
      }
      if (path === "/api/admin/covers/r2/purge" && request.method === "POST") {
        return await adminPurgeCoverR2(env);
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
      if (path === "/api/admin/book-meta" && request.method === "GET") {
        return await adminListBookMeta(env, parsePage(url), url.searchParams.get("q") ?? "");
      }
      if (path === "/api/admin/book-meta/summary" && request.method === "GET") {
        return await adminBookMetaSummary(env);
      }
      if (path === "/api/admin/book-meta/purge" && request.method === "POST") {
        return await adminPurgeBookMeta(request, env);
      }
      const adminBookMetaMatch = path.match(/^\/api\/admin\/book-meta\/([0-9Xx]+)$/);
      if (adminBookMetaMatch && request.method === "DELETE") {
        return await adminDeleteBookMeta(env, adminBookMetaMatch[1]);
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
    // HTML ページには <!--ANALYTICS--> に Google タグを差し込む（admin は素通り）。
    return injectAnalytics(await env.ASSETS.fetch(request), env);
  },

  // Cron（wrangler.jsonc triggers）: 売上ランキングの日次スナップショット。
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runSalesSnapshot(env, "cron").then(
        (r) => console.log("sales snapshot", r),
        (err) => console.error("sales snapshot failed", err)
      )
    );
  },
} satisfies ExportedHandler<Env>;

// On-demand cover resolution (hits Google/Rakuten, caches results). The list
// endpoints return cache-only covers so they're instant; the client calls this
// to fill the gaps lazily. Returns isbn → cover URL for the ones that resolved.
async function resolveCoversApi(request: Request, env: Env): Promise<Response> {
  const body = (await readJsonObject(request)) as {
    isbns?: unknown;
    cache_only?: unknown;
    client?: unknown;
    pending?: unknown;
  };
  const isbns = Array.isArray(body.isbns)
    ? body.isbns.filter((x): x is string => typeof x === "string").slice(0, 400)
    : [];
  // cache_only: just read the site-wide covers (no store lookups) — the editor uses it
  // on load to pick up covers that changed since its draft was saved (admin approvals).
  // client/pending: the 表紙を取得 loops report their browser id and covers left, so the
  // response can say how many people are filling covers and how deep the site-wide wait is.
  const queue = body.cache_only === true ? null : await reportCoverQueue(env, body.client, body.pending);
  // A finished fill sends no ISBNs and pending 0 to leave the count right away.
  if (isbns.length === 0) return json(queue ? { covers: {}, queue } : { covers: {} }, 200, { "cache-control": "no-store" });
  const map = body.cache_only === true ? await readCachedCovers(env, isbns) : await resolveCovers(env, isbns);
  const covers: Record<string, string> = {};
  for (const [isbn, url] of map) if (url) covers[isbn] = url;
  return json(queue ? { covers, queue } : { covers }, 200, { "cache-control": "no-store" });
}

async function reportCoverQueue(env: Env, client: unknown, pending: unknown): Promise<CoverQueue | null> {
  if (!env.RAKUTEN_LIMITER || typeof client !== "string" || !/^[\w-]{8,64}$/.test(client)) return null;
  if (typeof pending !== "number" || !Number.isFinite(pending)) return null;
  try {
    return await env.RAKUTEN_LIMITER.getByName("cover-queue").report(client, Math.min(Math.max(Math.floor(pending), 0), 1000));
  } catch {
    return null; // presence is cosmetic — never fail the cover fill over it
  }
}

async function renderViewPage(env: Env, slug: string, origin: string): Promise<Response> {
  const data = await getListData(env, slug);
  // ブラウザで開かれるページなので JSON の 404 ではなくトップへ戻し、そこでモーダルを出す。
  if (!data) {
    return new Response(null, {
      status: 302,
      headers: { location: `${origin}/?notfound=list`, "cache-control": "no-store" },
    });
  }
  bumpPopularity(env, "list", slug, data.owner_name ?? "");

  const templateRes = await env.ASSETS.fetch(new Request(`${origin}/view.html`));
  let html = await templateRes.text();

  const meta = buildOgp(data, `${origin}/l/${slug}`);
  const aff = affIds(env);
  const injected =
    `<script>window.__LIST__=${safeJson(data)};` +
    `window.__AFF__=${safeJson(aff)};</script>`;

  html = html
    .replace("<!--OGP_META-->", meta)
    .replace("<!--ANALYTICS-->", analyticsTags(env))
    .replace("<!--GTM_BODY-->", gtmBody(env))
    .replace("<!--LIST_DATA-->", injected)
    .replace("<!--FOOTER_AFF-->", footerHtml(true));

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
    `<meta property="og:site_name" content="My 100 Manga">`,
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
  tags.push(`<title>${escapeHtml(title)} | My 100 Manga</title>`);
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
