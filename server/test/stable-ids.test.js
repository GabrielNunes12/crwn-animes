// v1.6: ids are never reused. Migration 14 rebuilds series and videos as
// INTEGER PRIMARY KEY AUTOINCREMENT, keeping every row, id, index, trigger,
// foreign key and aggregate; afterwards a deleted id is never handed out again.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { SCHEMA_VERSION, openDatabase } from "../src/db.js";
import { createRatingService } from "../src/ratingService.js";
import { createRepository } from "../src/repository.js";
import { purgeTrash } from "../src/retention.js";
import { createTrashService } from "../src/trashService.js";
import { createVideoService } from "../src/videoService.js";
import { assertFresh, quickUser, startServer, vid } from "./helpers.js";

const DAY = 86_400_000;

function services(db, now = () => new Date()) {
  const repo = createRepository(db);
  const videos = createVideoService({ repo, fetchVideoInfo: async () => ({ title: "t", channel: null }) });
  return { repo, videos, trash: createTrashService({ db, repo, videos, now }) };
}

/** Every row of every table (order-free), and the schema as SQLite reports it. */
function snapshot(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").pluck().all();
  const data = {};
  const schema = {};
  for (const t of tables) {
    data[t] = db.prepare(`SELECT * FROM "${t}"`).all().map((row) => JSON.stringify(row)).sort();
    schema[t] = {
      columns: db.pragma(`table_xinfo("${t}")`),
      foreignKeys: db.pragma(`foreign_key_list("${t}")`),
      indexes: db
        .pragma(`index_list("${t}")`)
        .map(({ seq, ...index }) => ({ ...index, columns: db.pragma(`index_xinfo("${index.name}")`) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
  const objects = Object.fromEntries(
    db
      .prepare("SELECT type || ' ' || name AS k, tbl_name, sql FROM sqlite_master WHERE type IN ('index', 'trigger', 'view') ORDER BY k")
      .all()
      .map((o) => [o.k, { table: o.tbl_name, sql: o.sql }])
  );
  return { tables, data, schema, objects };
}

const rowsOf = (db, sql, ...args) => db.prepare(sql).all(...args);

describe("migration 14: series and videos become AUTOINCREMENT", () => {
  test("a v13 database with data: same rows, ids, indexes, triggers, foreign keys and aggregates; triggers still fire; ids never come back", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crwn-m14-"));
    const file = path.join(dir, "old.db");
    try {
      // ---- a v13 database, filled through the real services ----
      const old = openDatabase(file, { seedCatalog: false, migrateTo: 13 });
      let clock = Date.now() - 5 * DAY;
      const { repo, videos, trash } = services(old, () => new Date(clock));
      const alpha = repo.createSeries({ slug: "alpha", name: "Alpha", aliases: ["Arufa"], genres: ["Ação"] });
      const beta = repo.createSeries({ slug: "beta", name: "Beta", coverSourceUrl: "https://img.example/beta.png" });
      const gamma = repo.createSeries({ slug: "gamma", name: "Gamma" });
      const put = (n, slug, section, number, season = 1) =>
        videos.add({ url: vid(n), title: `clip ${n}`, overrides: { section, seriesSlug: slug, number, season } });
      const a1 = await put(1, "alpha", "anime", 1);
      const a2 = await put(2, "alpha", "anime", 2);
      const a3 = await put(3, "alpha", "manga", 1);
      const a4 = await put(4, "alpha", "anime", 1, 2);
      const b1 = await put(5, "beta", "anime", 1);
      const b2 = await put(6, "beta", "anime", 2);
      const g1 = await put(7, "gamma", "anime", 1);
      const t1 = await put(8, "alpha", "anime", 3);
      const p1 = await videos.add({ url: vid(9), title: "no series named here" });
      const p2 = await put(10, "alpha", "anime", 1); // slot taken by a1
      assert.equal(p1.status, "pending");
      assert.equal(p2.status, "pending");
      repo.setAvailability(g1.id, "unavailable");

      const insertUser = old.prepare(`INSERT INTO users (email, display_name, password_hash, privacy_accepted_at, created_at, session_epoch)
        VALUES (?, 'U', 'x', '2026-01-01', '2026-01-01', 2)`);
      const users = [1, 2, 3, 4].map((u) => Number(insertUser.run(`u${u}@example.com`).lastInsertRowid));
      old.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, epoch) VALUES ('h1', ?, '2999-01-01T00:00:00.000Z', 2)").run(users[0]);
      old.prepare("INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at) VALUES ('e1', ?, 'reset', '2999-01-01')").run(users[1]);
      const ratings = createRatingService({ db: old, now: () => new Date(clock) });
      for (const [u, user] of users.entries()) {
        for (const video of [a1, a2, a3, a4, b1, b2, g1, t1]) ratings.set(user, video.id, { score: 1 + ((u + video.id) % 5), reaction: "wow" });
        clock += DAY;
      }
      trash.trashVideo(t1.id);
      trash.trashSeries(beta.id);
      old.exec("ANALYZE");
      assertFresh(old, "v13 before the migration");
      const before = snapshot(old);
      const maxVideo = old.prepare("SELECT MAX(id) FROM videos").pluck().get();
      const maxSeries = old.prepare("SELECT MAX(id) FROM series").pluck().get();
      assert.match(old.prepare("SELECT sql FROM sqlite_master WHERE name = 'videos'").pluck().get(), /^((?!AUTOINCREMENT).)*$/s);
      old.close();

      // ---- migrate ----
      const db = openDatabase(file);
      try {
        assert.equal(db.pragma("user_version", { simple: true }), SCHEMA_VERSION);
        for (const t of ["series", "videos"]) {
          assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").pluck().get(t), /id\s+INTEGER PRIMARY KEY AUTOINCREMENT/, t);
        }
        const after = snapshot(db);
        assert.deepEqual(db.pragma("foreign_key_check"), []);
        assert.equal(db.pragma("integrity_check", { simple: true }), "ok");

        // Every row of every table that existed is there, byte for byte (ids, aggregates, users, sessions, tokens).
        for (const t of before.tables) assert.deepEqual(after.data[t], before.data[t], `rows of ${t}`);
        assert.deepEqual(after.tables.filter((t) => !before.tables.includes(t)), ["rating_days"], "only migration 15's table is new");
        // Columns, foreign keys (ratings / rating_activity / video_rating_stats -> videos, videos -> series, ...) and
        // indexes (unique, partial, covering) of every table, as SQLite reports them.
        const withoutV15 = ({ indexes, ...rest }) => ({ ...rest, indexes: indexes.filter((i) => i.name !== "videos_unavailable") });
        for (const t of before.tables) assert.deepEqual(withoutV15(after.schema[t]), before.schema[t], `schema of ${t}`);
        assert.deepEqual(
          after.schema.ratings.foreignKeys.map((fk) => [fk.table, fk.from, fk.on_delete]).sort(),
          [["users", "user_id", "CASCADE"], ["videos", "video_id", "CASCADE"]]
        );
        assert.deepEqual(after.schema.videos.foreignKeys.map((fk) => [fk.table, fk.from, fk.on_delete]), [["series", "series_id", "CASCADE"]]);
        // Every index and trigger, with the same SQL and on the same table; migration 15 adds its own.
        for (const [key, value] of Object.entries(before.objects)) assert.deepEqual(after.objects[key], value, key);
        assert.deepEqual(
          Object.keys(after.objects).filter((k) => !(k in before.objects)).sort(),
          ["index videos_unavailable", "trigger rating_days_delete", "trigger rating_days_insert", "trigger rating_days_update"]
        );
        for (const name of ["videos_published_slot", "videos_status", "videos_created", "videos_status_created", "series_name"]) {
          assert.match(after.objects[`index ${name}`].sql, /WHERE .*deleted_at IS NULL/, name);
        }
        assert.deepEqual(rowsOf(db, "SELECT name, seq FROM sqlite_sequence ORDER BY name"), [
          { name: "series", seq: maxSeries },
          { name: "videos", seq: maxVideo },
        ]);
        assert.ok(db.prepare("SELECT COUNT(*) FROM sqlite_stat1 WHERE tbl IN ('series', 'videos')").pluck().get() > 0, "statistics rebuilt");
        assertFresh(db, "right after the migration");
        // migration 15 filled rating_days from rating_activity (checked by assertFresh): 4 days of activity
        assert.equal(db.prepare("SELECT COUNT(*) FROM rating_days").pluck().get(), 4);

        // ---- every trigger still fires ----
        const s = services(db);
        const live = createRatingService({ db });
        const version = () => db.prepare("SELECT version FROM catalog_version").pluck().get();
        const seriesVersion = () => db.prepare("SELECT version FROM series_version").pluck().get();
        const totals = () => db.prepare("SELECT n, total FROM rating_totals").get();
        live.set(users[0], a2.id, { score: 5, reaction: null });
        assertFresh(db, "rated after the migration");
        const v0 = version();
        const t0 = totals();
        s.trash.trashVideo(a1.id);
        assert.ok(version() > v0, "catalog_version bumped");
        assert.ok(totals().n < t0.n, "a1's ratings left the totals");
        assertFresh(db, "a1 trashed");
        s.trash.restoreVideo(a1.id);
        assert.deepEqual(totals(), t0);
        assertFresh(db, "a1 restored");
        const restored = s.trash.restoreSeries(beta.id);
        assert.deepEqual(restored.published.map((v) => v.id).sort(), [b1.id, b2.id].sort());
        assert.equal(db.prepare("SELECT COUNT(*) FROM series_stats WHERE series_id = ?").pluck().get(beta.id), 1);
        assertFresh(db, "series beta restored");
        s.trash.trashSeries(gamma.id);
        assert.equal(db.prepare("SELECT COUNT(*) FROM series_stats WHERE series_id = ?").pluck().get(gamma.id), 0);
        assertFresh(db, "series gamma trashed");
        assert.deepEqual(purgeTrash(db, new Date(Date.now() + 8 * DAY)), { series: 1, videos: 1 }); // gamma (+ g1), t1
        for (const v of [g1, t1]) {
          assert.equal(db.prepare("SELECT COUNT(*) FROM ratings WHERE video_id = ?").pluck().get(v.id), 0, "ratings cascade from the new videos table");
          assert.equal(db.prepare("SELECT COUNT(*) FROM video_rating_stats WHERE video_id = ?").pluck().get(v.id), 0);
          assert.equal(db.prepare("SELECT COUNT(*) FROM rating_activity WHERE video_id = ?").pluck().get(v.id), 0);
        }
        assertFresh(db, "purged");
        const sv0 = seriesVersion();
        s.repo.createSeries({ slug: "delta", name: "Delta" });
        assert.ok(seriesVersion() > sv0, "series_version bumped");
        assert.equal(p2.id, maxVideo, "the newest video was p2");

        // ---- deleted ids never come back ----
        // The newest video goes for good (trash + delete forever), then a new one: a NEW id.
        s.trash.trashVideo(p2.id);
        s.trash.deleteVideoForever(p2.id);
        const next = await s.videos.add({ url: vid(50), title: "another upload naming no series" });
        assert.equal(next.id, maxVideo + 1);
        // A hard delete of the newest one, then another insert.
        assert.ok(s.repo.deleteVideo(next.id));
        const after2 = await s.videos.add({ url: vid(51), title: "yet another upload" });
        assert.equal(after2.id, maxVideo + 2);
        // Series: the newest one (delta) deleted forever, then a new one.
        const delta = s.repo.getSeries("delta");
        assert.equal(delta.id, maxSeries + 1);
        s.trash.trashSeries(delta.id);
        s.trash.deleteSeriesForever(delta.id);
        assert.equal(s.repo.createSeries({ slug: "delta", name: "Delta" }).id, maxSeries + 2);
        // The 7-day purge too.
        const epsilon = s.repo.createSeries({ slug: "epsilon", name: "Epsilon" });
        s.trash.trashSeries(epsilon.id);
        purgeTrash(db, new Date(Date.now() + 8 * DAY));
        assert.equal(s.repo.createSeries({ slug: "zeta", name: "Zeta" }).id, epsilon.id + 1);
        assertFresh(db, "after the id checks");

        s.repo.deleteSeries(alpha.id); // hard delete: videos and their ratings cascade
        assert.equal(db.prepare("SELECT COUNT(*) FROM videos WHERE series_id = ?").pluck().get(alpha.id), 0);
        assert.equal(db.prepare("SELECT COUNT(*) FROM ratings WHERE video_id IN (?, ?, ?, ?)").pluck().get(a1.id, a2.id, a3.id, a4.id), 0);
        assertFresh(db, "series alpha hard-deleted");
        assert.deepEqual(db.pragma("foreign_key_check"), []);
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an empty v13 database upgrades too; a new database is AUTOINCREMENT from the start", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crwn-m14-empty-"));
    const file = path.join(dir, "empty.db");
    try {
      openDatabase(file, { seedCatalog: false, migrateTo: 13 }).close();
      const db = openDatabase(file, { seedCatalog: false });
      try {
        assert.deepEqual(rowsOf(db, "SELECT name, seq FROM sqlite_sequence ORDER BY name"), [
          { name: "series", seq: 0 },
          { name: "videos", seq: 0 },
        ]);
        const { repo } = services(db);
        const first = repo.createSeries({ slug: "one", name: "One" });
        assert.equal(first.id, 1);
        repo.deleteSeries(first.id);
        assert.equal(repo.createSeries({ slug: "one", name: "One" }).id, 2, "id 1 is not handed out again");
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const fresh = openDatabase(":memory:");
    try {
      for (const t of ["series", "videos"]) {
        assert.match(fresh.prepare("SELECT sql FROM sqlite_master WHERE name = ?").pluck().get(t), /AUTOINCREMENT/);
      }
      assert.equal(fresh.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'series'").pluck().get(), 7, "the seeded catalog");
    } finally {
      fresh.close();
    }
  });
});

// The scenario the e2e run reported: delete forever, add again, and the old id came back.
describe("over HTTP: delete forever, then add again → a new id", () => {
  test("videos and series", async () => {
    const srv = await startServer();
    try {
      const admin = quickUser(srv, "admin@example.com", "admin").client;
      const created = await admin.post("/api/admin/series", { name: "Stable Ids" });
      assert.equal(created.status, 201);
      const seriesId = created.body.series.id;
      const body = { url: `https://youtu.be/${vid(1)}`, title: "Stable Ids episode 1", section: "anime", seriesSlug: "stable-ids", number: 1 };
      const first = await admin.post("/api/admin/videos", body);
      assert.equal(first.status, 201);
      assert.equal(first.body.video.status, "published");
      const oldId = first.body.video.id;
      assert.equal((await srv.client().get(`/api/videos/${oldId}`)).status, 200);

      assert.equal((await admin.del(`/api/admin/videos/${oldId}`)).status, 204);
      assert.equal((await admin.del(`/api/admin/trash/videos/${oldId}`)).status, 204);
      const again = await admin.post("/api/admin/videos", body);
      assert.equal(again.status, 201);
      assert.notEqual(again.body.video.id, oldId);
      assert.ok(again.body.video.id > oldId);
      assert.equal((await srv.client().get(`/api/videos/${oldId}`)).status, 404, "the old id stays gone");
      assert.equal((await srv.client().get(`/api/videos/${again.body.video.id}`)).body.video.youtubeVideoId, vid(1));

      assert.equal((await admin.del(`/api/admin/series/${seriesId}`)).status, 204);
      assert.equal((await admin.del(`/api/admin/trash/series/${seriesId}`)).status, 204);
      const recreated = await admin.post("/api/admin/series", { name: "Stable Ids" });
      assert.equal(recreated.status, 201);
      assert.ok(recreated.body.series.id > seriesId, "a new series id");
      const third = await admin.post("/api/admin/videos", body);
      assert.ok(third.body.video.id > again.body.video.id, "its video too");
      assertFresh(srv.db, "after the HTTP round trips");
    } finally {
      await srv.close();
    }
  });
});
