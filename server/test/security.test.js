// Regression tests for the security review findings (one describe per finding).
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";
import { assertSafeConfig, loadConfig, parseTrustProxy } from "../src/config.js";
import { openDatabase } from "../src/db.js";
import { createMailer } from "../src/mail.js";
import { ipKey, rateLimit } from "../src/middleware/rateLimit.js";
import { PASSWORD, addVideo, lastEmail, signUp, startServer, tokenFrom, vid } from "./helpers.js";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withServer(options, fn) {
  const srv = await startServer(options);
  try {
    return await fn(srv);
  } finally {
    await srv.close();
  }
}

describe("1. pre-registration account takeover", () => {
  test("re-registering an unverified e-mail replaces the pending password; only the newest link works", () =>
    withServer({}, async (srv) => {
      // Attacker signs up with the victim's (admin) e-mail first.
      await srv.client().post("/api/auth/register", {
        email: "admin@example.com",
        password: "attacker-pass-123",
        displayName: "Attacker",
        acceptPrivacy: true,
      });
      const attackerLink = tokenFrom(lastEmail(srv.mailer, "admin@example.com"));

      // The real owner signs up: same 201, a fresh verification e-mail (not the "someone tried" one).
      const victim = srv.client();
      const reg = await victim.post("/api/auth/register", {
        email: "admin@example.com",
        password: "real-admin-pass-1",
        displayName: "Real",
        acceptPrivacy: true,
      });
      assert.equal(reg.status, 201);
      const mail = lastEmail(srv.mailer, "admin@example.com");
      assert.match(mail.subject, /Confirme/);
      const ownerLink = tokenFrom(mail);
      assert.notEqual(ownerLink, attackerLink);

      assert.equal((await srv.client().post("/api/auth/verify-email", { token: attackerLink })).status, 400, "older link is dead");
      const verified = await victim.post("/api/auth/verify-email", { token: ownerLink });
      assert.equal(verified.status, 200);
      assert.equal(verified.body.user.displayName, "Real");
      assert.equal(verified.body.user.role, "admin");

      const attacker = await srv.client().post("/api/auth/login", { email: "admin@example.com", password: "attacker-pass-123" });
      assert.equal(attacker.status, 401);
      assert.equal((await srv.client().post("/api/auth/login", { email: "admin@example.com", password: "real-admin-pass-1" })).status, 200);
    }));

  test("a verified account is never changed by a new sign-up", () =>
    withServer({}, async (srv) => {
      await signUp(srv, { email: "owner@example.com" });
      const res = await srv.client().post("/api/auth/register", { email: "owner@example.com", password: "attacker-pass-123", displayName: "Xavier", acceptPrivacy: true });
      assert.equal(res.status, 201);
      assert.match(lastEmail(srv.mailer, "owner@example.com").subject, /Tentativa de cadastro/);
      assert.equal((await srv.client().post("/api/auth/login", { email: "owner@example.com", password: "attacker-pass-123" })).status, 401);
      assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM email_tokens").get().n, 0);
    }));
});

describe("2. unauthenticated scrypt work and password brute force", () => {
  test("reset-password checks the token before hashing", () =>
    withServer({}, async (srv) => {
      const started = Date.now();
      const results = await Promise.all(
        Array.from({ length: 20 }, () => srv.client().post("/api/auth/reset-password", { token: "bogus", password: "a".repeat(256) }))
      );
      assert.ok(results.every((r) => r.status === 400 && r.body.error.code === "INVALID_TOKEN"));
      // 20 scrypt hashes at N=2^17 would take several seconds.
      assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
    }));

  test("reset-password is rate limited per IP", () =>
    withServer({ config: { rateLimit: { max: 3, windowMs: 60_000 } } }, async (srv) => {
      const client = srv.client();
      const statuses = [];
      for (let i = 0; i < 4; i++) statuses.push((await client.post("/api/auth/reset-password", { token: "x", password: PASSWORD })).status);
      assert.deepEqual(statuses, [400, 400, 400, 429]);
    }));

  test("POST /me/password and DELETE /me are limited per account even across IPs", () =>
    withServer({ config: { rateLimit: { max: 3, windowMs: 60_000 }, trustProxy: 1 } }, async (srv) => {
      const user = await signUp(srv, { email: "bf@example.com" });
      const guess = (i, method, path, body) => user.request(method, path, { body, headers: { "x-forwarded-for": `203.0.113.${i}` } });
      const change = [];
      for (let i = 0; i < 4; i++) change.push((await guess(i, "POST", "/api/me/password", { currentPassword: `guess-${i}`, newPassword: "new-password-123" })).status);
      assert.deepEqual(change, [401, 401, 401, 429]);
      const del = [];
      for (let i = 0; i < 4; i++) del.push((await guess(10 + i, "DELETE", "/api/me", { password: `guess-${i}` })).status);
      assert.deepEqual(del, [401, 401, 401, 429]);
    }));
});

