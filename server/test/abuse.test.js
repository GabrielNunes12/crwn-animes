// Security sweep #2: abuse and resource exhaustion. Covers ReDoS / CPU cost of
// every input-reachable regex, races between concurrent requests,
// business-logic abuse (type confusion, limits, fan-out) and in-memory
// structures under many unique keys.
// Each test asserts the SAFE behaviour. A test that shows a real defect is kept
// with { todo: "<what is wrong, where>" }: it still runs and reports, but does
// not fail the suite until the defect is fixed.
import assert from "node:assert/strict";
import { randomBytes, scryptSync } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { classify, normalize, parseYouTubeId } from "../src/classifier.js";
import { hashPassword, verifyPassword } from "../src/crypto.js";
import { genreKey } from "../src/genres.js";
import { rateLimit } from "../src/middleware/rateLimit.js";
import { createRepository } from "../src/repository.js";
import { collectBulkInputs } from "../src/routes/admin.js";
import { slugify } from "../src/routing.js";
import { searchNormalize } from "../src/search.js";
import { createSitemap, resolvePage, truncate } from "../src/seo.js";
import { validator } from "../src/validation.js";
import { PASSWORD, addVideo, lastEmail, signUp, startServer, tokenFrom, vid } from "./helpers.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** express.json({ limit: "20kb" }): the largest string any JSON body can carry. */
const BODY_LIMIT = 20 * 1024;
/** The CPU budget of one request (sweep brief: anything slower is a finding). */
const BUDGET_MS = 100;

async function withServer(options, fn) {
  const srv = await startServer(options);
  try {
    return await fn(srv);
  } finally {
    await srv.close();
  }
}

/** Runs fn (sync or async) up to twice and returns the faster time, so one GC pause is not a finding. */
async function fastest(fn) {
  let best = Infinity;
  let value;
  for (let i = 0; i < 2 && best >= BUDGET_MS; i++) {
    const t = performance.now();
    value = await fn();
    best = Math.min(best, performance.now() - t);
  }
  return { ms: best, value };
}

/**
 * A verified user with a live session, made without scrypt (the stored hash
 * is a placeholder, so this user cannot log in with a password).
 */
function quickUser(srv, email, role = "user") {
  const { users, rotateSession } = srv.services.auth;
  const at = new Date().toISOString();
  const id = users.createUser({ email, displayName: "Quick", passwordHash: "x", now: at });
  users.markVerified(id, at);
  if (role !== "user") users.setRole(id, role);
  const client = srv.client();
  client.cookie = `sid=${rotateSession(id, null)}`;
  return { id, client };
}

/** A raw request (node:http) so any header and path is sent as is. */
function raw(base, { method = "GET", path: p = "/", headers = {}, body = null } = {}) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        method,
        path: p,
        headers: { ...(body != null ? { "content-length": Buffer.byteLength(body) } : {}), ...headers },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      }
    );
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

/** series_stats, rating_totals and rating_activity must equal a fresh aggregation of `ratings`. */
function assertRatingsConsistent(db, step) {
  const expectedStats = db
    .prepare(`
      SELECT v.series_id, v.section, COUNT(*) AS video_count, MAX(v.published_at) AS latest_published_at,
        (SELECT COUNT(*) FROM ratings r JOIN videos v2 ON v2.id = r.video_id
          WHERE v2.series_id = v.series_id AND v2.section = v.section AND v2.status = 'published') AS rating_n,
        (SELECT COALESCE(SUM(r.score), 0) FROM ratings r JOIN videos v2 ON v2.id = r.video_id
          WHERE v2.series_id = v.series_id AND v2.section = v.section AND v2.status = 'published') AS rating_sum
      FROM videos v WHERE v.status = 'published' AND v.section IS NOT NULL AND v.series_id IN (SELECT id FROM series)
      GROUP BY v.series_id, v.section ORDER BY v.series_id, v.section`)
    .all();
  assert.deepEqual(db.prepare("SELECT * FROM series_stats ORDER BY series_id, section").all(), expectedStats, `${step}: series_stats`);
  assert.deepEqual(
    db.prepare("SELECT n, total FROM rating_totals").get(),
    db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(score), 0) AS total FROM ratings").get(),
    `${step}: rating_totals`
  );
  // rating_activity counts current ratings by the day they were last set (rows may drop to 0, never below).
  assert.deepEqual(
    db.prepare("SELECT video_id, day, count, score_sum FROM rating_activity WHERE count > 0 ORDER BY video_id, day").all(),
    db
      .prepare(`
        SELECT video_id, substr(updated_at, 1, 10) AS day, COUNT(*) AS count, SUM(score) AS score_sum
        FROM ratings GROUP BY video_id, day ORDER BY video_id, day`)
      .all(),
    `${step}: rating_activity`
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rating_activity WHERE count = 0 AND score_sum <> 0").get().n, 0, `${step}: empty activity rows`);
}

/** How long one scrypt hash takes on this machine right now (the width of every auth race window). */
async function scryptMs() {
  const t = performance.now();
  await hashPassword("measure-the-window");
  return performance.now() - t;
}

/** A password hash made with the pre-2^17 scrypt cost (accounts not logged in since the upgrade). */
function legacyHash(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return ["scrypt", 16384, 8, 1, salt.toString("base64"), hash.toString("base64")].join("$");
}

// Inputs that make backtracking regexes go quadratic: long runs of the characters
// a pattern repeats, ending with one it cannot match.
const hostile = (n) => ({
  dots: `${".".repeat(n)}a`,
  dotsThenSpace: `${".".repeat(n)} `,
  closers: `${")]'\">.".repeat(n / 6)}a`,
  digits: `${"1".repeat(n)}x`,
  spacedDigits: `${" 1".repeat(n / 2)} x`,
  spaces: `${" ".repeat(n)}x`,
  ats: `a${"@".repeat(n)}x`,
  dashes: `${"a-".repeat(n / 2)}-`,
  markers: "episode 1 season 2 s01e01 chapter 3 cap #4 1st temporada ".repeat(n / 57),
  urlish: "https://youtube.com/watch?v=".repeat(n / 28),
  combining: `a${"\u0301".repeat(n - 1)}`,
  nfkdBomb: "\uFDFA".repeat(n),
});

