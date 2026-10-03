import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adminCsrfOk, devBypassActive, isAdminUiPath, requireAdmin } from "../src/adminAuth";
import { purgeExpiredSessions, safeReturnPath } from "../src/auth";
import { getTrimmedCover, normalizeCoverTarget, trimKind } from "../src/coverBytes";
import { createList, MAX_LIST_BODY, stripUrls, updateList } from "../src/lists";
import { purgePublishAudit, PUBLISH_AUDIT_RETENTION_MS } from "../src/reports";
import type { Env } from "../src/types";
import {
  BODY_TOO_LARGE,
  errorPageHtml,
  readJsonBody,
  replaceLiteral,
  timingSafeEqualStr,
  withSecurityHeaders,
} from "../src/util";
import { BROWSER_UA, items } from "./helpers";

const baseEnv = env as unknown as Env;
const withEnv = (over: Partial<Env>): Env => ({ ...baseEnv, ...over });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("safeReturnPath（ログイン後の戻り先）", () => {
  it("同一オリジンのパスはクエリ・ハッシュごと返す", () => {
    expect(safeReturnPath("/l/abc?x=1#top")).toBe("/l/abc?x=1#top");
    expect(safeReturnPath("/")).toBe("/");
  });
  it("外部へ飛ばせる形・制御文字・バックスラッシュは / に落とす", () => {
    for (const raw of [
      null,
      "",
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "/\tevil.example",
      "/\n/evil.example",
      "\\/evil.example",
      "evil",
      "/" + "a".repeat(600),
    ]) {
      expect(safeReturnPath(raw)).toBe("/");
    }
  });
});

describe("admin の保護", () => {
  it("admin.html に解決されうるパスの変形を拾う", () => {
    for (const p of ["/admin", "/admin.html", "/admin/", "/ADMIN.html", "/%61dmin.html", "/%2561dmin", "//admin", "/admin/index.html", "/x/%2e%2e/admin"]) {
      expect(isAdminUiPath(p), p).toBe(true);
    }
    for (const p of ["/", "/admin.js", "/administrator", "/api/admin/stats", "/l/admin"]) {
      expect(isAdminUiPath(p), p).toBe(false);
    }
  });

  it("ADMIN_DEV_BYPASS はローカルからのリクエストでだけ効く", () => {
    const on = withEnv({ ADMIN_DEV_BYPASS: "true" });
    expect(devBypassActive(new Request("http://localhost:8787/admin"), on)).toBe(true);
    expect(devBypassActive(new Request("http://127.0.0.1:8787/admin"), on)).toBe(true);
    expect(devBypassActive(new Request("http://[::1]:8787/admin"), on)).toBe(true);
    // wrangler dev は URL を routes のドメインに書き換えるが、cf-connecting-ip はループバック。
    expect(devBypassActive(new Request("https://example.com/admin", { headers: { "cf-connecting-ip": "127.0.0.1" } }), on)).toBe(true);
    expect(devBypassActive(new Request("https://example.com/admin"), on)).toBe(false);
    expect(devBypassActive(new Request("https://example.com/admin", { headers: { "cf-connecting-ip": "203.0.113.1" } }), on)).toBe(false);
    expect(devBypassActive(new Request("http://localhost:8787/admin"), withEnv({ ADMIN_DEV_BYPASS: "" }))).toBe(false);
  });

  it("本番ホストではバイパスフラグがあっても未設定扱いで 403", async () => {
    const res = await requireAdmin(new Request("https://example.com/api/admin/stats"), withEnv({ ADMIN_DEV_BYPASS: "true" }));
    expect(res?.status).toBe(403);
  });

  it("ADMIN_EMAILS が空なら Access の設定があっても 403（fail-closed）", async () => {
    const res = await requireAdmin(
      new Request("https://example.com/api/admin/stats", { headers: { "cf-access-jwt-assertion": "x.y.z" } }),
      withEnv({ ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "aud", ADMIN_EMAILS: " , " })
    );
    expect(res?.status).toBe(403);
  });

  it("正しい Access JWT でも許可メール以外は 403、許可メールなら通す", async () => {
    const team = "team.cloudflareaccess.com";
    const aud = "aud-tag";
    const kp = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"]
    )) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey;
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const u = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (u === `https://${team}/cdn-cgi/access/certs`) return Response.json({ keys: [{ ...jwk, kid: "k1" }] });
      return realFetch(input, init);
    });
    const b64 = (o: unknown) =>
      btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const sign = async (email: string) => {
      const head = b64({ alg: "RS256", kid: "k1" });
      const body = b64({ aud: [aud], iss: `https://${team}`, exp: Math.floor(Date.now() / 1000) + 600, email });
      const sig = new Uint8Array(
        await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, new TextEncoder().encode(`${head}.${body}`))
      );
      const s = btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      return `${head}.${body}.${s}`;
    };
    const e = withEnv({ ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud, ADMIN_EMAILS: "Boss@Example.com" });
    const req = async (email: string) =>
      requireAdmin(new Request("https://example.com/api/admin/stats", { headers: { "cf-access-jwt-assertion": await sign(email) } }), e);
    expect((await req("someone@example.com"))?.status).toBe(403);
    expect(await req("boss@example.com")).toBeNull();
  });

  it("状態を変える admin API は Origin 必須・自オリジン一致", () => {
    const e = withEnv({ ADMIN_DEV_BYPASS: "" });
    const r = (method: string, origin?: string) =>
      new Request("https://example.com/api/admin/lists/x", { method, headers: origin ? { origin } : {} });
    expect(adminCsrfOk(r("GET"), e)).toBe(true);
    expect(adminCsrfOk(r("POST", "https://example.com"), e)).toBe(true);
    expect(adminCsrfOk(r("DELETE", "https://example.com"), e)).toBe(true);
    expect(adminCsrfOk(r("POST"), e)).toBe(false);
    expect(adminCsrfOk(r("DELETE", "https://evil.example"), e)).toBe(false);
    expect(adminCsrfOk(r("POST", "null"), e)).toBe(false);
    // ローカル dev（バイパス中）は Origin が localhost でも通す。
    const local = new Request("https://example.com/api/admin/lists/x", {
      method: "POST",
      headers: { origin: "http://localhost:8787", "cf-connecting-ip": "127.0.0.1" },
    });
    expect(adminCsrfOk(local, withEnv({ ADMIN_DEV_BYPASS: "true" }))).toBe(true);
    expect(adminCsrfOk(local, e)).toBe(false);
  });

  it("admin.html の変形パスも認証が無ければ 403（静的配信させない）", async () => {
    for (const p of ["/admin", "/admin.html", "/ADMIN.html", "/%61dmin.html", "/admin/"]) {
      const res = await SELF.fetch(`https://example.com${p}`, { redirect: "manual" });
      expect(res.status, p).toBe(403);
      expect(await res.text()).not.toContain("<html");
    }
  });
});

