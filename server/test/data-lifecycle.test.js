// Security sweep #3: data lifecycle and RGPD / LGPD after migrations 10-12
// (session epochs, video_rating_stats, series_stats / rating_totals, rating_activity).
//   - DELETE /api/me removes or decrements EVERYTHING derived from the user,
//     checked against fresh recounts, and no table/column keeps a trace of them;
//   - GET /api/me/export holds every personal field of docs/API.md's
//     "Personal data we keep" table and nothing secret (hashes, epochs, tokens);
//   - the retention job (purgeExpired) leaves nothing personal behind either;
//   - deleted rows do not survive in the database FILE (free pages / WAL).
// Each test asserts the SAFE behaviour; a real defect is kept as
// { todo: "<what is wrong, where>" } (it runs and reports, but does not fail the suite).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";
import { createMailer } from "../src/mail.js";
import { RATING_ACTIVITY_DAYS, purgeExpired } from "../src/retention.js";
import { Client, PASSWORD, addVideo, lastEmail, signUp, startServer, tokenFrom } from "./helpers.js";

const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DAY = 86_400_000;
const isoDaysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();
const ACTIVITY_DAYS = RATING_ACTIVITY_DAYS;

async function withServer(options, fn) {
  const srv = await startServer(options);
  try {
    return await fn(srv);
  } finally {
    await srv.close();
  }
}

/** The raw sid value of a helpers.Client. */
const sidOf = (client) => client.cookie?.replace(/^sid=/, "") ?? null;

/** Every table (but SQLite's own) and every cell in it. */
function dumpAll(db) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  const cells = [];
  for (const table of tables) {
    for (const row of db.prepare(`SELECT * FROM "${table}"`).all()) {
      for (const [column, value] of Object.entries(row)) cells.push({ table, column, value });
    }
  }
  return { tables, cells };
}

/** Cells that contain any of `needles` (case-insensitive) or reference user `userId`. */
function traces(db, { needles = [], userId = null }) {
  const lower = needles.filter(Boolean).map((n) => String(n).toLowerCase());
  return dumpAll(db).cells.filter(
    ({ table, column, value }) =>
      (typeof value === "string" && lower.some((n) => value.toLowerCase().includes(n))) ||
      (userId != null && value === userId && (/(^|_)user_id$/.test(column) || (table === "users" && column === "id")))
  );
}

/**
 * Every derived counter equals a fresh recount of `ratings`: series_stats (published
 * videos only), rating_totals, video_rating_stats, and rating_activity for the days
 * the retention job keeps (rows may drop to 0, never below, and 0 rows carry no sum).
 */
function assertAggregates(db, step) {
  assert.deepEqual(
    db.prepare("SELECT * FROM series_stats ORDER BY series_id, section").all(),
    db
      .prepare(`
        SELECT v.series_id, v.section, COUNT(*) AS video_count, MAX(v.published_at) AS latest_published_at,
          (SELECT COUNT(*) FROM ratings r JOIN videos v2 ON v2.id = r.video_id
            WHERE v2.series_id = v.series_id AND v2.section = v.section AND v2.status = 'published') AS rating_n,
          (SELECT COALESCE(SUM(r.score), 0) FROM ratings r JOIN videos v2 ON v2.id = r.video_id
            WHERE v2.series_id = v.series_id AND v2.section = v.section AND v2.status = 'published') AS rating_sum
        FROM videos v WHERE v.status = 'published' AND v.section IS NOT NULL AND v.series_id IN (SELECT id FROM series)
        GROUP BY v.series_id, v.section ORDER BY v.series_id, v.section`)
      .all(),
    `${step}: series_stats`
  );
  assert.deepEqual(
    db.prepare("SELECT n, total FROM rating_totals").get(),
    db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(score), 0) AS total FROM ratings").get(),
    `${step}: rating_totals`
  );
  assert.deepEqual(
    db.prepare("SELECT video_id, n, total FROM video_rating_stats ORDER BY video_id").all(),
    db.prepare("SELECT video_id, COUNT(*) AS n, SUM(score) AS total FROM ratings GROUP BY video_id ORDER BY video_id").all(),
    `${step}: video_rating_stats`
  );
  const since = isoDaysAgo(ACTIVITY_DAYS).slice(0, 10);
  assert.deepEqual(
    db.prepare("SELECT video_id, day, count, score_sum FROM rating_activity WHERE count > 0 AND day >= ? ORDER BY video_id, day").all(since),
    db
      .prepare(`
        SELECT video_id, substr(updated_at, 1, 10) AS day, COUNT(*) AS count, SUM(score) AS score_sum
        FROM ratings WHERE substr(updated_at, 1, 10) >= ? GROUP BY video_id, day ORDER BY video_id, day`)
      .all(since),
    `${step}: rating_activity`
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM rating_activity WHERE count < 0 OR score_sum < 0 OR (count = 0 AND score_sum <> 0)").get().n,
    0,
    `${step}: rating_activity rows never go negative`
  );
}