// ===================================================================== 1. ReDoS / CPU
describe("1. ReDoS / CPU exhaustion", () => {
  test("every pure function fed by request input stays under 100 ms at the 20 KB body limit", async () => {
    const series = [
      { id: 1, slug: "one-piece", name: "One Piece", aliases: ["Wan Pisu"] },
      { id: 2, slug: "kaiju-no-8", name: "Kaiju No. 8", aliases: [] },
    ];
    const fns = {
      normalize: (s) => normalize(s),
      classify: (s) => classify({ title: s }, series),
      parseYouTubeId: (s) => parseYouTubeId(s),
      searchNormalize: (s) => searchNormalize(s),
      slugify: (s) => slugify(s),
      genreKey: (s) => genreKey(s),
      truncate: (s) => truncate(s),
      "validator.email": (s) => validator({ v: s }).email("v"),
      "validator.displayName": (s) => validator({ v: s }).displayName("v"),
      "validator.slug": (s) => validator({ v: s }).slug("v"),
      "validator.httpUrl": (s) => validator({ v: `https://example.com/${s}` }).httpUrl("v"),
      "validator.stringList": (s) => validator({ v: [s, s] }).stringList("v"),
    };
    const slow = [];
    for (const [input, text] of Object.entries(hostile(BODY_LIMIT))) {
      for (const [name, fn] of Object.entries(fns)) {
        const { ms } = await fastest(() => fn(text));
        if (ms >= BUDGET_MS) slow.push(`${name}(${input}) ${ms.toFixed(0)} ms`);
      }
    }
    assert.deepEqual(slow, []);
  });

  test(
    "bulk add: a 20 KB paste is tokenised in < 100 ms, whatever its shape",
    () =>
      withServer({}, async (srv) => {
        const { client: admin } = quickUser(srv, "admin@example.com", "admin");
        const slow = [];
        for (const [input, text] of Object.entries(hostile(BODY_LIMIT - 64))) {
          const pure = await fastest(() => collectBulkInputs(text, []));
          if (pure.ms >= BUDGET_MS) slow.push(`collectBulkInputs(${input}) ${pure.ms.toFixed(0)} ms`);
        }
        const body = { text: `${".".repeat(BODY_LIMIT - 30)}a`, dryRun: true };
        const viaHttp = await fastest(() => admin.post("/api/admin/videos/bulk", body));
        assert.equal(viaHttp.value.status, 400);
        if (viaHttp.ms >= BUDGET_MS) slow.push(`POST /api/admin/videos/bulk (20 KB of dots) ${viaHttp.ms.toFixed(0)} ms`);
        assert.equal(srv.fake.calls.length, 0);
        assert.deepEqual(slow, []);
      })
  );

  test("hostile headers, long paths and thousands of query parameters: 2xx/4xx in < 100 ms, never 5xx (API and page renderer)", async () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), "crwn-abuse-"));
    fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html><html><head><title>Crwn Animes</title></head><body></body></html>");
    try {
      await withServer({ config: { clientDist: dist } }, async (srv) => {
        await addVideo(srv, 1, "One Piece Episode 1");
        const { client: admin } = quickUser(srv, "admin@example.com", "admin");
        const H = 15_000; // under Node's 16 KB header limit
        const requests = [
          { label: "content-type with 3000 params", method: "POST", path: "/api/auth/login", body: "{}", headers: { "content-type": `application/json${" ;a=b".repeat(3000)}` } },
          { label: "content-type padded with spaces", method: "POST", path: "/api/auth/login", body: "{}", headers: { "content-type": `application/json${" ".repeat(H)};x` } },
          { label: "content-type quoted backslashes", method: "POST", path: "/api/auth/login", body: "{}", headers: { "content-type": `application/json; a="${"\\".repeat(H)}` } },
          { label: "cookie of semicolons", path: "/api/auth/me", headers: { cookie: ";".repeat(H) } },
          { label: "cookie with 3000 pairs", path: "/api/auth/me", headers: { cookie: `${"a=b; ".repeat(3000)}sid=x` } },
          { label: "cookie with bad %-escapes", path: "/api/auth/me", headers: { cookie: `sid=${"%E0%A4%A".repeat(1500)}` } },
          { label: "if-none-match list", path: "/api/sections", headers: { "if-none-match": 'W/"x", '.repeat(2000) } },
          { label: "accept list", path: "/api/sections", headers: { accept: "text/html;q=0.1, ".repeat(800) } },
          { label: "long origin", method: "POST", path: "/api/auth/logout", headers: { origin: `http://${"a.".repeat(H / 2)}com` } },
          { label: "15 KB API path", path: `/api/${"a".repeat(H)}` },
          { label: "7500 API path segments", path: `/api${"/a".repeat(H / 2)}` },
          { label: "15 KB video id", path: `/api/videos/${"1".repeat(H)}/rating` },
          { label: "15 KB of %-escapes", path: `/api/videos/${"%41".repeat(H / 3)}` },
          { label: "1500 distinct query params", path: `/api/search?${Array.from({ length: 1500 }, (_, i) => `p${i}=1`).join("&")}` },
          { label: "1500 repeated q", path: `/api/search?${"q=a&".repeat(1500)}` },
          { label: "bracket keys", path: `/api/search?${"q[a][b][c][__proto__]=1&".repeat(400)}` },
          { label: "prototype keys", path: "/api/search?__proto__=x&constructor=y&hasOwnProperty=z&toString=1" },
          { label: "limit of 15k digits", path: `/api/search?limit=${"9".repeat(H)}` },
          { label: "clamped limit of 15k digits", path: `/api/latest?limit=${"9".repeat(H)}` },
          { label: "admin offset of 5k digits", path: `/api/admin/videos?offset=${"9".repeat(5000)}`, headers: { cookie: admin.cookie } },
          { label: "q of 80 NFKD-expanding chars", path: `/api/search?q=${encodeURIComponent("\uFDFA".repeat(80))}` },
          { label: "page: 15 KB genre", path: `/genre/${"a".repeat(H)}` },
          { label: "page: 5000 %-encoded genre chars", path: `/genre/${"%C3%A7".repeat(2400)}` },
          { label: "page: 15 KB slug", path: `/anime/${"a-".repeat(H / 2)}a` },
          { label: "page: episode of 10k digits", path: `/anime/one-piece/episode/${"9".repeat(10_000)}` },
          { label: "page: season of 10k digits", path: `/anime/one-piece/season/${"9".repeat(10_000)}/episode/1` },
          { label: "page: 5000 segments", path: "/a".repeat(5000) },
          { label: "sitemap child with huge n", path: `/sitemap-${"9".repeat(H)}.xml` },
        ];
        const problems = [];
        for (const { label, ...req } of requests) {
          const { ms, value } = await fastest(() => raw(srv.base, req));
          if (value.status >= 500) problems.push(`${label}: ${value.status}`);
          if (ms >= BUDGET_MS) problems.push(`${label}: ${ms.toFixed(0)} ms`);
        }
        // Over Node's header limit: refused before any app code runs (431, or a reset when the
        // server closes while the client is still sending).
        const over = await raw(srv.base, { path: `/api/${"a".repeat(100_000)}` }).catch((error) => ({ status: error.code }));
        assert.ok([431, "ECONNRESET", "EPIPE"].includes(over.status), String(over.status));
        assert.deepEqual(problems, []);
      });
    } finally {
      fs.rmSync(dist, { recursive: true, force: true });
    }
  });

  test(
    "adding or editing a series re-classifies the pending queue in < 150 ms (300 pending × 100 series × 20 aliases)",
    () =>
      withServer({}, async (srv) => {
        const { repo } = srv.services;
        srv.db.transaction(() => {
          for (let s = 0; s < 100; s++) {
            const aliases = Array.from({ length: 20 }, (_, a) => `alias ${s} ${a} ${"x".repeat(60)}`);
            repo.createSeries({ name: `Series ${s} zz`, slug: `series-${s}-zz`, aliases, genres: [] });
          }
          for (let i = 0; i < 300; i++) {
            repo.insertVideo({
              youtubeVideoId: vid(100_000 + i),
              title: `Some unknown show episode ${i} ${"word ".repeat(40)}`,
              section: null,
              seriesId: null,
              season: 1,
              number: null,
              status: "pending",
            });
          }
        })();
        const { client: admin } = quickUser(srv, "admin@example.com", "admin");
        let t = performance.now();
        const created = await admin.post("/api/admin/series", { name: "Brand New Show" });
        const postMs = performance.now() - t;
        assert.equal(created.status, 201);
        t = performance.now();
        const patched = await admin.patch(`/api/admin/series/${created.body.series.id}`, { synopsis: "Only the synopsis changed." });
        const patchMs = performance.now() - t;
        assert.equal(patched.status, 200);
        assert.ok(postMs < 150 && patchMs < 150, `POST /api/admin/series ${postMs.toFixed(0)} ms, PATCH ${patchMs.toFixed(0)} ms`);
      })
  );
});