describe("セキュリティヘッダ・エラー画面", () => {
  it("HTML・API・静的アセットのどれにも付く", async () => {
    for (const p of ["/", "/api/version", "/styles.css"]) {
      const res = await SELF.fetch(`https://example.com${p}`);
      expect(res.headers.get("x-frame-options"), p).toBe("DENY");
      expect(res.headers.get("content-security-policy"), p).toBe("frame-ancestors 'none'");
      expect(res.headers.get("x-content-type-options"), p).toBe("nosniff");
      expect(res.headers.get("referrer-policy"), p).toBe("strict-origin-when-cross-origin");
      expect(res.headers.get("permissions-policy"), p).toContain("camera=()");
      await res.arrayBuffer();
    }
  });

  it("immutable なヘッダのレスポンスも作り直して付け、既存の同名ヘッダは上書きしない", async () => {
    const immutable = await fetch("data:text/plain,hi").catch(() => null);
    const res = withSecurityHeaders(
      immutable ?? new Response("hi", { headers: { "x-frame-options": "SAMEORIGIN" } })
    );
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(await res.text()).toBe("hi");
    const own = withSecurityHeaders(new Response("x", { headers: { "x-frame-options": "SAMEORIGIN" } }));
    expect(own.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  it("500 のエラー画面は日本語の HTML でトップへのリンクがある", async () => {
    const res = errorPageHtml();
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("エラーが発生しました");
    expect(html).toContain(`href="/"`);
  });
});

describe("util", () => {
  it("timingSafeEqualStr", () => {
    expect(timingSafeEqualStr("abc", "abc")).toBe(true);
    expect(timingSafeEqualStr("abc", "abd")).toBe(false);
    expect(timingSafeEqualStr("abc", "abcd")).toBe(false);
    expect(timingSafeEqualStr("", "x")).toBe(false);
  });

  it("replaceLiteral は $& などを特殊解釈しない", () => {
    expect(replaceLiteral("a<!--X-->b", "<!--X-->", "$&$'$`$1")).toBe("a$&$'$`$1b");
  });

  it("readJsonBody は上限超えを Content-Length でもストリームでも弾く", async () => {
    const big = JSON.stringify({ x: "a".repeat(2000) });
    expect(await readJsonBody(new Request("https://e/", { method: "POST", body: big }), 1000)).toBe(BODY_TOO_LARGE);
    const stream = new ReadableStream({
      start(c) {
        for (let i = 0; i < 4; i++) c.enqueue(new TextEncoder().encode("a".repeat(500)));
        c.close();
      },
    });
    expect(await readJsonBody(new Request("https://e/", { method: "POST", body: stream }), 1000)).toBe(BODY_TOO_LARGE);
    expect(await readJsonBody(new Request("https://e/", { method: "POST", body: `{"a":1}` }), 1000)).toEqual({ a: 1 });
    expect(await readJsonBody(new Request("https://e/", { method: "POST", body: `{` }), 1000)).toBeNull();
  });
});

describe("stripUrls", () => {
  it("スキーム無しのドメイン形式も消す", () => {
    expect(stripUrls("詳しくはexample.com/x を見て")).toBe("詳しくは を見て");
    expect(stripUrls("bit.ly/abc")).toBe("");
    expect(stripUrls("sub.example.co.jp")).toBe("");
    expect(stripUrls("https://a.example/b と www.example.org")).toBe("と");
  });
  it("作品名や巻表記は残す", () => {
    for (const s of ["Dr.STONE 最高", "Vol.2 が好き", "D.Gray-man", "ONE PIECE 105巻", "No.6", "メールは a@b"]) {
      expect(stripUrls(s)).toBe(s);
    }
  });
});

describe("/cover の正規化と上流チェック", () => {
  it("Yahoo はクエリ・フラグメントを捨て、楽天は既定サイズの _ex だけ残す", () => {
    expect(normalizeCoverTarget(new URL("https://item-shopping.c.yimg.jp/i/l/store_x?a=1#f"), "yahoo").toString()).toBe(
      "https://item-shopping.c.yimg.jp/i/l/store_x"
    );
    const mottainai = (q: string) =>
      normalizeCoverTarget(
        new URL(`https://thumbnail.image.rakuten.co.jp/@0_mall/comicset/cabinet/a.jpg${q}`),
        "mottainai"
      ).toString();
    expect(mottainai("?_ex=600x600&z=1")).toBe(
      "https://thumbnail.image.rakuten.co.jp/@0_mall/comicset/cabinet/a.jpg?_ex=600x600"
    );
    // 既定以外のサイズは落とす。残すと _ex を変えるだけで別ハッシュ＝別 R2 オブジェクト
    // （永久保存）を際限なく作らせられる。
    const bare = "https://thumbnail.image.rakuten.co.jp/@0_mall/comicset/cabinet/a.jpg";
    expect(mottainai("?_ex=1200x1200")).toBe(bare);
    expect(mottainai("?_ex=599x599")).toBe(bare);
    expect(mottainai("")).toBe(bare);
  });

  it("パスの形・ポート・認証情報が怪しい URL は対象外", () => {
    expect(trimKind(new URL("https://item-shopping.c.yimg.jp/i/l/store_x"))).toBe("yahoo");
    expect(trimKind(new URL("https://item-shopping.c.yimg.jp:8443/i/l/x"))).toBeNull();
    expect(trimKind(new URL("https://u:p@item-shopping.c.yimg.jp/i/l/x"))).toBeNull();
    expect(trimKind(new URL("https://item-shopping.c.yimg.jp/i/l/a;b"))).toBeNull();
    expect(trimKind(new URL("https://item-shopping.c.yimg.jp/i/l/" + "a".repeat(400)))).toBeNull();
    expect(trimKind(new URL("http://item-shopping.c.yimg.jp/i/l/x"))).toBeNull();
  });

  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  const target = new URL("https://item-shopping.c.yimg.jp/i/l/test_nonimage");
  const noR2 = withEnv({ COVERS: undefined });

  it("上流が image/* でなければデコードせず失敗扱い", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>", { headers: { "content-type": "text/html" } }));
    expect(await getTrimmedCover(noR2, ctx, target, "yahoo")).toBeNull();
  });

  it("上流が上限（2MB）超なら失敗扱い", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("x", { headers: { "content-type": "image/jpeg", "content-length": String(3 * 1024 * 1024) } })
    );
    expect(await getTrimmedCover(noR2, ctx, target, "yahoo")).toBeNull();
  });

  it("R2 ミス時に onMiss が拒めば上流を叩かない", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await getTrimmedCover(noR2, ctx, target, "yahoo", { onMiss: async () => false })).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("許可外ホストは 403", async () => {
    const res = await SELF.fetch(`https://example.com/cover?u=${encodeURIComponent("https://evil.example/a.jpg")}`);
    expect(res.status).toBe(403);
  });
});