describe("3 + 12. e-mails are fire-and-forget and errors never log addresses", () => {
  test("slow SMTP does not slow down known accounts", async () => {
    const inner = createMailer({ smtp: null }, { log: () => {} });
    const mailer = { outbox: inner.outbox, send: async (m) => (await sleep(800), inner.send(m)) };
    await withServer({ mailer }, async (srv) => {
      await srv.client().post("/api/auth/register", { email: "slow@example.com", password: PASSWORD, displayName: "Slow", acceptPrivacy: true });
      for (const [path, body] of [
        ["/api/auth/forgot-password", { email: "slow@example.com" }],
        ["/api/auth/resend-verification", { email: "slow@example.com" }],
      ]) {
        const started = Date.now();
        const res = await srv.client().post(path, body);
        assert.equal(res.status, 202);
        assert.ok(Date.now() - started < 600, `${path} waited for SMTP (${Date.now() - started} ms)`);
      }
      await sleep(900);
      assert.ok(lastEmail(srv.mailer, "slow@example.com", /Redefina/), "still sent in the background");
    });
  });

  test("SMTP errors log only the error code", async (t) => {
    const errors = [];
    t.mock.method(console, "error", (...args) => errors.push(args.join(" ")));
    const mailer = {
      outbox: [],
      send: async () => {
        const error = new Error("Can't send mail - all recipients were rejected: 550 <leak@example.com>");
        error.code = "EENVELOPE";
        throw error;
      },
    };
    await withServer({ mailer }, async (srv) => {
      const res = await srv.client().post("/api/auth/register", { email: "leak@example.com", password: PASSWORD, displayName: "Leak", acceptPrivacy: true });
      assert.equal(res.status, 201);
      await sleep(20);
    });
    assert.ok(errors.some((line) => line.includes("EENVELOPE")));
    assert.ok(errors.every((line) => !line.includes("leak@example.com")));
  });
});

describe("4. changing the password kills pending reset links", () => {
  test("old reset link fails after POST /me/password", () =>
    withServer({}, async (srv) => {
      const user = await signUp(srv, { email: "d@example.com" });
      await srv.client().post("/api/auth/forgot-password", { email: "d@example.com" });
      const token = tokenFrom(lastEmail(srv.mailer, "d@example.com", /Redefina/), "reset-password");
      assert.equal((await user.post("/api/me/password", { currentPassword: PASSWORD, newPassword: "owner-changed-pass" })).status, 200);
      const use = await srv.client().post("/api/auth/reset-password", { token, password: "attacker-new-pass" });
      assert.equal(use.status, 400);
      assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM email_tokens").get().n, 0);
    }));
});