// ===================================================================== 2. races
describe("2. races between concurrent requests", () => {
  test("PUT/DELETE storms on one video keep series_stats, rating_totals and rating_activity equal to the truth", () =>
    withServer({}, async (srv) => {
      const a = await addVideo(srv, 1, "One Piece Episode 1");
      const b = await addVideo(srv, 2, "One Piece Episode 2");
      const c = await addVideo(srv, 3, "Bleach Episode 1");
      const users = Array.from({ length: 15 }, (_, i) => quickUser(srv, `storm${i}@example.com`).client);
      let seed = 7;
      const rnd = (n) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
      for (let round = 0; round < 4; round++) {
        const results = await Promise.all(
          Array.from({ length: 50 }, (_, i) => {
            const user = users[i % users.length];
            const video = [a, a, a, b, c][rnd(5)];
            return rnd(3) === 0
              ? user.del(`/api/videos/${video.id}/rating`)
              : user.put(`/api/videos/${video.id}/rating`, { score: 1 + rnd(5), reaction: [null, "fire", "love"][rnd(3)] });
          })
        );
        assert.deepEqual([...new Set(results.map((r) => r.status))], [200], `round ${round}`);
        assertRatingsConsistent(srv.db, `round ${round}`);
      }
      // The public summary is exactly the users' own ratings.
      const summary = (await srv.client().get(`/api/videos/${a.id}/rating`)).body;
      const mine = (await Promise.all(users.map((u) => u.get(`/api/videos/${a.id}/rating`)))).map((r) => r.body.mine).filter(Boolean);
      assert.equal(summary.count, mine.length);
      for (const s of [1, 2, 3, 4, 5]) assert.equal(summary.distribution[s], mine.filter((m) => m.score === s).length, `score ${s}`);
      for (const key of ["fire", "love"]) assert.equal(summary.reactions[key], mine.filter((m) => m.reaction === key).length, key);
    }));

  test("rating storms racing admin unpublish / republish / move / delete stay consistent; a deleted video keeps no ratings", () =>
    withServer({}, async (srv) => {
      const a = await addVideo(srv, 1, "One Piece Episode 1");
      const b = await addVideo(srv, 2, "One Piece Episode 2");
      const users = Array.from({ length: 10 }, (_, i) => quickUser(srv, `race${i}@example.com`).client);
      const { client: admin } = quickUser(srv, "admin@example.com", "admin");
      const rate = (i, video) => users[i % users.length].put(`/api/videos/${video.id}/rating`, { score: 1 + (i % 5) });

      // Requests of one Promise.all may reach the server in any order, so each admin change gets its own round.
      const round1 = [admin.patch(`/api/admin/videos/${a.id}`, { section: "manga" })]; // "Episode 1" as manga: no chapter number -> pending
      for (let i = 0; i < 20; i++) round1.push(rate(i, a), rate(i + 3, b));
      const round2 = [
        admin.patch(`/api/admin/videos/${a.id}`, { section: null }), // back to anime: published again
        admin.patch(`/api/admin/videos/${b.id}`, { seriesSlug: "bleach", number: 50 }), // moved to another series
      ];
      for (let i = 0; i < 20; i++) round2.push(rate(i + 1, a), rate(i + 2, b));
      const results = [...(await Promise.all(round1)), ...(await Promise.all(round2))];
      assert.deepEqual(results.filter((r) => ![200, 404].includes(r.status)).map((r) => `${r.status} ${r.text}`), []);
      assert.equal(srv.services.repo.getVideo(a.id).status, "published");
      assert.equal(srv.services.repo.getVideo(b.id).seriesSlug, "bleach");
      assertRatingsConsistent(srv.db, "after moves");

      const storm = [admin.del(`/api/admin/videos/${a.id}`)];
      for (let i = 0; i < 30; i++) storm.push(rate(i, a), users[i % 10].del(`/api/videos/${a.id}/rating`));
      const after = await Promise.all(storm);
      assert.equal(after[0].status, 204);
      assert.ok(after.slice(1).every((r) => r.status === 200 || r.status === 404));
      // v1.4: DELETE moves it to the trash (ratings kept 7 days); deleting it forever removes them.
      assert.equal((await admin.del(`/api/admin/trash/videos/${a.id}`)).status, 204);
      assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM ratings WHERE video_id = ?").get(a.id).n, 0);
      assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM rating_activity WHERE video_id = ?").get(a.id).n, 0);
      assertRatingsConsistent(srv.db, "after delete");
    }));

  test("account deletion racing the user's own rating storm: no rating survives, counters stay true, the old cookie gets 401", () =>
    withServer({}, async (srv) => {
      const videos = [await addVideo(srv, 1, "One Piece Episode 1"), await addVideo(srv, 2, "One Piece Episode 2"), await addVideo(srv, 3, "Bleach Episode 1")];
      const email = "leaving@example.com";
      const first = await signUp(srv, { email });
      const userId = (await first.get("/api/auth/me")).body.user.id;
      const second = srv.client();
      assert.equal((await second.post("/api/auth/login", { email, password: PASSWORD })).status, 200);
      await quickUser(srv, "stays@example.com").client.put(`/api/videos/${videos[0].id}/rating`, { score: 4 });

      const ops = [first.del("/api/me", { password: PASSWORD })];
      for (let i = 0; i < 30; i++) ops.push(second.put(`/api/videos/${videos[i % 3].id}/rating`, { score: 1 + (i % 5), reaction: "wow" }));
      const [deleted, ...puts] = await Promise.all(ops);
      assert.equal(deleted.status, 204);
      assert.ok(puts.every((r) => r.status === 200 || r.status === 401), puts.map((r) => r.status).join());
      assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM ratings WHERE user_id = ?").get(userId).n, 0);
      assertRatingsConsistent(srv.db, "after deletion");

      // Rating after account deletion with an old cookie.
      assert.equal((await second.put(`/api/videos/${videos[0].id}/rating`, { score: 5 })).status, 401);
      assert.equal((await second.del(`/api/videos/${videos[0].id}/rating`)).status, 401);
      assert.equal((await second.get("/api/auth/me")).body.user, null);
      assert.equal((await second.get("/api/me/export")).status, 401);
    }));

  test("8 concurrent sign-ups of one e-mail: one account, one live link, which activates only the password stored with it", () =>
    withServer({}, async (srv) => {
      const email = "dup@example.com";
      const attempts = Array.from({ length: 8 }, (_, i) => ({ password: `password-number-${i}`, displayName: `Name ${i}` }));
      const res = await Promise.all(attempts.map((a) => srv.client().post("/api/auth/register", { email, ...a, acceptPrivacy: true })));
      assert.deepEqual(res.map((r) => r.status), Array(8).fill(201));
      await sleep(20); // e-mails are fire-and-forget

      const rows = srv.db.prepare("SELECT * FROM users WHERE email = ?").all(email);
      assert.equal(rows.length, 1);
      const [row] = rows;
      assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM email_tokens WHERE user_id = ? AND purpose = 'verify'").get(row.id).n, 1);
      const matches = await Promise.all(attempts.map((a) => verifyPassword(a.password, row.password_hash)));
      assert.equal(matches.filter(Boolean).length, 1);
      const winner = attempts[matches.indexOf(true)];
      assert.equal(row.display_name, winner.displayName, "name and password come from the same sign-up");

      const tokens = srv.mailer.outbox.filter((m) => m.to === email && /confirme/i.test(m.subject)).map((m) => tokenFrom(m));
      assert.equal(tokens.length, 8);
      for (const token of tokens.slice(0, -1)) {
        const old = await srv.client().post("/api/auth/verify-email", { token, password: winner.password });
        assert.equal(old.body.error.code, "INVALID_TOKEN");
      }
      const loser = attempts.find((a) => a !== winner);
      assert.equal((await srv.client().post("/api/auth/verify-email", { token: tokens.at(-1), password: loser.password })).status, 401);
      assert.equal((await srv.client().post("/api/auth/verify-email", { token: tokens.at(-1), password: winner.password })).status, 200);
    }));

  test("15 concurrent verify-email calls with one link: exactly one signs in, one session, one welcome e-mail", () =>
    withServer({}, async (srv) => {
      const email = "once@example.com";
      await srv.client().post("/api/auth/register", { email, password: PASSWORD, displayName: "Once", acceptPrivacy: true });
      await sleep(10);
      const token = tokenFrom(lastEmail(srv.mailer, email, /confirme/i));
      const clients = Array.from({ length: 15 }, () => srv.client());
      const res = await Promise.all(clients.map((c) => c.post("/api/auth/verify-email", { token, password: PASSWORD })));
      assert.equal(res.filter((r) => r.status === 200).length, 1);
      assert.ok(res.filter((r) => r.status !== 200).every((r) => r.status === 400 && r.body.error.code === "INVALID_TOKEN"));
      assert.equal(clients.filter((c) => c.cookie).length, 1);
      const { id } = srv.db.prepare("SELECT id FROM users WHERE email = ?").get(email);
      assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").get(id).n, 1);
      await sleep(10);
      assert.equal(srv.mailer.outbox.filter((m) => m.to === email && /bem-vind/i.test(m.subject)).length, 1);
    }));

  test("8 concurrent reset-password calls with one link: exactly one wins, and only its password is stored", () =>
    withServer({}, async (srv) => {
      const email = "reset-race@example.com";
      await signUp(srv, { email });
      await srv.client().post("/api/auth/forgot-password", { email });
      await sleep(10);
      const token = tokenFrom(lastEmail(srv.mailer, email, /redefin/i), "reset-password");
      const passwords = Array.from({ length: 8 }, (_, i) => `reset-password-${i}`);
      const res = await Promise.all(passwords.map((password) => srv.client().post("/api/auth/reset-password", { token, password })));
      const won = res.map((r, i) => (r.status === 200 ? i : -1)).filter((i) => i >= 0);
      assert.equal(won.length, 1);
      assert.ok(res.filter((r) => r.status !== 200).every((r) => r.status === 400 && r.body.error.code === "INVALID_TOKEN"));
      const row = srv.db.prepare("SELECT id, password_hash FROM users WHERE email = ?").get(email);
      const matches = await Promise.all(passwords.map((p) => verifyPassword(p, row.password_hash)));
      assert.deepEqual(matches, passwords.map((_, i) => i === won[0]));
      assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").get(row.id).n, 1, "only the winner's session");
      assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM email_tokens WHERE user_id = ?").get(row.id).n, 0);
    }));

  test("30 concurrent adds of one link (every URL form, with and without lookup, single and bulk) store it once; never 5xx", () =>
    withServer({}, async (srv) => {
      const { client: admin } = quickUser(srv, "admin@example.com", "admin");
      const [id, id2] = [vid(70), vid(71)];
      srv.fake.titles[id] = "Bleach Episode 70";
      srv.fake.titles[id2] = "Bleach Episode 71";
      srv.fake.delayMs = 25;
      const forms = [id, `https://youtu.be/${id}`, `https://www.youtube.com/watch?v=${id}`, `https://m.youtube.com/shorts/${id}`, `youtube.com/embed/${id}`];
      const singles = Array.from({ length: 20 }, (_, i) =>
        admin.post("/api/admin/videos", { url: forms[i % forms.length], ...(i % 2 ? { title: "Bleach Episode 70" } : {}) })
      );
      const bulks = Array.from({ length: 10 }, (_, i) => admin.post("/api/admin/videos/bulk", { text: `${forms[i % 5]}\nhttps://youtu.be/${id2}` }));
      const [s, b] = await Promise.all([Promise.all(singles), Promise.all(bulks)]);
      assert.ok(s.every((r) => r.status === 201 || r.status === 409), s.map((r) => r.status).join());
      assert.ok(b.every((r) => r.status === 200));
      const rows = b.flatMap((r) => r.body.results);
      assert.ok(rows.every((r) => r.outcome === "created" || r.outcome === "duplicate"), JSON.stringify(rows.filter((r) => !["created", "duplicate"].includes(r.outcome))));
      const created = (yt) => s.filter((r) => r.status === 201 && r.body.video.youtubeVideoId === yt).length + rows.filter((r) => r.youtubeVideoId === yt && r.outcome === "created").length;
      assert.equal(created(id), 1);
      assert.equal(created(id2), 1);
      assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM videos WHERE youtube_video_id IN (?, ?)").get(id, id2).n, 2);
    }));

  test("PATCH url swaps racing an add of the same new ID, and a PATCH racing a DELETE: one owner, 404/409 for the rest, never 5xx", () =>
    withServer({}, async (srv) => {
      const { client: admin } = quickUser(srv, "admin@example.com", "admin");
      const [v1, v2, v3] = [await addVideo(srv, 1, "One Piece Episode 1"), await addVideo(srv, 2, "One Piece Episode 2"), await addVideo(srv, 3, "One Piece Episode 3")];
      srv.fake.delayMs = 20;
      const target = vid(80);
      const res = await Promise.all([
        admin.patch(`/api/admin/videos/${v1.id}`, { url: target }),
        admin.patch(`/api/admin/videos/${v2.id}`, { url: `https://youtu.be/${target}` }),
        admin.post("/api/admin/videos", { url: target }),
        admin.post("/api/admin/videos", { url: target, title: "Bleach Episode 80" }),
      ]);
      assert.ok(res.every((r) => [200, 201, 409].includes(r.status)), res.map((r) => r.status).join());
      assert.equal(res.filter((r) => r.status < 300).length, 1);
      assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM videos WHERE youtube_video_id = ?").get(target).n, 1);

      const [patched, deleted] = await Promise.all([admin.patch(`/api/admin/videos/${v3.id}`, { url: vid(81) }), admin.del(`/api/admin/videos/${v3.id}`)]);
      assert.equal(deleted.status, 204);
      assert.ok([200, 404].includes(patched.status), String(patched.status));
      assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM videos WHERE id = ? AND deleted_at IS NULL").get(v3.id).n, 0, "in the trash");
    }));

  test("concurrent series creation with one slug (or names that slugify to it): one 201, the rest 409; renames to one slug: one wins", () =>
    withServer({}, async (srv) => {
      const { client: admin } = quickUser(srv, "admin@example.com", "admin");
      const bodies = [{ name: "Zeta Frontier" }, { name: "zeta frontier" }, { name: "Zeta-Frontier!" }, { name: "  ZETA   FRONTIER " }, { name: "Zéta Frontier" }, { name: "Other", slug: "zeta-frontier" }];
      const res = await Promise.all(Array.from({ length: 24 }, (_, i) => admin.post("/api/admin/series", bodies[i % bodies.length])));
      assert.equal(res.filter((r) => r.status === 201).length, 1);
      assert.equal(res.filter((r) => r.status === 409).length, 23);
      assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM series WHERE slug = 'zeta-frontier'").get().n, 1);

      const a = (await admin.post("/api/admin/series", { name: "Alpha Show" })).body.series;
      const b = (await admin.post("/api/admin/series", { name: "Beta Show" })).body.series;
      const renames = await Promise.all([
        admin.patch(`/api/admin/series/${a.id}`, { slug: "same-slug" }),
        admin.patch(`/api/admin/series/${b.id}`, { slug: "same-slug" }),
        admin.post("/api/admin/series", { name: "Gamma", slug: "same-slug" }),
      ]);
      assert.equal(renames.filter((r) => r.status < 300).length, 1, renames.map((r) => r.status).join());
      assert.ok(renames.every((r) => r.status < 300 || r.status === 409));
      assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM series WHERE slug = 'same-slug'").get().n, 1);
    }));

  test("logout-all racing requests on the user's other sessions: every pre-existing session is dead afterwards, never 5xx", () =>
    withServer({}, async (srv) => {
      const video = await addVideo(srv, 1, "One Piece Episode 1");
      const email = "everywhere@example.com";
      const main = await signUp(srv, { email });
      const mainSid = main.cookie;
      const userId = (await main.get("/api/auth/me")).body.user.id;
      const others = Array.from({ length: 6 }, () => {
        const c = srv.client();
        c.cookie = `sid=${srv.services.auth.rotateSession(userId, null)}`;
        return c;
      });
      const fresh = srv.client();
      const res = await Promise.all([
        main.post("/api/auth/logout-all"),
        ...others.flatMap((c) => [c.get("/api/auth/me"), c.put(`/api/videos/${video.id}/rating`, { score: 3 }), c.get("/api/me/export")]),
        fresh.post("/api/auth/login", { email, password: PASSWORD }),
      ]);
      assert.ok(res.every((r) => r.status < 500));
      assert.equal(res[0].status, 204);
      const replay = srv.client();
      replay.cookie = mainSid;
      for (const c of [replay, ...others]) assert.equal((await c.get("/api/auth/me")).body.user, null);
      // A login that completes after "sign out everywhere" is a new sign-in with a still-valid password: allowed.
      assert.equal(res.at(-1).status, 200);
      assert.equal((await fresh.get("/api/auth/me")).body.user.email, email);
      assertRatingsConsistent(srv.db, "after logout-all");
    }));

  test(
    "a password change also ends logins that were in flight with the old password",
    () =>
      withServer({}, async (srv) => {
        const T = await scryptMs();
        const email = "victim@example.com";
        const victim = await signUp(srv, { email });
        const offsets = [0.5, 0.9, 1.2, 1.5, 1.8, 2.2].map((f) => Math.round(f * T));
        const attackers = offsets.map(() => srv.client());
        const [changed] = await Promise.all([
          victim.post("/api/me/password", { currentPassword: PASSWORD, newPassword: "a-brand-new-password-1" }),
          ...offsets.map(async (ms, i) => {
            await sleep(ms);
            return attackers[i].post("/api/auth/login", { email, password: PASSWORD });
          }),
        ]);
        assert.equal(changed.status, 200);
        const alive = [];
        for (const [i, attacker] of attackers.entries()) if ((await attacker.get("/api/auth/me")).body.user) alive.push(`+${offsets[i]} ms`);
        assert.deepEqual(alive, [], "old-password logins started at these offsets still have a session after the change");
      })
  );

  test(
    "a password reset also ends logins that were in flight with the old password",
    () =>
      withServer({}, async (srv) => {
        const T = await scryptMs();
        const email = "reset-victim@example.com";
        await signUp(srv, { email });
        await srv.client().post("/api/auth/forgot-password", { email });
        await sleep(10);
        const token = tokenFrom(lastEmail(srv.mailer, email, /redefin/i), "reset-password");
        const offsets = [10, Math.round(0.3 * T), Math.round(0.6 * T)];
        const attackers = offsets.map(() => srv.client());
        const [reset] = await Promise.all([
          srv.client().post("/api/auth/reset-password", { token, password: "a-brand-new-password-2" }),
          ...offsets.map(async (ms, i) => {
            await sleep(ms);
            return attackers[i].post("/api/auth/login", { email, password: PASSWORD });
          }),
        ]);
        assert.equal(reset.status, 200);
        const alive = [];
        for (const [i, attacker] of attackers.entries()) if ((await attacker.get("/api/auth/me")).body.user) alive.push(`+${offsets[i]} ms`);
        assert.deepEqual(alive, [], "old-password logins started at these offsets still have a session after the reset");
      })
  );

  test(
    "an old-password login on a legacy-hash account cannot undo a password change or reset",
    () =>
      withServer({}, async (srv) => {
        const outcomes = [];
        for (const mode of ["change", "reset"]) {
          const email = `legacy-${mode}@example.com`;
          const victim = await signUp(srv, { email });
          srv.db.prepare("UPDATE users SET password_hash = ? WHERE email = ?").run(legacyHash(PASSWORD), email);
          const NEW = `the-new-password-${mode}`;
          let token = null;
          if (mode === "reset") {
            await srv.client().post("/api/auth/forgot-password", { email });
            await sleep(10);
            token = tokenFrom(lastEmail(srv.mailer, email, /redefin/i), "reset-password");
          }
          const attacker = srv.client();
          const [op] = await Promise.all([
            mode === "change"
              ? victim.post("/api/me/password", { currentPassword: PASSWORD, newPassword: NEW })
              : srv.client().post("/api/auth/reset-password", { token, password: NEW }),
            sleep(40).then(() => attacker.post("/api/auth/login", { email, password: PASSWORD })),
          ]);
          assert.equal(op.status, 200);
          const row = srv.db.prepare("SELECT password_hash FROM users WHERE email = ?").get(email);
          outcomes.push({
            mode,
            newWorks: await verifyPassword(NEW, row.password_hash),
            oldWorks: await verifyPassword(PASSWORD, row.password_hash),
            attackerSession: Boolean((await attacker.get("/api/auth/me")).body.user),
          });
        }
        assert.deepEqual(outcomes, [
          { mode: "change", newWorks: true, oldWorks: false, attackerSession: false },
          { mode: "reset", newWorks: true, oldWorks: false, attackerSession: false },
        ]);
      })
  );

  test(
    "a login racing the deletion of its account answers 401 (or 200 if it finished first), never 500",
    (t) =>
      withServer({}, async (srv) => {
        const errors = t.mock.method(console, "error", () => {});
        const T = await scryptMs();
        const email = "gone-soon@example.com";
        const user = await signUp(srv, { email });
        const offsets = [10, Math.round(0.3 * T), Math.round(0.6 * T)];
        const [deleted, ...logins] = await Promise.all([
          user.del("/api/me", { password: PASSWORD }),
          ...offsets.map(async (ms) => {
            await sleep(ms);
            return srv.client().post("/api/auth/login", { email, password: PASSWORD });
          }),
        ]);
        assert.equal(deleted.status, 204);
        assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, 0, "no session for a deleted account");
        // A login that completed before the deletion committed got a 200 (its session then went with the account).
        const statuses = logins.map((r) => r.status);
        assert.ok(
          statuses.every((s) => s === 200 || s === 401),
          `logins at +${offsets.join("/+")} ms answered ${statuses.join("/")}; ${errors.mock.callCount()} errors logged`
        );
        assert.equal(errors.mock.callCount(), 0, "nothing was logged as an internal error");
      })
  );
});

