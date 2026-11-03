import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { SCHEMA_VERSION, openDatabase } from "../src/db.js";
import { searchNormalize, searchText } from "../src/search.js";
import { addVideo, signUp, startServer } from "./helpers.js";

const slugs = (res) => res.body.items.map((i) => i.slug);
const keys = (res) => res.body.items.map((i) => `${i.section}:${i.slug}`);

/** Publishes `count` anime videos for a series through the classifier overrides. */
async function publish(srv, firstN, seriesSlug, count = 1, section = "anime") {
  const out = [];
  for (let i = 0; i < count; i++) {
    const video = await addVideo(srv, firstN + i, `upload ${firstN + i}`, { section, seriesSlug, number: i + 1 });
    assert.equal(video.status, "published", `${seriesSlug} #${i + 1}`);
    out.push(video);
  }
  return out;
}

/** Ratings straight in the DB (signing up dozens of users would be slow). */
function rate(srv, videoId, scores) {
  const db = srv.db;
  const insertUser = db.prepare(`
    INSERT INTO users (email, display_name, password_hash, privacy_accepted_at, created_at)
    VALUES (?, 'Rater', 'x', datetime('now'), datetime('now'))`);
  const insertRating = db.prepare("INSERT INTO ratings (user_id, video_id, score, updated_at) VALUES (?, ?, ?, datetime('now'))");
  for (const score of scores) {
    const { lastInsertRowid } = insertUser.run(`rater${Math.random().toString(36).slice(2)}@example.com`);
    insertRating.run(lastInsertRowid, videoId, score);
  }
}