/** Moves a user's rating of `videoId` (and its anonymous activity) to `daysAgo` days ago, as if it had been set then. */
function backdateRating(db, userId, videoId, daysAgo) {
  const row = db.prepare("SELECT score, updated_at FROM ratings WHERE user_id = ? AND video_id = ?").get(userId, videoId);
  const at = isoDaysAgo(daysAgo);
  db.transaction(() => {
    db.prepare("UPDATE rating_activity SET count = count - 1, score_sum = score_sum - ? WHERE video_id = ? AND day = ?").run(row.score, videoId, row.updated_at.slice(0, 10));
    db.prepare("UPDATE ratings SET updated_at = ? WHERE user_id = ? AND video_id = ?").run(at, userId, videoId);
    if (daysAgo <= ACTIVITY_DAYS) {
      db.prepare(`
        INSERT INTO rating_activity (video_id, day, count, score_sum) VALUES (?, ?, 1, ?)
        ON CONFLICT (video_id, day) DO UPDATE SET count = count + 1, score_sum = score_sum + excluded.score_sum`).run(videoId, at.slice(0, 10), row.score);
    }
  })();
}

/** A catalog with ratings from `leaver` on published, unpublished, backdated and purged-activity videos. */
async function scenario(srv) {
  const admin = await signUp(srv, { email: "admin@example.com", displayName: "Admin" });
  const stayer = await signUp(srv, { email: "stayer@example.com", displayName: "Stayer Person" });
  const v = {
    op1: await addVideo(srv, 1, "One Piece Episode 1"),
    op2: await addVideo(srv, 2, "One Piece Episode 2"),
    opm: await addVideo(srv, 3, "One Piece Chapter 1"),
    bl1: await addVideo(srv, 4, "Bleach Episode 1"),
    bl7: await addVideo(srv, 5, "Bleach Episode 7"),
  };
  for (const video of Object.values(v)) assert.equal(video.status, "published", video.title);
  // Created last, so its id is the highest: a later sign-up may reuse it (INTEGER PRIMARY KEY).
  const leaverEmail = "leaver.person@example.com";
  const leaverName = "Leaver Unique Zeta";
  const leaver = await signUp(srv, { email: leaverEmail, displayName: leaverName });
  const leaverId = (await leaver.get("/api/auth/me")).body.user.id;
  const ratings = [
    [v.op1, 5, "love"],
    [v.op2, 1, null],
    [v.opm, 3, "fire"],
    [v.bl1, 4, "wow"],
    [v.bl7, 2, "cry"],
  ];
  for (const [video, score, reaction] of ratings) {
    assert.equal((await leaver.put(`/api/videos/${video.id}/rating`, { score, reaction })).status, 200);
  }
  await stayer.put(`/api/videos/${v.op1.id}/rating`, { score: 3, reaction: "fire" });
  await stayer.put(`/api/videos/${v.bl1.id}/rating`, { score: 5 });
  backdateRating(srv.db, leaverId, v.op2.id, 3); // rated three days ago
  backdateRating(srv.db, leaverId, v.opm.id, 40); // its activity row was already purged
  // Rated while published, then unpublished: "Bleach Episode 7" as manga has no chapter number -> pending.
  assert.equal((await admin.patch(`/api/admin/videos/${v.bl7.id}`, { section: "manga" })).body.video.status, "pending");
  // A second device and a pending reset link.
  const device2 = srv.client();
  assert.equal((await device2.post("/api/auth/login", { email: leaverEmail, password: PASSWORD })).status, 200);
  await srv.client().post("/api/auth/forgot-password", { email: leaverEmail });
  await sleep(20);
  const resetToken = tokenFrom(lastEmail(srv.mailer, leaverEmail, /Redefina/), "reset-password");
  assertAggregates(srv.db, "before deletion");
  return { admin, stayer, v, leaver, leaverId, leaverEmail, leaverName, device2, resetToken, ratings };
}

