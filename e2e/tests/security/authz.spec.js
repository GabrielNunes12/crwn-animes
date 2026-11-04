// Security: authorisation / IDOR. Anonymous visitors and normal users attack
// every /api/admin/* route, other users' ratings and other users' data.
import { expect, seedSeries, createUser, uniqueEmail, loginViaApi } from "../fixtures.js";
import { apiClient, newUserClient, test, withAdmin } from "./helpers.js";

const SERIES = { name: "Sec Authz Saga", slug: "sec-authz-saga", aliases: [], genres: ["Segurança"] };
let seed; // { series, videos }

test.beforeAll(async () => {
  seed = await withAdmin((admin) =>
    seedSeries(admin, SERIES, [
      { youtubeId: "secAuthz001", title: "Sec Authz Saga Episode 1", section: "anime", number: 1 },
      { youtubeId: "secAuthz002", title: "Sec Authz Saga Episode 2", section: "anime", number: 2 },
      { youtubeId: "secAuthz003", title: "Sec Authz Saga Episode 3", section: "anime", number: 3 },
    ])
  );
});

/** Every admin route with a body that would succeed for an admin. */
function adminRoutes() {
  const sid = seed.series.id;
  const vid = seed.videos[0].id;
  return [
    ["GET", "/api/admin/series", null],
    ["GET", "/api/admin/series?q=sec&limit=100", null],
    ["POST", "/api/admin/series", { name: "Pwned Series", slug: "sec-pwned-series" }],
    ["PATCH", `/api/admin/series/${sid}`, { name: "Pwned" }],
    ["DELETE", `/api/admin/series/${sid}`, null],
    ["GET", "/api/admin/videos", null],
    ["GET", "/api/admin/videos?status=pending&availability=unavailable", null],
    ["POST", "/api/admin/videos", { url: "https://youtu.be/secPwned001", title: "Pwned video" }],
    ["POST", "/api/admin/videos/bulk", { text: "https://youtu.be/secPwned002", dryRun: false }],
    ["POST", "/api/admin/videos/health-check", null],
    ["PATCH", `/api/admin/videos/${vid}`, { section: "manga" }],
    ["DELETE", `/api/admin/videos/${vid}`, null],
    // v1.4: board, reorder, draft preview and the trash.
    ["GET", `/api/admin/series/${sid}`, null],
    ["PUT", `/api/admin/series/${sid}/order`, { section: "anime", season: 1, videoIds: seed.videos.map((v) => v.id).reverse(), expected: seed.videos.map((v) => v.id) }],
    ["GET", `/api/admin/videos/${vid}/preview`, null],
    ["GET", "/api/admin/trash", null],
    ["POST", `/api/admin/trash/series/${sid}/restore`, null],
    ["POST", `/api/admin/trash/videos/${vid}/restore`, null],
    ["DELETE", `/api/admin/trash/series/${sid}`, null],
    ["DELETE", `/api/admin/trash/videos/${vid}`, null],
    ["GET", "/api/admin/does-not-exist", null],
    // Express routing tricks: case, trailing slash, double slash, encoded slash.
    ["GET", "/api/ADMIN/series", null],
    ["GET", "/api/admin/series/", null],
    ["GET", "/api/admin//series", null],
  ];
}

async function expectAdminUntouched(admin) {
  const series = (await (await admin.get(`/api/admin/series?q=${encodeURIComponent(SERIES.name)}`)).json()).items;
  const s = series.find((x) => x.slug === SERIES.slug);
  expect(s, "the canary series still exists").toBeTruthy();
  expect(s.name).toBe(SERIES.name);
  const res = await admin.get(`/api/videos/${seed.videos[0].id}`);
  expect(res.status(), "the canary video is still published").toBe(200);
  expect((await res.json()).video.section).toBe("anime");
  const pwned = (await (await admin.get("/api/admin/videos?q=pwned")).json()).items;
  expect(pwned, "no video was created").toEqual([]);
  const pwnedSeries = (await (await admin.get("/api/admin/series?q=pwned")).json()).items;
  expect(pwnedSeries, "no series was created").toEqual([]);
  // v1.4: nothing was moved to the trash and the episode order was not changed.
  const trash = await (await admin.get("/api/admin/trash")).json();
  expect(trash.series.filter((x) => x.slug === SERIES.slug), "the canary series is not in the trash").toEqual([]);
  expect(trash.videos.filter((v) => v.seriesId === seed.series.id), "no canary video is in the trash").toEqual([]);
  const board = await (await admin.get(`/api/admin/series/${seed.series.id}`)).json();
  expect(board.sections.anime.videos.map((v) => [v.id, v.number]), "the canary episodes keep their order").toEqual(seed.videos.map((v, i) => [v.id, i + 1]));
}