describe("5. production safety", () => {
  test("production without SMTP is refused; the dev outbox needs dev mode and no SMTP", async () => {
    assert.throws(() => assertSafeConfig(loadConfig({ NODE_ENV: "production" })), /SMTP_HOST/);
    assert.doesNotThrow(() => assertSafeConfig(loadConfig({ NODE_ENV: "production", SMTP_HOST: "smtp.example.com" })));
    assert.doesNotThrow(() => assertSafeConfig(loadConfig({})));

    const run = spawnSync(process.execPath, ["src/index.js"], {
      cwd: SERVER_DIR,
      env: { ...process.env, NODE_ENV: "production", SMTP_HOST: "", PORT: "0", DATABASE_FILE: ":memory:" },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /Refusing to start: .*SMTP_HOST/);

    await withServer({ config: { smtp: { host: "smtp.example.com", port: 587 } } }, async (srv) => {
      assert.equal((await srv.client().get("/api/dev/outbox")).status, 404);
    });
  });

  test("tokenised links are printed in development only", async () => {
    const message = { to: "a@b.cd", subject: "Reset", text: "go http://app/reset-password?token=SECRETTOKEN", html: "" };
    const prodLines = [];
    await createMailer({ smtp: null, isProduction: true }, { log: (line) => prodLines.push(line) }).send(message);
    assert.ok(prodLines.every((line) => !line.includes("SECRETTOKEN") && !line.includes("a@b.cd")));
    const devLines = [];
    await createMailer({ smtp: null, isProduction: false }, { log: (line) => devLines.push(line) }).send(message);
    assert.ok(devLines.some((line) => line.includes("SECRETTOKEN")));
    assert.ok(devLines.every((line) => !line.includes("a@b.cd")));
  });
});

describe("7. proxy trust and rate-limit keys", () => {
  test('TRUST_PROXY accepts hop counts and subnets, refuses "true"', () => {
    assert.equal(parseTrustProxy("1"), 1);
    assert.deepEqual(parseTrustProxy("10.0.0.0/8, loopback"), ["10.0.0.0/8", "loopback"]);
    assert.equal(parseTrustProxy(""), false);
    for (const bad of ["true", true, "yes", "*"]) assert.throws(() => parseTrustProxy(bad), /TRUST_PROXY/);
    assert.throws(() => loadConfig({ TRUST_PROXY: "true" }), /TRUST_PROXY/);
    assert.throws(() => createApp({ db: openDatabase(), config: { trustProxy: true } }), /TRUST_PROXY/);
  });

  test("IPv6 clients are keyed by /64, IPv4-mapped by their IPv4", () => {
    assert.equal(ipKey("2001:db8:1:2:aaaa::1"), ipKey("2001:db8:1:2:ffff:ffff:ffff:ffff"));
    assert.notEqual(ipKey("2001:db8:1:2::1"), ipKey("2001:db8:1:3::1"));
    assert.equal(ipKey("::ffff:192.0.2.1"), "192.0.2.1");
    assert.equal(ipKey("192.0.2.1"), "192.0.2.1");
  });

  test("the limiter Map is capped and evicts the oldest key", () => {
    const limiter = rateLimit({ max: 1, windowMs: 60_000, maxEntries: 2 });
    const res = { set() {} };
    const hit = (ip) => {
      try {
        limiter({ ip }, res, () => {});
        return "ok";
      } catch (error) {
        return error.status;
      }
    };
    assert.equal(hit("192.0.2.1"), "ok");
    assert.equal(hit("192.0.2.1"), 429);
    hit("192.0.2.2");
    hit("192.0.2.3"); // evicts .1
    assert.equal(hit("192.0.2.1"), "ok", "the evicted key starts over");
    assert.equal(hit("192.0.2.3"), 429, "recent keys are kept");
  });
});

describe("8. migration of orphaned published videos", () => {
  test("published videos whose series was deleted (SET NULL) become pending", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crwn-orphan-"));
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
      INSERT INTO series (id, slug, name) VALUES (1, 'one-piece', 'One Piece');
      INSERT INTO videos (youtube_video_id, source_title, section, series_id, number, status)
        VALUES ('aaaaaaaaaaa', 'One Piece Episode 1', 'anime', 1, 1, 'published'),
               ('bbbbbbbbbbb', 'Gone Episode 1', 'anime', NULL, 1, 'published');
    `);
    old.close();
    const db = openDatabase(file);
    try {
      const rows = db.prepare("SELECT youtube_video_id AS id, status, classification FROM videos ORDER BY id").all();
      assert.deepEqual(rows.map((r) => [r.id, r.status]), [["aaaaaaaaaaa", "published"], ["bbbbbbbbbbb", "pending"]]);
      assert.match(JSON.parse(rows[1].classification).reasons.at(-1), /series was deleted/);
      const app = createApp({ db, config: { clientDist: "/nonexistent" } });
      const server = await new Promise((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
      });
      const latest = await (await fetch(`http://127.0.0.1:${server.address().port}/api/latest`)).json();
      server.close();
      assert.deepEqual(latest.map((v) => v.youtubeVideoId), ["aaaaaaaaaaa"]);
      assert.ok(latest.every((v) => v.route));
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("9. concurrent adds of the same link", () => {
  test("the second request gets 409 CONFLICT, not 500", () =>
    withServer({}, async (srv) => {
      const admin = await signUp(srv, { email: "admin@example.com" });
      srv.fake.delayMs = 50;
      srv.fake.titles[vid(50)] = "One Piece Episode 50";
      const results = await Promise.all([admin.post("/api/admin/videos", { url: vid(50) }), admin.post("/api/admin/videos", { url: vid(50) })]);
      assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
      const conflict = results.find((r) => r.status === 409);
      assert.equal(conflict.body.error.code, "CONFLICT");
      assert.equal(conflict.body.error.details.video.youtubeVideoId, vid(50));

      // Two different links for the same episode: one published, one pending.
      srv.fake.titles[vid(51)] = "Bleach Episode 7";
      srv.fake.titles[vid(52)] = "Bleach Episode 7 (alt)";
      const slot = await Promise.all([admin.post("/api/admin/videos", { url: vid(51) }), admin.post("/api/admin/videos", { url: vid(52) })]);
      assert.deepEqual(slot.map((r) => r.body.video.status).sort(), ["pending", "published"]);
    }));
});

describe("10. deleting an account updates trending", () => {
  test("the user's ratings leave rating_activity", () =>
    withServer({}, async (srv) => {
      const video = await addVideo(srv, 1, "One Piece Episode 1");
      const user = await signUp(srv, { email: "gone@example.com" });
      await user.put(`/api/videos/${video.id}/rating`, { score: 5 });
      assert.deepEqual((await srv.client().get("/api/trending")).body.map((v) => v.id), [video.id]);
      assert.equal((await user.del("/api/me", { password: PASSWORD })).status, 204);
      assert.deepEqual((await srv.client().get("/api/trending")).body, []);
      assert.equal(srv.db.prepare("SELECT SUM(count) AS n FROM rating_activity").get().n, 0);
    }));
});

describe("11. static fallback", () => {
  test("missing assets and paths with an extension are 404, routes get index.html", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crwn-static-"));
    fs.mkdirSync(path.join(dir, "assets"));
    fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Crwn Animes</title>");
    try {
      await withServer({ config: { clientDist: dir } }, async (srv) => {
        for (const p of ["/assets/missing-123.js", "/assets/sub/thing", "/robots.txt", "/favicon.ico", "/anime/x.map"]) {
          const res = await srv.client().get(p);
          assert.equal(res.status, 404, p);
          assert.doesNotMatch(res.text, /Crwn Animes/, p);
        }
        assert.equal((await srv.client().get("/anime/one-piece/episode/5")).status, 200);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("13. PATCH video validates everything before writing", () => {
  test("a bad seriesSlug next to a url changes nothing; a good pair applies both", () =>
    withServer({}, async (srv) => {
      const admin = await signUp(srv, { email: "admin@example.com" });
      const video = await addVideo(srv, 1, "Bleach Episode 3");
      const bad = await admin.patch(`/api/admin/videos/${video.id}`, { url: vid(2), seriesSlug: "no-such-series" });
      assert.equal(bad.status, 400);
      const after = srv.services.repo.getVideo(video.id);
      assert.equal(after.youtubeVideoId, vid(1), "url not swapped");
      assert.deepEqual(after.overrides, {});

      const good = await admin.patch(`/api/admin/videos/${video.id}`, { url: vid(2), number: 4 });
      assert.equal(good.status, 200);
      assert.equal(good.body.video.youtubeVideoId, vid(2));
      assert.equal(good.body.video.route, "/anime/bleach/episode/4");
    }));
});

describe("14. scrypt cost", () => {
  test("new hashes use N=2^17; older hashes still log in and are upgraded", () =>
    withServer({}, async (srv) => {
      await signUp(srv, { email: "legacy@example.com" });
      const current = srv.db.prepare("SELECT password_hash FROM users WHERE email = 'legacy@example.com'").get().password_hash;
      assert.match(current, /^scrypt\$131072\$8\$1\$/);

      const salt = randomBytes(16);
      const legacy = ["scrypt", 16384, 8, 1, salt.toString("base64"), scryptSync(PASSWORD, salt, 64, { N: 16384, r: 8, p: 1 }).toString("base64")].join("$");
      srv.db.prepare("UPDATE users SET password_hash = ? WHERE email = 'legacy@example.com'").run(legacy);
      assert.equal((await srv.client().post("/api/auth/login", { email: "legacy@example.com", password: PASSWORD })).status, 200);
      const upgraded = srv.db.prepare("SELECT password_hash FROM users WHERE email = 'legacy@example.com'").get().password_hash;
      assert.match(upgraded, /^scrypt\$131072\$/);
      assert.equal((await srv.client().post("/api/auth/login", { email: "legacy@example.com", password: PASSWORD })).status, 200);
    }));
});
