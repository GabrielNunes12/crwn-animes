// v1.6: GET /api/admin/metrics — anonymous aggregates only (catalog counts, the
// pending queue, site-wide and per-day ratings, top series, the image cache).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { openDatabase } from "../src/db.js";
import { METRICS_DAYS, PENDING_REASONS, createMetricsService } from "../src/metricsService.js";
import { createRatingService } from "../src/ratingService.js";
import { createRepository } from "../src/repository.js";
import { purgeExpired, purgeTrash } from "../src/retention.js";
import { createTrashService } from "../src/trashService.js";
import { createVideoService } from "../src/videoService.js";
import { addVideo, assertFresh, fakeJpeg, quickUser, startServer, vid } from "./helpers.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const round1 = (x) => Math.round(x * 10) / 10;
/** "YYYY-MM-DD HH:MM:SS", what SQLite's datetime('now') stores in created_at. */
const sqliteTime = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
const BROKEN_THUMB = vid(23);

/**
 * Top 1..12: one published anime video each (Top 1..3 also a manga one), rated by
 * 3–6 users over the last days (Top 11 and 12: only two 5-star ratings, below n >= 3);
 * Top 5 also has a rated video in the trash; Top 12's anime video is unavailable.
 * Pending: P1 (no section, series or number), P2 (no series), P3 (slot of Top 1 taken),
 * P4 (complete, slot freed when Spare's video went to the trash), P5 (Top 3, only a bare
 * number), P6 (bare number, no series: its admin-picked series Gone is in the trash).
 * Series Gone is in the trash with its three videos.
 */
async function seedMetrics(srv) {
  const { repo, trash } = srv.services;
  let clock = Date.now();
  const ratings = createRatingService({ db: srv.db, now: () => new Date(clock) });
  const users = Array.from({ length: 6 }, (_, i) => quickUser(srv, `rater${i}@example.com`).id);
  const put = (n, slug, section, number, title = `clip ${n}`) => addVideo(srv, n, title, { section, seriesSlug: slug, number });
  const rate = (u, video, score) => {
    clock = Date.now() - u * DAY - 60_000;
    ratings.set(users[u], video.id, { score, reaction: null });
  };
  for (let i = 1; i <= 12; i++) {
    repo.createSeries({ slug: `top-${i}`, name: `Top ${i}` });
    const anime = await put(i, `top-${i}`, "anime", 1);
    const n = i <= 10 ? 3 + (i % 4) : 2;
    for (let u = 0; u < n; u++) rate(u, anime, i > 10 ? 5 : ((i * 3 + u * 2) % 5) + 1);
    if (i <= 3) {
      const manga = await put(20 + i, `top-${i}`, "manga", 1);
      for (let u = 0; u < 3 + i; u++) rate(u, manga, ((i + u) % 5) + 1);
    }
  }
  const trashedRated = await put(30, "top-5", "anime", 2);
  for (let u = 0; u < 3; u++) rate(u, trashedRated, 1);
  trash.trashVideo(trashedRated.id);
  repo.setAvailability(repo.getVideoByYoutubeId(vid(12)).id, "unavailable");

  repo.createSeries({ slug: "spare", name: "Spare" });
  const spare = await put(50, "spare", "anime", 1);
  const p1 = await addVideo(srv, 40, "an upload naming nothing");
  const p2 = await addVideo(srv, 41, "anime episode 3 of something unknown");
  const p3 = await put(42, "top-1", "anime", 1);
  const p4 = await put(43, "spare", "anime", 1);
  const p5 = await addVideo(srv, 44, "Top 3 anime clip 12");
  const p6 = await addVideo(srv, 45, "anime random clip 42");
  for (const p of [p1, p2, p3, p4, p5, p6]) assert.equal(p.status, "pending");
  assert.equal(p5.classification.suggestedNumber, 12);
  assert.ok(p5.seriesId);
  trash.trashVideo(spare.id);
  const now = Date.now();
  const setCreated = srv.db.prepare("UPDATE videos SET created_at = ? WHERE id = ?");
  [p1, p2, p3, p4, p5, p6].forEach((p, i) => setCreated.run(sqliteTime(now - (60 - 10 * i) * HOUR), p.id));

  repo.createSeries({ slug: "gone", name: "Gone" });
  await put(60, "gone", "anime", 1);
  await put(61, "gone", "manga", 1);
  const unavailableTrashed = await put(62, "gone", "anime", 2);
  repo.setAvailability(unavailableTrashed.id, "unavailable");
  trash.trashSeries(repo.getSeries("gone").id);
  // P6's admin-picked series is in the trash. The API never stores that (an add or patch naming a
  // trashed series is a 400) but older data or a video restored on its own can carry it.
  srv.db.prepare("UPDATE videos SET overrides = ? WHERE id = ?").run(JSON.stringify({ seriesSlug: "gone" }), p6.id);
  return { users, ratings, p1, p2, p3, p4, p5, p6 };
}