// ============================================================ account deletion
describe("account deletion removes everything derived from the user", () => {
  test("ratings and every aggregate (series_stats, rating_totals, video_rating_stats, rating_activity) equal fresh recounts afterwards", () =>
    withServer({}, async (srv) => {
      const s = await scenario(srv);
      const op = srv.db.prepare("SELECT id FROM series WHERE slug = 'one-piece'").get().id;
      const statsBefore = srv.db.prepare("SELECT rating_n, rating_sum FROM series_stats WHERE series_id = ? AND section = 'anime'").get(op);
      assert.deepEqual(statsBefore, { rating_n: 3, rating_sum: 5 + 1 + 3 });

      assert.equal((await s.leaver.del("/api/me", { password: PASSWORD })).status, 204);
      assertAggregates(srv.db, "after deletion");
      assert.deepEqual(srv.db.prepare("SELECT rating_n, rating_sum FROM series_stats WHERE series_id = ? AND section = 'anime'").get(op), { rating_n: 1, rating_sum: 3 });
      assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM video_rating_stats WHERE video_id IN (?, ?, ?)").get(s.v.op2.id, s.v.opm.id, s.v.bl7.id).n, 0, "videos only the leaver rated have no aggregate row");
      assert.deepEqual(srv.db.prepare("SELECT n, total FROM rating_totals").get(), { n: 2, total: 8 });

      // The public views agree.
      const summary = (await srv.client().get(`/api/videos/${s.v.op1.id}/rating`)).body;
      assert.deepEqual({ count: summary.count, average: summary.average, love: summary.reactions.love, fire: summary.reactions.fire }, { count: 1, average: 3, love: 0, fire: 1 });
      const series = (await srv.client().get("/api/anime/series")).body.find((x) => x.slug === "one-piece");
      assert.deepEqual(series.rating, { average: 3, count: 1 });
      const latest = (await srv.client().get("/api/latest?limit=50")).body;
      assert.equal(latest.find((x) => x.id === s.v.op2.id).rating.count, 0);
      const trending = (await srv.client().get("/api/trending?limit=50")).body.map((x) => x.id);
      assert.ok(!trending.includes(s.v.op2.id), "a video only the leaver rated leaves trending");
    }));

  test("no table or column keeps the e-mail, name, password hash, token hashes or user id; old cookies and links are dead", () =>
    withServer({}, async (srv) => {
      const s = await scenario(srv);
      const row = srv.db.prepare("SELECT * FROM users WHERE id = ?").get(s.leaverId);
      const needles = [s.leaverEmail, s.leaverName, row.password_hash, sha256(sidOf(s.leaver)), sha256(sidOf(s.device2)), sha256(s.resetToken)];
      assert.ok(traces(srv.db, { needles, userId: s.leaverId }).length >= 10, "the dump does see the user before deletion");

      assert.equal((await s.leaver.del("/api/me", { password: PASSWORD })).status, 204);
      const { tables } = dumpAll(srv.db);
      for (const t of ["users", "sessions", "email_tokens", "ratings", "rating_activity", "video_rating_stats", "series_stats", "rating_totals"]) {
        assert.ok(tables.includes(t), `dump covers ${t}`);
      }
      assert.deepEqual(traces(srv.db, { needles, userId: s.leaverId }), []);

      assert.equal((await s.device2.get("/api/auth/me")).body.user, null);
      assert.equal((await s.device2.get("/api/me/export")).status, 401);
      assert.equal((await s.device2.put(`/api/videos/${s.v.op1.id}/rating`, { score: 5 })).status, 401);
      assert.equal((await srv.client().post("/api/auth/reset-password", { token: s.resetToken, password: "takeover-password" })).status, 400);
      assert.equal((await srv.client().post("/api/auth/login", { email: s.leaverEmail, password: PASSWORD })).status, 401);
    }));

  test("a new account (same e-mail, or one that reuses the deleted id) starts empty: no rating, session or link comes back", () =>
    withServer({}, async (srv) => {
      const s = await scenario(srv);
      assert.equal((await s.leaver.del("/api/me", { password: PASSWORD })).status, 204);
      const fresh = await signUp(srv, { email: "someone.new@example.com", displayName: "Someone New" });
      const again = await signUp(srv, { email: s.leaverEmail, displayName: "Came Back" });
      const ids = [(await fresh.get("/api/auth/me")).body.user.id, (await again.get("/api/auth/me")).body.user.id];
      assert.ok(ids.includes(s.leaverId), "the test does exercise id reuse");
      for (const client of [fresh, again]) {
        const data = JSON.parse((await client.get("/api/me/export")).text);
        assert.deepEqual(data.ratings, []);
        assert.equal(data.sessions.length, 1, "only the session it just made");
        for (const { id } of Object.values(s.v)) {
          const mine = (await client.get(`/api/videos/${id}/rating`)).body?.mine ?? null;
          assert.equal(mine, null);
        }
      }
      assertAggregates(srv.db, "after re-registration");
    }));
});