describe("search: matching, filters, both sections", () => {
  let srv;
  before(async () => {
    srv = await startServer();
    srv.services.repo.createSeries({ slug: "pokemon", name: "Pokémon", aliases: ["Pocket Monsters"], genres: ["Adventure", "Kids"] });
    await addVideo(srv, 1, "One Piece Episode 1");
    await addVideo(srv, 2, "One Piece Chapter 1100 Manga");
    await addVideo(srv, 3, "JJK Episode 3 Dublado");
    await addVideo(srv, 4, "Pokémon Episode 1");
    await addVideo(srv, 5, "Bleach Episode 1");
    await addVideo(srv, 6, "Top 10 anime fights"); // pending
  });
  after(() => srv.close());

  test("accent- and case-insensitive on name and aliases", async () => {
    const c = srv.client();
    for (const q of ["pokemon", "POKÉMON", "Poké", "pocket", "pocket monsters", "kemo"]) {
      const res = await c.get(`/api/search?q=${encodeURIComponent(q)}`);
      assert.equal(res.status, 200, q);
      assert.deepEqual(slugs(res), ["pokemon"], q);
      assert.equal(res.body.total, 1, q);
    }
    assert.deepEqual(slugs(await c.get("/api/search?q=jjk")), ["jujutsu-kaisen"], "alias");
    assert.deepEqual(slugs(await c.get("/api/search?q=JUJUTSU%20kaisen")), ["jujutsu-kaisen"]);
    assert.deepEqual((await c.get("/api/search?q=zzz")).body, { items: [], total: 0 });
    // A name and an alias are separate: no match across the boundary.
    assert.deepEqual((await c.get("/api/search?q=pokemon%20pocket")).body.total, 0);
  });

  test("SearchItem shape; a series in both sections is two items", async () => {
    const res = await srv.client().get("/api/search?q=one%20piece");
    assert.deepEqual(keys(res), ["anime:one-piece", "manga:one-piece"]);
    assert.equal(res.body.total, 2);
    const [anime, manga] = res.body.items;
    assert.equal(anime.route, "/anime/one-piece");
    assert.equal(manga.route, "/manga/one-piece");
    assert.equal(anime.videoCount, 1);
    assert.deepEqual(anime.rating, { average: null, count: 0 });
    assert.ok(anime.latestPublishedAt);
    for (const field of ["id", "slug", "name", "synopsis", "aliases", "genres", "coverUrl"]) assert.ok(field in anime, field);
    assert.equal("search_text" in anime, false);
    assert.equal("searchText" in anime, false);
  });

  test("section and genre filters; only series with published videos", async () => {
    const c = srv.client();
    assert.deepEqual(keys(await c.get("/api/search?section=manga")), ["manga:one-piece"]);
    assert.deepEqual(keys(await c.get("/api/search?q=one&section=anime")), ["anime:one-piece"]);
    // Genre is case-insensitive and exact (not "Kid" for "Kids").
    assert.deepEqual(keys(await c.get("/api/search?genre=kids")), ["anime:pokemon"]);
    assert.deepEqual(keys(await c.get("/api/search?genre=kid")), []);
    assert.deepEqual(keys(await c.get("/api/search?genre=SHONEN&section=anime")), ["anime:bleach", "anime:jujutsu-kaisen", "anime:one-piece"]);
    // Seeded series without published videos (Naruto Shippuden, ...) never appear.
    const all = await c.get("/api/search");
    assert.deepEqual(keys(all), ["anime:bleach", "anime:jujutsu-kaisen", "anime:one-piece", "manga:one-piece", "anime:pokemon"]);
    assert.equal(all.body.total, 5);
    assert.equal(all.headers.get("cache-control"), "public, max-age=60, stale-while-revalidate=600");
    assert.ok(all.headers.get("etag"));
  });

  test("validation: 400 VALIDATION_ERROR", async () => {
    const c = srv.client();
    const bad = [
      ["limit=0", "limit"],
      ["limit=51", "limit"],
      ["limit=abc", "limit"],
      ["limit=1.5", "limit"],
      ["offset=-1", "offset"],
      ["offset=x", "offset"],
      ["sort=rating", "sort"],
      ["section=drama", "section"],
      [`q=${"a".repeat(81)}`, "q"],
      ["q=a&q=b", "q"],
      ["genre=a&genre=b", "genre"],
    ];
    for (const [query, field] of bad) {
      const res = await c.get(`/api/search?${query}`);
      assert.equal(res.status, 400, query);
      assert.equal(res.body.error.code, "VALIDATION_ERROR", query);
      assert.ok(res.body.error.details[field], `${query} -> ${field}`);
      assert.equal(res.headers.get("cache-control"), "private, no-store", "errors are not cached");
    }
    assert.equal((await c.get(`/api/search?q=${"a".repeat(80)}`)).status, 200, "80 chars is fine");
    assert.equal((await c.get(`/api/search?q=${encodeURIComponent("é".repeat(80))}`)).status, 200, "counts characters");
    assert.equal((await c.get("/api/search?limit=50&offset=0")).status, 200);
    // SQL/LIKE metacharacters are just text.
    for (const q of ["%", "_", "'; DROP TABLE series; --", "\\"]) {
      const res = await c.get(`/api/search?q=${encodeURIComponent(q)}`);
      assert.equal(res.status, 200, q);
    }
    assert.equal((await c.get("/api/search?q=o%25e")).body.total, 0, "% is not a wildcard");
    // A q with nothing searchable in it matches nothing (it does not browse everything).
    for (const q of ["%", "%%", "😀", "!!!", "—"]) {
      const res = await c.get(`/api/search?q=${encodeURIComponent(q)}`);
      assert.deepEqual(res.body, { items: [], total: 0 }, q);
      assert.deepEqual((await c.get(`/api/anime/series?q=${encodeURIComponent(q)}`)).body, [], q);
    }
  });

  test("GET /api/:section/series?q= uses the same matching and limits", async () => {
    const c = srv.client();
    const long = await c.get(`/api/anime/series?q=${"a".repeat(81)}`);
    assert.equal(long.status, 400);
    assert.ok(long.body.error.details.q);
    assert.equal((await c.get("/api/anime/series?q=a&q=b")).status, 400);
    assert.equal((await c.get(`/api/anime/series?q=${"a".repeat(80)}`)).status, 200);
    assert.deepEqual((await c.get("/api/anime/series?q=pokemon")).body.map((s) => s.slug), ["pokemon"]);
    assert.deepEqual((await c.get("/api/anime/series?q=Pocket")).body.map((s) => s.slug), ["pokemon"]);
    assert.deepEqual((await c.get("/api/anime/series?q=jjk&genre=fantasy")).body.map((s) => s.slug), ["jujutsu-kaisen"]);
    assert.deepEqual((await c.get("/api/manga/series?q=pokemon")).body, []);
  });

  test("search_text follows admin create and patch", async () => {
    const admin = await signUp(srv, { email: "admin@example.com" });
    const created = await admin.post("/api/admin/series", { name: "Shingeki no Kyojin", aliases: ["Attack on Titan"], genres: ["Action"] });
    assert.equal(created.status, 201);
    const id = created.body.series.id;
    await publish(srv, 20, created.body.series.slug);
    assert.deepEqual(slugs(await srv.client().get("/api/search?q=attack")), ["shingeki-no-kyojin"]);

    const patched = await admin.patch(`/api/admin/series/${id}`, { name: "Ataque dos Titãs", aliases: ["AoT"] });
    assert.equal(patched.status, 200);
    assert.deepEqual(slugs(await srv.client().get("/api/search?q=titas")), ["shingeki-no-kyojin"]);
    assert.deepEqual(slugs(await srv.client().get("/api/search?q=aot")), ["shingeki-no-kyojin"]);
    assert.equal((await srv.client().get("/api/search?q=attack")).body.total, 0, "old alias is gone");
    assert.equal((await srv.client().get("/api/search?q=shingeki")).body.total, 0, "old name is gone");
    assert.equal(srv.db.prepare("SELECT search_text FROM series WHERE id = ?").get(id).search_text, "|ataque dos titas|aot|");
  });
});

