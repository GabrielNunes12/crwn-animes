// Security: the session cookie, rotation, sign-out everywhere, password reset
// and single-use e-mail tokens.
import { test, expect, createUser, uniqueEmail, loginViaApi, waitForEmail, linkFrom, SUBJECT, newGuardedContext, headerLogin, headerUser, API_ORIGIN } from "../fixtures.js";
import { apiClient, newUserClient, rawRequest, sidOf, whoIs } from "./helpers.js";

const setCookies = (res) => res.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie").map((h) => h.value);

async function resetLink(ctx, email, startedAt) {
  const mail = await waitForEmail(ctx, { to: email, subject: SUBJECT.reset, after: startedAt });
  return linkFrom(mail);
}
const tokenOf = (link) => new URL(link).searchParams.get("token");

test.describe("session cookie", () => {
  test("login sets exactly one cookie: sid; HttpOnly; SameSite=Lax; Path=/; 30-day Max-Age; opaque high-entropy value", async () => {
    const ctx = await apiClient();
    const user = await createUser(ctx, { email: uniqueEmail("cookie") });
    await ctx.post("/api/auth/logout");
    const res = await ctx.post("/api/auth/login", { data: { email: user.email, password: user.password } });
    expect(res.status()).toBe(200);
    const cookies = setCookies(res);
    expect(cookies).toHaveLength(1);
    const [raw] = cookies;
    const [pair, ...attrs] = raw.split(";").map((s) => s.trim());
    const [name, value] = [pair.slice(0, pair.indexOf("=")), decodeURIComponent(pair.slice(pair.indexOf("=") + 1))];
    expect(name).toBe("sid");
    expect(value.length, "session token has >= 128 bits of entropy").toBeGreaterThanOrEqual(22);
    expect(value).not.toContain(String(user.email.split("@")[0]));
    const lower = attrs.map((a) => a.toLowerCase());
    expect(lower).toContain("httponly");
    expect(lower).toContain("samesite=lax");
    expect(lower).toContain("path=/");
    expect(lower.some((a) => a.startsWith("domain=")), "host-only cookie (no Domain attribute)").toBe(false);
    const maxAge = Number(lower.find((a) => a.startsWith("max-age="))?.split("=")[1]);
    expect(maxAge).toBeGreaterThan(29 * 86400);
    expect(maxAge).toBeLessThanOrEqual(30 * 86400);
    // The JSON body never echoes the token.
    expect(await res.text()).not.toContain(value);
    await ctx.dispose();
  });

  test("in the browser the sid cookie is HttpOnly + Lax and invisible to page scripts", async ({ page, context }) => {
    const user = await createUser(page.request, { email: uniqueEmail("cookiejs"), displayName: "Cookie JS" });
    await page.goto("/");
    await expect(headerUser(page, user.displayName)).toBeVisible();
    const cookies = await context.cookies();
    const sid = cookies.find((c) => c.name === "sid");
    expect(sid).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" });
    expect(await page.evaluate(() => document.cookie)).not.toContain("sid");
  });

  test("login rotates the session: a pre-set (fixated) sid and the previous sid both become invalid", async () => {
    const { ctx, user } = await newUserClient();
    const first = await sidOf(ctx);
    expect(await whoIs(first)).toMatchObject({ email: user.email });

    // Logging in again from the same client rotates: the old token is dead.
    await loginViaApi(ctx, user);
    const second = await sidOf(ctx);
    expect(second).not.toBe(first);
    expect(await whoIs(first)).toBeNull();
    expect(await whoIs(second)).toMatchObject({ email: user.email });

    // Session fixation: an attacker-chosen sid planted before login is never adopted.
    const planted = "attacker-chosen-session-id-0123456789abcdef";
    const res = await rawRequest({
      method: "POST",
      path: "/api/auth/login",
      headers: { "content-type": "application/json", cookie: `sid=${planted}` },
      body: JSON.stringify({ email: user.email, password: user.password }),
    });
    expect(res.status).toBe(200);
    const issued = /sid=([^;]+)/.exec([].concat(res.headers["set-cookie"]).join("\n"))?.[1];
    expect(issued).toBeTruthy();
    expect(decodeURIComponent(issued)).not.toBe(planted);
    expect(await whoIs(planted)).toBeNull();
    await ctx.dispose();
  });

  test("logout kills the server-side session (a copied sid cannot be replayed) and clears the cookie", async () => {
    const { ctx, user } = await newUserClient();
    const sid = await sidOf(ctx);
    const res = await ctx.post("/api/auth/logout");
    expect(res.status()).toBe(204);
    expect(setCookies(res).join(";")).toMatch(/sid=;.*(Expires=Thu, 01 Jan 1970|Max-Age=0)/i);
    expect(await whoIs(sid), "replayed sid after logout").toBeNull();
    expect(user.email).toBeTruthy();
    await ctx.dispose();
  });

  test("sign out everywhere (logout-all) kills every other browser context of that user, not other users", async ({ browser }) => {
    const ctxA = await newGuardedContext(browser);
    const ctxB = await newGuardedContext(browser);
    const other = await newUserClient({ displayName: "Bystander" });
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    const user = await createUser(pageA.request, { email: uniqueEmail("everywhere"), displayName: "Everywhere" });
    await loginViaApi(pageB.request, user);
    await pageB.goto("/account");
    await expect(headerUser(pageB, user.displayName)).toBeVisible();

    await pageA.goto("/account");
    await pageA.getByRole("button", { name: "Sair de todos os dispositivos" }).click();
    await expect(pageA).toHaveURL(/\/login/);
    expect(await (await pageA.request.get("/api/auth/me")).json()).toEqual({ user: null });

    await pageB.reload();
    await expect(headerLogin(pageB)).toBeVisible();
    expect(await (await pageB.request.get("/api/auth/me")).json()).toEqual({ user: null });
    expect((await pageB.request.get("/api/me/export")).status()).toBe(401);
    // Another user's session is untouched.
    expect((await (await other.ctx.get("/api/auth/me")).json()).user?.email).toBe(other.user.email);
    await Promise.all([ctxA.close(), ctxB.close(), other.ctx.dispose()]);
  });
});

