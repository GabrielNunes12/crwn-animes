// v1.3 (cycle 3): /api/latest offset + section, paginated/searchable admin
// lists, seasons on series pages.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { openDatabase } from "../src/db.js";
import { createRepository } from "../src/repository.js";
import { addVideo, signUp, startServer } from "./helpers.js";

/** Every page of `url` (which has no limit/offset yet), `limit` at a time. */
async function allPages(client, url, limit) {
  const sep = url.includes("?") ? "&" : "?";
  const pages = [];
  for (let offset = 0; ; offset += limit) {
    const res = await client.get(`${url}${sep}limit=${limit}&offset=${offset}`);
    assert.equal(res.status, 200, res.text);
    pages.push(res.body);
    if (res.body.items.length < limit) return pages;
  }
}

const assertValidation = (res, fields) => {
  assert.equal(res.status, 400, res.text);
  assert.equal(res.body.error.code, "VALIDATION_ERROR");
  assert.deepEqual(Object.keys(res.body.error.details).sort(), [...fields].sort());
};

describe("v1.3 public catalog: latest offset/section, seasons", () => {
  let srv;
  let v;
  before(async () => {
    srv = await startServer();
    v = {
      s1e1: await addVideo(srv, 1, "One Piece Episode 1"),
      s1e2: await addVideo(srv, 2, "One Piece Episode 2"),
      s3e1: await addVideo(srv, 3, "One Piece Season 3 Episode 1"),
      s3e2: await addVideo(srv, 4, "One Piece Season 3 Episode 2"),
      ch1: await addVideo(srv, 5, "One Piece Chapter 1100 Manga"),
      ch2: await addVideo(srv, 6, "One Piece Chapter 1101 Manga"),
      bleach: await addVideo(srv, 7, "Bleach Episode 1"),
    };
    for (const video of Object.values(v)) assert.equal(video.status, "published", video.title);
    // Two videos published at the same instant: the id breaks the tie.
    srv.db.prepare("UPDATE videos SET published_at = ? WHERE id IN (?, ?)").run("2026-01-01T00:00:00.000Z", v.s1e1.id, v.s1e2.id);
  });
  after(() => srv.close());

  test("latest: offset pages through the same order without repeats", async () => {
    const client = srv.client();
    const all = (await client.get("/api/latest?limit=50")).body.map((x) => x.id);
    assert.equal(all.length, 7);
    const paged = [];
    for (let offset = 0; offset < 9; offset += 2) {
      const res = await client.get(`/api/latest?limit=2&offset=${offset}`);
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body), "still a plain Video[]");
      paged.push(...res.body.map((x) => x.id));
    }
    assert.deepEqual(paged, all);
    assert.deepEqual(all.slice(-2), [v.s1e2.id, v.s1e1.id], "same publishedAt: higher id first");
    assert.deepEqual((await client.get("/api/latest?offset=10000")).body, []);
  });

  test("latest: section filter", async () => {
    const client = srv.client();
    const manga = (await client.get("/api/latest?section=manga")).body;
    assert.deepEqual(manga.map((x) => x.id), [v.ch2.id, v.ch1.id]);
    const anime = (await client.get("/api/latest?section=anime&limit=2&offset=1")).body;
    assert.ok(anime.every((x) => x.section === "anime"));
    assert.equal(anime.length, 2);
    assert.equal((await client.get("/api/latest?section=")).body.length, 7, "blank section = both");
  });

  test("latest: validation", async () => {
    const client = srv.client();
    assertValidation(await client.get("/api/latest?offset=-1"), ["offset"]);
    assertValidation(await client.get("/api/latest?offset=10001"), ["offset"]);
    assertValidation(await client.get("/api/latest?offset=1.5&section=drama&limit=0"), ["limit", "offset", "section"]);
    assertValidation(await client.get("/api/latest?offset=1&offset=2"), ["offset"]);
    assert.equal((await client.get("/api/latest?limit=500")).status, 200, "limit above 50 is still clamped");
  });

  test("series page lists seasons; ?season= filters the videos", async () => {
    const client = srv.client();
    const full = await client.get("/api/anime/series/one-piece");
    assert.deepEqual(full.body.seasons, [1, 3]);
    assert.deepEqual(full.body.videos.map((x) => x.id), [v.s1e1.id, v.s1e2.id, v.s3e1.id, v.s3e2.id], "unchanged without season");

    const s3 = await client.get("/api/anime/series/one-piece?season=3");
    assert.equal(s3.status, 200);
    assert.equal(s3.body.series.slug, "one-piece");
    assert.deepEqual(s3.body.videos.map((x) => x.id), [v.s3e1.id, v.s3e2.id]);
    assert.deepEqual(s3.body.seasons, [1, 3], "seasons never depend on the filter");
    assert.equal("classification" in s3.body.videos[0], false);

    const unknown = await client.get("/api/anime/series/one-piece?season=2");
    assert.equal(unknown.status, 200);
    assert.deepEqual(unknown.body.videos, []);
    assert.deepEqual(unknown.body.seasons, [1, 3]);
  });

  test("manga seasons are [1]; a section without videos has none", async () => {
    const client = srv.client();
    const manga = await client.get("/api/manga/series/one-piece");
    assert.deepEqual(manga.body.seasons, [1]);
    assert.deepEqual((await client.get("/api/manga/series/one-piece?season=1")).body.videos.map((x) => x.id), [v.ch1.id, v.ch2.id]);
    assert.deepEqual((await client.get("/api/manga/series/one-piece?season=2")).body.videos, []);
    const empty = await client.get("/api/manga/series/bleach");
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.seasons, []);
    assert.deepEqual(empty.body.videos, []);
  });

  test("series page: invalid season -> 400, unknown series still 404", async () => {
    const client = srv.client();
    for (const season of ["0", "100", "abc", "1.5", "-1", "1&season=2"]) {
      assertValidation(await client.get(`/api/anime/series/one-piece?season=${season}`), ["season"]);
    }
    assert.equal((await client.get("/api/anime/series/one-piece?season=")).body.videos.length, 4, "blank = all");
    assert.equal((await client.get("/api/anime/series/nope?season=1")).status, 404);
  });
});