describe("search: sorting and pagination", () => {
  let srv;
  before(async () => {
    srv = await startServer();
    const { repo } = srv.services;
    // q=dragon: exact name, exact alias, name prefix, word prefix, substring.
    repo.createSeries({ slug: "ultradragon", name: "Ultradragon" });
    repo.createSeries({ slug: "shin-dragon", name: "Shin Dragon" });
    repo.createSeries({ slug: "dragon-ball", name: "Dragon Ball" });
    repo.createSeries({ slug: "kid", name: "Kid", aliases: ["Dragon"] });
    repo.createSeries({ slug: "dragon", name: "Dragon" });
    let n = 1;
    const videos = {};
    for (const slug of ["ultradragon", "shin-dragon", "dragon-ball", "kid", "dragon"]) {
      videos[slug] = await publish(srv, n, slug, 3);
      n += 3;
    }
    // Ratings (published videos only count): m = site mean.
    rate(srv, videos.ultradragon[0].id, [5, 5, 5, 5, 5]); // n=5, high
    rate(srv, videos["shin-dragon"][0].id, [4, 4, 4]); // n=3
    rate(srv, videos.kid[0].id, [5, 5]); // n=2 < 3: ranked after the n >= 3 ones for "top"
    rate(srv, videos.dragon[0].id, [1, 1, 1]); // n=3, low
    // Latest publishedAt per series.
    const at = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
    const setPublished = srv.db.prepare("UPDATE videos SET published_at = ? WHERE series_id = (SELECT id FROM series WHERE slug = ?)");
    for (const [slug, days] of [["ultradragon", 5], ["shin-dragon", 1], ["dragon-ball", 3], ["kid", 2], ["dragon", 4]]) {
      setPublished.run(at(days), slug);
    }
  });
  after(() => srv.close());

  test("relevance is the default with q: exact name, exact alias, prefix, word, substring", async () => {
    const expected = ["dragon", "kid", "dragon-ball", "shin-dragon", "ultradragon"];
    assert.deepEqual(slugs(await srv.client().get("/api/search?q=dragon")), expected);
    assert.deepEqual(slugs(await srv.client().get("/api/search?q=DRAGON&sort=relevance")), expected);
  });

  test("relevance ties are broken by rating", async () => {
    srv.services.repo.createSeries({ slug: "dragon-quest", name: "Dragon Quest" });
    await publish(srv, 100, "dragon-quest", 1);
    const [video] = srv.services.repo.listPublishedInSeries(srv.services.repo.getSeries("dragon-quest").id, "anime");
    rate(srv, video.id, [5, 5, 5, 5]);
    try {
      // Both are name prefixes; the rated one wins over the unrated one.
      assert.deepEqual(slugs(await srv.client().get("/api/search?q=dragon")), ["dragon", "kid", "dragon-quest", "dragon-ball", "shin-dragon", "ultradragon"]);
    } finally {
      srv.services.repo.deleteSeries(srv.services.repo.getSeries("dragon-quest").id);
    }
  });

  test("top: Bayesian rating, n >= 3 first", async () => {
    const res = await srv.client().get("/api/search?sort=top");
    assert.deepEqual(slugs(res), ["ultradragon", "shin-dragon", "dragon", "kid", "dragon-ball"]);
    const ultra = res.body.items[0];
    assert.deepEqual(ultra.rating, { average: 5, count: 5 });
  });

  test("new: latest publishedAt first", async () => {
    const res = await srv.client().get("/api/search?sort=new");
    assert.deepEqual(slugs(res), ["shin-dragon", "kid", "dragon-ball", "dragon", "ultradragon"]);
    const dates = res.body.items.map((i) => i.latestPublishedAt);
    assert.deepEqual([...dates].sort().reverse(), dates);
  });

  test("az is the default without q", async () => {
    const expected = ["dragon", "dragon-ball", "kid", "shin-dragon", "ultradragon"];
    assert.deepEqual(slugs(await srv.client().get("/api/search")), expected);
    assert.deepEqual(slugs(await srv.client().get("/api/search?q=dragon&sort=az")), expected);
    assert.deepEqual(slugs(await srv.client().get("/api/search?q=%20%20")), expected, "blank q browses");
  });

  test("limit/offset pages with a stable total", async () => {
    const pages = [];
    for (const offset of [0, 2, 4, 6]) {
      const res = await srv.client().get(`/api/search?sort=top&limit=2&offset=${offset}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.total, 5);
      pages.push(slugs(res));
    }
    assert.deepEqual(pages, [["ultradragon", "shin-dragon"], ["dragon", "kid"], ["dragon-ball"], []]);
    assert.equal((await srv.client().get("/api/search")).body.items.length, 5, "default limit 20");
  });
});

describe("search_text migration", () => {
  test("a database from before v1.2 gets search_text filled in", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crwn-search-"));
    const file = path.join(dir, "old.db");
    try {
      const old = openDatabase(file, { seedCatalog: false, migrateTo: 3 });
      old.prepare("INSERT INTO series (slug, name, aliases) VALUES (?, ?, ?)").run("pokemon", "Pokémon", JSON.stringify(["Pocket Monsters"]));
      old.prepare("INSERT INTO series (slug, name, aliases) VALUES (?, ?, ?)").run("broken", "Broken", "not json");
      old.prepare("INSERT INTO series (slug, name, aliases) VALUES (?, ?, ?)").run("aot", "進撃の巨人", JSON.stringify(["Shingeki", 1, null]));
      old.close();

      const db = openDatabase(file);
      try {
        const rows = db.prepare("SELECT slug, search_text FROM series ORDER BY slug").all();
        assert.deepEqual(rows, [
          { slug: "aot", search_text: "|進撃の巨人|shingeki|" },
          { slug: "broken", search_text: "|broken|" },
          { slug: "pokemon", search_text: "|pokemon|pocket monsters|" },
        ]);
        assert.equal(db.pragma("user_version", { simple: true }), SCHEMA_VERSION);
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("migration 5 re-normalises v1.2.0 search_text (non-Latin names were dropped)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crwn-search-"));
    const file = path.join(dir, "v4.db");
    try {
      const old = openDatabase(file, { seedCatalog: false, migrateTo: 4 });
      // What the first v1.2 normaliser stored: only [a-z0-9] survived.
      old.prepare("INSERT INTO series (slug, name, aliases, search_text) VALUES (?, ?, ?, ?)").run("kny", "鬼滅の刃", JSON.stringify(["Kimetsu"]), "|kimetsu|");
      old.close();
      const db = openDatabase(file);
      try {
        assert.equal(db.prepare("SELECT search_text FROM series WHERE slug = 'kny'").get().search_text, "|鬼滅の刃|kimetsu|");
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fresh databases have it for the seeded catalog", () => {
    const db = openDatabase(":memory:");
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM series WHERE search_text = ''").get().n, 0);
      assert.equal(db.prepare("SELECT search_text FROM series WHERE slug = 'jujutsu-kaisen'").get().search_text, searchText("Jujutsu Kaisen", ["JJK"]));
    } finally {
      db.close();
    }
  });
});

describe("search: letters of every script", () => {
  test("searchNormalize strips accents and case, keeps non-Latin letters, folds full-width", () => {
    assert.equal(searchNormalize("Pokémon!"), "pokemon");
    assert.equal(searchNormalize("ＰＯＫＥＭＯＮ"), "pokemon");
    assert.equal(searchNormalize("Ataque dos Titãs — 2ª temporada"), "ataque dos titas 2a temporada");
    assert.equal(searchNormalize("鬼滅の刃"), "鬼滅の刃");
    assert.equal(searchNormalize("진격의 거인"), searchNormalize("진격의 거인"));
    assert.equal(searchNormalize("😀 % —"), "");
    assert.equal(searchText("Kimetsu", ["鬼滅の刃", 42, null]), "|kimetsu|鬼滅の刃|");
  });

  test("Japanese names and aliases are findable", async () => {
    const srv = await startServer();
    try {
      srv.services.repo.createSeries({ slug: "kimetsu", name: "Kimetsu no Yaiba", aliases: ["鬼滅の刃"] });
      srv.services.repo.createSeries({ slug: "shingeki", name: "進撃の巨人", aliases: ["Attack on Titan"] });
      await publish(srv, 1, "kimetsu");
      await publish(srv, 2, "shingeki");
      const c = srv.client();
      assert.deepEqual(slugs(await c.get(`/api/search?q=${encodeURIComponent("鬼滅")}`)), ["kimetsu"]);
      assert.deepEqual(slugs(await c.get(`/api/search?q=${encodeURIComponent("進撃の巨人")}`)), ["shingeki"]);
      assert.deepEqual((await c.get(`/api/anime/series?q=${encodeURIComponent("巨人")}`)).body.map((s) => s.slug), ["shingeki"]);
      assert.deepEqual((await c.get(`/api/search?q=${encodeURIComponent("😀")}`)).body, { items: [], total: 0 });
    } finally {
      await srv.close();
    }
  });
});
