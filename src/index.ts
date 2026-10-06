import { handleSearch, handleLiveSearch } from "./search";
import { handleSuggest, rebuildSuggest } from "./suggest";
import {
  cachedSeriesVolumes,
  getMasterUpdatedAt,
  getSeriesVolumes,
  handleMasterInfo,
  purgeSeriesVolumesCache,
} from "./series";
import { getGroupVolumes, resolveGroup } from "./groups";
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
import { createList, updateList } from "./lists";
import {
  adminCoverSummary,
  adminListCoverSuggestions,
  adminApproveCoverSuggestion,
  adminDismissCoverSuggestion,
  adminDeleteCorrection,
  adminUpdateCorrection,
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
  adminDeleteNameOverride,
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
import { addReport, purgePublishAudit } from "./reports";
import { adminCsrfOk, isAdminUiPath, requireAdmin } from "./adminAuth";
import { errorPageHtml, MAX_JSON_BODY, readJsonBody, withSecurityHeaders } from "./util";
import { currentUser, loginCallback, loginStart, logout, purgeExpiredSessions } from "./auth";
import { handleAccountApi } from "./account";
import { handleRanking } from "./ranking";
import { consumeViewBatch, handleListView, handlePublicLists, purgeListViewSeen } from "./publicLists";
import { adminSalesSnapshot, adminSalesStatus, handleSalesRanking, runSalesSnapshot } from "./salesRanking";
import {
  adminCirculationLink,
  adminCirculationRecompute,
  adminCirculationStatus,
  adminCirculationSuggest,
  handleCirculation,
} from "./circulation";
import { adminWarm, adminWarmStatus } from "./warm";
import {
  adminDeleteMasterFix,
  adminListMasterFixes,
  adminLookupMasterFix,
  adminSaveMasterFix,
} from "./masterFix";
import {
  adminDismissRegisterRequest,
  adminListRegisterRequests,
  adminRegisterCandidates,
  adminRegisterSeries,
  requestSeriesRegister,
} from "./seriesRegister";
import { handleSiteFile } from "./robots";
import { ageGate } from "./ageGate";
import { fetchSiteAsset, isAdultAssetPath } from "./siteAssets";
import { handleSiteStats } from "./siteStats";
import { analyticsTags, applySiteIdentity, gtmBody, injectAnalytics, injectVersion, appVersion, affIds } from "./analytics";
import { footerHtml } from "./footer";
import { headerLinksHtml } from "./header";
import { site } from "./site";
import { bumpPopularity } from "./popularity";
import {
  adminConfirmSeriesTagRequest,
  adminDismissSeriesTagRequest,
  adminListLabels,
  adminListSeriesTagRequests,
  adminSetLabelTags,
  adminSetSeriesTag,
  requestSeriesTag,
} from "./labels";
import { Env, MangaList, ShareJob } from "./types";
import { rateLimit } from "./ratelimit";
import { turnstileAction, verifyTurnstile } from "./turnstile";
import { COVER_CACHE, getTrimmedCover, trimKind } from "./coverBytes";
import { ensureShareImage, getShareImage, isLinkPreviewBot, shareImageHash, SHARE_IMAGE_SIZE, SHARE_VARIANTS, type ShareVariant } from "./shareImage";
import {
  bumpsViewEpoch,
  bumpViewEpoch,
  getListSnapshot,
  ogpWorkTitles,
  readViewCache,
  refreshListView,
  viewCacheKeys,
  VIEW_CACHE_TTL,
  writeViewCache,
} from "./viewSnapshot";
import { badRequest, escapeHtml, json, notFound, readJsonObject, replaceLiteral } from "./util";

export { RakutenRateLimiter } from "./ratelimiter";
import { limiterStub, type CoverQueue } from "./ratelimiter";

function coverHeaders(etag?: string): Headers {
  const h = new Headers();
  h.set("content-type", "image/jpeg");
  h.set("cache-control", COVER_CACHE);
  if (etag) h.set("etag", etag);
  return h;
}

// Serve a store cover with its baked-in framing trimmed (src/coverBytes.ts
// getTrimmedCover). Whitelisted to *.yimg.jp and もったいない本舗's 楽天 cabinets so it
// can't be used as an open proxy. The URL is normalized (coverBytes.ts
// normalizeCoverTarget) before hashing/fetching, and only an R2 miss — the path that
// fetches upstream and decodes — counts against the per-IP limit (RL_COVERS).
async function handleCover(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const u = new URL(request.url).searchParams.get("u") || "";
  if (u.length > 1000) return new Response("bad url", { status: 400 });
  let target: URL;
  try {
    target = new URL(u);
  } catch {
    return new Response("bad url", { status: 400 });
  }
  const kind = trimKind(target);
  if (!kind) return new Response("forbidden host", { status: 403 });

  let limited: Response | null = null;
  const cover = await getTrimmedCover(env, ctx, target, kind, {
    onMiss: async () => !(limited = await rateLimit(request, env.RL_COVERS, "cover-img")),
  });
  if (limited) return limited;
  if (!cover) return new Response("upstream error", { status: 502 });
  return new Response(cover.body, { status: 200, headers: coverHeaders(cover.etag) });
}

// 実体のハンドラ。export default はこれをセキュリティヘッダ付与（util.ts withSecurityHeaders）で包む。
const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // public/adult/ は R18版の差し替え用（src/siteAssets.ts）。直接は引かせない（URL を 1 本に
      // 保つため。ここで止めないと本家で /adult/terms が R18版の本文を返してしまう）。
      if (isAdultAssetPath(path)) {
        const res = await env.ASSETS.fetch(new Request(`${url.origin}/404`));
        return await injectAnalytics(new Response(res.body, { status: 404, headers: res.headers }), env, url.origin);
      }
      // 年齢確認ゲート（R18版だけ、src/ageGate.ts）。同意が無ければ中身を返さない。レート制限
      // より前に置く（未確認の相手はゲートの HTML を返すだけなので、書き込み枠を使わせない）。
      // 本家（SITE_VARIANT="general"）では常に null が返る＝素通り。
      const gated = await ageGate(request, url, env);
      if (gated) return gated;
      // 公開書き込み系の濫用よけ。ルート照合の前に IP 単位でレート制限をかける。
      // /api/covers は外部 API を叩くので別枠（RL_COVERS）、それ以外の書き込みは RL_WRITE。
      // /api/admin/* は Cloudflare Access で守られているので対象外。binding 未設定なら通す。
      if (request.method === "POST" || request.method === "PUT") {
        if (path === "/api/covers") {
          const limited = await rateLimit(request, env.RL_COVERS, "covers");
          if (limited) return limited;
        } else if (path === "/api/me/draft") {
          // 作成中のリストの自動保存。ログイン必須の 1 行 upsert だが、無制限に打てる口を
          // 残さない。公開の書き込み枠（30/分）だと編集中（2 秒ごとに保存）で普通に頭を打つ
          // ので、広い方の binding を別 bucket で使う（120/分 = 0.5 秒に 1 回）。
          const limited = await rateLimit(request, env.RL_COVERS, "draft");
          if (limited) return limited;
        } else if (path.startsWith("/api/") && !path.startsWith("/api/admin/")) {
          // 閲覧ビーコンは公開・通報と枠を分ける（たくさん閲覧した人や同じ IP を共有する人が
          // 直後の公開で 429 にならないように）。
          const bucket = /^\/api\/lists\/[A-Za-z0-9_-]+\/view$/.test(path) ? "view" : "write";
          const limited = await rateLimit(request, env.RL_WRITE, bucket);
          if (limited) return limited;
        }
      }
      // リスト公開・通報・データ修正系はボット確認（Turnstile, src/turnstile.ts）も通す。
      const botAction = turnstileAction(request.method, path);
      if (botAction) {
        const denied = await verifyTurnstile(request, env, botAction);
        if (denied) return denied;
      }
      // ユーザが明示的に押す「本データを再取得」(/api/book?refresh=1) は Rakuten を叩き直す
      // ので、GET でも外部 API 枠（RL_COVERS）で濫用よけする。
      // 外部 API・MADB・D1 の重いクエリを叩く GET（検索・候補・本データ）も同じ binding で
      // 縛る。キーの bucket 名を分けているので、エンドポイントごとに別カウント（検索の連打で
      // 表紙解決が詰まったりしない）。/api/book はキャッシュ判定前に一律で数える（判定に D1 を
      // 引くので、未キャッシュだけ数えるより安く、通常の閲覧で上限に届く量でもない）。
      if (request.method === "GET") {
        const getBucket =
          path === "/api/book"
            ? url.searchParams.get("refresh") === "1" ? "covers" : "book"
            : path === "/api/search"
              ? "search"
              : path === "/api/suggest"
                ? "suggest"
                : path === "/api/cover-candidates" || path === "/api/volume-candidates"
                  ? "candidates"
                  : path === "/api/public-lists"
                    ? "public-lists"
                    : /^\/api\/series\/[A-Za-z0-9]+\/(volumes|merge-candidates)$/.test(path)
                      ? "volumes"
                      : null;
        if (getBucket) {
          const limited = await rateLimit(request, env.RL_COVERS, getBucket);
          if (limited) return limited;
        }
        // MADB への全文検索（SPARQL）と最大 2000 行の書き込みを伴うので、さらに狭い枠（RL_HEAVY）。
        if (path === "/api/live-search") {
          const limited = await rateLimit(request, env.RL_HEAVY, "live-search");
          if (limited) return limited;
        }
      }
      // 「最新データベースから取得」(POST /api/series/:id/supplement) はキャッシュの TTL を
      // 無視して毎回 MADB に SPARQL を投げる（src/madbLive.ts force）。/api/live-search と
      // 同じ重さなので同じ狭い枠で縛る（上の書き込み枠にも数える）。G<ISBN> のまとまりは
      // 探索しない（巻一覧を返すだけ）ので対象外。
      if (request.method === "POST") {
        const probe = path.match(/^\/api\/series\/([A-Za-z0-9]+)\/supplement$/);
        if (probe && !/^G\d{13}$/.test(probe[1])) {
          const limited = await rateLimit(request, env.RL_HEAVY, "supplement");
          if (limited) return limited;
        }
      }
      // 状態を変えるリクエストの本文サイズの上限（JSON しか受けないので 256KB で十分）。
      // 個々のハンドラも上限付きで読むが、Content-Length で分かるものはここで早く弾く。
      if (request.method !== "GET" && request.method !== "HEAD" && path.startsWith("/api/")) {
        const declared = Number(request.headers.get("content-length") ?? "");
        if (Number.isFinite(declared) && declared > MAX_JSON_BODY) {
          return json({ error: "リクエストが大きすぎます" }, 413, { "cache-control": "no-store" });
        }
      }
      // robots.txt / sitemap.xml はドメインを含むので、静的ファイルではなく配信時のオリジンから
      // 組む（本家と R18版で同じコードを使うため。src/robots.ts）。
      {
        const siteFile = handleSiteFile(path, request.method, url.origin, env);
        if (siteFile) return siteFile;
      }
      // --- API ---
      if (path === "/api/search" && request.method === "GET") {
        return await handleSearch(request, env);
      }
      // 検索欄の入力補完（前方一致の候補。src/suggest.ts）。
      if (path === "/api/suggest" && request.method === "GET") {
        return await handleSuggest(request, env);
      }
      // 現在のデプロイ版を返す。開きっぱなしの SPA タブがこれを見て、自分が読み込んだ版
      // （<meta app-version>）と食い違ったら「新しい版」バナーを出す。see public/app.js
      if (path === "/api/version" && request.method === "GET") {
        return json({ version: appVersion(env) }, 200, { "cache-control": "no-store" });
      }
      // 本が追加されている回数ランキング (累計 / 過去30日 / 7日 / 24時間)。
      if (path === "/api/ranking" && request.method === "GET") {
        return await handleRanking(env, ctx);
      }
      // 公開リスト一覧（新着 / アクセス数順）。限定公開は含めない。
      if (path === "/api/public-lists" && request.method === "GET") {
        return await handlePublicLists(url, env);
      }
      // 売上ランキング（楽天ブックスの売れている順の日次スナップショットを作品単位で集計）。
      if (path === "/api/sales-ranking" && request.method === "GET") {
        return await handleSalesRanking(env);
      }
      // 発行部数ランキング（Wikipedia「List of best-selling manga」の累計発行部数）。
      if (path === "/api/circulation" && request.method === "GET") {
        return await handleCirculation(env);
      }
      // トップページの収録数（シリーズ / 巻 / 公開リスト）。
      if (path === "/api/site-stats" && request.method === "GET") {
        return await handleSiteStats(env, ctx);
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
      // グループの巻を返す。手動追加（抜け巻・新刊）と巻の通報はグループの正規 ID に記録し、
      // 既存シリーズに寄せられる・紐付け済みのグループならそのシリーズに記録する。
      // まとまりの名前（＝巻の書名。マスタが「Dr.スランプ」を「Dr」で持つなど壊れていること
      // がある）の通報も同じく正規 ID に記録する。管理者はその ID に series_name_override を
      // 書いて直す（src/admin.ts adminOverrideSeriesName、読み出しは groups.applyGroupNames）。
      const groupMatch = path.match(/^\/api\/series\/(G\d{13})\/(volumes|supplement|corrections|corrections\/report|report)$/);
      if (groupMatch) {
        const groupVolumes = () =>
          getGroupVolumes(env, groupMatch[1], (id) => getSeriesVolumes(env, id), () => getMasterUpdatedAt(env));
        // 巻一覧はエッジキャッシュ越しに返す（src/series.ts cachedSeriesVolumes）。まとまりの
        // supplement は探索せず巻一覧を返すだけだが、POST なのでキャッシュは挟まない。
        if (groupMatch[2] === "volumes" && request.method === "GET") {
          return await cachedSeriesVolumes(env, groupMatch[1], groupVolumes);
        }
        if (groupMatch[2] === "supplement" && request.method === "POST") {
          return await groupVolumes();
        }
        if ((groupMatch[2] === "corrections" || groupMatch[2] === "corrections/report") && request.method === "POST") {
          const r = await resolveGroup(env, groupMatch[1]);
          if (!r) return notFound("シリーズが見つかりません");
          const [id, group] = "seriesId" in r ? [r.seriesId, null] : [r.group.id, r.group];
          if (groupMatch[2] !== "corrections") return await reportVolume(request, env, id, group);
          const res = await addCorrection(request, env, id, group);
          // 手動追加は巻一覧の中身を変える。書いた本人がすぐ開き直すので、この colo の
          // キャッシュ（たどってきた G<ISBN> の分と、寄せ先のシリーズの分）を消す。
          if (res.ok) await Promise.all([groupMatch[1], id].map((k) => purgeSeriesVolumesCache(env, k)));
          return res;
        }
        if (groupMatch[2] === "report" && request.method === "POST") {
          const r = await resolveGroup(env, groupMatch[1]);
          if (!r) return notFound("シリーズが見つかりません");
          return "seriesId" in r
            ? await reportSeriesName(request, env, r.seriesId)
            : await reportSeriesName(request, env, r.group.id, r.group);
        }
        return badRequest("このまとまりはシリーズに属していないため、この操作はできません");
      }
      const seriesMatch = path.match(/^\/api\/series\/([A-Za-z0-9]+)\/volumes$/);
      if (seriesMatch && request.method === "GET") {
        bumpPopularity(env, "series", seriesMatch[1]);
        return await cachedSeriesVolumes(env, seriesMatch[1], () => getSeriesVolumes(env, seriesMatch[1]));
      }
      // Button-triggered live-MADB supplement probe (see src/series.ts). Kept out
      // of the GET above so browsing never blocks on the SPARQL round-trip.
      const supplementMatch = path.match(/^\/api\/series\/([A-Za-z0-9]+)\/supplement$/);
      if (supplementMatch && request.method === "POST") {
        bumpPopularity(env, "supplement", supplementMatch[1]);
        const res = await getSeriesVolumes(env, supplementMatch[1], true);
        // 補完の取得は巻一覧の中身と supplement_probed を変えるので、この colo の分を消す。
        if (res.ok) await purgeSeriesVolumesCache(env, supplementMatch[1]);
        return res;
      }
      const correctionReportMatch = path.match(/^\/api\/series\/([A-Za-z0-9]+)\/corrections\/report$/);
      if (correctionReportMatch && request.method === "POST") {
        return await reportVolume(request, env, correctionReportMatch[1]);
      }
      const correctionMatch = path.match(/^\/api\/series\/([A-Za-z0-9]+)\/corrections$/);
      if (correctionMatch && request.method === "POST") {
        const res = await addCorrection(request, env, correctionMatch[1]);
        if (res.ok) await purgeSeriesVolumesCache(env, correctionMatch[1]);
        return res;
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
      // 「廉価版・文庫版？」: シリーズ個別のタグの申請（collect-only, see src/labels.ts）。
      const tagReqMatch = path.match(/^\/api\/series\/([A-Za-z0-9]+)\/tag-request$/);
      if (tagReqMatch && request.method === "POST") {
        return await requestSeriesTag(request, env, tagReqMatch[1]);
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
      // 「マスタに無い作品をシリーズとして登録してほしい」依頼。collect-only で、運ぶのは
      // ISBN 1 つだけ（書名はサーバが控えから引く）。src/seriesRegister.ts
      if (path === "/api/series-register-requests" && request.method === "POST") {
        return await requestSeriesRegister(request, env);
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
      // --- Google ログイン（任意, src/auth.ts）と /api/me*（src/account.ts）---
      if (path === "/auth/google/login" && request.method === "GET") {
        return await loginStart(request, env);
      }
      if (path === "/auth/google/callback" && request.method === "GET") {
        return await loginCallback(request, env);
      }
      if (path === "/auth/logout" && request.method === "POST") {
        return await logout(request, env);
      }
      if (path === "/api/me" || path.startsWith("/api/me/")) {
        return await handleAccountApi(request, env, path);
      }
      if (path === "/api/lists" && request.method === "POST") {
        const user = await currentUser(request, env);
        const res = await createList(request, env, user?.id ?? null);
        if (res.ok) {
          const { slug } = (await res.clone().json()) as { slug: string };
          // 作成者はすぐ /l/:slug を開くので、応答前にスナップショットを作っておく。
          const fresh = await refreshListView(env, slug, url.origin);
          await queueShareImages(env, ctx, slug, url.host, fresh);
        }
        return res;
      }
      // 閲覧ページのアクセス数ビーコン（src/publicLists.ts）。
      const listViewMatch = path.match(/^\/api\/lists\/([A-Za-z0-9_-]+)\/view$/);
      if (listViewMatch && request.method === "POST") {
        return await handleListView(request, env, ctx, listViewMatch[1]);
      }
      const reportMatch = path.match(/^\/api\/lists\/([A-Za-z0-9_-]+)\/reports$/);
      if (reportMatch && request.method === "POST") {
        return await addReport(request, env, reportMatch[1]);
      }
      const listMatch = path.match(/^\/api\/lists\/([A-Za-z0-9_-]+)$/);
      if (listMatch) {
        const slug = listMatch[1];
        if (request.method === "GET") return await handleListJson(request, env, ctx, slug, url.origin);
        if (request.method === "PUT") {
          const res = await updateList(request, env, slug);
          if (res.ok) {
            const fresh = await refreshListView(env, slug, url.origin);
            await queueShareImages(env, ctx, slug, url.host, fresh);
          }
          return res;
        }
        return new Response("Method Not Allowed", { status: 405 });
      }

      // --- Admin ---
      // Cloudflare Access + Worker 側 JWT 検証でガード（src/adminAuth.ts）。
      // 管理 UI（/admin・/admin.html）と全 /api/admin/* を対象にする。UI を無認証で
      // 開けても中身は API が閉じていれば無害だが、多重防御として HTML も塞ぐ。
      // これらのパスは assets.run_worker_first（wrangler.jsonc）で Worker が先に走る。
      // 認証を通したら末尾の env.ASSETS.fetch(request) が /admin → admin.html を配信する。
      // admin.html に解決されうる変形（/ADMIN.html・/%61dmin・/admin/ 等）も isAdminUiPath で拾う。
      // 状態を変える /api/admin/* は CSRF よけに Origin 必須・自オリジン一致も求める（adminCsrfOk）。
      if (path.startsWith("/api/admin/") || isAdminUiPath(path)) {
        const denied = await requireAdmin(request, env);
        if (denied) return denied;
        if (path.startsWith("/api/admin/") && !adminCsrfOk(request, env)) {
          return json({ error: "不正なリクエストです" }, 403, { "cache-control": "no-store" });
        }
      }
      if (path === "/api/admin/stats" && request.method === "GET") {
        return await adminStats(request, env);
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
      // 発行部数ランキングの取り込み状況と、作品 → シリーズの寄せ直し。
      if (path === "/api/admin/circulation" && request.method === "GET") {
        return await adminCirculationStatus(env);
      }
      if (path === "/api/admin/circulation/recompute" && request.method === "POST") {
        return await adminCirculationRecompute(env);
      }
      // 指定の無い作品を自動照合して circulation_link に 'suggested' で入れる
      // （?overwrite=1 は 'suggested' の行も入れ直す。'manual' は触らない）。
      if (path === "/api/admin/circulation/suggest" && request.method === "POST") {
        return await adminCirculationSuggest(env, url.searchParams.get("overwrite") === "1");
      }
      // 寄せ先の確定（series_id: 文字列 = そこへ寄せる / "" = 寄せない / null = 自動に戻す）。
      if (path === "/api/admin/circulation/link" && request.method === "POST") {
        return await adminCirculationLink(env, await readJsonBody(request, MAX_JSON_BODY));
      }
      // サジェストの前方一致索引（series_suggest）を今の master から作り直す。ふだんは月次の
      // 取り込みが作り直すので、管理者が結合・名前修正をした分を今すぐ候補に反映したいとき用。
      if (path === "/api/admin/suggest/rebuild" && request.method === "POST") {
        return json({ ok: true, rows: await rebuildSuggest(env) }, 200, { "cache-control": "no-store" });
      }
      // 表紙・書誌キャッシュの暖機（公開前。scripts/warm-cache.mjs が繰り返し叩く）。
      if (path === "/api/admin/warm" && request.method === "GET") {
        return await adminWarmStatus(env);
      }
      if (path === "/api/admin/warm" && request.method === "POST") {
        return await adminWarm(env, url);
      }
      // 開発用: マスターデータ以外を全削除して DB を初期化。dev（ADMIN_DEV_BYPASS）限定。
      if (path === "/api/admin/dev/reset" && request.method === "POST") {
        return await adminDevReset(request, env);
      }
      if (path === "/api/admin/lists" && request.method === "GET") {
        return await adminListLists(env, parsePage(url));
      }
      const adminListMatch = path.match(/^\/api\/admin\/lists\/([A-Za-z0-9_-]+)$/);
      if (adminListMatch) {
        const slug = adminListMatch[1];
        if (request.method === "GET") return await adminGetList(env, slug);
        if (request.method === "DELETE") return await adminDeleteList(env, slug, url.origin);
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
      // 巻番号の付け直し・別シリーズへの移動（確定/却下だけでは直せない取り違えの受け皿）。
      if (adminCorrMatch && request.method === "PATCH") {
        return await adminUpdateCorrection(request, env, adminCorrMatch[1], adminCorrMatch[2]);
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
      // 修正を外す: 上書き行だけ消し、表示名をマスター（name_display → name）に戻す。
      // タグ（廉価版/文庫版/傑作選）で版の違いが出せるようになった修正の片付けに使う。
      const adminSeriesOverrideMatch = path.match(/^\/api\/admin\/series-overrides\/([A-Za-z0-9]+)$/);
      if (adminSeriesOverrideMatch && request.method === "DELETE") {
        return await adminDeleteNameOverride(env, adminSeriesOverrideMatch[1]);
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
      // 上流が壊している巻のマスタ行の修正（volume_master_fix）。src/masterFix.ts
      if (path === "/api/admin/master-fixes" && request.method === "GET") {
        return await adminListMasterFixes(env, parsePage(url));
      }
      if (path === "/api/admin/master-fixes/lookup" && request.method === "GET") {
        // フォームの下書き材料（今のマスタ行・既存の修正・openBD の書誌・シリーズの手本）。
        return await adminLookupMasterFix(env, url);
      }
      if (path === "/api/admin/master-fixes" && request.method === "POST") {
        return await adminSaveMasterFix(request, env);
      }
      const adminMasterFixMatch = path.match(/^\/api\/admin\/master-fixes\/([0-9Xx]+)$/);
      if (adminMasterFixMatch && request.method === "DELETE") {
        // 取り消し: 控えがあればマスタ行を戻し、無ければ（足した巻なので）消す。
        return await adminDeleteMasterFix(env, adminMasterFixMatch[1]);
      }
      // マスタに無い作品のシリーズ登録（custom_series + volume_master_fix）。src/seriesRegister.ts
      if (path === "/api/admin/series-register-requests" && request.method === "GET") {
        // ?resolved=1 で処理済み（登録/却下）の履歴、無ければ未処理のキュー。
        return await adminListRegisterRequests(env, parsePage(url), url);
      }
      const adminRegisterReqMatch = path.match(/^\/api\/admin\/series-register-requests\/([0-9Xx]+)$/);
      if (adminRegisterReqMatch && request.method === "DELETE") {
        return await adminDismissRegisterRequest(env, adminRegisterReqMatch[1]);
      }
      if (path === "/api/admin/series-register/candidates" && request.method === "GET") {
        // 代表 ISBN から作品を同定し、その作品の巻を楽天（+ 絶版巻は Yahoo）から集める。
        return await adminRegisterCandidates(env, url);
      }
      if (path === "/api/admin/series-register" && request.method === "POST") {
        return await adminRegisterSeries(request, env);
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
        return await adminPurgeCoverR2(request, env);
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
      // レーベルのタグ付け（廉価版・文庫版・傑作選）。?q= 名前（空白区切りで AND）/
      // ?filter= untagged | tagged | <タグ名> / ?era= dated | undated（発行年の有無）。
      if (path === "/api/admin/labels" && request.method === "GET") {
        // ページ送りはしない（絞り込んだ結果を 1 画面に出して全選択 → まとめて設定するため）。
        return await adminListLabels(
          env,
          url.searchParams.get("q") ?? "",
          url.searchParams.get("filter") ?? "",
          url.searchParams.get("era") ?? ""
        );
      }
      // レーベル名そのものが鍵なので（日本語・記号を含む）パスには載せず body で受ける。
      if (path === "/api/admin/labels" && request.method === "POST") {
        return await adminSetLabelTags(env, await readJsonObject(request));
      }
      // シリーズ個別のタグ: 利用者からの申請のキューと、確定・却下・直接設定。
      if (path === "/api/admin/series-tag-requests" && request.method === "GET") {
        return await adminListSeriesTagRequests(env, parsePage(url));
      }
      const adminTagReqConfirm = path.match(/^\/api\/admin\/series-tag-requests\/([A-Za-z0-9]+)\/confirm$/);
      if (adminTagReqConfirm && request.method === "POST") {
        return await adminConfirmSeriesTagRequest(env, adminTagReqConfirm[1], await readJsonObject(request));
      }
      const adminTagReqMatch = path.match(/^\/api\/admin\/series-tag-requests\/([A-Za-z0-9]+)$/);
      if (adminTagReqMatch && request.method === "DELETE") {
        return await adminDismissSeriesTagRequest(env, adminTagReqMatch[1]);
      }
      if (path === "/api/admin/series-tags" && request.method === "POST") {
        return await adminSetSeriesTag(env, await readJsonObject(request));
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
        return await adminRedactReport(env, Number(adminReportRedactMatch[1]), url.origin);
      }
      const adminReportMatch = path.match(/^\/api\/admin\/reports\/([0-9]+)$/);
      if (adminReportMatch && request.method === "DELETE") {
        return await adminDismissReport(env, Number(adminReportMatch[1]));
      }

      // --- Public view page with OGP meta ---
      const viewMatch = path.match(/^\/l\/([A-Za-z0-9_-]+)$/);
      if (viewMatch && request.method === "GET") {
        return await renderViewPage(request, env, ctx, viewMatch[1], url.origin, url.searchParams.get("i") === "1");
      }

      // --- Share image (all 100 covers in one picture; og:image + X attachment) ---
      const shareMatch = path.match(/^\/share\/([A-Za-z0-9_-]+)\/(og|full|q[1-4])\.jpg$/);
      if (shareMatch && request.method === "GET") {
        return await handleShareImage(request, env, ctx, shareMatch[1], shareMatch[2] as ShareVariant);
      }
    } catch (err) {
      console.error("request failed", err);
      if (path.startsWith("/api/")) return json({ error: "サーバエラーが発生しました" }, 500);
      // ブラウザで開かれるページには素のテキストではなく簡単なエラー画面を返す。
      if ((request.headers.get("accept") ?? "").includes("text/html")) return errorPageHtml(site(env).name);
      return new Response("Internal Server Error", { status: 500 });
    }

    // --- Static assets (editor, css, js, view.html template, etc.) ---
    // HTML ページには <!--ANALYTICS--> に Google タグを差し込む（admin は素通り）。
    return injectAnalytics(await fetchSiteAsset(request, env, path), env, url.origin, path);
  },

  // Cron（wrangler.jsonc triggers）: 売上ランキングの日次スナップショット。
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runSalesSnapshot(env, "cron").then(
        (r) => console.log("sales snapshot", r),
        (err) => console.error("sales snapshot failed", err)
      )
    );
    // 公開リストのアクセス数の重複判定（list_view_seen）の古い記録を消す。
    ctx.waitUntil(purgeListViewSeen(env).catch((err) => console.error("list view purge failed", err)));
    // 公開の監査ログ（publish_audit, IP・UA を含む）は 365 日で消す。期限切れのログインセッションも掃除する。
    ctx.waitUntil(purgePublishAudit(env).catch((err) => console.error("publish audit purge failed", err)));
    ctx.waitUntil(purgeExpiredSessions(env).catch((err) => console.error("session purge failed", err)));
  },

  // キューの consumer。閲覧ビーコン（VIEW_QUEUE）と共有画像（SHARE_QUEUE）の 2 本を受ける。
  async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
    if (batch.queue.includes(VIEW_QUEUE_MARK)) return await consumeViewBatch(batch, env);
    // 共有画像の事前生成（SHARE_QUEUE, wrangler.jsonc queues）。max_batch_size 1 /
    // max_concurrency 1 で、1 リストの og/full/q1–q4 を 1 枚ずつ描いて R2 に置く（og は
    // 公開時に描き済みなので、R2 にあれば飛ばす）。
    for (const msg of batch.messages) {
      const job = msg.body as Partial<ShareJob> | null;
      if (!job || typeof job.slug !== "string" || typeof job.host !== "string" || !/^[A-Za-z0-9_-]+$/.test(job.slug)) {
        msg.ack(); // 形の壊れたメッセージは捨てる
        continue;
      }
      try {
        await renderAllShareImages(env, ctx, job as ShareJob);
        msg.ack();
      } catch (err) {
        console.error("share queue job failed", job.slug, err);
        msg.retry();
      }
    }
  },
} satisfies ExportedHandler<Env>;

// 閲覧ビーコンのキューの見分け方。1 つの Worker が閲覧ビーコンと共有画像の 2 本を受けるので、
// キュー名で振り分ける。名前の頭はデプロイごとに違う（my100manga-views / my100shunga-views-dev
// 等）ので、プロジェクト名ではなく用途の部分だけを見る。wrangler.jsonc のキュー名はこれに
// 合わせて付けること（閲覧ビーコン側に "-views" を含める）。
const VIEW_QUEUE_MARK = "-views";

export default {
  ...worker,
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const res = await worker.fetch(request, env, ctx);
    // 管理者の変更（結合・表紙承認・名前修正など）を閲覧ページに早く反映するため、表示に効く
    // admin の更新系 API が成功したら表示データの世代を上げる（src/viewSnapshot.ts）。
    if (res.ok && bumpsViewEpoch(request)) {
      ctx.waitUntil(bumpViewEpoch(env).catch((err) => console.error("view epoch bump failed", err)));
    }
    return withSecurityHeaders(res);
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
    return await limiterStub(env.RAKUTEN_LIMITER, "cover-queue").report(client, Math.min(Math.max(Math.floor(pending), 0), 1000));
  } catch {
    return null; // presence is cosmetic — never fail the cover fill over it
  }
}

// ?v=<hash> on the URL is only a cache buster; the response is whatever the list
// looks like now. Rendering is CPU-heavy, so only a cache miss counts against the
// per-IP limit (a miss happens once per list edit per variant).
async function handleShareImage(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  slug: string,
  variant: ShareVariant
): Promise<Response> {
  const data = await getListSnapshot(env, ctx, slug);
  if (!data) return new Response("not found", { status: 404 });
  let limited: Response | null = null;
  // リンクプレビューのクローラ（X 等）は投稿直後に一斉に取りに来るので、人のブラウザとは
  // 別 bucket にして互いに干渉させない。素通しにはしない: UA は名乗るだけで詐称できるので、
  // 素通しだと描画（CPU とメモリを最も食う処理）を無制限に起こせる。
  const bucket = isLinkPreviewBot(request.headers.get("user-agent")) ? "share-bot" : "share";
  const body = await getShareImage(env, ctx, data, variant, new URL(request.url).host, {
    onMiss: async () => !(limited = await rateLimit(request, env.RL_COVERS, bucket)),
  });
  if (!body) return limited ?? new Response("rate limited", { status: 429 });
  return new Response(body, {
    headers: {
      "content-type": "image/jpeg",
      "cache-control": new URL(request.url).searchParams.has("v") ? COVER_CACHE : "public, max-age=300",
    },
  });
}

// 作成/更新の直後に共有画像を描いておく。X 等のクローラは投稿直後に og:image を取りに来る
// ので、og はこのリクエストの waitUntil ですぐ描く（グローバルに直列のキューで待たせない）。
// 残りの variant（full/q1–q4）はキュー（SHARE_QUEUE）に遅延付きで積み、consumer が描く。
// 遅延の間に編集し直されたら、consumer は古いメッセージを捨てる（renderAllShareImages）ので、
// 編集を続けても描画は最後の版の 1 回で済む。
const SHARE_QUEUE_DELAY_SEC = 60;

async function queueShareImages(env: Env, ctx: ExecutionContext, slug: string, host: string, list: MangaList | null): Promise<void> {
  ctx.waitUntil(
    (async () => {
      const data = list ?? (await getListSnapshot(env, ctx, slug));
      if (data) await getShareImage(env, ctx, data, "og", host);
    })().catch((err) => console.error("share image prewarm failed", err))
  );
  if (!env.SHARE_QUEUE) return;
  try {
    const job: ShareJob = { slug, host, updated_at: list?.updated_at };
    await env.SHARE_QUEUE.send(job, { delaySeconds: SHARE_QUEUE_DELAY_SEC });
  } catch (err) {
    console.error("share queue send failed", err);
  }
}

/** キュー consumer の本体: og を先頭に全 variant を 1 枚ずつ、R2 に無いものだけ描く。
 *  メッセージより新しい版があれば（遅延中に編集された）、その版のメッセージが後から来るので捨てる。 */
async function renderAllShareImages(env: Env, ctx: ExecutionContext, job: ShareJob): Promise<void> {
  const data = await getListSnapshot(env, ctx, job.slug);
  if (!data) return; // 削除済み
  if (typeof job.updated_at === "number" && data.updated_at > job.updated_at) return;
  for (const variant of SHARE_VARIANTS) await ensureShareImage(env, ctx, data, variant, job.host);
}

// 閲覧レスポンスの cache-control。ブラウザは毎回取り直し（編集直後に古い版を見せない）、
// colo キャッシュ（Cache API）には VIEW_CACHE_TTL 秒置く。
const VIEW_CACHE_CONTROL = `public, max-age=0, s-maxage=${VIEW_CACHE_TTL}`;
// キャッシュに置いたレスポンスに持たせる表示名（人気計測用）。返す前に外す。
const OWNER_HEADER = "x-my100manga-owner";

/** 公開 JSON（GET /api/lists/:slug）。スナップショットから返し、colo キャッシュに置く。
 *  edit_token は MangaList に元から含まれない（編集用は /api/me/lists が返す）。 */
async function handleListJson(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  slug: string,
  origin: string
): Promise<Response> {
  const key = (await viewCacheKeys(env, origin, slug)).json;
  const cached = await readViewCache(key);
  if (cached) {
    if (cached.status !== 404) return cached;
    // 404 の写しは colo の中だけで使う。ブラウザに持たせると、作成直後に同じ slug を開いた
    // 端末が「見つかりません」を抱えたままになる。
    const headers = new Headers(cached.headers);
    headers.set("cache-control", "no-store");
    return new Response(cached.body, { status: 404, headers });
  }
  const data = await getListSnapshot(env, ctx, slug);
  if (!data) {
    const limited = await listMissLimited(request, env);
    if (limited) return limited;
    // ブラウザには持たせない（作成直後に「見つかりません」を抱えたままにしない）。写しだけ
    // colo に短く置く。
    const res = notFound("リストが見つかりません");
    res.headers.set("cache-control", "no-store");
    ctx.waitUntil(writeViewCache(key, notFoundCacheCopy(res)));
    return res;
  }
  const res = json(data, 200, { "cache-control": VIEW_CACHE_CONTROL });
  ctx.waitUntil(writeViewCache(key, res.clone()));
  return res;
}

/** 存在しない slug は R2（スナップショット）と D1 を 1 回ずつ使うので、総当たり（/l/<ランダム>・
 *  /api/lists/<ランダム>）を無制限には通さない。見つからなかったときだけ数えるので、普通の閲覧や
 *  共有リンクは何度開いても当たらない（同じ IP を大勢で共有していても閲覧は止まらない）。 */
async function listMissLimited(request: Request, env: Env): Promise<Response | null> {
  return await rateLimit(request, env.RL_COVERS, "list-404");
}

/** 404 を colo キャッシュに置く写し（本体はブラウザに no-store で返す）。 */
function notFoundCacheCopy(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("cache-control", `public, max-age=${NOT_FOUND_CACHE_TTL}`);
  return new Response(res.clone().body, { status: 404, headers });
}

// 見つからないリストは 404 のページを返す（以前は /?notfound=list へ 302 していた。
// app.js 側の ?notfound=list 処理は古いリンク用にそのまま残る）。public/404.html があれば
// それを使い、無ければ簡単なページを出す。
/** 存在しないリストの 404 を colo キャッシュに置く秒数。 */
const NOT_FOUND_CACHE_TTL = 60;

async function listNotFoundPage(env: Env, origin: string): Promise<Response> {
  const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
  try {
    const res = await fetchSiteAsset(new Request(`${origin}/404`), env, "/404");
    if (res.ok && (res.headers.get("content-type") ?? "").includes("text/html")) {
      return await injectAnalytics(new Response(await res.text(), { status: 404, headers }), env, origin);
    }
  } catch {
    // フォールバックへ
  }
  const name = escapeHtml(site(env).name);
  const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>リストが見つかりません | ${name}</title>
<style>body{font-family:system-ui,-apple-system,"Hiragino Sans",sans-serif;margin:0;color:#222;background:#f7f8fb}header{padding:12px 16px;background:#fff;border-bottom:1px solid #e3e6ee}header a{color:#2a5bd7;font-weight:bold;text-decoration:none}main{max-width:560px;margin:48px auto;padding:0 16px;line-height:1.7}a.btn{display:inline-block;margin-top:16px;padding:8px 16px;border-radius:6px;background:#2a5bd7;color:#fff;text-decoration:none}</style>
</head>
<body>
<header><a href="/">${name}</a></header>
<main>
<h1>リストが見つかりませんでした</h1>
<p>削除されたか、URL が間違っている可能性があります。</p>
<a class="btn" href="/">トップへ戻る</a>
</main>
</body>
</html>`;
  return new Response(html, { status: 404, headers });
}

// noCard（?i=1）は画像付きで投稿するとき用の URL（public/share-x.js）。リンクカードの
// メタタグを出さないので、X 等がカードを作らず添付画像の邪魔をしない。
async function renderViewPage(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  slug: string,
  origin: string,
  noCard = false
): Promise<Response> {
  const keys = await viewCacheKeys(env, origin, slug);
  const key = noCard ? keys.pageNoCard : keys.page;
  const cached = await readViewCache(key);
  if (cached) {
    const headers = new Headers(cached.headers);
    if (cached.status === 404) {
      headers.set("cache-control", "no-store");
      return new Response(cached.body, { status: 404, headers });
    }
    const owner = cached.headers.get(OWNER_HEADER);
    bumpPopularity(env, "list", slug, owner ? decodeURIComponent(owner) : "");
    headers.delete(OWNER_HEADER);
    return new Response(cached.body, { status: cached.status, headers });
  }

  const data = await getListSnapshot(env, ctx, slug);
  if (!data) {
    // 毎回違う slug で総当たりされるとキャッシュは効かないので、見つからなかった回数で止める。
    const limited = await listMissLimited(request, env);
    if (limited) return limited;
    // 存在しない slug も colo キャッシュに短く置く（同じ URL を繰り返し叩かれても R2・D1 を
    // 使わない）。作成時は refreshListView がこの colo のキーを消すので、出来たてのリストが
    // 404 のまま見えるのは、作成前に同じ slug を開いた他の colo で最大 NOT_FOUND_CACHE_TTL 秒だけ。
    const res = await listNotFoundPage(env, origin);
    ctx.waitUntil(writeViewCache(key, notFoundCacheCopy(res)));
    return res;
  }
  bumpPopularity(env, "list", slug, data.owner_name ?? "");

  const templateRes = await fetchSiteAsset(new Request(`${origin}/view.html`), env, "/view.html");
  // script/stylesheet の ?v= と <meta app-version>、サイト種別の表記は、ユーザ入力を差し込む前の
  // テンプレートに付ける。
  let html = injectVersion(applySiteIdentity(await templateRes.text(), env, origin), appVersion(env));

  const pageUrl = `${origin}/l/${slug}`;
  const meta = buildOgp(site(env).name, data, pageUrl, `${origin}/share/${slug}/og.jpg?v=${await shareImageHash(data)}`, noCard);
  const aff = affIds(env);
  const injected =
    `<script>window.__LIST__=${safeJson(data)};` +
    `window.__AFF__=${safeJson(aff)};</script>`;

  // 置換文字列にユーザ入力（表示名・コメント）が入るので、関数で渡して `$&` 等を
  // 特殊パターンとして解釈させない。
  const fill: [string, string][] = [
    ["<!--OGP_META-->", meta],
    ["<!--ANALYTICS-->", analyticsTags(env)],
    ["<!--GTM_BODY-->", gtmBody(env)],
    ["<!--LIST_DATA-->", injected],
    ["<!--HEADER_LINKS-->", headerLinksHtml(env)],
    ["<!--FOOTER_AFF-->", footerHtml(env, true)],
  ];
  for (const [ph, value] of fill) html = replaceLiteral(html, ph, value);

  // 限定公開リストは検索エンジンに載せない（URL を知っている人だけが見る想定）。
  const headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": VIEW_CACHE_CONTROL,
  };
  if (data.unlisted) headers["x-robots-tag"] = "noindex";
  const res = new Response(html, { headers });
  const toCache = new Response(html, { headers: { ...headers, [OWNER_HEADER]: encodeURIComponent(data.owner_name ?? "") } });
  ctx.waitUntil(writeViewCache(key, toCache));
  return res;
}

function buildOgp(siteName: string, data: MangaList, pageUrl: string, image: string, noCard = false): string {
  const owner = data.owner_name ? `${data.owner_name}さん` : "誰か";
  const title = `${owner}を構成する100の漫画`;
  const titles = ogpWorkTitles(data).join("、");
  const desc = titles ? `${titles} など${data.items.length}冊` : `${data.items.length}冊のおすすめ漫画リスト`;
  const robots = data.unlisted ? [`<meta name="robots" content="noindex">`] : [];
  const canonical = `<link rel="canonical" href="${escapeHtml(pageUrl)}">`;

  if (noCard) {
    return [
      ...robots,
      `<meta name="description" content="${escapeHtml(desc)}">`,
      canonical,
      `<title>${escapeHtml(title)} | ${escapeHtml(siteName)}</title>`,
    ].join("\n  ");
  }
  const tags = [
    ...robots,
    canonical,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="${escapeHtml(siteName)}">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(desc)}">`,
    `<meta property="og:url" content="${escapeHtml(pageUrl)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${escapeHtml(title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(desc)}">`,
    `<meta name="description" content="${escapeHtml(desc)}">`,
    `<meta property="og:image" content="${escapeHtml(image)}">`,
    `<meta property="og:image:width" content="${SHARE_IMAGE_SIZE.og.width}">`,
    `<meta property="og:image:height" content="${SHARE_IMAGE_SIZE.og.height}">`,
    `<meta name="twitter:image" content="${escapeHtml(image)}">`,
  ];
  tags.push(`<title>${escapeHtml(title)} | ${escapeHtml(siteName)}</title>`);
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
