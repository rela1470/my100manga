import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ageConfirmed, ageGate } from "../src/ageGate";
import type { Env } from "../src/types";

// 年齢確認ゲート（R18版だけ、src/ageGate.ts）。テストの Worker は本家で動くので、
// R18版は env を差し替えて関数単位で見る（site.test.ts と同じやり方）。

const general = env as unknown as Env;
const adult = { ...general, SITE_VARIANT: "adult" } as Env;
const ORIGIN = "https://my100shunga.test";
const BROWSER = {
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130 Safari/537.36",
  accept: "text/html,application/xhtml+xml",
};

function get(path: string, headers: Record<string, string> = BROWSER): [Request, URL] {
  const req = new Request(`${ORIGIN}${path}`, { headers });
  return [req, new URL(req.url)];
}

const confirmed = { ...BROWSER, cookie: "age_ok=1" };

describe("年齢確認ゲート", () => {
  it("本家（general）では何もしない", async () => {
    for (const path of ["/", "/l/abc", "/api/public-lists"]) {
      expect(await ageGate(...get(path), general)).toBeNull();
    }
  });

  it("R18版で同意が無ければページの中身を返さない", async () => {
    const res = await ageGate(...get("/l/abc"), adult);
    expect(res?.status).toBe(200);
    expect(res?.headers.get("cache-control")).toBe("no-store");
    const html = await res!.text();
    expect(html).toContain("18歳以上です");
    expect(html).toContain("noindex");
    // 戻り先に元のパスを持つ（同意後にそこへ戻す）
    expect(html).toContain('name="next" value="/l/abc"');
    expect(res?.headers.get("set-cookie")).toBeNull();
  });

  it("同意済みの端末は素通り", async () => {
    expect(await ageGate(...get("/l/abc", confirmed), adult)).toBeNull();
    expect(ageConfirmed(get("/", confirmed)[0])).toBe(true);
    expect(ageConfirmed(get("/")[0])).toBe(false);
  });

  it("API は 403（未確認の端末から書き込みを通さない）", async () => {
    const res = await ageGate(...get("/api/public-lists", { ...BROWSER, accept: "application/json" }), adult);
    expect(res?.status).toBe(403);
    expect(await res!.json()).toMatchObject({ age_gate: true });
  });

  it("ドキュメント以外（css/js/画像）とクローラ、外に出る画像は素通り", async () => {
    const asset = await ageGate(...get("/styles.css", { accept: "text/css" }), adult);
    expect(asset).toBeNull();
    const dest = await ageGate(...get("/app.js", { ...BROWSER, "sec-fetch-dest": "script" }), adult);
    expect(dest).toBeNull();
    for (const path of ["/cover?u=x", "/share/abc/og.jpg", "/robots.txt", "/sitemap.xml", "/auth/google/callback", "/admin"]) {
      expect(await ageGate(...get(path), adult)).toBeNull();
    }
    const bot = await ageGate(...get("/l/abc", { ...BROWSER, "user-agent": "Twitterbot/1.0" }), adult);
    expect(bot).toBeNull();
  });

  it("同意の送信で Cookie を立てて元のページへ戻す", async () => {
    const req = new Request(`${ORIGIN}/age-gate`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: "next=%2Fl%2Fabc%3Fv%3D1",
    });
    const res = await ageGate(req, new URL(req.url), adult);
    expect(res?.status).toBe(303);
    expect(res?.headers.get("location")).toBe("/l/abc?v=1");
    const cookie = res?.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("age_ok=1");
    expect(cookie).toContain("Max-Age=31536000");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
  });

  it("外部への戻り先は捨てる / 他オリジンからの送信は拒否", async () => {
    const away = new Request(`${ORIGIN}/age-gate`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: "next=https%3A%2F%2Fevil.example%2F",
    });
    expect((await ageGate(away, new URL(away.url), adult))?.headers.get("location")).toBe("/");

    const cross = new Request(`${ORIGIN}/age-gate`, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" },
      body: "next=%2F",
    });
    const res = await ageGate(cross, new URL(cross.url), adult);
    expect(res?.status).toBe(403);
    expect(res?.headers.get("set-cookie")).toBeNull();
  });
});