// ===================================================================== 3. business logic
describe("3. business-logic abuse", () => {
  test("rating bodies with the wrong types are 400 and store nothing", () =>
    withServer({}, async (srv) => {
      const video = await addVideo(srv, 1, "One Piece Episode 1");
      const { client: user } = quickUser(srv, "types@example.com");
      const url = `/api/videos/${video.id}/rating`;
      const bodies = [
        {},
        { score: "5" },
        { score: "5 " },
        { score: 4.5 },
        { score: 0 },
        { score: -0 },
        { score: 6 },
        { score: -1 },
        { score: 2 ** 53 },
        { score: 1e308 },
        { score: [5] },
        { score: { $gt: 0 } },
        { score: null },
        { score: true },
        { score: 5, reaction: "FIRE" },
        { score: 5, reaction: ["fire"] },
        { score: 5, reaction: { 0: "fire" } },
        { score: 5, reaction: "__proto__" },
        { score: 5, reaction: "toString" },
        { score: 5, reaction: "constructor" },
        { score: 5, reaction: 1 },
        { score: 5, reaction: true },
        { score: 5, reaction: "" },
      ];
      for (const body of bodies) {
        const res = await user.put(url, body);
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.equal(res.body.error.code, "VALIDATION_ERROR", JSON.stringify(body));
      }
      const rawBodies = ['{"score":1e400}', '{"score":5,"score":"x"}', '{"score":05}', '{"score":0x5}', "[]", '[{"score":5}]', '"5"', "5", "null", '{"score":5}garbage'];
      for (const text of rawBodies) {
        const res = await user.request("PUT", url, { body: text, raw: true, headers: { "content-type": "application/json" } });
        assert.equal(res.status, 400, text);
      }
      assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM ratings").get().n, 0);
      assertRatingsConsistent(srv.db, "after rejected ratings");
    }));

  test("only published videos can be rated: pending, deleted and malformed ids are 404; an unavailable video stays out of discovery lists", () =>
    withServer({}, async (srv) => {
      const { client: user } = quickUser(srv, "target@example.com");
      const published = await addVideo(srv, 1, "One Piece Episode 1");
      const pending = await addVideo(srv, 2, "Something without a series");
      const deleted = await addVideo(srv, 3, "One Piece Episode 3");
      srv.services.repo.deleteVideo(deleted.id);
      assert.equal(pending.status, "pending");
      for (const id of [pending.id, deleted.id, 999999, "0", "01", "1e0", "0x1", "-1", "1.0", "9".repeat(17), "%32%30"]) {
        assert.equal((await user.put(`/api/videos/${id}/rating`, { score: 5 })).status, 404, String(id));
        assert.equal((await user.del(`/api/videos/${id}/rating`)).status, 404, String(id));
      }
      // Unavailable videos are still published (series pages list them greyed out), so they can be rated,
      // but /top-rated and /trending must never surface them (docs/API.md v1.1).
      srv.services.repo.setAvailability(published.id, "unavailable");
      const raters = Array.from({ length: 4 }, (_, i) => quickUser(srv, `r${i}@example.com`).client);
      for (const r of raters) assert.equal((await r.put(`/api/videos/${published.id}/rating`, { score: 5 })).status, 200);
      assert.deepEqual((await srv.client().get("/api/top-rated")).body, []);
      assert.deepEqual((await srv.client().get("/api/trending")).body, []);
      assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM ratings").get().n, 4);
    }));

  test("bulk add limits: > 50 IDs, thousands of IDs or > 20 KB are refused before any oEmbed lookup; duplicates collapse", () =>
    withServer({}, async (srv) => {
      const { client: admin } = quickUser(srv, "admin@example.com", "admin");
      const ids = (n, base) => Array.from({ length: n }, (_, i) => vid(base + i));
      const bulk = (body) => admin.post("/api/admin/videos/bulk", body);

      let res = await bulk({ urls: ids(51, 1000) });
      assert.equal(res.status, 400);
      assert.match(res.body.error.details.text, /At most 50 .*found 51/);
      res = await bulk({ text: ids(1500, 5000).join("\n") });
      assert.equal(res.status, 400);
      assert.match(res.body.error.details.text, /found 1500/);
      res = await bulk({ text: ids(30, 7000).join("\n"), urls: ids(30, 7100) }); // 60 across text + urls
      assert.equal(res.status, 400);
      res = await bulk({ text: "x".repeat(BODY_LIMIT) });
      assert.equal(res.status, 413);
      assert.equal(srv.fake.calls.length, 0, "no lookup for refused requests");

      // 50 IDs written 3 ways each (150 tokens) + repeated invalid input: 50 rows + 1 invalid... over the limit by one.
      const fifty = ids(50, 8000);
      const text = fifty.flatMap((id) => [`https://youtu.be/${id}`, `<https://www.youtube.com/watch?v=${id}>,`, `youtube.com/shorts/${id}.`]).join(" ");
      res = await bulk({ text, urls: Array(200).fill("https://youtube.com/not-a-video"), dryRun: true });
      assert.equal(res.status, 400, "the invalid link counts towards the 50");
      res = await bulk({ text, dryRun: true });
      assert.equal(res.status, 200);
      assert.equal(res.body.results.length, 50);
      assert.equal(srv.fake.calls.length, 50, "one lookup per distinct ID");
      assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM videos").get().n, 0, "dry run stores nothing");

      res = await bulk({ urls: Array(2000).fill("x") });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.results.map((r) => r.outcome), ["invalid"]);
      res = await bulk({ text: vid(1), defaults: { seriesSlug: "no-such-series", season: 1e9, section: "music" } });
      assert.equal(res.status, 400);
      assert.deepEqual(Object.keys(res.body.error.details).sort(), ["defaults.season", "defaults.section", "defaults.seriesSlug"]);
    }));

  test(
    "concurrent health checks are coalesced: N parallel runs cost at most one oEmbed lookup per video",
    () =>
      withServer({}, async (srv) => {
        const { client: admin } = quickUser(srv, "admin@example.com", "admin");
        for (let i = 1; i <= 20; i++) await addVideo(srv, i, `One Piece Episode ${i}`);
        srv.fake.calls.length = 0;
        srv.fake.delayMs = 10;
        const res = await Promise.all(Array.from({ length: 8 }, () => admin.post("/api/admin/videos/health-check")));
        assert.ok(res.every((r) => r.status === 200));
        assert.ok(srv.fake.calls.length <= 20, `${srv.fake.calls.length} oEmbed lookups for 20 videos`);
      })
  );

  test("health check: unreachable YouTube leaves videos untouched; gone videos are marked once, not duplicated", () =>
    withServer({}, async (srv) => {
      const { client: admin } = quickUser(srv, "admin@example.com", "admin");
      const videos = [];
      for (let i = 1; i <= 5; i++) videos.push(await addVideo(srv, i, `One Piece Episode ${i}`));
      srv.fake.down = true;
      let res = await admin.post("/api/admin/videos/health-check");
      assert.deepEqual([res.status, res.body.checked, res.body.unavailable.length], [200, 0, 0]);
      srv.fake.down = false;
      srv.fake.gone.add(videos[0].youtubeVideoId);
      const both = await Promise.all([admin.post("/api/admin/videos/health-check"), admin.post("/api/admin/videos/health-check")]);
      for (const r of both) assert.deepEqual(r.body.unavailable.map((v) => v.id), [videos[0].id]);
      res = await srv.client().get("/api/latest");
      assert.ok(!res.body.some((v) => v.id === videos[0].id));
    }));

  test("pagination abuse: every limit/offset combination is clamped or 400, bounded in size, never 5xx, < 100 ms", () =>
    withServer({}, async (srv) => {
      for (let i = 1; i <= 3; i++) await addVideo(srv, i, `One Piece Episode ${i}`);
      const { client: admin } = quickUser(srv, "admin@example.com", "admin");
      const cases = [
        ["/api/search?limit=50&offset=100000", 200, 50],
        ["/api/search?offset=100001", 400],
        ["/api/search?limit=0", 400],
        ["/api/search?limit=51", 400],
        ["/api/search?limit=1e3", 400],
        ["/api/search?limit=-1", 400],
        ["/api/search?limit=+5", 400],
        ["/api/search?offset=9.5", 400],
        ["/api/search?limit=10&limit=20", 400],
        [`/api/search?offset=${"0".repeat(5000)}1`, 200, 20],
        ["/api/latest?limit=99999999999999999999999", 200, 50],
        ["/api/latest?offset=10001", 400],
        ["/api/latest?limit=50&offset=10000", 200, 50],
        ["/api/top-rated?limit=1000000", 200, 50],
        ["/api/trending?limit=00000000000000000000050", 200, 50],
        ["/api/trending?limit=0", 400],
        ["/api/admin/videos?limit=100&offset=10000000", 200, 100],
        ["/api/admin/videos?offset=10000001", 400],
        ["/api/admin/series?limit=101", 400],
        ["/api/admin/series?limit=100&offset=10000000", 200, 100],
        ["/api/anime/series/one-piece?season=100", 400],
        ["/api/anime/series/one-piece?season=99", 200],
      ];
      const problems = [];
      for (const [url, status, maxItems] of cases) {
        const { ms, value: res } = await fastest(() => (url.startsWith("/api/admin") ? admin : srv.client()).get(url));
        if (res.status !== status) problems.push(`${url}: ${res.status} (want ${status})`);
        if (ms >= BUDGET_MS) problems.push(`${url}: ${ms.toFixed(0)} ms`);
        const items = Array.isArray(res.body) ? res.body : res.body?.items;
        if (maxItems && items && items.length > maxItems) problems.push(`${url}: ${items.length} items`);
      }
      const far = await admin.get("/api/admin/videos?limit=100&offset=10000000");
      assert.deepEqual([far.body.items.length, far.body.total], [0, 3], "total stays right past the end");
      assert.deepEqual(problems, []);
    }));

  test("sitemap, genre list and genre pages stay equal to a fresh build under interleaved writes and concurrent reads", () =>
    withServer({}, async (srv) => {
      const { client: admin } = quickUser(srv, "admin@example.com", "admin");
      const anon = srv.client();
      const fresh = () => {
        const repo = createRepository(srv.db);
        return { sitemap: createSitemap({ repo, appUrl: "http://app.test" }).get(0), genres: repo.listGenres(), repo };
      };
      const check = async (step) => {
        const reads = await Promise.all([anon.get("/sitemap.xml"), anon.get("/api/genres"), anon.get("/sitemap.xml"), anon.get("/api/genres")]);
        const want = fresh();
        for (const i of [0, 2]) assert.equal(reads[i].text, want.sitemap, `${step}: sitemap`);
        for (const i of [1, 3]) assert.deepEqual(reads[i].body, want.genres, `${step}: genres`);
        for (const genre of want.genres) assert.equal(resolvePage(want.repo, `/genre/${encodeURIComponent(genre)}`).status, 200, `${step}: /genre/${genre}`);
      };
      await check("start");
      const [series] = await Promise.all([admin.post("/api/admin/series", { name: "Churn Show", genres: ["Ação", "Mistério"] }), anon.get("/sitemap.xml"), anon.get("/api/genres")]);
      const seriesId = series.body.series.id;
      await check("series created (no videos: no genre page yet)");
      const [added] = await Promise.all([admin.post("/api/admin/videos", { url: vid(1), title: "Churn Show Episode 1" }), anon.get("/sitemap.xml"), anon.get("/api/genres")]);
      assert.equal(added.body.video.status, "published");
      await check("video published");
      await Promise.all([admin.patch(`/api/admin/series/${seriesId}`, { genres: ["AÇÃO", "Terror"] }), anon.get("/api/genres"), admin.post("/api/admin/videos", { url: vid(2), title: "Churn Show Episode 2" })]);
      await check("genres edited + second video");
      srv.fake.gone.add(vid(1));
      srv.fake.gone.add(vid(2));
      await Promise.all([admin.post("/api/admin/videos/health-check"), anon.get("/sitemap.xml"), anon.get("/api/genres")]);
      await check("every video unavailable");
      await Promise.all([admin.patch(`/api/admin/videos/${added.body.video.id}`, { url: vid(3) }), anon.get("/api/genres")]);
      await check("url swapped (available again)");
      await Promise.all([admin.del(`/api/admin/videos/${added.body.video.id}`), admin.del(`/api/admin/series/${seriesId}`), anon.get("/sitemap.xml")]);
      await check("deleted");
    }));
});

