// Shared test helpers: an in-memory app on a random port, a fetch client with
// a cookie jar, and shortcuts to create users and videos.
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { openDatabase } from "../src/db.js";
import { HttpError } from "../src/errors.js";
import { createMailer } from "../src/mail.js";

/** 11-char fake YouTube ID: vid(7) -> "vid00000007". */
export const vid = (n) => `vid${String(n).padStart(8, "0")}`;

export const PASSWORD = "correct-horse-battery";

export class Client {
  constructor(base) {
    this.base = base;
    this.cookie = null;
  }

  async request(method, path, { body, headers = {}, raw = false } = {}) {
    const h = { ...headers };
    let payload;
    if (body !== undefined) {
      payload = raw ? body : JSON.stringify(body);
      if (!raw) h["content-type"] ??= "application/json";
    }
    if (this.cookie && !h.cookie) h.cookie = this.cookie;
    const res = await fetch(this.base + path, { method, headers: h, body: payload });
    const setCookie = res.headers.getSetCookie();
    for (const line of setCookie) {
      const [pair] = line.split(";");
      const index = pair.indexOf("=");
      if (pair.slice(0, index) === "sid") {
        const value = pair.slice(index + 1);
        this.cookie = value ? `sid=${value}` : null;
      }
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, headers: res.headers, body: json, text, setCookie };
  }

  get(path, options) {
    return this.request("GET", path, options);
  }
  post(path, body, options) {
    return this.request("POST", path, { ...options, body });
  }
  put(path, body, options) {
    return this.request("PUT", path, { ...options, body });
  }
  patch(path, body, options) {
    return this.request("PATCH", path, { ...options, body });
  }
  del(path, body, options) {
    return this.request("DELETE", path, { ...options, body });
  }
}

/**
 * Starts the app on port 0 with an in-memory DB.
 * fake.titles[id] sets what "YouTube" answers; fake.gone has IDs that answer 404;
 * fake.down makes every lookup fail like a network error; fake.delayMs slows lookups.
 */
export async function startServer({ config = {}, mailer: customMailer } = {}) {
  const db = openDatabase(":memory:");
  const mailer = customMailer ?? createMailer({ smtp: null }, { log: () => {} });
  const fake = { titles: {}, gone: new Set(), down: false, calls: [], delayMs: 0 };
  const fetchVideoInfo = async (id) => {
    fake.calls.push(id);
    if (fake.delayMs) await new Promise((resolve) => setTimeout(resolve, fake.delayMs));
    if (fake.down) throw new HttpError(502, "Could not reach YouTube.");
    if (fake.gone.has(id)) throw new HttpError(404, "YouTube has no public video with this ID.");
    return { title: fake.titles[id] ?? `Untitled upload ${id}`, channel: "Test Channel" };
  };
  const app = createApp({
    db,
    mailer,
    fetchVideoInfo,
    config: {
      nodeEnv: "test",
      isProduction: false,
      appUrl: "http://app.test",
      adminEmails: ["admin@example.com"],
      rateLimit: { max: 1000, windowMs: 15 * 60 * 1000 },
      clientDist: "/nonexistent-client-dist",
      ...config,
    },
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    app,
    db,
    mailer,
    fake,
    base,
    services: app.locals.services,
    client: () => new Client(base),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
        db.close();
      }),
  };
}

/** Last e-mail sent to `to` (optionally whose subject matches). */
export function lastEmail(mailer, to, subject) {
  return mailer.outbox.filter((m) => m.to === to && (!subject || subject.test(m.subject))).at(-1) ?? null;
}

