// Review fixes for v1.2: precomputed series stats, one spelling per genre,
// manga chapters without seasons.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { classify } from "../src/classifier.js";
import { openDatabase } from "../src/db.js";
import { addVideo, signUp, startServer, vid } from "./helpers.js";

/** series_stats rebuilt from scratch, to compare with what the triggers kept. */
function expectedStats(db) {
  return db
    .prepare(`
      SELECT v.series_id, v.section, COUNT(*) AS video_count, MAX(v.published_at) AS latest_published_at,
        (SELECT COUNT(*) FROM ratings r JOIN videos v2 ON v2.id = r.video_id
          WHERE v2.series_id = v.series_id AND v2.section = v.section AND v2.status = 'published') AS rating_n,
        (SELECT COALESCE(SUM(r.score), 0) FROM ratings r JOIN videos v2 ON v2.id = r.video_id
          WHERE v2.series_id = v.series_id AND v2.section = v.section AND v2.status = 'published') AS rating_sum
      FROM videos v WHERE v.status = 'published' AND v.section IS NOT NULL AND v.series_id IN (SELECT id FROM series)
      GROUP BY v.series_id, v.section ORDER BY v.series_id, v.section`)
    .all();
}
const actualStats = (db) => db.prepare("SELECT * FROM series_stats ORDER BY series_id, section").all();
const totals = (db) => db.prepare("SELECT n, total FROM rating_totals").get();

function addUser(db, email) {
  return db
    .prepare("INSERT INTO users (email, display_name, password_hash, privacy_accepted_at, created_at) VALUES (?, 'U', 'x', datetime('now'), datetime('now'))")
    .run(email).lastInsertRowid;
}
const rate = (db, userId, videoId, score) =>
  db.prepare("INSERT INTO ratings (user_id, video_id, score, updated_at) VALUES (?, ?, ?, datetime('now'))").run(userId, videoId, score);

describe("series_stats and rating_totals follow every write (triggers)", () => {
  let srv;
  before(async () => {
    srv = await startServer();
  });
  after(() => srv.close());

  test("inserts, ratings, unpublish, moves, deletes, cascades", async () => {
    const { db } = srv;
    const { repo } = srv.services;
    const check = (step) => {
      assert.deepEqual(actualStats(db), expectedStats(db), step);
      const all = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(score), 0) AS total FROM ratings").get();
      assert.deepEqual(totals(db), all, `${step}: site totals`);
    };
    check("empty");
    const op1 = await addVideo(srv, 1, "One Piece Episode 1");
    const op2 = await addVideo(srv, 2, "One Piece Episode 2");
    const opm = await addVideo(srv, 3, "One Piece Chapter 10 Manga");
    const bl = await addVideo(srv, 4, "Bleach Episode 1");
    check("videos added");

    const users = ["a", "b", "c"].map((u) => addUser(db, `${u}@example.com`));
    rate(db, users[0], op1.id, 5);
    rate(db, users[1], op1.id, 3);
    rate(db, users[0], opm.id, 4);
    rate(db, users[2], bl.id, 1);
    check("rated");
    db.prepare("UPDATE ratings SET score = 1 WHERE user_id = ? AND video_id = ?").run(users[0], op1.id);
    check("rating changed");

    db.prepare("UPDATE videos SET status = 'pending' WHERE id = ?").run(op1.id);
    check("unpublished (its ratings stop counting)");
    db.prepare("UPDATE videos SET status = 'published' WHERE id = ?").run(op1.id);
    db.prepare("UPDATE videos SET section = 'manga', number = 99 WHERE id = ?").run(op2.id);
    check("moved to the other section");
    db.prepare("UPDATE videos SET series_id = ? WHERE id = ?").run(repo.getSeries("bleach").id, op2.id);
    check("moved to another series");
    db.prepare("UPDATE videos SET published_at = '2030-01-01T00:00:00.000Z' WHERE id = ?").run(bl.id);
    check("publishedAt changed");

    // Through the real services too: rating API, account deletion, video and series deletion.
    const user = await signUp(srv, { email: "real@example.com" });
    assert.equal((await user.put(`/api/videos/${bl.id}/rating`, { score: 5 })).status, 200);
    check("rated through the API");
    srv.services.ratings.removeAllForUser(users[2]);
    check("account ratings removed");
    repo.deleteVideo(op1.id);
    check("video deleted (ratings cascade)");
    repo.deleteSeries(repo.getSeries("one-piece").id);
    check("series deleted (videos and ratings cascade)");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM series_stats WHERE series_id NOT IN (SELECT id FROM series)").get().n, 0);
  });

  test("the catalog version moves on series/video changes, not on ratings", async () => {
    const { db } = srv;
    const { repo } = srv.services;
    const version = () => repo.catalogVersion();
    let v0 = version();
    const video = await addVideo(srv, 50, "Bleach Episode 50");
    assert.ok(version() > v0, "video added");
    v0 = version();
    rate(db, addUser(db, "x@example.com"), video.id, 4);
    assert.equal(version(), v0, "ratings do not change the catalog");
    db.prepare("UPDATE videos SET checked_at = 'now' WHERE id = ?").run(video.id);
    assert.equal(version(), v0, "a health-check timestamp alone does not");
    repo.setAvailability(video.id, "unavailable");
    assert.ok(version() > v0, "availability does");
    v0 = version();
    repo.updateSeries(repo.getSeries("bleach").id, { ...repo.getSeries("bleach"), synopsis: "x" });
    assert.ok(version() > v0, "series edited");
  });
});

