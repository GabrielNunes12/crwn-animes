// Security sweep #2: abuse against the real server process. Covers races
// between concurrent requests, single-use links under concurrency, one admin
// request stalling every visitor, and hostile paths on the SEO renderer.
// (server/test/abuse.test.js covers the same ground in depth with a fake
// oEmbed; this spec checks the real stack end to end.)
//
// test.fail() marks a REAL defect: the test asserts the safe behaviour, fails
// today, and turns red ("expected to fail") once the defect is fixed. Then
// drop the .fail.
import { expect } from "@playwright/test";
import { SUBJECT, ensureSeries, ensureVideo, fakeYouTubeId, linkFrom, uniqueEmail, waitForEmail } from "../fixtures.js";
import { apiClient, newUserClient, rawRequest, test } from "./helpers.js";

// The stall test below blocks the server for ~0.5 s: keep this file's tests in one worker, in order,
// so it never skews the latency checks of its neighbours here.
test.describe.configure({ mode: "default" });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tokenOf = (link) => new URL(link).searchParams.get("token");
const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

test.describe("races on the real server", () => {
  test("rating storm: 48 concurrent PUT/DELETE from 8 users leave the summary equal to the users' own ratings; the series rating agrees", async ({ admin }) => {
    const id = unique();
    const slug = `abuse-storm-${id}`;
    const series = await ensureSeries(admin, { name: `Abuse Storm ${id}`, slug });
    const video = await ensureVideo(admin, { youtubeId: fakeYouTubeId("storm"), title: `Abuse Storm ${id} Episode 1`, section: "anime", seriesSlug: slug, number: 1 });
    expect(video.status).toBe("published");
    const users = await Promise.all(Array.from({ length: 8 }, () => newUserClient()));
    const url = `/api/videos/${video.id}/rating`;
    const reactions = [null, "fire", "laugh", "cry", "wow", "love"];

    const requests = Array.from({ length: 48 }, (_, i) => {
      const { ctx } = users[i % users.length];
      return i % 5 === 4 ? ctx.delete(url) : ctx.put(url, { data: { score: 1 + ((i * 7) % 5), reaction: reactions[i % reactions.length] } });
    });
    const statuses = (await Promise.all(requests)).map((r) => r.status());
    expect(statuses.filter((s) => s !== 200)).toEqual([]);

    const mine = (await Promise.all(users.map(async ({ ctx }) => (await (await ctx.get(url)).json()).mine))).filter(Boolean);
    const anon = await apiClient();
    const summary = await (await anon.get(url)).json();
    expect(summary.count).toBe(mine.length);
    for (const s of [1, 2, 3, 4, 5]) expect(summary.distribution[s], `score ${s}`).toBe(mine.filter((m) => m.score === s).length);
    for (const r of reactions.slice(1)) expect(summary.reactions[r], r).toBe(mine.filter((m) => m.reaction === r).length);
    const average = mine.length ? Math.round((mine.reduce((sum, m) => sum + m.score, 0) / mine.length) * 10) / 10 : null;
    expect(summary.average).toBe(average);

    // series_stats (kept by triggers) must agree with the per-video truth.
    const search = await (await anon.get(`/api/search?q=${encodeURIComponent(series.name)}&section=anime`)).json();
    expect(search.items.find((s) => s.slug === slug)?.rating).toEqual({ average, count: mine.length });
    await Promise.all([anon.dispose(), ...users.map(({ ctx }) => ctx.dispose())]);
  });

  test("e-mail links are single-use under concurrency: 12 parallel verifies → one session; 8 parallel resets → one winner, only its password logs in", async () => {
    const email = uniqueEmail("abuse-once");
    const password = "correct-horse-battery";
    const ctx = await apiClient();
    const startedAt = Date.now() - 1000;
    expect((await ctx.post("/api/auth/register", { data: { email, password, displayName: "Once", acceptPrivacy: true } })).status()).toBe(201);
    const token = tokenOf(linkFrom(await waitForEmail(ctx, { to: email, subject: SUBJECT.verify, after: startedAt })));

    const verifiers = await Promise.all(Array.from({ length: 12 }, () => apiClient()));
    const verifies = (await Promise.all(verifiers.map((c) => c.post("/api/auth/verify-email", { data: { token, password } })))).map((r) => r.status());
    expect(verifies.filter((s) => s === 200), `statuses ${verifies}`).toHaveLength(1);
    expect(verifies.filter((s) => s !== 200 && s !== 400)).toEqual([]);
    const signedIn = (await Promise.all(verifiers.map(async (c) => (await (await c.get("/api/auth/me")).json()).user))).filter(Boolean);
    expect(signedIn).toHaveLength(1);

    const resetStartedAt = Date.now() - 1000;
    expect((await ctx.post("/api/auth/forgot-password", { data: { email } })).status()).toBe(202);
    const resetToken = tokenOf(linkFrom(await waitForEmail(ctx, { to: email, subject: SUBJECT.reset, after: resetStartedAt })));
    const passwords = Array.from({ length: 8 }, (_, i) => `concurrent-reset-${i}-pw`);
    const resetters = await Promise.all(passwords.map(() => apiClient()));
    const resets = (await Promise.all(passwords.map((p, i) => resetters[i].post("/api/auth/reset-password", { data: { token: resetToken, password: p } })))).map((r) => r.status());
    const winners = resets.map((s, i) => (s === 200 ? i : -1)).filter((i) => i >= 0);
    expect(winners, `statuses ${resets}`).toHaveLength(1);
    expect(resets.filter((s) => s !== 200 && s !== 400)).toEqual([]);

    const loginClients = await Promise.all(passwords.map(() => apiClient()));
    const logins = await Promise.all(passwords.map(async (p, i) => (await loginClients[i].post("/api/auth/login", { data: { email, password: p } })).status()));
    expect(logins).toEqual(passwords.map((_, i) => (i === winners[0] ? 200 : 401)));
    // The verify winner's session died with the reset.
    expect((await Promise.all(verifiers.map(async (c) => (await (await c.get("/api/auth/me")).json()).user))).filter(Boolean)).toEqual([]);
    await Promise.all([ctx, ...verifiers, ...resetters, ...loginClients].map((c) => c.dispose()));
  });

  test("6 concurrent sign-ups of one e-mail: all 201; only the newest link works, and only with the password sent along with it", async () => {
    const email = uniqueEmail("abuse-dup");
    const attempts = Array.from({ length: 6 }, (_, i) => ({ password: `dup-signup-password-${i}`, displayName: `Dup ${i}` }));
    const ctx = await apiClient();
    const res = await Promise.all(attempts.map((a) => ctx.post("/api/auth/register", { data: { email, ...a, acceptPrivacy: true } })));
    expect(res.map((r) => r.status())).toEqual(attempts.map(() => 201));

    let mails = [];
    await expect
      .poll(async () => {
        mails = (await (await ctx.get("/api/dev/outbox")).json()).filter((m) => m.to === email && SUBJECT.verify.test(m.subject));
        return mails.length;
      })
      .toBe(attempts.length);
    const tokens = mails.map((m) => tokenOf(linkFrom(m)));
    for (const token of tokens.slice(0, -1)) {
      const old = await ctx.post("/api/auth/verify-email", { data: { token, password: attempts[0].password } });
      expect(old.status(), "an older sign-up link is dead").toBe(400);
    }
    // The newest link activates exactly one password (a wrong one is 401 and leaves the link valid).
    const tried = [];
    for (const attempt of attempts) {
      const client = await apiClient();
      const status = (await client.post("/api/auth/verify-email", { data: { token: tokens.at(-1), password: attempt.password } })).status();
      tried.push({ attempt, status, client });
      if (status === 200) break;
    }
    expect(tried.map((t) => t.status)).toEqual([...tried.slice(0, -1).map(() => 401), 200]);
    const winner = tried.at(-1);
    const me = (await (await winner.client.get("/api/auth/me")).json()).user;
    expect(me.displayName, "name and password come from the same sign-up").toBe(winner.attempt.displayName);
    await Promise.all([ctx, ...tried.map((t) => t.client)].map((c) => c.dispose()));
  });

  test.fail("a login racing the deletion of its account never answers 500", async () => {
    // DEFECT (server/src/routes/auth.js:57 + authService.js:68): the login verifies the password (~0.4 s) while the
    // account is deleted, then INSERT INTO sessions hits the foreign key → 500 INTERNAL_ERROR + a stack trace in the log.
    const { ctx, user } = await newUserClient();
    const clients = await Promise.all([0, 1, 2].map(() => apiClient()));
    const [deleted, ...logins] = await Promise.all([
      ctx.delete("/api/me", { data: { password: user.password } }),
      ...[20, 120, 220].map(async (ms, i) => {
        await sleep(ms);
        return (await clients[i].post("/api/auth/login", { data: { email: user.email, password: user.password } })).status();
      }),
    ]);
    expect(deleted.status()).toBe(204);
    await Promise.all([ctx, ...clients].map((c) => c.dispose()));
    expect(logins.filter((s) => s >= 500), `login statuses ${logins}`).toEqual([]);
  });

  test.fail("a password reset also ends logins that were in flight with the old password", async () => {
    // DEFECT (server/src/authService.js:154-166): login checks the password against the row it read before its
    // ~0.4 s scrypt and then creates a session without re-checking; a reset committed meanwhile does not end it.
    const { ctx, user } = await newUserClient();
    const startedAt = Date.now() - 1000;
    expect((await ctx.post("/api/auth/forgot-password", { data: { email: user.email } })).status()).toBe(202);
    const token = tokenOf(linkFrom(await waitForEmail(ctx, { to: user.email, subject: SUBJECT.reset, after: startedAt })));
    const resetter = await apiClient();
    const attackers = await Promise.all([0, 1, 2].map(() => apiClient()));
    const [reset] = await Promise.all([
      resetter.post("/api/auth/reset-password", { data: { token, password: "reset-by-the-real-owner-1" } }),
      ...[10, 120, 240].map(async (ms, i) => {
        await sleep(ms);
        return attackers[i].post("/api/auth/login", { data: { email: user.email, password: user.password } });
      }),
    ]);
    expect(reset.status()).toBe(200);
    const alive = [];
    for (const [i, attacker] of attackers.entries()) if ((await (await attacker.get("/api/auth/me")).json()).user) alive.push(i);
    await Promise.all([ctx, resetter, ...attackers].map((c) => c.dispose()));
    expect(alive, "old-password sessions that outlived the reset").toEqual([]);
  });
});