test.describe("password reset & e-mail tokens", () => {
  test("reset revokes every other session, token is single-use, an older reset link dies when a newer one is issued", async () => {
    const { ctx: device1, user } = await newUserClient({ displayName: "Reset Me" });
    const device2 = await apiClient();
    await loginViaApi(device2, user);
    const attacker = await apiClient();

    let startedAt = Date.now() - 1000;
    expect((await attacker.post("/api/auth/forgot-password", { data: { email: user.email } })).status()).toBe(202);
    const oldLink = await resetLink(attacker, user.email, startedAt);
    await new Promise((r) => setTimeout(r, 1100)); // sentAt has ms precision; keep the second mail strictly newer
    startedAt = Date.now() - 100;
    expect((await attacker.post("/api/auth/forgot-password", { data: { email: user.email } })).status()).toBe(202);
    const newLink = await resetLink(attacker, user.email, startedAt);
    expect(tokenOf(newLink)).not.toBe(tokenOf(oldLink));
    expect(newLink.startsWith(`${new URL(newLink).origin}/reset-password?token=`)).toBe(true);

    const newPassword = "brand-new-password-456";
    const stale = await attacker.post("/api/auth/reset-password", { data: { token: tokenOf(oldLink), password: newPassword } });
    expect(stale.status(), "older reset link is invalid once a newer one exists").toBe(400);
    expect((await stale.json()).error.code).toBe("INVALID_TOKEN");

    const reset = await attacker.post("/api/auth/reset-password", { data: { token: tokenOf(newLink), password: newPassword } });
    expect(reset.status()).toBe(200);
    expect((await (await device1.get("/api/auth/me")).json()).user, "device 1 signed out").toBeNull();
    expect((await (await device2.get("/api/auth/me")).json()).user, "device 2 signed out").toBeNull();
    expect((await (await attacker.get("/api/auth/me")).json()).user?.email).toBe(user.email);

    const replay = await apiClient();
    const again = await replay.post("/api/auth/reset-password", { data: { token: tokenOf(newLink), password: "another-password-789" } });
    expect(again.status(), "reset token is single-use").toBe(400);
    expect((await again.json()).error.code).toBe("INVALID_TOKEN");
    expect((await replay.post("/api/auth/login", { data: { email: user.email, password: user.password } })).status()).toBe(401);
    expect((await replay.post("/api/auth/login", { data: { email: user.email, password: newPassword } })).status()).toBe(200);
    await Promise.all([device1.dispose(), device2.dispose(), attacker.dispose(), replay.dispose()]);
  });

  test("garbage, empty, oversized and verify-purpose tokens are refused by reset-password (and vice versa)", async () => {
    const ctx = await apiClient();
    const user = await createUser(ctx, { email: uniqueEmail("tokenmix"), verify: false });
    const verifyToken = tokenOf(user.verifyLink);
    // A verify token cannot be used as a reset token.
    const cross = await ctx.post("/api/auth/reset-password", { data: { token: verifyToken, password: "hijacked-password-1" } });
    expect(cross.status()).toBe(400);
    for (const token of ["", "x", "' OR 1=1 --", "a".repeat(201), null, 123, { $ne: null }, ["a"]]) {
      const res = await ctx.post("/api/auth/reset-password", { data: { token, password: "hijacked-password-1" } });
      expect(res.status(), `token ${JSON.stringify(token)}`).toBe(400);
      const v = await ctx.post("/api/auth/verify-email", { data: { token, password: user.password } });
      expect(v.status(), `verify token ${JSON.stringify(token)}`).toBe(400);
    }
    // The verify token still works (with the sign-up password) — exactly once.
    expect((await ctx.post("/api/auth/verify-email", { data: { token: verifyToken, password: user.password } })).status()).toBe(200);
    const replay = await apiClient();
    const again = await replay.post("/api/auth/verify-email", { data: { token: verifyToken, password: user.password } });
    expect(again.status(), "verify token is single-use").toBe(400);
    expect((await again.json()).error.code).toBe("INVALID_TOKEN");
    expect((await (await replay.get("/api/auth/me")).json()).user).toBeNull();
    await Promise.all([ctx.dispose(), replay.dispose()]);
  });

  test("changing the password revokes other sessions and pending reset links", async () => {
    const { ctx: device1, user } = await newUserClient();
    const device2 = await apiClient();
    await loginViaApi(device2, user);
    const anon = await apiClient();
    const startedAt = Date.now() - 1000;
    await anon.post("/api/auth/forgot-password", { data: { email: user.email } });
    const link = await resetLink(anon, user.email, startedAt);

    const wrong = await device1.post("/api/me/password", { data: { currentPassword: "not-my-password", newPassword: "changed-password-123" } });
    expect(wrong.status()).toBe(401);
    expect((await (await device2.get("/api/auth/me")).json()).user).not.toBeNull();

    const ok = await device1.post("/api/me/password", { data: { currentPassword: user.password, newPassword: "changed-password-123" } });
    expect(ok.status()).toBe(200);
    expect((await (await device1.get("/api/auth/me")).json()).user?.email, "this device keeps a fresh session").toBe(user.email);
    expect((await (await device2.get("/api/auth/me")).json()).user, "other device signed out").toBeNull();
    const late = await anon.post("/api/auth/reset-password", { data: { token: tokenOf(link), password: "attacker-password-1" } });
    expect(late.status(), "a reset link from before the change no longer works").toBe(400);
    await Promise.all([device1.dispose(), device2.dispose(), anon.dispose()]);
  });

  test("password-reset poisoning: Host / X-Forwarded-Host headers never change the e-mailed link", async () => {
    const ctx = await apiClient();
    const user = await createUser(ctx, { email: uniqueEmail("hostpoison") });
    const appOrigin = new URL(user.verifyLink).origin; // APP_URL
    const startedAt = Date.now() - 1000;
    const res = await rawRequest({
      method: "POST",
      path: "/api/auth/forgot-password",
      headers: {
        "content-type": "application/json",
        host: "evil.example",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "https",
        forwarded: "host=evil.example;proto=https",
      },
      body: JSON.stringify({ email: user.email }),
    });
    expect(res.status).toBe(202);
    const mail = await waitForEmail(ctx, { to: user.email, subject: SUBJECT.reset, after: startedAt });
    expect(mail.text).not.toContain("evil.example");
    expect(mail.html ?? "").not.toContain("evil.example");
    expect(linkFrom(mail).startsWith(`${appOrigin}/reset-password?token=`)).toBe(true);
    expect(API_ORIGIN).toBeTruthy();
    await ctx.dispose();
  });
});
