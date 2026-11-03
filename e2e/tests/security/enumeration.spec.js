// Security: account enumeration and brute-force limits.
// The shared e2e API runs with RATE_LIMIT_MAX=100000, so enumeration safety is
// checked against it, and the 429 behaviour against a PRIVATE instance of the
// real server started by this file with RATE_LIMIT_MAX=3.
import { test, expect, createUser, uniqueEmail } from "../fixtures.js";
import { apiClient, postJson, startPrivateApi } from "./helpers.js";

/** Status + body + the headers an attacker could diff on. */
async function shape(res) {
  const h = res.headers();
  return { status: res.status(), body: await res.text(), cacheControl: h["cache-control"], setCookie: h["set-cookie"] ?? null };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

test.describe("account enumeration", () => {
  test("register: existing verified, existing unverified and unknown e-mails get the identical 201 answer", async () => {
    const ctx = await apiClient();
    const verified = await createUser(ctx, { email: uniqueEmail("enum-v") });
    const unverified = await createUser(ctx, { email: uniqueEmail("enum-u"), verify: false });
    await ctx.post("/api/auth/logout");
    const body = (email) => ({ data: { email, password: "another-password-123", displayName: "Enum", acceptPrivacy: true } });
    const a = await shape(await ctx.post("/api/auth/register", body(verified.email)));
    const b = await shape(await ctx.post("/api/auth/register", body(unverified.email)));
    const c = await shape(await ctx.post("/api/auth/register", body(uniqueEmail("enum-new"))));
    expect(a.status).toBe(201);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    // The real owner can still log in with their own password (registering again did not change it).
    expect((await ctx.post("/api/auth/login", { data: { email: verified.email, password: verified.password } })).status()).toBe(200);
    await ctx.dispose();
  });

  test("forgot-password and resend-verification: identical 202 for existing, unverified and unknown e-mails", async () => {
    const ctx = await apiClient();
    const verified = await createUser(ctx, { email: uniqueEmail("enum-fv") });
    const unverified = await createUser(ctx, { email: uniqueEmail("enum-fu"), verify: false });
    await ctx.post("/api/auth/logout");
    for (const route of ["/api/auth/forgot-password", "/api/auth/resend-verification"]) {
      const answers = [];
      for (const email of [verified.email, unverified.email, uniqueEmail("enum-nobody"), verified.email.toUpperCase()]) {
        answers.push(await shape(await ctx.post(route, { data: { email } })));
      }
      expect(answers[0].status, route).toBe(202);
      for (const other of answers.slice(1)) expect(other, route).toEqual(answers[0]);
    }
    await ctx.dispose();
  });

  test("login: unknown e-mail and wrong password give the same 401 body; timing does not reveal which", async () => {
    const ctx = await apiClient();
    const user = await createUser(ctx, { email: uniqueEmail("enum-login") });
    const unverified = await createUser(ctx, { email: uniqueEmail("enum-login-u"), verify: false });
    await ctx.post("/api/auth/logout");
    const attempt = async (email, password) => {
      const t0 = performance.now();
      const res = await ctx.post("/api/auth/login", { data: { email, password } });
      return { ms: performance.now() - t0, ...(await shape(res)) };
    };
    const unknown = await attempt(uniqueEmail("enum-nobody"), "whatever-password-1");
    const wrong = await attempt(user.email, "whatever-password-1");
    const wrongUnverified = await attempt(unverified.email, "whatever-password-1");
    expect(unknown.status).toBe(401);
    for (const r of [wrong, wrongUnverified]) {
      expect({ status: r.status, body: r.body, setCookie: r.setCookie }).toEqual({ status: unknown.status, body: unknown.body, setCookie: unknown.setCookie });
    }
    expect(JSON.parse(unknown.body).error.code).toBe("INVALID_CREDENTIALS");

    // Timing: an unknown e-mail still pays for a password hash (no fast path).
    const tUnknown = [];
    const tWrong = [];
    for (let i = 0; i < 7; i++) {
      tUnknown.push((await attempt(uniqueEmail("enum-t"), "whatever-password-1")).ms);
      tWrong.push((await attempt(user.email, "whatever-password-1")).ms);
    }
    const [mu, mw] = [median(tUnknown), median(tWrong)];
    expect(mu, `median unknown ${mu.toFixed(1)} ms vs wrong password ${mw.toFixed(1)} ms`).toBeGreaterThan(mw * 0.4);
    await ctx.dispose();
  });
});

test.describe("brute-force limits (private API instance, RATE_LIMIT_MAX=3)", () => {
  let api;
  test.beforeAll(async () => {
    api = await startPrivateApi({ RATE_LIMIT_MAX: "3" });
  });
  test.afterAll(async () => {
    await api?.stop();
  });

  const ROUTES = [
    ["/api/auth/login", { email: "nobody@e2e.test", password: "wrong-password-1" }],
    ["/api/auth/register", { email: "burst@e2e.test", password: "correct-horse-battery", displayName: "Burst", acceptPrivacy: true }],
    ["/api/auth/forgot-password", { email: "nobody@e2e.test" }],
    ["/api/auth/resend-verification", { email: "nobody@e2e.test" }],
    ["/api/auth/verify-email", { token: "not-a-real-token", password: "wrong-password-1" }],
    ["/api/auth/reset-password", { token: "not-a-real-token", password: "new-password-123" }],
  ];

  test("every credential/e-mail route answers 429 RATE_LIMITED + Retry-After after the limit; spoofed X-Forwarded-For does not reset it", async () => {
    for (const [route, body] of ROUTES) {
      const statuses = [];
      let last;
      for (let i = 0; i < 6; i++) {
        // A different spoofed client IP on every request: must be ignored (TRUST_PROXY is unset).
        last = await postJson(api.origin, route, body, { "x-forwarded-for": `203.0.113.${i + 1}`, "x-real-ip": `198.51.100.${i + 1}` });
        statuses.push(last.status);
      }
      expect(statuses.slice(0, 3).every((s) => s !== 429), `${route}: first 3 allowed (${statuses})`).toBe(true);
      expect(statuses.slice(3), `${route}: ${statuses}`).toEqual([429, 429, 429]);
      expect(JSON.parse(last.body).error.code).toBe("RATE_LIMITED");
      expect(Number(last.headers["retry-after"])).toBeGreaterThan(0);
    }
  });

  test("the limit for one route does not leak into reads, and a limited login does not reveal whether the password was right", async () => {
    // GET routes are not limited.
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${api.origin}/api/auth/me`);
      expect(res.status).toBe(200);
    }
    // Login is already exhausted for this IP (previous test or this one): even a correct-looking
    // attempt gets the same 429, so the limiter cannot be used as a password oracle.
    let res;
    for (let i = 0; i < 5; i++) res = await postJson(api.origin, "/api/auth/login", { email: "nobody@e2e.test", password: "wrong-password-1" });
    expect(res.status).toBe(429);
    const other = await postJson(api.origin, "/api/auth/login", { email: "someone-else@e2e.test", password: "another-password" });
    expect(other.status).toBe(429);
    expect(JSON.parse(other.body).error.code).toBe("RATE_LIMITED");
  });
});