describe("リスト作成・更新の入力上限", () => {
  const post = (body: string | Record<string, unknown>, headers: Record<string, string> = {}) =>
    new Request("https://example.com/api/lists", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": BROWSER_UA, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("200KB 超の本文は 413", async () => {
    const res = await createList(post({ owner_name: "x", items: items(), pad: "a".repeat(MAX_LIST_BODY) }), baseEnv, null);
    expect(res.status).toBe(413);
  });

  it("101 件以上は 1 件ずつの検証の前に 400", async () => {
    const res = await createList(post({ owner_name: "x", items: items(101) }), baseEnv, null);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("100件");
  });

  it("独自 URL にも NG ワードを当てる", async () => {
    const res = await createList(post({ owner_name: "x", items: items(), slug: "ｷﾓｲ" }), baseEnv, null);
    // 文字種で弾かれるもの（全角）は形式エラー、英字の NG ワードは NG エラー。
    expect(res.status).toBe(400);
    const res2 = await createList(post({ owner_name: "x", items: items(), slug: "ChinKo" }), baseEnv, null);
    expect(res2.status).toBe(400);
    expect(((await res2.json()) as { error: string }).error).toContain("不適切");
  });

  it("edit_token が違えば 403、正しければ更新できる", async () => {
    const created = await createList(post({ owner_name: "x", items: items() }), baseEnv, null);
    const { slug, edit_token } = (await created.json()) as { slug: string; edit_token: string };
    const put = (token: string) =>
      new Request(`https://example.com/api/lists/${slug}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: items(), edit_token: token }),
      });
    // 末尾 1 文字を必ず別の文字に差し替える。"0" を固定で足すと、トークンが 16 進で（util.ts
    // randomToken）元が "0" で終わるとき 16 回に 1 回は本物と同じになり、200 が返って落ちる。
    const wrong = edit_token.slice(0, -1) + (edit_token.endsWith("0") ? "1" : "0");
    expect((await updateList(put(wrong), baseEnv, slug)).status).toBe(403);
    expect((await updateList(put(""), baseEnv, slug)).status).toBe(403);
    expect((await updateList(put(edit_token), baseEnv, slug)).status).toBe(200);
  });
});

describe("Cron の掃除", () => {
  it("365 日より古い publish_audit を消す", async () => {
    const now = Date.now();
    const ins = env.DB.prepare(`INSERT INTO publish_audit (slug, action, created_at) VALUES (?, 'create', ?)`);
    await env.DB.batch([ins.bind("old", now - PUBLISH_AUDIT_RETENTION_MS - 1000), ins.bind("new", now - 1000)]);
    await purgePublishAudit(baseEnv, now);
    const { results } = await env.DB.prepare(`SELECT slug FROM publish_audit`).all<{ slug: string }>();
    expect(results.map((r) => r.slug)).toEqual(["new"]);
  });

  it("期限切れのセッションを消す", async () => {
    const now = Date.now();
    await env.DB.prepare(`DELETE FROM sessions`).run();
    const ins = env.DB.prepare(`INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES (?, 'u', 0, ?)`);
    await env.DB.batch([ins.bind("expired", now - 1), ins.bind("live", now + 60_000)]);
    await purgeExpiredSessions(baseEnv, now);
    const { results } = await env.DB.prepare(`SELECT id_hash FROM sessions`).all<{ id_hash: string }>();
    expect(results.map((r) => r.id_hash)).toEqual(["live"]);
  });
});
