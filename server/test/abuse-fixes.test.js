// Regression tests for security sweep #2 fixes, beyond the races in
// abuse.test.js: session epochs (and their migration), the per-user session
// cap, upgrade-rehash under concurrency, targeted re-classification, shared
// health-check runs, long bulk tokens and the per-video rating aggregates.
import assert from "node:assert/strict";
import { randomBytes, scryptSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { MAX_SESSIONS_PER_USER, createAuthService } from "../src/authService.js";
import { hashToken, verifyPassword } from "../src/crypto.js";
import { openDatabase } from "../src/db.js";
import { createMailer } from "../src/mail.js";
import { collectBulkInputs } from "../src/routes/admin.js";
import { PASSWORD, addVideo, signUp, startServer, vid } from "./helpers.js";

async function withServer(options, fn) {
  const srv = await startServer(options);
  try {
    return await fn(srv);
  } finally {
    await srv.close();
  }
}

/** A verified user with a session, without scrypt. */
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

const legacyHash = (password) => {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return ["scrypt", 16384, 8, 1, salt.toString("base64"), hash.toString("base64")].join("$");
};

describe("session epochs", () => {
  test("logout-all, password change and reset bump the epoch; a session made with an older epoch is refused or dead", () =>
    withServer({}, async (srv) => {
      const { auth } = srv.services;
      const { id, client } = quickUser(srv, "epoch@example.com");
      const epoch = auth.users.findById(id).session_epoch;
      auth.endAllSessions(id);
      assert.equal(auth.users.findById(id).session_epoch, epoch + 1);
      assert.equal((await client.get("/api/auth/me")).body.user, null);
      // A login that authenticated before the bump cannot get a session afterwards.
      assert.throws(() => auth.rotateSession(id, null, epoch), (e) => e.status === 401 && e.code === "INVALID_CREDENTIALS");
      assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").get(id).n, 0);
      // A row written with a stale epoch (any other path) is not a valid session either.
      const token = auth.rotateSession(id, null);
      assert.ok(auth.userForSession(token));
      srv.db.prepare("UPDATE sessions SET epoch = epoch - 1 WHERE user_id = ?").run(id);
      assert.equal(auth.userForSession(token), null);
    }));

  test("migration 10 keeps the sessions that existed before it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crwn-epoch-"));
    const file = path.join(dir, "old.db");
    try {
      const old = openDatabase(file, { seedCatalog: false, migrateTo: 9 });
      old.prepare("INSERT INTO users (id, email, display_name, password_hash, email_verified_at, privacy_accepted_at, created_at) VALUES (1, 'a@b.co', 'A', 'x', 'x', 'x', 'x')").run();
      old.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, 1, '2999-01-01T00:00:00.000Z')").run(hashToken("legacy-token"));
      old.close();
      const db = openDatabase(file);
      try {
        const auth = createAuthService({ db, config: { appUrl: "http://x", adminEmails: [] }, mailer: createMailer({ smtp: null }, { log: () => {} }) });
        const row = db.prepare("SELECT s.epoch, u.session_epoch FROM sessions s JOIN users u ON u.id = s.user_id").get();
        assert.deepEqual(row, { epoch: 0, session_epoch: 0 });
        assert.equal(auth.userForSession("legacy-token")?.email, "a@b.co");
        assert.ok(auth.rotateSession(1, null), "new sessions work too");
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`at most ${MAX_SESSIONS_PER_USER} live sessions per user: a new login drops the oldest`, () =>
    withServer({}, async (srv) => {
      const { auth } = srv.services;
      const user = await signUp(srv, { email: "many@example.com" });
      const id = (await user.get("/api/auth/me")).body.user.id;
      const tokens = [user.cookie.slice(4)];
      for (let i = 0; i < MAX_SESSIONS_PER_USER - 1; i++) tokens.push(auth.rotateSession(id, null));
      const count = () => srv.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").get(id).n;
      assert.equal(count(), MAX_SESSIONS_PER_USER);
      const login = await srv.client().post("/api/auth/login", { email: "many@example.com", password: PASSWORD });
      assert.equal(login.status, 200);
      assert.equal(count(), MAX_SESSIONS_PER_USER);
      assert.equal(auth.userForSession(tokens[0]), null, "the oldest went");
      assert.ok(tokens.slice(1).every((t) => auth.userForSession(t)), "the others stay");
      // Other users are untouched.
      const other = quickUser(srv, "other@example.com");
      assert.equal((await other.client.get("/api/auth/me")).body.user.email, "other@example.com");
    }));
});