/** Token from a link like ".../verify-email?token=XYZ" in the e-mail's text. */
export function tokenFrom(email, page = "verify-email") {
  const match = email?.text.match(new RegExp(`/${page}\\?token=([^\\s]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

/** Registers, verifies through the e-mailed link and returns a logged-in client. */
export async function signUp(srv, { email, displayName = "Tester", password = PASSWORD } = {}) {
  const client = srv.client();
  const reg = await client.post("/api/auth/register", { email, password, displayName, acceptPrivacy: true });
  if (reg.status !== 201) throw new Error(`register failed: ${reg.status} ${reg.text}`);
  const token = tokenFrom(lastEmail(srv.mailer, email.toLowerCase(), /confirm|confirme/i));
  const verified = await client.post("/api/auth/verify-email", { token, password });
  if (verified.status !== 200) throw new Error(`verify failed: ${verified.status} ${verified.text}`);
  return client;
}

/** Adds a video straight through the service (title given, no lookup). */
export function addVideo(srv, n, title, overrides = {}) {
  return srv.services.videos.add({ url: vid(n), title, overrides });
}

/** A verified account with a live session, without scrypt (fast). */
export function quickUser(srv, email, role = "user") {
  const { users, rotateSession } = srv.services.auth;
  const at = new Date().toISOString();
  const id = users.createUser({ email, displayName: "Quick", passwordHash: "x", now: at });
  users.markVerified(id, at);
  if (role !== "user") users.setRole(id, role);
  const client = srv.client();
  client.cookie = `sid=${rotateSession(id, null)}`;
  return { id, client };
}

/**
 * Every derived table equals a fresh aggregation in which trashed rows count as
 * "not there": series_stats (live published videos of live series, their
 * ratings), rating_totals (ratings of live videos). video_rating_stats and
 * rating_activity are per video and keep a trashed video's ratings until purge.
 */
export function assertFresh(db, step) {
  assert.deepEqual(
    db.prepare("SELECT * FROM series_stats ORDER BY series_id, section").all(),
    db
      .prepare(`
        SELECT v.series_id, v.section, COUNT(*) AS video_count, MAX(v.published_at) AS latest_published_at,
          (SELECT COUNT(*) FROM ratings r JOIN videos v2 ON v2.id = r.video_id
            WHERE v2.series_id = v.series_id AND v2.section = v.section AND v2.status = 'published'
              AND v2.deleted_at IS NULL) AS rating_n,
          (SELECT COALESCE(SUM(r.score), 0) FROM ratings r JOIN videos v2 ON v2.id = r.video_id
            WHERE v2.series_id = v.series_id AND v2.section = v.section AND v2.status = 'published'
              AND v2.deleted_at IS NULL) AS rating_sum
        FROM videos v JOIN series s ON s.id = v.series_id
        WHERE v.status = 'published' AND v.deleted_at IS NULL AND s.deleted_at IS NULL AND v.section IS NOT NULL
        GROUP BY v.series_id, v.section ORDER BY v.series_id, v.section`)
      .all(),
    `${step}: series_stats`
  );
  assert.deepEqual(
    db.prepare("SELECT n, total FROM rating_totals").get(),
    db
      .prepare(`
        SELECT COUNT(*) AS n, COALESCE(SUM(r.score), 0) AS total
        FROM ratings r JOIN videos v ON v.id = r.video_id WHERE v.deleted_at IS NULL`)
      .get(),
    `${step}: rating_totals (live videos only)`
  );
  assert.deepEqual(
    db.prepare("SELECT video_id, n, total FROM video_rating_stats ORDER BY video_id").all(),
    db.prepare("SELECT video_id, COUNT(*) AS n, SUM(score) AS total FROM ratings GROUP BY video_id ORDER BY video_id").all(),
    `${step}: video_rating_stats`
  );
  assert.deepEqual(
    db.prepare("SELECT video_id, day, count, score_sum FROM rating_activity WHERE count > 0 ORDER BY video_id, day").all(),
    db
      .prepare(`
        SELECT video_id, substr(updated_at, 1, 10) AS day, COUNT(*) AS count, SUM(score) AS score_sum
        FROM ratings GROUP BY video_id, day ORDER BY video_id, day`)
      .all(),
    `${step}: rating_activity`
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM videos v JOIN series s ON s.id = v.series_id WHERE v.deleted_at IS NULL AND s.deleted_at IS NOT NULL").get().n,
    0,
    `${step}: no live video in a trashed series`
  );
}