test.describe("authorisation", () => {
  test("anonymous: every /api/admin/* route → 401 UNAUTHENTICATED, and nothing changes", async ({ admin }) => {
    const anon = await apiClient();
    for (const [method, url, data] of adminRoutes()) {
      const res = await anon.fetch(url, { method, ...(data ? { data } : {}) });
      expect(res.status(), `${method} ${url}`).toBe(401);
      expect((await res.json()).error.code, `${method} ${url}`).toBe("UNAUTHENTICATED");
      expect(res.headers()["cache-control"]).toBe("private, no-store");
    }
    await expectAdminUntouched(admin);
    await anon.dispose();
  });

  test("normal verified user: every /api/admin/* route → 403 FORBIDDEN, and nothing changes", async ({ admin }) => {
    const { ctx } = await newUserClient();
    for (const [method, url, data] of adminRoutes()) {
      const res = await ctx.fetch(url, { method, ...(data ? { data } : {}) });
      expect(res.status(), `${method} ${url}`).toBe(403);
      expect((await res.json()).error.code, `${method} ${url}`).toBe("FORBIDDEN");
    }
    await expectAdminUntouched(admin);
    await ctx.dispose();
  });

  test("a forged/garbage sid, or a method-override header, never grants admin", async () => {
    const forged = await apiClient({ extraHTTPHeaders: { cookie: "sid=admin; role=admin", "x-http-method-override": "GET", "x-forwarded-for": "127.0.0.1" } });
    for (const url of ["/api/admin/series", "/api/admin/videos"]) {
      expect((await forged.get(url)).status()).toBe(401);
      expect((await forged.post(url, { data: {} })).status()).toBe(401);
    }
    await forged.dispose();
  });

  test("privilege escalation by mass assignment: role in register / PATCH /api/me / __proto__ is ignored", async () => {
    const ctx = await apiClient();
    const email = uniqueEmail("massassign");
    // register with role: admin + isAdmin, then verify normally
    const user = await createUser(ctx, { email, displayName: "Mass Assign" });
    const patch = await ctx.patch("/api/me", { data: { displayName: "Still User", role: "admin", isAdmin: true, email: "admin@e2e.test", id: 1 } });
    expect(patch.status()).toBe(200);
    expect((await patch.json()).user).toMatchObject({ email, role: "user", displayName: "Still User" });
    const proto = await ctx.fetch("/api/me", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      data: '{"displayName":"Proto User","__proto__":{"role":"admin"},"constructor":{"prototype":{"role":"admin"}}}',
    });
    expect(proto.status()).toBe(200);
    expect((await proto.json()).user.role).toBe("user");
    expect((await ctx.get("/api/admin/series")).status()).toBe(403);
    expect(user.email).toBe(email);
    await ctx.dispose();
  });

  test("register with an extra role field cannot create an admin", async () => {
    const ctx = await apiClient();
    const email = uniqueEmail("regrole");
    const res = await ctx.post("/api/auth/register", { data: { email, password: "correct-horse-battery", displayName: "Reg Role", acceptPrivacy: true, role: "admin" } });
    expect(res.status()).toBe(201);
    await ctx.dispose();
    const c2 = await apiClient();
    // verify it properly, then check the role
    const u = await createUser(c2, { email, displayName: "Reg Role" });
    expect(u.email).toBe(email);
    expect((await (await c2.get("/api/auth/me")).json()).user.role).toBe("user");
    await c2.dispose();
  });

  test("ratings: a user can never change or delete someone else's rating; extra ids in the body are ignored", async () => {
    const video = seed.videos[1];
    const a = await newUserClient({ displayName: "Rater A" });
    const b = await newUserClient({ displayName: "Rater B" });
    const url = `/api/videos/${video.id}/rating`;

    expect((await a.ctx.put(url, { data: { score: 5, reaction: "love" } })).status()).toBe(200);
    const before = await (await a.ctx.get(url)).json();
    expect(before.mine).toEqual({ score: 5, reaction: "love" });

    // B tries to overwrite A's rating by naming A in every plausible way.
    const evil = await b.ctx.put(url, { data: { score: 1, reaction: "cry", userId: a.me.id, user_id: a.me.id, user: { id: a.me.id }, email: a.me.email } });
    expect(evil.status()).toBe(200);
    expect((await evil.json()).mine).toEqual({ score: 1, reaction: "cry" });
    // B deletes "the" rating, with A's id in the query and body.
    expect((await b.ctx.fetch(`${url}?userId=${a.me.id}`, { method: "DELETE", data: { userId: a.me.id } })).status()).toBe(200);

    const after = await (await a.ctx.get(url)).json();
    expect(after.mine, "A's rating is untouched").toEqual({ score: 5, reaction: "love" });
    expect((await (await b.ctx.get(url)).json()).mine, "B's own rating is gone").toBeNull();

    // There is no rating-by-id endpoint to address someone else's row.
    for (const path of [`/api/ratings/${a.me.id}`, `/api/videos/${video.id}/rating/${a.me.id}`, `/api/users/${a.me.id}/ratings`, `/api/videos/${video.id}/ratings`]) {
      for (const method of ["GET", "PUT", "DELETE"]) {
        const res = await b.ctx.fetch(path, { method, ...(method === "PUT" ? { data: { score: 1 } } : {}) });
        expect(res.status(), `${method} ${path}`).toBe(404);
      }
    }
    // The public summary never reveals who rated.
    const anon = await apiClient();
    const summaryText = await (await anon.get(url)).text();
    expect(summaryText).not.toContain(a.me.email);
    expect(summaryText).not.toMatch(/userId|user_id|email|displayName/);
    await Promise.all([a.ctx.dispose(), b.ctx.dispose(), anon.dispose()]);
  });

  test("ratings: anonymous → 401; pending/unknown/garbage video ids → 404; out-of-range scores → 400", async ({ admin }) => {
    const anon = await apiClient();
    const url = `/api/videos/${seed.videos[0].id}/rating`;
    expect((await anon.put(url, { data: { score: 5 } })).status()).toBe(401);
    expect((await anon.delete(url)).status()).toBe(401);

    const { ctx } = await newUserClient();
    // A pending video (no series) cannot be rated, nor can ids that are not plain integers.
    const pendingRes = await admin.post("/api/admin/videos", { data: { url: "https://youtu.be/secPend0001", title: "zzqx unclassifiable thing" } });
    expect([201, 409]).toContain(pendingRes.status());
    const pendingBody = await pendingRes.json();
    const pending = pendingBody.video ?? pendingBody.error.details.video;
    expect(pending.status).toBe("pending");
    for (const id of [pending.id, 999999999, "0", "-1", "1e3", "0x1", "1.0", "1%20OR%201=1", "1;DROP TABLE ratings"]) {
      const res = await ctx.put(`/api/videos/${id}/rating`, { data: { score: 5 } });
      expect(res.status(), `PUT /api/videos/${id}/rating`).toBe(404);
    }
    for (const score of [0, 6, -1, 2.5, "5", null, true, [5], { $gt: 0 }]) {
      const res = await ctx.put(url, { data: { score } });
      expect(res.status(), `score ${JSON.stringify(score)}`).toBe(400);
    }
    expect((await ctx.put(url, { data: { score: 3, reaction: "<img src=x>" } })).status()).toBe(400);
    await Promise.all([anon.dispose(), ctx.dispose()]);
  });

  test("an unverified account cannot log in, gets no session cookie, and cannot rate", async () => {
    const ctx = await apiClient();
    const user = await createUser(ctx, { email: uniqueEmail("unverified"), verify: false });
    const login = await ctx.post("/api/auth/login", { data: { email: user.email, password: user.password } });
    expect(login.status()).toBe(403);
    expect((await login.json()).error.code).toBe("EMAIL_NOT_VERIFIED");
    expect(login.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie" && /^sid=[^;]+/.test(h.value) && !/^sid=;/.test(h.value))).toEqual([]);
    expect((await (await ctx.get("/api/auth/me")).json()).user).toBeNull();
    expect((await ctx.put(`/api/videos/${seed.videos[0].id}/rating`, { data: { score: 5 } })).status()).toBe(401);
    // A wrong password on the verify link does not sign in either.
    const token = new URL(user.verifyLink).searchParams.get("token");
    const wrong = await ctx.post("/api/auth/verify-email", { data: { token, password: "not-the-right-password" } });
    expect(wrong.status()).toBe(401);
    expect((await (await ctx.get("/api/auth/me")).json()).user).toBeNull();
    expect((await ctx.put(`/api/videos/${seed.videos[0].id}/rating`, { data: { score: 5 } })).status()).toBe(401);
    await ctx.dispose();
  });

  test("a deleted account's other sessions are dead immediately; its ratings are gone; it cannot log in", async () => {
    const url = `/api/videos/${seed.videos[2].id}/rating`; // only this test rates episode 3
    const anon = await apiClient();
    const { ctx: device1, user } = await newUserClient({ displayName: "Doomed User" });
    const device2 = await apiClient();
    await loginViaApi(device2, user);
    expect((await device2.put(url, { data: { score: 2 } })).status()).toBe(200);
    const countBefore = (await (await anon.get(url)).json()).count;

    // Wrong password: nothing happens.
    expect((await device1.delete("/api/me", { data: { password: "wrong-password-123" } })).status()).toBe(401);
    expect((await (await device2.get("/api/auth/me")).json()).user?.email).toBe(user.email);

    expect((await device1.delete("/api/me", { data: { password: user.password } })).status()).toBe(204);
    expect((await (await device1.get("/api/auth/me")).json()).user).toBeNull();
    expect((await (await device2.get("/api/auth/me")).json()).user, "the other device's session died with the account").toBeNull();
    expect((await device2.put(url, { data: { score: 5 } })).status()).toBe(401);
    expect((await device2.get("/api/me/export")).status()).toBe(401);
    expect((await device2.patch("/api/me", { data: { displayName: "Zombie" } })).status()).toBe(401);
    expect((await (await anon.get(url)).json()).count).toBe(countBefore - 1);
    const relogin = await anon.post("/api/auth/login", { data: { email: user.email, password: user.password } });
    expect(relogin.status()).toBe(401);
    await Promise.all([anon.dispose(), device1.dispose(), device2.dispose()]);
  });

  test("/api/me/export returns only the caller's own account and ratings (no secrets), never someone else's", async () => {
    const a = await newUserClient({ displayName: "Export A" });
    const b = await newUserClient({ displayName: "Export B" });
    const [v1, v2] = seed.videos;
    await a.ctx.put(`/api/videos/${v1.id}/rating`, { data: { score: 4 } });
    await b.ctx.put(`/api/videos/${v1.id}/rating`, { data: { score: 1, reaction: "cry" } });
    await b.ctx.put(`/api/videos/${v2.id}/rating`, { data: { score: 2 } });

    // Every way of asking for B's data with A's session still yields A's data.
    for (const path of ["/api/me/export", `/api/me/export?userId=${b.me.id}`, `/api/me/export?email=${encodeURIComponent(b.me.email)}`, `/api/me/export?id=${b.me.id}`]) {
      const res = await a.ctx.get(path);
      expect(res.status(), path).toBe(200);
      expect(res.headers()["content-disposition"]).toMatch(/^attachment/);
      expect(res.headers()["cache-control"]).toBe("private, no-store");
      const text = await res.text();
      const data = JSON.parse(text);
      expect(data.account).toMatchObject({ id: a.me.id, email: a.me.email, displayName: "Export A" });
      expect(data.ratings.map((r) => [r.videoId, r.score])).toEqual([[v1.id, 4]]);
      expect(text).not.toContain(b.me.email);
      expect(text).not.toContain("Export B");
      expect(text, "no password hash / token material").not.toMatch(/password|hash|token|scrypt|\$s\d/i);
    }
    // Other users' records are not addressable at all.
    for (const path of [`/api/users/${b.me.id}`, `/api/me/${b.me.id}`, `/api/me/export/${b.me.id}`]) {
      expect((await a.ctx.get(path)).status(), path).toBe(404);
    }
    const anon = await apiClient();
    expect((await anon.get("/api/me/export")).status()).toBe(401);
    await Promise.all([a.ctx.dispose(), b.ctx.dispose(), anon.dispose()]);
  });

  test("public catalog responses never leak admin-only fields, pending videos or user data", async ({ admin }) => {
    const anon = await apiClient();
    const pendingId = (await (await admin.get("/api/admin/videos?status=pending&limit=1")).json()).items[0]?.id;
    if (pendingId) expect((await anon.get(`/api/videos/${pendingId}`)).status(), "pending video is not public").toBe(404);
    for (const path of ["/api/latest?limit=50", "/api/top-rated", "/api/trending", `/api/anime/series/${SERIES.slug}`, `/api/videos/${seed.videos[0].id}`, "/api/search?q=sec", "/api/anime/series", "/api/sections", "/api/genres"]) {
      const res = await anon.get(path);
      expect(res.status(), path).toBe(200);
      const text = await res.text();
      expect(text, `${path}: admin-only fields`).not.toMatch(/"classification"|"overrides"|"reasons"|"deletedAt"|"purgeAt"/);
      expect(text, `${path}: user data`).not.toMatch(/@e2e\.test|password|"email"/);
    }
    await anon.dispose();
  });
});