describe("upgrade-rehash on login", () => {
  test("two concurrent logins of a legacy-hash account both succeed; the hash is upgraded once and still matches", () =>
    withServer({}, async (srv) => {
      const email = "legacy@example.com";
      await signUp(srv, { email });
      srv.db.prepare("UPDATE users SET password_hash = ? WHERE email = ?").run(legacyHash(PASSWORD), email);
      const [a, b] = await Promise.all([0, 1].map(() => srv.client().post("/api/auth/login", { email, password: PASSWORD })));
      assert.deepEqual([a.status, b.status], [200, 200]);
      const stored = srv.db.prepare("SELECT password_hash FROM users WHERE email = ?").pluck().get(email);
      assert.match(stored, /^scrypt\$131072\$/);
      assert.equal(await verifyPassword(PASSWORD, stored), true);
    }));

  test("the conditional write never replaces a hash it did not verify", () =>
    withServer({}, async (srv) => {
      const { users } = srv.services.auth;
      const { id } = quickUser(srv, "cas@example.com");
      users.setPassword(id, "hash-a");
      assert.equal(users.setPasswordIfUnchanged(id, "hash-b", "hash-x"), false);
      assert.equal(users.findById(id).password_hash, "hash-a");
      assert.equal(users.setPasswordIfUnchanged(id, "hash-b", "hash-a"), true);
      assert.equal(users.findById(id).password_hash, "hash-b");
    }));
});

describe("targeted re-classification", () => {
  test("a synopsis/genre/cover edit, or an alias that normalises the same, does not look at the pending queue", (t) =>
    withServer({}, async (srv) => {
      const { client: admin } = quickUser(srv, "admin@example.com", "admin");
      await addVideo(srv, 1, "Mystery Show clip");
      const series = (await admin.post("/api/admin/series", { name: "Frieren", aliases: ["Sousou no Frieren"] })).body.series;
      const scans = t.mock.method(srv.services.repo, "pendingForReclassify");
      for (const patch of [{ synopsis: "x" }, { genres: ["Drama"] }, { coverUrl: "https://example.com/c.jpg" }, { aliases: ["SOUSOU NO FRIEREN!"] }, { name: "frieren" }]) {
        const res = await admin.patch(`/api/admin/series/${series.id}`, patch);
        assert.equal(res.status, 200, JSON.stringify(patch));
        assert.deepEqual(res.body.published, []);
      }
      assert.equal(scans.mock.callCount(), 0);
      await admin.patch(`/api/admin/series/${series.id}`, { aliases: ["Mystery Show"] });
      assert.equal(scans.mock.callCount(), 1, "a real alias change does");
    }));

  test("removing a name makes an ambiguous title match the other series (old names count too)", () =>
    withServer({}, async (srv) => {
      const { client: admin } = quickUser(srv, "admin@example.com", "admin");
      const a = (await admin.post("/api/admin/series", { name: "Twin Blades" })).body.series;
      const b = (await admin.post("/api/admin/series", { name: "Other Show", aliases: ["Twin Blades"] })).body.series;
      const video = await addVideo(srv, 1, "Twin Blades Episode 3");
      assert.equal(video.status, "pending", "two series with the same name: ambiguous");
      const res = await admin.patch(`/api/admin/series/${b.id}`, { aliases: [] });
      assert.deepEqual(res.body.published.map((v) => [v.id, v.seriesId]), [[video.id, a.id]]);
    }));

  test("only pending videos naming the series are rewritten; a video whose override names the old slug stays pending (no 400)", () =>
    withServer({}, async (srv) => {
      const { client: admin } = quickUser(srv, "admin@example.com", "admin");
      const kaiju = (await admin.post("/api/admin/series", { name: "Kaiju Story" })).body.series;
      const pinned = await addVideo(srv, 1, "Random upload", { seriesSlug: "kaiju-story" });
      assert.equal(pinned.status, "pending");
      const bystander = await addVideo(srv, 2, "Something else entirely");
      const before = srv.db.prepare("SELECT updated_at, classification FROM videos WHERE id = ?").get(bystander.id);
      srv.db.prepare("UPDATE videos SET updated_at = '2000-01-01 00:00:00' WHERE id = ?").run(bystander.id);

      const res = await admin.patch(`/api/admin/series/${kaiju.id}`, { slug: "kaiju-story-x" });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.published, []);
      const reasons = srv.services.repo.getVideo(pinned.id).classification.reasons;
      assert.ok(reasons.some((r) => /unknown series "kaiju-story"/.test(r)), reasons.join("; "));
      const after = srv.db.prepare("SELECT updated_at, classification FROM videos WHERE id = ?").get(bystander.id);
      assert.deepEqual(after, { updated_at: "2000-01-01 00:00:00", classification: before.classification }, "not rewritten");

      // Creating a series with a title's name publishes it (and only it).
      const show = await addVideo(srv, 3, "Moon Rabbit Episode 7");
      const created = await admin.post("/api/admin/series", { name: "Moon Rabbit" });
      assert.deepEqual(created.body.published.map((v) => [v.id, v.route]), [[show.id, "/anime/moon-rabbit/episode/7"]]);
      // Without an argument everything pending is re-classified (no change here).
      assert.deepEqual(srv.services.videos.reclassifyPending(), []);
    }));
});