// ===================================================================== 4. resource exhaustion
describe("4. resource exhaustion", () => {
  test("the rate limiter keeps at most 10,000 keys by default: 50,000 unique clients cost < 500 ms and evict only the oldest", () => {
    const limiter = rateLimit({ max: 1, windowMs: 60_000 });
    const res = { set() {} };
    const ip = (i) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
    const hit = (address) => {
      try {
        limiter({ ip: address }, res, () => {});
        return "ok";
      } catch (error) {
        return error.status;
      }
    };
    const t = performance.now();
    for (let i = 0; i < 50_000; i++) hit(ip(i));
    const ms = performance.now() - t;
    assert.ok(ms < 500, `${ms.toFixed(0)} ms`);
    assert.equal(hit(ip(40_001)), 429, "the newest 10,000 keys are kept");
    assert.equal(hit(ip(0)), "ok", "older keys were evicted (memory stays bounded)");
  });

  test("the dev outbox keeps the last 50 e-mails and a user never holds more than one live reset token", () =>
    withServer({}, async (srv) => {
      const email = "mailbomb@example.com";
      const { id } = quickUser(srv, email);
      const res = await Promise.all(Array.from({ length: 120 }, () => srv.client().post("/api/auth/forgot-password", { email })));
      assert.ok(res.every((r) => r.status === 202));
      await sleep(20);
      assert.equal(srv.mailer.outbox.length, 50);
      assert.equal((await srv.client().get("/api/dev/outbox")).body.length, 50);
      assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM email_tokens WHERE user_id = ?").get(id).n, 1);
      // Only the newest of the 120 links works.
      const newest = tokenFrom(srv.mailer.outbox.at(-1), "reset-password");
      const older = tokenFrom(srv.mailer.outbox.at(-2), "reset-password");
      assert.equal((await srv.client().post("/api/auth/reset-password", { token: older, password: "another-password-9" })).status, 400);
      assert.equal((await srv.client().post("/api/auth/reset-password", { token: newest, password: "another-password-9" })).status, 200);
    }));
});