describe("v1.3 admin lists: { items, total }, q, paging", () => {
  let srv;
  let admin;
  let user;
  before(async () => {
    srv = await startServer();
    admin = await signUp(srv, { email: "admin@example.com", displayName: "Boss" });
    user = await signUp(srv, { email: "fan@example.com", displayName: "Fan" });
  });
  after(() => srv.close());

  test("non-admins: 401 logged out, 403 for users, whatever the query", async () => {
    for (const url of ["/api/admin/series?q=one&limit=5", "/api/admin/videos?q=one&offset=1", "/api/admin/videos?limit=999"]) {
      const anon = await srv.client().get(url);
      assert.equal(anon.status, 401, url);
      assert.equal(anon.body.error.code, "UNAUTHENTICATED");
      const forbidden = await user.get(url);
      assert.equal(forbidden.status, 403, url);
      assert.equal(forbidden.body.error.code, "FORBIDDEN");
    }
  });

  test("series: shape, totals and stable paging over tied names", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await admin.post("/api/admin/series", { name: "Twin Star", slug: `twin-star-${i}` });
      assert.equal(res.status, 201);
    }
    const first = await admin.get("/api/admin/series");
    assert.equal(first.status, 200);
    assert.deepEqual(Object.keys(first.body).sort(), ["items", "total"]);
    const total = first.body.total;
    assert.equal(total, 7 + 5, "seeded + created");
    assert.equal(first.body.items.length, total, "default limit 50");
    assert.equal("search_text" in first.body.items[0], false);

    const pages = await allPages(admin, "/api/admin/series", 3);
    const ids = pages.flatMap((p) => p.items.map((s) => s.id));
    assert.ok(pages.every((p) => p.total === total));
    assert.equal(new Set(ids).size, total, "no duplicates");
    assert.deepEqual(ids, first.body.items.map((s) => s.id), "no skips, same order");
    const twins = first.body.items.filter((s) => s.name === "Twin Star").map((s) => s.id);
    assert.deepEqual(twins, [...twins].sort((a, b) => a - b), "ties broken by id");
    const names = first.body.items.map((s) => s.name.toLowerCase());
    assert.deepEqual(names, [...names].sort());

    const past = await admin.get("/api/admin/series?offset=500");
    assert.deepEqual(past.body, { items: [], total });
  });

  test("series: q matches name and aliases, ignoring accents and case", async () => {
    await admin.post("/api/admin/series", { name: "Pokémon", aliases: ["Pocket Monsters"] });
    const byName = await admin.get("/api/admin/series?q=POKEMON");
    assert.deepEqual(byName.body.items.map((s) => s.name), ["Pokémon"]);
    assert.equal(byName.body.total, 1);
    assert.deepEqual((await admin.get("/api/admin/series?q=pocket%20mon")).body.items.map((s) => s.slug), ["pokemon"]);
    assert.deepEqual((await admin.get("/api/admin/series?q=jjk")).body.items.map((s) => s.slug), ["jujutsu-kaisen"]);
    const twins = await admin.get("/api/admin/series?q=twin&limit=2&offset=2");
    assert.equal(twins.body.total, 5);
    assert.equal(twins.body.items.length, 2);
    assert.deepEqual((await admin.get("/api/admin/series?q=%F0%9F%98%80")).body, { items: [], total: 0 }, "nothing searchable");
    assert.equal((await admin.get("/api/admin/series?q=%20%20")).body.total, 13, "blank q = everything");
  });

  test("series: validation", async () => {
    assertValidation(await admin.get("/api/admin/series?limit=0"), ["limit"]);
    assertValidation(await admin.get("/api/admin/series?limit=101"), ["limit"]);
    assertValidation(await admin.get(`/api/admin/series?q=${"a".repeat(81)}&offset=-1&limit=x`), ["limit", "offset", "q"]);
    assertValidation(await admin.get("/api/admin/series?q=a&q=b"), ["q"]);
    assert.equal((await admin.get(`/api/admin/series?q=${"a".repeat(80)}&limit=100`)).status, 200);
  });

  test("videos: stable paging with created_at ties, totals, filters", async () => {
    const made = [];
    for (let i = 0; i < 13; i++) made.push(await addVideo(srv, 100 + i, `Naruto Shippuden Episode ${i + 1}`));
    for (let i = 0; i < 4; i++) made.push(await addVideo(srv, 200 + i, `Random clip number ${i}`));
    // Three created_at values shared by many rows: only the id can order them.
    srv.db.prepare(`UPDATE videos SET created_at = CASE id % 3
      WHEN 0 THEN '2026-01-01 00:00:00' WHEN 1 THEN '2026-01-03 00:00:00' ELSE '2026-01-02 00:00:00' END`).run();

    const expected = srv.db.prepare("SELECT id FROM videos ORDER BY created_at DESC, id DESC").pluck().all();
    assert.equal(expected.length, 17);
    for (const limit of [1, 4, 5, 100]) {
      const pages = await allPages(admin, "/api/admin/videos", limit);
      const ids = pages.flatMap((p) => p.items.map((x) => x.id));
      assert.deepEqual(ids, expected, `limit ${limit}`);
      assert.ok(pages.every((p) => p.total === 17));
    }
    const first = await admin.get("/api/admin/videos?limit=2");
    assert.ok(first.body.items[0].classification, "admin fields");
    assert.ok(first.body.items[0].overrides);

    const pending = await admin.get("/api/admin/videos?status=pending");
    assert.equal(pending.body.total, 4);
    assert.deepEqual(pending.body.items.map((x) => x.id), expected.filter((id) => made.slice(13).some((m) => m.id === id)));
    const published = await allPages(admin, "/api/admin/videos?status=published", 5);
    assert.deepEqual(published.flatMap((p) => p.items.map((x) => x.id)), expected.filter((id) => made.slice(0, 13).some((m) => m.id === id)));

    srv.services.repo.setAvailability(made[2].id, "unavailable");
    srv.services.repo.setAvailability(made[15].id, "unavailable");
    const gone = await admin.get("/api/admin/videos?availability=unavailable&status=published");
    assert.deepEqual(gone.body, { items: [gone.body.items[0]], total: 1 });
    assert.equal(gone.body.items[0].id, made[2].id);
    assert.equal((await admin.get("/api/admin/videos?availability=unavailable")).body.total, 2);
    assert.deepEqual((await admin.get("/api/admin/videos?offset=999")).body, { items: [], total: 17 });
  });

  test("videos: q matches the title or the series name, accent-insensitive", async () => {
    await admin.post("/api/admin/series", { name: "Mahō Shōjo Café", aliases: ["MSC"] });
    const viaAlias = await addVideo(srv, 300, "MSC Episode 1");
    assert.equal(viaAlias.seriesSlug, "maho-shojo-cafe");
    const accented = await addVideo(srv, 301, "Tóquio Ghoul Épisode spécial");

    // Series name ("maho" is nowhere in the title).
    const byName = await admin.get("/api/admin/videos?q=MAHO%20SHOJO");
    assert.deepEqual(byName.body.items.map((x) => x.id), [viaAlias.id]);
    assert.equal(byName.body.total, 1);
    // Title, accents and case ignored both ways.
    assert.deepEqual((await admin.get("/api/admin/videos?q=episode%20special")).body.items.map((x) => x.id), [accented.id]);
    assert.deepEqual((await admin.get("/api/admin/videos?q=T%C3%93QUIO")).body.items.map((x) => x.id), [accented.id]);

    const naruto = await allPages(admin, "/api/admin/videos?q=shippuden", 4);
    assert.ok(naruto.every((p) => p.total === 13));
    assert.equal(new Set(naruto.flatMap((p) => p.items.map((x) => x.id))).size, 13);
    assert.equal((await admin.get("/api/admin/videos?q=shippuden&status=pending")).body.total, 0);
    assert.equal((await admin.get("/api/admin/videos?q=random%20clip&status=pending")).body.total, 4);
    assert.equal((await admin.get("/api/admin/videos?q=episode%201&availability=ok")).body.total, 6, "Naruto 1, 10-13 + MSC 1");
    assert.deepEqual((await admin.get("/api/admin/videos?q=%25")).body, { items: [], total: 0 }, "no LIKE wildcards");
    assert.deepEqual((await admin.get("/api/admin/videos?q=zzz")).body, { items: [], total: 0 });
  });

  test("videos: validation lists every bad field", async () => {
    assertValidation(
      await admin.get(`/api/admin/videos?status=nope&availability=gone&q=${"x".repeat(81)}&limit=101&offset=-5`),
      ["availability", "limit", "offset", "q", "status"]
    );
    assertValidation(await admin.get("/api/admin/videos?status=pending&status=published"), ["status"]);
    assertValidation(await admin.get("/api/admin/videos?limit=0"), ["limit"]);
    assert.equal((await admin.get("/api/admin/videos?status=&availability=&q=")).body.total, 19, "blank = no filter");
  });
});

test("migration 9 fills title_search for existing videos", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crwn-title-"));
  const file = path.join(dir, "old.db");
  try {
    const old = openDatabase(file, { seedCatalog: false, migrateTo: 8 });
    old.prepare("INSERT INTO series (id, slug, name, search_text) VALUES (1, 'kimetsu', 'Kimetsu no Yaiba', '|kimetsu no yaiba|')").run();
    old.prepare(`INSERT INTO videos (youtube_video_id, source_title, section, series_id, number, status, published_at)
      VALUES ('aaaaaaaaaaa', 'Demon Slayer — Episódio 1 (Dublado)', 'anime', 1, 1, 'published', '2026-01-01T00:00:00.000Z')`).run();
    old.close();

    const db = openDatabase(file);
    try {
      assert.equal(db.prepare("SELECT title_search FROM videos").pluck().get(), "demon slayer episodio 1 dublado");
      const repo = createRepository(db);
      const page = (q) => repo.adminVideosPage({ needle: q, limit: 10, offset: 0 });
      assert.equal(page("episodio 1").total, 1);
      assert.equal(page("kimetsu").total, 1);
      assert.equal(page("dublado x").total, 0);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