describe("health checks", () => {
  test("the daily job and admin requests share one run; a later call starts a new one", () =>
    withServer({}, async (srv) => {
      const { client: admin } = quickUser(srv, "admin@example.com", "admin");
      for (let i = 1; i <= 6; i++) await addVideo(srv, i, `One Piece Episode ${i}`);
      srv.fake.calls.length = 0;
      srv.fake.delayMs = 20;
      const job = srv.services.videos.healthCheck({ olderThan: new Date(Date.now() + 60_000).toISOString() });
      const [res1, res2] = await Promise.all([admin.post("/api/admin/videos/health-check"), admin.post("/api/admin/videos/health-check")]);
      const jobResult = await job;
      assert.equal(srv.fake.calls.length, 6, "one lookup per video");
      assert.deepEqual(res1.body, { checked: 6, unavailable: [] });
      assert.deepEqual(res2.body, res1.body);
      assert.deepEqual(jobResult, res1.body);
      srv.fake.gone.add(vid(2));
      const again = await admin.post("/api/admin/videos/health-check");
      assert.equal(srv.fake.calls.length, 12);
      assert.deepEqual(again.body.unavailable.map((v) => v.youtubeVideoId), [vid(2)]);
      srv.fake.down = true;
      await assert.doesNotReject(srv.services.videos.healthCheck(), "a failed run does not block the next");
    }));
});

describe("bulk tokens", () => {
  test("wrapping punctuation is stripped; tokens are capped, so a long link with an early v= still works", () => {
    const id = vid(7);
    const rows = collectBulkInputs(
      [
        `<https://youtu.be/${id}>,`,
        `("https://www.youtube.com/watch?v=${vid(8)}").`,
        `https://www.youtube.com/watch?v=${vid(9)}&list=${"x".repeat(5000)}`,
        `[[[${")".repeat(10_000)}`,
      ].join("\n"),
      []
    );
    assert.deepEqual(rows.map((r) => r.youtubeVideoId), [id, vid(8), vid(9)]);
  });
});

describe("per-video rating aggregates", () => {
  test("video_rating_stats follows every write; top-rated equals a fresh aggregation", () =>
    withServer({}, async (srv) => {
      const videos = [];
      for (let i = 1; i <= 6; i++) videos.push(await addVideo(srv, i, `One Piece Episode ${i}`));
      const users = Array.from({ length: 8 }, (_, i) => quickUser(srv, `r${i}@example.com`));
      let seed = 3;
      const rnd = (n) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
      for (let k = 0; k < 60; k++) {
        const { client } = users[rnd(users.length)];
        const video = videos[rnd(videos.length)];
        if (rnd(4) === 0) await client.del(`/api/videos/${video.id}/rating`);
        else await client.put(`/api/videos/${video.id}/rating`, { score: 1 + rnd(5) });
      }
      const check = (step) => {
        assert.deepEqual(
          srv.db.prepare("SELECT video_id, n, total FROM video_rating_stats ORDER BY video_id").all(),
          srv.db.prepare("SELECT video_id, COUNT(*) AS n, SUM(score) AS total FROM ratings GROUP BY video_id ORDER BY video_id").all(),
          step
        );
        const all = srv.db.prepare("SELECT video_id, COUNT(*) AS n, SUM(score) AS total FROM ratings GROUP BY video_id").all();
        const sum = all.reduce((acc, r) => ({ n: acc.n + r.n, total: acc.total + r.total }), { n: 0, total: 0 });
        const m = sum.n ? sum.total / sum.n : 0;
        const expected = all
          .filter((r) => r.n >= 3)
          .map((r) => ({ id: r.video_id, score: (5 * m + r.total) / (5 + r.n), n: r.n }))
          .sort((x, y) => y.score - x.score || y.n - x.n || y.id - x.id)
          .map((r) => r.id);
        assert.deepEqual(srv.services.repo.listTopRated({ limit: 50 }).map((v) => v.id), expected, step);
        for (const v of srv.services.repo.listLatest({ limit: 50 })) {
          const row = all.find((r) => r.video_id === v.id);
          assert.equal(v.rating.count, row?.n ?? 0, step);
        }
      };
      check("after a storm of PUT/DELETE");
      srv.services.videos.remove(videos[0].id);
      check("after deleting a rated video");
      await users[0].client.del("/api/me", { password: "x" }); // wrong password: nothing changes
      srv.services.ratings.removeAllForUser(users[1].id);
      srv.services.auth.users.deleteUser(users[1].id);
      check("after deleting a user");
    }));
});