/** The metrics as fresh recounts over the raw tables (videos, series, ratings). */
function expected(db) {
  const count = (sql, ...args) => db.prepare(sql).pluck().get(...args);
  const section = (name) =>
    db
      .prepare(`
        SELECT COUNT(DISTINCT v.series_id) AS series, COUNT(*) AS videos
        FROM videos v JOIN series s ON s.id = v.series_id
        WHERE v.status = 'published' AND v.deleted_at IS NULL AND s.deleted_at IS NULL AND v.section = ?`)
      .get(name);
  const live = db.prepare("SELECT COUNT(*) AS n, SUM(r.score) AS sum FROM ratings r JOIN videos v ON v.id = r.video_id WHERE v.deleted_at IS NULL").get();
  const m = live.n ? live.sum / live.n : 0;
  const top = db
    .prepare(`
      SELECT s.id, s.name, s.slug, v.section, COUNT(*) AS n, SUM(r.score) AS sum
      FROM ratings r JOIN videos v ON v.id = r.video_id JOIN series s ON s.id = v.series_id
      WHERE v.status = 'published' AND v.deleted_at IS NULL AND s.deleted_at IS NULL
      GROUP BY s.id, v.section`)
    .all()
    .filter((r) => r.n >= 3)
    .map((r) => ({ ...r, bayes: (5 * m + r.sum) / (5 + r.n) }))
    .sort(
      (a, b) =>
        b.bayes - a.bayes || b.n - a.n || (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0) ||
        a.section.localeCompare(b.section) || a.id - b.id
    )
    .slice(0, 10)
    .map((r) => ({ id: r.id, name: r.name, slug: r.slug, section: r.section, ratingCount: r.n, average: round1(r.sum / r.n) }));
  return {
    catalog: {
      series: count("SELECT COUNT(*) FROM series WHERE deleted_at IS NULL"),
      anime: section("anime"),
      manga: section("manga"),
      pending: count("SELECT COUNT(*) FROM videos WHERE status = 'pending' AND deleted_at IS NULL"),
      unavailable: count("SELECT COUNT(*) FROM videos WHERE availability = 'unavailable' AND deleted_at IS NULL"),
      trashed: {
        series: count("SELECT COUNT(*) FROM series WHERE deleted_at IS NOT NULL"),
        videos: count("SELECT COUNT(*) FROM videos WHERE deleted_at IS NOT NULL"),
      },
    },
    ratings: { total: live.n, average: live.n ? round1(m) : null },
    // Per day, every rating of a video that is not purged (rating_activity keeps trashed videos' until the purge).
    perDay: new Map(
      db
        .prepare("SELECT substr(updated_at, 1, 10) AS day, COUNT(*) AS n, SUM(score) AS sum FROM ratings GROUP BY day")
        .all()
        .map((r) => [r.day, r])
    ),
    topSeries: top,
  };
}

const metricsUrl = (days) => `/api/admin/metrics${days === undefined ? "" : `?days=${days}`}`;