// ============================================================ export
describe("GET /api/me/export", () => {
  test("holds every stored account field, session expiry and rating; nothing secret (hashes, epochs, tokens) and nobody else's data", () =>
    withServer({}, async (srv) => {
      const s = await scenario(srv);
      const res = await s.leaver.get("/api/me/export");
      assert.equal(res.status, 200);
      const data = JSON.parse(res.text);
      const row = srv.db.prepare("SELECT * FROM users WHERE id = ?").get(s.leaverId);

      for (const key of ["account", "exportedAt", "ratings", "sessions"]) assert.ok(key in data, key);
      assert.deepEqual(data.account, {
        id: row.id,
        email: row.email,
        displayName: row.display_name,
        role: row.role,
        emailVerifiedAt: row.email_verified_at,
        privacyAcceptedAt: row.privacy_accepted_at,
        createdAt: row.created_at,
      });
      const sessions = srv.db.prepare("SELECT expires_at FROM sessions WHERE user_id = ? ORDER BY expires_at").all(s.leaverId);
      assert.deepEqual(data.sessions, sessions.map((x) => ({ expiresAt: x.expires_at })), "every session (both devices), expiry only");
      const stored = srv.db.prepare("SELECT video_id, score, reaction, updated_at FROM ratings WHERE user_id = ? ORDER BY video_id").all(s.leaverId);
      assert.deepEqual(
        data.ratings.map((r) => ({ video_id: r.videoId, score: r.score, reaction: r.reaction, updated_at: r.updatedAt })).sort((a, b) => a.video_id - b.video_id),
        stored,
        "every rating, including the one on a now-unpublished video"
      );
      assert.equal(data.ratings.find((r) => r.videoId === s.v.bl7.id).route, null, "no route for an unpublished video");

      // Nothing secret, nothing internal, nobody else.
      const text = res.text;
      assert.doesNotMatch(text, /\b[0-9a-f]{64}\b/, "no SHA-256 (session / token hashes)");
      assert.doesNotMatch(text, /scrypt|epoch/i, "no password hash, no session epoch");
      for (const secret of [row.password_hash, row.password_hash.split("$").at(-1), sidOf(s.leaver), sidOf(s.device2), s.resetToken]) {
        assert.ok(!text.includes(secret), "no hash, cookie or link token");
      }
      assert.ok(!text.includes("stayer@example.com") && !text.includes("Stayer Person") && !text.includes("admin@example.com"));
      const keys = new Set();
      const walk = (node) => {
        if (node && typeof node === "object") for (const [k, val] of Object.entries(node)) keys.add(k), walk(val);
      };
      walk(data);
      for (const k of keys) assert.doesNotMatch(k, /hash|epoch|secret|^ip$|ipAddress|userAgent|^token$/i, k);
    }));

  test(
    "lists pending e-mail tokens (purpose + expiry only), which the personal-data table lists",
    () =>
      withServer({}, async (srv) => {
        const s = await scenario(srv);
        const pending = srv.db.prepare("SELECT purpose, expires_at FROM email_tokens WHERE user_id = ?").all(s.leaverId);
        assert.equal(pending.length, 1, "the scenario left a pending reset link");
        const text = (await s.leaver.get("/api/me/export")).text;
        assert.ok(text.includes(pending[0].expires_at), "the reset link's expiry is in the export");
        assert.doesNotMatch(text, /\b[0-9a-f]{64}\b/, "but never its hash");
      })
  );
});