test.describe("CPU exhaustion", () => {
  test.fail("one 20 KB admin bulk paste does not stall other visitors for more than 100 ms", async ({ admin }) => {
    // DEFECT (server/src/routes/admin.js:65): collectBulkInputs strips trailing punctuation from every token with
    // /[>)"'\].]+$/g, which backtracks O(n²) on one long run of "." or ")": ~0.5 s of blocked event loop per request.
    const bulk = admin.post("/api/admin/videos/bulk", { data: { text: `${".".repeat(20 * 1024 - 40)}a`, dryRun: true } });
    const probes = [40, 120, 220].map(async (ms) => {
      await sleep(ms);
      const t0 = performance.now();
      const res = await rawRequest({ path: "/api/sections" });
      return { status: res.status, ms: performance.now() - t0 };
    });
    const [res, ...latencies] = await Promise.all([bulk, ...probes]);
    expect(res.status(), "no link in the paste").toBe(400);
    expect(latencies.map((p) => p.status)).toEqual([200, 200, 200]);
    const worst = Math.max(...latencies.map((p) => p.ms));
    expect(worst, `GET /api/sections latency while the paste is processed: ${latencies.map((p) => p.ms.toFixed(0)).join("/")} ms`).toBeLessThan(100);
  });

  test("hostile paths and query strings on the real page renderer and API: never 5xx, no pathological cost", async () => {
    const H = 15_000; // under Node's 16 KB header limit
    const paths = [
      `/genre/${"a".repeat(H)}`,
      `/genre/${"%C3%A7".repeat(2400)}`,
      `/anime/${"a-".repeat(H / 2)}a`,
      `/anime/one-piece/episode/${"9".repeat(10_000)}`,
      `/anime/one-piece/season/${"9".repeat(10_000)}/episode/1`,
      "/a".repeat(5000),
      `/sitemap-${"9".repeat(H)}.xml`,
      `/api/${"a".repeat(H)}`,
      `/api/videos/${"%41".repeat(H / 3)}`,
      `/api/search?${Array.from({ length: 1500 }, (_, i) => `p${i}=1`).join("&")}`,
      `/api/search?${"q=a&".repeat(1500)}`,
      `/api/search?limit=${"9".repeat(H)}`,
      `/api/latest?limit=${"9".repeat(H)}`,
      `/api/search?q=${encodeURIComponent("ﷺ".repeat(80))}`,
    ];
    const problems = [];
    for (const p of paths) {
      const t0 = performance.now();
      const res = await rawRequest({ path: p }).catch((error) => ({ status: error.code ?? error.message }));
      const ms = performance.now() - t0;
      if (typeof res.status !== "number" || res.status >= 500) problems.push(`${p.slice(0, 40)}…: ${res.status}`);
      // Generous: other workers share this server. server/test/abuse.test.js checks the 100 ms budget precisely.
      if (ms > 500) problems.push(`${p.slice(0, 40)}…: ${ms.toFixed(0)} ms`);
    }
    // Over Node's header limit: 431, or a reset when the server closes while the client is still sending.
    const over = await rawRequest({ path: `/api/${"a".repeat(100_000)}` }).catch((error) => ({ status: error.code }));
    expect([431, "ECONNRESET", "EPIPE"], "over the header limit").toContain(over.status);
    expect(problems).toEqual([]);
  });
});