describe("GET /api/admin/metrics", () => {
  let srv;
  let admin;
  let seeded;
  before(async () => {
    srv = await startServer({
      fetchThumbnail: async (id) => {
        if (id === BROKEN_THUMB) throw new Error("upstream down");
        return fakeJpeg(id);
      },
    });
    admin = quickUser(srv, "admin@example.com", "admin").client;
    seeded = await seedMetrics(srv);
  });
  after(() => srv.close());

  test("401 logged out, 403 for non-admins; never cached (private, no-store), errors included", async () => {
    const anonymous = await srv.client().get(metricsUrl());
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers.get("cache-control"), "private, no-store");
    const user = await quickUser(srv, "plain@example.com").client.get(metricsUrl());
    assert.equal(user.status, 403);
    const ok = await admin.get(metricsUrl());
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("cache-control"), "private, no-store");
    const bad = await admin.get(metricsUrl(6));
    assert.equal(bad.headers.get("cache-control"), "private, no-store");
  });

  test("days: 7–90, default 30; anything else is a 400 VALIDATION_ERROR on days", async () => {
    for (const days of ["6", "91", "0", "-7", "abc", "7.5", "1e1", "30d", " 3", "1000000000000000000000"]) {
      const res = await admin.get(`/api/admin/metrics?days=${encodeURIComponent(days)}`);
      assert.equal(res.status, 400, days);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
      assert.deepEqual(Object.keys(res.body.error.details), ["days"], days);
    }
    const twice = await admin.get("/api/admin/metrics?days=7&days=8");
    assert.equal(twice.status, 400);
    for (const [query, length] of [["", 30], ["?days=", 30], ["?days=7", 7], ["?days=90", 90], ["?days=45", 45], ["?days=007", 7]]) {
      const res = await admin.get(`/api/admin/metrics${query}`);
      assert.equal(res.status, 200, query);
      assert.equal(res.body.ratings.daily.length, length, query);
    }
    assert.deepEqual(METRICS_DAYS, { min: 7, max: 90, fallback: 30 });
  });

  test("exactly the contract's shape, every number equal to a fresh recount", async () => {
    // Two thumbnails cached, one failure remembered (images are fetched through /api/thumbs).
    for (const n of [1, 2]) assert.equal((await srv.client().get(`/api/thumbs/${vid(n)}.jpg`)).status, 200);
    assert.equal((await srv.client().get(`/api/thumbs/${BROKEN_THUMB}.jpg`)).status, 502);

    const res = await admin.get(metricsUrl(30));
    assert.equal(res.status, 200);
    const body = res.body;
    assert.deepEqual(Object.keys(body), ["generatedAt", "catalog", "pendingQueue", "ratings", "topSeries", "thumbnails"]);
    assert.deepEqual(Object.keys(body.catalog), ["series", "anime", "manga", "pending", "unavailable", "trashed"]);
    assert.deepEqual(Object.keys(body.pendingQueue), ["count", "oldestAt", "medianAgeHours", "byReason"]);
    assert.deepEqual(Object.keys(body.ratings), ["total", "average", "daily"]);
    assert.deepEqual(Object.keys(body.thumbnails), ["cachedFiles", "cachedBytes", "failuresRemembered"]);
    assert.ok(Math.abs(Date.parse(body.generatedAt) - Date.now()) < 60_000);
    assert.equal(new Date(body.generatedAt).toISOString(), body.generatedAt);

    const want = expected(srv.db);
    assert.deepEqual(body.catalog, want.catalog);
    // The seed in numbers: 7 seeded + Top 1..12 + Spare live; Gone in the trash.
    assert.deepEqual(body.catalog, {
      series: 20,
      anime: { series: 12, videos: 12 },
      manga: { series: 3, videos: 3 },
      pending: 6,
      unavailable: 1,
      trashed: { series: 1, videos: 5 },
    });

    assert.equal(body.ratings.total, want.ratings.total);
    assert.equal(body.ratings.average, want.ratings.average);
    assert.ok(body.ratings.total > 0);

    assert.deepEqual(body.topSeries, want.topSeries);
    assert.equal(body.topSeries.length, 10, "13 (series, section) pairs qualify: the top 10");
    assert.ok(body.topSeries.every((s) => s.ratingCount >= 3));
    assert.ok(!body.topSeries.some((s) => ["top-11", "top-12"].includes(s.slug)), "5 stars from two ratings is not enough");
    for (const s of body.topSeries) assert.deepEqual(Object.keys(s), ["id", "name", "slug", "section", "ratingCount", "average"]);

    assert.deepEqual(body.thumbnails, { cachedFiles: 2, cachedBytes: fakeJpeg(vid(1)).length + fakeJpeg(vid(2)).length, failuresRemembered: 1 });
  });

  test("ratings.daily: the last `days` UTC days, oldest first, every day present (0 / null when quiet)", async () => {
    const want = expected(srv.db);
    for (const days of [7, 30, 90]) {
      const { body } = await admin.get(metricsUrl(days));
      const { daily } = body.ratings;
      assert.equal(daily.length, days);
      assert.equal(daily.at(-1).day, body.generatedAt.slice(0, 10), "ends today (UTC)");
      for (let i = 1; i < daily.length; i++) {
        assert.equal(Date.parse(daily[i].day) - Date.parse(daily[i - 1].day), DAY, "consecutive days");
      }
      for (const { day, count, average } of daily) {
        assert.deepEqual(Object.keys(daily[0]), ["day", "count", "average"]);
        const row = want.perDay.get(day);
        assert.equal(count, row?.n ?? 0, day);
        assert.equal(average, row ? round1(row.sum / row.n) : null, day);
      }
      assert.equal(daily.filter((d) => d.count > 0).length, Math.min(6, days), "six raters, one day each");
    }
  });

  test("pendingQueue: count, oldest, median age (hours) and why, per reason", async () => {
    const { body } = await admin.get(metricsUrl());
    const q = body.pendingQueue;
    assert.equal(q.count, 6);
    const created = (p) => srv.db.prepare("SELECT created_at FROM videos WHERE id = ?").pluck().get(p.id);
    assert.equal(q.oldestAt, `${created(seeded.p1).replace(" ", "T")}.000Z`);
    // Ages 60, 50, 40, 30, 20, 10 hours: the median is the mean of the middle two.
    const age = (p) => (Date.parse(body.generatedAt) - Date.parse(`${created(p).replace(" ", "T")}Z`)) / HOUR;
    assert.equal(q.medianAgeHours, round1((age(seeded.p3) + age(seeded.p4)) / 2));
    assert.equal(q.medianAgeHours, 35);
    // Most frequent first, ties in PENDING_REASONS order; `key` stable, `reason` the English text.
    const text = Object.fromEntries(PENDING_REASONS.map((r) => [r.key, r.reason]));
    assert.deepEqual(
      q.byReason,
      [
        ["no-series", 2], // P1, P2
        ["guessed-number", 2], // P5, P6
        ["no-section", 1], // P1
        ["series-trashed", 1], // P6
        ["no-number", 1], // P1
        ["slot-taken", 1], // P3
        ["ready", 1], // P4
      ].map(([key, count]) => ({ key, reason: text[key], count }))
    );
    for (const r of q.byReason) assert.deepEqual(Object.keys(r), ["key", "reason", "count"]);
  });

  test("pending reasons: the documented stable keys", () => {
    assert.deepEqual(
      PENDING_REASONS.map((r) => r.key),
      ["no-section", "no-series", "series-trashed", "no-number", "guessed-number", "slot-taken", "ready"]
    );
    for (const { key, reason } of PENDING_REASONS) {
      assert.match(key, /^[a-z0-9-]+$/);
      assert.ok(reason.length > 0);
    }
  });

  test("an empty catalog: zeros, nulls and empty lists", async () => {
    const empty = await startServer();
    try {
      const { client } = quickUser(empty, "admin@example.com", "admin");
      const { body } = await client.get(metricsUrl(7));
      assert.deepEqual(body.catalog, {
        series: 7,
        anime: { series: 0, videos: 0 },
        manga: { series: 0, videos: 0 },
        pending: 0,
        unavailable: 0,
        trashed: { series: 0, videos: 0 },
      });
      assert.deepEqual(body.pendingQueue, { count: 0, oldestAt: null, medianAgeHours: null, byReason: [] });
      assert.equal(body.ratings.total, 0);
      assert.equal(body.ratings.average, null);
      assert.deepEqual(body.ratings.daily.map((d) => [d.count, d.average]), Array(7).fill([0, null]));
      assert.deepEqual(body.topSeries, []);
      assert.deepEqual(body.thumbnails, { cachedFiles: 0, cachedBytes: 0, failuresRemembered: 0 });
    } finally {
      await empty.close();
    }
  });
});