// ============================================================ retention
describe("retention job (purgeExpired)", () => {
  test("unverified > 7 days and every token of it, expired sessions, activity > 90 days go; afterwards no table holds a trace of the purged account", () =>
    withServer({}, async (srv) => {
      const keep = await signUp(srv, { email: "keeper@example.com", displayName: "Keeper" });
      const keepId = (await keep.get("/api/auth/me")).body.user.id;
      const video = await addVideo(srv, 1, "One Piece Episode 1");
      await keep.put(`/api/videos/${video.id}/rating`, { score: 4 });

      // Pending sign-ups: one 8 days old (with a verify AND a reset link), one 6 days old.
      for (const [email, name] of [["ghost.signup@example.com", "Ghost Signup Name"], ["recent.signup@example.com", "Recent Signup"]]) {
        await srv.client().post("/api/auth/register", { email, password: PASSWORD, displayName: name, acceptPrivacy: true });
      }
      await srv.client().post("/api/auth/forgot-password", { email: "ghost.signup@example.com" });
      await sleep(20);
      const ghost = srv.db.prepare("SELECT * FROM users WHERE email = 'ghost.signup@example.com'").get();
      const ghostTokens = srv.db.prepare("SELECT token_hash FROM email_tokens WHERE user_id = ?").all(ghost.id).map((r) => r.token_hash);
      assert.equal(ghostTokens.length, 2, "verify + reset");
      srv.db.prepare("UPDATE users SET created_at = ? WHERE id = ?").run(isoDaysAgo(8), ghost.id);
      srv.db.prepare("UPDATE users SET created_at = ? WHERE email = 'recent.signup@example.com'").run(isoDaysAgo(6));
      // An expired session of a verified user, anonymous activity of 91 days ago (goes) and of 31 and 89 days ago
      // (kept: 90 days since v1.6, for the admin metrics).
      srv.db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, epoch) VALUES (?, ?, ?, 0)").run(sha256("expired"), keepId, isoDaysAgo(1));
      const activity = srv.db.prepare("INSERT INTO rating_activity (video_id, day, count, score_sum) VALUES (?, ?, ?, ?)");
      activity.run(video.id, isoDaysAgo(91).slice(0, 10), 2, 7);
      for (const days of [31, 89]) activity.run(video.id, isoDaysAgo(days).slice(0, 10), 0, 0); // emptied rows: no rating behind them

      const result = purgeExpired(srv.db);
      assert.deepEqual(result, { sessions: 1, emailTokens: 0, unverifiedUsers: 1, ratingActivity: 1 });
      assert.deepEqual(traces(srv.db, { needles: ["ghost.signup@example.com", "Ghost Signup Name", ghost.password_hash, ...ghostTokens], userId: ghost.id }), []);
      assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'recent.signup@example.com'").get().n, 1, "6 days: kept");
      assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").get(keepId).n, 1, "the live session stays");
      assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM rating_activity WHERE day < ?").get(isoDaysAgo(90).slice(0, 10)).n, 0);
      assert.deepEqual(
        srv.db.prepare("SELECT day FROM rating_activity WHERE day < ? ORDER BY day").pluck().all(isoDaysAgo(7).slice(0, 10)),
        [isoDaysAgo(89).slice(0, 10), isoDaysAgo(31).slice(0, 10)],
        "31 and 89 days: kept"
      );
      assert.ok((await keep.get("/api/auth/me")).body.user, "the verified account still works");
      assertAggregates(srv.db, "after purge");

      // 25 h later the 6-day sign-up is past 7 days and its 24-h link has expired: both go.
      assert.deepEqual(purgeExpired(srv.db, new Date(Date.now() + 25 * 3_600_000)), { sessions: 0, emailTokens: 1, unverifiedUsers: 1, ratingActivity: 0 });
      assert.deepEqual(traces(srv.db, { needles: ["recent.signup@example.com", "Recent Signup"] }), []);
      assertAggregates(srv.db, "after the second purge");
    }));
});

