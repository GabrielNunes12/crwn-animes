import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { SCHEMA_VERSION, openDatabase } from "../src/db.js";
import { purgeExpired } from "../src/retention.js";
import { PASSWORD, addVideo, signUp, startServer } from "./helpers.js";

describe("your data (RGPD / LGPD)", () => {
  let srv;
  let video;
  before(async () => {
    srv = await startServer();
    video = await addVideo(srv, 1, "One Piece Episode 1");
  });
  after(() => srv.close());

  test("export has the account and every rating, never the password hash", async () => {
    const client = await signUp(srv, { email: "me@example.com", displayName: "Me" });
    await client.put(`/api/videos/${video.id}/rating`, { score: 5, reaction: "love" });
    const res = await client.get("/api/me/export");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-disposition"), /attachment; filename="?crwn-animes-my-data.json"?/);
    assert.match(res.headers.get("content-type"), /application\/json/);
    assert.equal(res.headers.get("cache-control"), "private, no-store");
    const data = JSON.parse(res.text);
    assert.equal(data.account.email, "me@example.com");
    assert.equal(data.account.displayName, "Me");
    assert.ok(data.account.privacyAcceptedAt);
    assert.ok(data.account.emailVerifiedAt);
    assert.equal(data.sessions.length, 1);
    assert.deepEqual(data.ratings.map(({ updatedAt, ...r }) => r), [
      {
        videoId: video.id,
        youtubeVideoId: video.youtubeVideoId,
        videoTitle: "One Piece Episode 1",
        route: "/anime/one-piece/episode/1",
        score: 5,
        reaction: "love",
      },
    ]);
    assert.doesNotMatch(res.text, /scrypt|password/i);
    assert.equal((await srv.client().get("/api/me/export")).status, 401);
  });

  test("PATCH /api/me renames", async () => {
    const client = await signUp(srv, { email: "rename@example.com", displayName: "Old" });
    const res = await client.patch("/api/me", { displayName: "  New   Name " });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.displayName, "New Name");
    assert.equal((await client.patch("/api/me", { displayName: "x" })).status, 400);
  });

  test("DELETE /api/me needs the password and removes everything", async () => {
    const client = await signUp(srv, { email: "bye@example.com" });
    const other = srv.client();
    await other.post("/api/auth/login", { email: "bye@example.com", password: PASSWORD });
    await client.put(`/api/videos/${video.id}/rating`, { score: 2 });
    const { id } = (await client.get("/api/auth/me")).body.user;

    assert.equal((await client.del("/api/me", { password: "wrong-password" })).status, 401);
    assert.equal((await client.del("/api/me", {})).status, 400);
    const res = await client.del("/api/me", { password: PASSWORD });
    assert.equal(res.status, 204);
    assert.equal(client.cookie, null, "cookie cleared");
    for (const table of ["users WHERE id = ?", "sessions WHERE user_id = ?", "ratings WHERE user_id = ?", "email_tokens WHERE user_id = ?"]) {
      assert.equal(srv.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(id).n, 0, table);
    }
    assert.equal((await other.get("/api/auth/me")).body.user, null);
    assert.equal((await srv.client().get(`/api/videos/${video.id}/rating`)).body.count, 1, "only the other rating is left");
  });
});

describe("retention", () => {
  test("purges expired sessions/tokens, unverified accounts after 7 days, old rating activity", async () => {
    const srv = await startServer();
    try {
      const keep = await signUp(srv, { email: "keep@example.com" });
      await srv.client().post("/api/auth/register", { email: "new@example.com", password: PASSWORD, displayName: "New", acceptPrivacy: true });
      await srv.client().post("/api/auth/register", { email: "old@example.com", password: PASSWORD, displayName: "Old", acceptPrivacy: true });
      const video = await addVideo(srv, 1, "One Piece Episode 1");
      await keep.put(`/api/videos/${video.id}/rating`, { score: 3 });

      const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
      srv.db.prepare("UPDATE users SET created_at = ? WHERE email = 'old@example.com'").run(daysAgo(8));
      srv.db.prepare("UPDATE users SET created_at = ? WHERE email = 'keep@example.com'").run(daysAgo(30));
      srv.db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) SELECT 'expired', id, ? FROM users WHERE email = 'keep@example.com'").run(daysAgo(1));
      srv.db.prepare("INSERT INTO rating_activity (video_id, day, count, score_sum) VALUES (?, ?, 1, 4)").run(video.id, daysAgo(31).slice(0, 10));

      const result = purgeExpired(srv.db);
      assert.deepEqual(result, { sessions: 1, emailTokens: 0, unverifiedUsers: 1, ratingActivity: 1 });
      const emails = srv.db.prepare("SELECT email FROM users ORDER BY email").all().map((r) => r.email);
      assert.deepEqual(emails, ["keep@example.com", "new@example.com"], "verified accounts stay whatever their age");
      assert.ok((await keep.get("/api/auth/me")).body.user, "live session kept");

      // Expired e-mail tokens go when the clock passes 24 h.
      const tomorrow = new Date(Date.now() + 25 * 3_600_000);
      assert.equal(purgeExpired(srv.db, tomorrow).emailTokens, 1);
      assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM rating_activity").get().n, 1, "recent activity kept");
    } finally {
      await srv.close();
    }
  });
});

describe("database migrations", () => {
  test("a database from the original schema upgrades in place", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crwn-db-"));
    const file = path.join(dir, "old.db");
    const old = new Database(file);
    old.exec(`
      CREATE TABLE series (id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        aliases TEXT NOT NULL DEFAULT '[]', genres TEXT NOT NULL DEFAULT '[]', cover_url TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE videos (id INTEGER PRIMARY KEY, youtube_video_id TEXT NOT NULL UNIQUE, source_title TEXT NOT NULL,
        channel TEXT, section TEXT CHECK (section IN ('anime', 'manga')),
        series_id INTEGER REFERENCES series(id) ON DELETE SET NULL, season INTEGER NOT NULL DEFAULT 1, number INTEGER,
        status TEXT NOT NULL CHECK (status IN ('published', 'pending')), classification TEXT NOT NULL DEFAULT '{}',
        overrides TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE UNIQUE INDEX videos_published_slot ON videos (series_id, section, season, number) WHERE status = 'published';
      CREATE INDEX videos_status ON videos (status);
      INSERT INTO series (id, slug, name) VALUES (1, 'one-piece', 'One Piece');
      INSERT INTO videos (youtube_video_id, source_title, section, series_id, number, status, created_at)
        VALUES ('vid00000001', 'One Piece Episode 1', 'anime', 1, 1, 'published', '2026-01-02 03:04:05');
    `);
    old.close();

    const db = openDatabase(file);
    try {
      assert.equal(db.pragma("user_version", { simple: true }), SCHEMA_VERSION);
      const video = db.prepare("SELECT * FROM videos").get();
      assert.equal(video.published_at, "2026-01-02T03:04:05.000Z");
      assert.equal(video.availability, "ok");
      assert.equal(db.prepare("SELECT synopsis FROM series").get().synopsis, null);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM series").get().n, 1, "no re-seeding");
      db.prepare("DELETE FROM series WHERE id = 1").run();
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM videos").get().n, 0, "cascade after upgrade");
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    // Opening again is a no-op.
  });
});