// ===================================================================== privacy
describe("the metrics read anonymous aggregates only", () => {
  test("no statement it runs reads users, sessions, email_tokens or the ratings rows (SQL text and EXPLAIN)", async () => {
    const db = openDatabase(":memory:");
    try {
      // Every statement prepared from here on records what it executes while `recording` is on.
      const executed = [];
      let recording = false;
      const prepare = db.prepare.bind(db);
      db.prepare = (sql) => {
        const stmt = prepare(sql);
        for (const method of ["get", "all", "run", "iterate"]) {
          const real = stmt[method].bind(stmt);
          stmt[method] = (...args) => {
            if (recording) executed.push({ sql, args });
            return real(...args);
          };
        }
        return stmt;
      };
      for (const method of ["exec", "pragma"]) {
        const real = db[method].bind(db);
        db[method] = (...args) => {
          if (recording) executed.push({ sql: String(args[0]), args: null });
          return real(...args);
        };
      }
      const repo = createRepository(db);
      const videos = createVideoService({ repo, fetchVideoInfo: async () => ({ title: "t" }) });
      const trash = createTrashService({ db, repo, videos });
      const metrics = createMetricsService({
        db,
        repo,
        images: { stats: () => ({ files: 3, bytes: 300, thumbnails: { failures: 1 }, covers: { failures: 2 } }) },
      });

      // Data for every branch: rated series, pending videos of every kind, the trash.
      repo.createSeries({ slug: "audit", name: "Audit" });
      const user = Number(
        db.prepare("INSERT INTO users (email, display_name, password_hash, privacy_accepted_at, created_at) VALUES ('a@b.c', 'A', 'x', 'n', 'n')").run().lastInsertRowid
      );
      db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ('h', ?, '2999-01-01')").run(user);
      const ratings = createRatingService({ db });
      const one = await videos.add({ url: vid(1), title: "x", overrides: { section: "anime", seriesSlug: "audit", number: 1 } });
      ratings.set(user, one.id, { score: 4 });
      await videos.add({ url: vid(2), title: "x", overrides: { section: "anime", seriesSlug: "audit", number: 1 } });
      await videos.add({ url: vid(3), title: "nothing here" });
      trash.trashVideo((await videos.add({ url: vid(4), title: "x", overrides: { section: "anime", seriesSlug: "audit", number: 4 } })).id);

      recording = true;
      const result = metrics.get({ days: 90 });
      recording = false;
      assert.equal(result.catalog.pending, 2);
      assert.equal(result.ratings.total, 1);
      assert.deepEqual(result.thumbnails, { cachedFiles: 3, cachedBytes: 300, failuresRemembered: 3 });

      assert.ok(executed.length >= 9, `recorded ${executed.length} statements`);
      const forbidden = /\b(users|sessions|email_tokens|ratings)\b/i;
      for (const { sql } of executed) assert.doesNotMatch(sql, forbidden, sql);

      // What SQLite actually opens (views, triggers or a rename could hide a table from the text).
      const tableOfRoot = new Map(db.prepare("SELECT rootpage, tbl_name FROM sqlite_master WHERE rootpage > 0").raw().all());
      tableOfRoot.set(1, "sqlite_master");
      const opened = new Set();
      for (const { sql, args } of executed) {
        assert.ok(args, `only prepared statements, no exec/pragma: ${sql}`);
        for (const op of prepare(`EXPLAIN ${sql}`).all(...args)) {
          if (op.opcode === "OpenRead" || op.opcode === "OpenWrite") opened.add(tableOfRoot.get(op.p2) ?? `root ${op.p2}`);
        }
      }
      assert.deepEqual([...opened].sort(), ["rating_days", "rating_totals", "series", "series_stats", "videos"]);
      assert.ok(!executed.some(({ sql }) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)), "read-only");
    } finally {
      db.close();
    }
  });
});