// ============================================================ the database file
describe("deleted personal data does not survive in the database file", () => {
  test(
    "after DELETE /api/me and the 7-day purge, the e-mails, names and password hash are gone from the SQLite file (and its WAL) once the server shuts down",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crwn-erasure-"));
      const file = path.join(dir, "erasure.db");
      const db = openDatabase(file);
      const mailer = createMailer({ smtp: null }, { log: () => {} });
      const app = createApp({
        db,
        mailer,
        fetchVideoInfo: async () => ({ title: "x", channel: null }),
        config: { appUrl: "http://app.test", rateLimit: { max: 1000, windowMs: 60_000 }, clientDist: "/nonexistent" },
      });
      const server = await new Promise((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
      });
      const srv = { db, mailer, client: () => new Client(`http://127.0.0.1:${server.address().port}`) };
      try {
        const leaver = await signUp(srv, { email: "erase.me@example.com", displayName: "Erase Me Fully" });
        const hash = db.prepare("SELECT password_hash FROM users WHERE email = 'erase.me@example.com'").get().password_hash;
        await srv.client().post("/api/auth/register", { email: "never.verified@example.com", password: PASSWORD, displayName: "Never Verified Qx", acceptPrivacy: true });
        db.prepare("UPDATE users SET created_at = ? WHERE email = 'never.verified@example.com'").run(isoDaysAgo(8));
        db.pragma("wal_checkpoint(TRUNCATE)"); // the rows are in the main file now, as on any long-running server

        assert.equal((await leaver.del("/api/me", { password: PASSWORD })).status, 204);
        assert.equal(purgeExpired(db).unverifiedUsers, 1);
        assert.deepEqual(traces(db, { needles: ["erase.me@example.com", "never.verified@example.com"] }), [], "no table has them");

        await new Promise((resolve) => server.close(resolve));
        db.close(); // a normal shutdown: checkpoint, WAL removed
        const files = fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f))]);
        const found = [];
        for (const needle of ["erase.me@example.com", "Erase Me Fully", hash.split("$").at(-1), "never.verified@example.com", "Never Verified Qx"]) {
          for (const [name, bytes] of files) if (bytes.includes(Buffer.from(needle, "utf8"))) found.push(`${needle} in ${name}`);
        }
        assert.deepEqual(found, []);
      } finally {
        if (server.listening) await new Promise((resolve) => server.close(resolve));
        if (db.open) db.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});