describe("genres: one spelling per genre, compared the same way everywhere", () => {
  let srv;
  before(async () => {
    srv = await startServer();
    const { repo } = srv.services;
    repo.createSeries({ slug: "kimetsu", name: "Kimetsu", genres: ["Ação", "Sci.Fi"] });
    repo.createSeries({ slug: "shingeki", name: "Shingeki", genres: ["AÇÃO", " ação ", "Drama"] });
    repo.createSeries({ slug: "hidden", name: "Hidden", genres: ["Só Escondido"] });
    await addVideo(srv, 1, "x", { section: "anime", seriesSlug: "kimetsu", number: 1 });
    await addVideo(srv, 2, "x", { section: "anime", seriesSlug: "shingeki", number: 1 });
    const hidden = await addVideo(srv, 3, "x", { section: "anime", seriesSlug: "hidden", number: 1 });
    repo.setAvailability(hidden.id, "unavailable");
  });
  after(() => srv.close());

  test("stored in the first spelling, de-duplicated inside a series", () => {
    assert.deepEqual(srv.services.repo.getSeries("shingeki").genres, ["Ação", "Drama"]);
    // Changing the only user of a spelling is allowed (it does not match itself).
    const { repo } = srv.services;
    const solo = repo.createSeries({ slug: "solo", name: "Solo", genres: ["mecha"] });
    assert.deepEqual(repo.updateSeries(solo.id, { ...solo, genres: ["Mecha"] }).genres, ["Mecha"]);
    repo.deleteSeries(solo.id);
  });

  test("/api/genres lists genres of published, available series once", async () => {
    const res = await srv.client().get("/api/genres");
    assert.equal(res.body.filter((g) => g.toLocaleLowerCase("pt-BR") === "ação").length, 1);
    assert.ok(res.body.includes("Ação"));
    assert.ok(res.body.includes("Sci.Fi"));
    assert.equal(res.body.includes("Só Escondido"), false, "only series is unavailable");
    assert.equal(res.body.includes("Drama"), true);
  });

  test("search, section list, genre page and sitemap agree on any casing", async () => {
    const c = srv.client();
    for (const genre of ["Ação", "AÇÃO", "ação", "  ação "]) {
      const res = await c.get(`/api/search?genre=${encodeURIComponent(genre)}`);
      assert.deepEqual(res.body.items.map((i) => i.slug), ["kimetsu", "shingeki"], genre);
      const list = await c.get(`/api/anime/series?genre=${encodeURIComponent(genre)}`);
      assert.deepEqual(list.body.map((i) => i.slug), ["kimetsu", "shingeki"], genre);
    }
    assert.deepEqual((await c.get("/api/search?genre=nope")).body, { items: [], total: 0 });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crwn-genre-"));
    fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Crwn Animes</title>");
    const web = await startServer({ config: { clientDist: dir } });
    try {
      web.services.repo.createSeries({ slug: "kimetsu", name: "Kimetsu", genres: ["Ação", "Sci.Fi"] });
      await addVideo(web, 1, "x", { section: "anime", seriesSlug: "kimetsu", number: 1 });
      const page = await web.client().get("/genre/A%C3%87%C3%83O");
      assert.equal(page.status, 200);
      assert.match(page.text, /<link rel="canonical" href="http:\/\/app\.test\/genre\/A%C3%A7%C3%A3o"/);
      const dotted = await web.client().get("/genre/Sci.Fi");
      assert.equal(dotted.status, 200, "a dot in a genre is not a file extension");
      assert.match(dotted.headers.get("content-type"), /^text\/html/);
      assert.match(dotted.text, /<title>Sci\.Fi · Animes e mangás · Crwn Animes<\/title>/);
      assert.equal((await web.client().get("/genre/Missing.js")).status, 404);
      const sitemap = (await web.client().get("/sitemap.xml")).text;
      assert.equal((sitemap.match(/\/genre\/A%C3%A7%C3%A3o</g) ?? []).length, 1);
      // A genre whose only series is unavailable has no page.
      web.services.repo.createSeries({ slug: "hidden", name: "Hidden", genres: ["Só Escondido"] });
      const hidden = await addVideo(web, 2, "x", { section: "anime", seriesSlug: "hidden", number: 1 });
      assert.equal((await web.client().get("/genre/s%C3%B3%20escondido")).status, 200);
      web.services.repo.setAvailability(hidden.id, "unavailable");
      assert.equal((await web.client().get("/genre/s%C3%B3%20escondido")).status, 404);
      assert.doesNotMatch((await web.client().get("/sitemap.xml")).text, /escondido/i);
    } finally {
      await web.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("migration 6 canonicalises existing genres", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crwn-genres-"));
    const file = path.join(dir, "old.db");
    try {
      const old = openDatabase(file, { seedCatalog: false, migrateTo: 5 });
      const insert = old.prepare("INSERT INTO series (slug, name, genres) VALUES (?, ?, ?)");
      insert.run("a", "A", JSON.stringify(["Ação", "Drama"]));
      insert.run("b", "B", JSON.stringify(["AÇÃO", "drama", "Drama", "  Slice   of Life "]));
      insert.run("c", "C", "not json");
      old.close();
      const db = openDatabase(file);
      try {
        const rows = db.prepare("SELECT slug, genres FROM series ORDER BY slug").all();
        assert.deepEqual(rows.map((r) => [r.slug, JSON.parse(r.genres)]), [
          ["a", ["Ação", "Drama"]],
          ["b", ["Ação", "Drama", "Slice of Life"]],
          ["c", []],
        ]);
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("manga chapters have no seasons", () => {
  test("the classifier ignores a season override for manga", () => {
    const series = [{ id: 1, slug: "mg", name: "Mg", aliases: [] }];
    const result = classify({ title: "Mg chapter 4 manga" }, series, { season: 2 });
    assert.equal(result.section, "manga");
    assert.equal(result.season, 1);
    assert.match(result.classification.reasons.join("\n"), /no seasons/);
    assert.equal(classify({ title: "Mg episode 4" }, series, { section: "anime", season: 2 }).season, 2, "anime keeps it");
  });

  test("admin overrides cannot put two chapters with one number in different seasons", async () => {
    const srv = await startServer();
    try {
      srv.services.repo.createSeries({ slug: "mg", name: "Mg" });
      const admin = await signUp(srv, { email: "admin@example.com" });
      const a = await admin.post("/api/admin/videos", { url: vid(10), title: "t", section: "manga", seriesSlug: "mg", season: 1, number: 4 });
      const b = await admin.post("/api/admin/videos", { url: vid(11), title: "t", section: "manga", seriesSlug: "mg", season: 2, number: 4 });
      assert.equal(a.body.video.status, "published");
      assert.equal(b.body.video.status, "pending", "same chapter slot");
      assert.equal(b.body.video.season, 1);
      const moved = await admin.patch(`/api/admin/videos/${a.body.video.id}`, { season: 3 });
      assert.equal(moved.status, 200);
      assert.equal(moved.body.video.season, 1);
      assert.equal(moved.body.video.route, "/manga/mg/chapter/4");
    } finally {
      await srv.close();
    }
  });

  test("migration 7: season 1 for every manga video; the oldest published chapter keeps its slot", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crwn-manga-"));
    const file = path.join(dir, "old.db");
    try {
      const old = openDatabase(file, { seedCatalog: false, migrateTo: 6 });
      old.prepare("INSERT INTO series (id, slug, name) VALUES (1, 'mg', 'Mg')").run();
      const insert = old.prepare(`
        INSERT INTO videos (youtube_video_id, source_title, section, series_id, season, number, status, published_at, classification)
        VALUES (?, 't', ?, 1, ?, ?, ?, ?, ?)`);
      insert.run("aaaaaaaaaaa", "manga", 2, 4, "published", "2026-01-02T00:00:00.000Z", JSON.stringify({ reasons: ["x"] }));
      insert.run("bbbbbbbbbbb", "manga", 1, 4, "published", "2026-01-01T00:00:00.000Z", "{}"); // oldest: stays
      insert.run("ccccccccccc", "manga", 3, 4, "published", "2026-01-03T00:00:00.000Z", "broken");
      insert.run("ddddddddddd", "manga", 2, 5, "published", "2026-01-04T00:00:00.000Z", "{}"); // alone: just moves
      insert.run("eeeeeeeeeee", "manga", 2, 6, "pending", null, "{}");
      insert.run("fffffffffff", "anime", 2, 4, "published", "2026-01-05T00:00:00.000Z", "{}"); // anime untouched
      old.close();

      const db = openDatabase(file);
      try {
        const rows = db.prepare("SELECT youtube_video_id AS id, section, season, number, status, classification FROM videos ORDER BY id").all();
        assert.deepEqual(rows.map((r) => [r.id, r.season, r.number, r.status]), [
          ["aaaaaaaaaaa", 1, 4, "pending"],
          ["bbbbbbbbbbb", 1, 4, "published"],
          ["ccccccccccc", 1, 4, "pending"],
          ["ddddddddddd", 1, 5, "published"],
          ["eeeeeeeeeee", 1, 6, "pending"],
          ["fffffffffff", 2, 4, "published"],
        ]);
        assert.deepEqual(JSON.parse(rows[0].classification).reasons[0], "x");
        assert.match(JSON.parse(rows[0].classification).reasons.at(-1), /older published video/);
        assert.match(JSON.parse(rows[2].classification).reasons.at(-1), /older published video/);
        // Stats were built after the fix-up: 2 published manga chapters.
        assert.deepEqual(db.prepare("SELECT section, video_count FROM series_stats ORDER BY section").all(), [
          { section: "anime", video_count: 1 },
          { section: "manga", video_count: 2 },
        ]);
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