// ===================================================================== rating_days
/** rating_days = SUM(rating_activity) per day (assertFresh also ties rating_activity to the ratings, which retention breaks on purpose). */
function assertDays(db, step) {
  assert.deepEqual(
    db.prepare("SELECT day, count, score_sum FROM rating_days ORDER BY day").all(),
    db
      .prepare(`
        SELECT day, SUM(count) AS count, SUM(score_sum) AS score_sum FROM rating_activity
        GROUP BY day HAVING SUM(count) <> 0 OR SUM(score_sum) <> 0 ORDER BY day`)
      .all(),
    step
  );
}

describe("rating_days (migration 15) is rating_activity summed per day, whoever writes", () => {
  test("re-rating on another day, removing, account deletion, retention, trash purge", async () => {
    const srv = await startServer();
    try {
      const { db } = srv;
      const { repo, trash, auth, metrics } = srv.services;
      let clock = Date.now() - 100 * DAY; // past the 90 days rating_activity is kept
      const ratings = createRatingService({ db, now: () => new Date(clock) });
      repo.createSeries({ slug: "days", name: "Days" });
      const v1 = await addVideo(srv, 1, "x", { section: "anime", seriesSlug: "days", number: 1 });
      const v2 = await addVideo(srv, 2, "x", { section: "anime", seriesSlug: "days", number: 2 });
      const users = [0, 1, 2].map((i) => quickUser(srv, `d${i}@example.com`).id);
      for (const u of users) ratings.set(u, v1.id, { score: 2 });
      assertFresh(db, "three ratings 100 days ago");
      clock = Date.now();
      ratings.set(users[0], v1.id, { score: 5 }); // moves from 100 days ago to today
      ratings.set(users[1], v2.id, { score: 3 });
      assertFresh(db, "re-rated today");
      const today = metrics.get({ days: 7 }).ratings.daily.at(-1);
      assert.deepEqual(today, { day: new Date().toISOString().slice(0, 10), count: 2, average: 4 });
      ratings.remove(users[1], v2.id);
      assertFresh(db, "removed");
      ratings.removeAllForUser(users[2]);
      auth.users.deleteUser(users[2]);
      assertFresh(db, "account deleted");
      const before90 = new Date(Date.now() - 90 * DAY).toISOString().slice(0, 10);
      assert.equal(db.prepare("SELECT COUNT(*) FROM rating_days WHERE day < ?").pluck().get(before90), 1);
      // 60 days old: kept by the retention job (90 days since v1.6) and shown by ?days=90.
      clock = Date.now() - 60 * DAY;
      ratings.set(users[1], v2.id, { score: 1 });
      assert.equal(purgeExpired(db).ratingActivity, 1);
      assert.equal(db.prepare("SELECT COUNT(*) FROM rating_days WHERE day < ?").pluck().get(before90), 0, "retention");
      const quarter = metrics.get({ days: 90 }).ratings.daily;
      assert.deepEqual(quarter.find((d) => d.day === new Date(clock).toISOString().slice(0, 10)), { day: new Date(clock).toISOString().slice(0, 10), count: 1, average: 1 });
      ratings.remove(users[1], v2.id);
      assertDays(db, "activity older than 30 days purged");
      trash.trashVideo(v1.id);
      assertDays(db, "trashed: its activity stays until the purge");
      assert.equal(metrics.get({ days: 7 }).ratings.daily.at(-1).count, 1);
      purgeTrash(db, new Date(Date.now() + 8 * DAY));
      assertDays(db, "purged with the video (FK cascade)");
      assert.equal(db.prepare("SELECT COUNT(*) FROM rating_days").pluck().get(), 0);
      assert.equal(metrics.get({ days: 7 }).ratings.daily.at(-1).count, 0);
    } finally {
      await srv.close();
    }
  });
});
