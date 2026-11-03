import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { addVideo, signUp, startServer } from "./helpers.js";

const rateAll = (clients, videoId, scores) =>
  Promise.all(scores.map((score, i) => clients[i].put(`/api/videos/${videoId}/rating`, { score })));

describe("catalog", () => {
  let srv;
  let v;
  before(async () => {
    srv = await startServer();
    v = {
      op1: await addVideo(srv, 1, "One Piece Episode 1"),
      op2: await addVideo(srv, 2, "One Piece Episode 2"),
      op3: await addVideo(srv, 3, "One Piece 2nd Season Episode 1"),
      opManga: await addVideo(srv, 4, "One Piece Chapter 1100 Manga"),
      bleach: await addVideo(srv, 5, "Bleach Episode 1"),
      jjk: await addVideo(srv, 6, "JJK Episode 3 Dublado"),
      pending: await addVideo(srv, 7, "Top 10 anime fights"),
    };
  });
  after(() => srv.close());

  test("sections count published videos and series", async () => {
    const res = await srv.client().get("/api/sections");
    assert.deepEqual(res.body, [
      { section: "anime", route: "/anime", seriesCount: 3, videoCount: 5 },
      { section: "manga", route: "/manga", seriesCount: 1, videoCount: 1 },
    ]);
  });

  test("genres", async () => {
    const res = await srv.client().get("/api/genres");
    assert.deepEqual(res.body, ["Adventure", "Comedy", "Drama", "Fantasy", "Shonen"]);
  });

  test("series list: genre and q filters, unknown section 404", async () => {
    const all = await srv.client().get("/api/anime/series");
    assert.deepEqual(all.body.map((s) => s.slug), ["bleach", "jujutsu-kaisen", "one-piece"]);
    const op = all.body.find((s) => s.slug === "one-piece");
    assert.equal(op.videoCount, 3);
    assert.equal(op.route, "/anime/one-piece");
    assert.deepEqual(op.rating, { average: null, count: 0 });
    assert.ok("synopsis" in op);

    assert.deepEqual((await srv.client().get("/api/anime/series?genre=fantasy")).body.map((s) => s.slug), ["jujutsu-kaisen"]);
    assert.deepEqual((await srv.client().get("/api/anime/series?q=jjk")).body.map((s) => s.slug), ["jujutsu-kaisen"], "alias");
    assert.deepEqual((await srv.client().get("/api/anime/series?q=PIEC")).body.map((s) => s.slug), ["one-piece"]);
    assert.deepEqual((await srv.client().get("/api/manga/series")).body.map((s) => s.slug), ["one-piece"]);
    assert.equal((await srv.client().get("/api/drama/series")).status, 404);
    assert.equal((await srv.client().get("/api/drama/series/one-piece")).status, 404);
  });

  test("series page: ordered by season then number; public videos have no admin fields", async () => {
    const res = await srv.client().get("/api/anime/series/one-piece");
    assert.equal(res.status, 200);
    assert.equal(res.body.series.slug, "one-piece");
    assert.deepEqual(res.body.videos.map((x) => x.route), [
      "/anime/one-piece/episode/1",
      "/anime/one-piece/episode/2",
      "/anime/one-piece/season/2/episode/1",
    ]);
    for (const video of res.body.videos) {
      assert.equal("classification" in video, false);
      assert.equal("overrides" in video, false);
      assert.equal(video.availability, "ok");
      assert.equal(video.isNew, true);
      assert.ok(video.publishedAt);
      assert.deepEqual(video.rating, { average: null, count: 0 });
      assert.equal(video.thumbnailUrl, `https://i.ytimg.com/vi/${video.youtubeVideoId}/hqdefault.jpg`);
    }
    const empty = await srv.client().get("/api/manga/series/bleach");
    assert.deepEqual(empty.body.videos, [], "series exists, no manga yet");
    assert.equal((await srv.client().get("/api/anime/series/nope")).status, 404);
  });

  test("video page with prev/next inside series + section", async () => {
    const res = await srv.client().get(`/api/videos/${v.op2.id}`);
    assert.equal(res.body.video.id, v.op2.id);
    assert.equal(res.body.series.slug, "one-piece");
    assert.equal(res.body.prev.id, v.op1.id);
    assert.equal(res.body.next.id, v.op3.id);
    assert.equal("classification" in res.body.prev, false);
    const first = await srv.client().get(`/api/videos/${v.op1.id}`);
    assert.equal(first.body.prev, null);
    const manga = await srv.client().get(`/api/videos/${v.opManga.id}`);
    assert.equal(manga.body.prev, null);
    assert.equal(manga.body.next, null);
    assert.equal((await srv.client().get(`/api/videos/${v.pending.id}`)).status, 404, "pending is hidden");
    assert.equal((await srv.client().get("/api/videos/0")).status, 404);
  });

  test("latest: newest first, limit, validation", async () => {
    const res = await srv.client().get("/api/latest?limit=2");
    assert.deepEqual(res.body.map((x) => x.id), [v.jjk.id, v.bleach.id]);
    assert.equal((await srv.client().get("/api/latest")).body.length, 6);
    assert.equal((await srv.client().get("/api/latest?limit=500")).status, 200, "clamped to 50");
    assert.equal((await srv.client().get("/api/latest?limit=abc")).status, 400);
  });

  test("isNew is false after 7 days", async () => {
    srv.db.prepare("UPDATE videos SET published_at = ? WHERE id = ?").run(new Date(Date.now() - 8 * 86_400_000).toISOString(), v.bleach.id);
    const res = await srv.client().get(`/api/videos/${v.bleach.id}`);
    assert.equal(res.body.video.isNew, false);
  });

  test("random", async () => {
    const res = await srv.client().get("/api/random?section=manga");
    assert.equal(res.body.video.id, v.opManga.id);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal((await srv.client().get("/api/random?section=nope")).status, 400);
    srv.services.repo.setAvailability(v.opManga.id, "unavailable");
    assert.equal((await srv.client().get("/api/random?section=manga")).status, 404);
    srv.services.repo.setAvailability(v.opManga.id, "ok");
  });
});

describe("rating-driven discovery", () => {
  let srv;
  let users;
  let videos;
  before(async () => {
    srv = await startServer();
    users = await Promise.all([1, 2, 3, 4].map((i) => signUp(srv, { email: `u${i}@example.com` })));
    videos = {
      a: await addVideo(srv, 1, "One Piece Episode 1"),
      b: await addVideo(srv, 2, "One Piece Episode 2"),
      c: await addVideo(srv, 3, "One Piece Episode 3"),
      d: await addVideo(srv, 4, "One Piece Chapter 4 Manga"),
    };
    // a: 5,5,5 (n=3)  b: 5,5 (n=2, below the n >= 3 bar)  c: 4,4,4,4 (n=4)  d: 2,2,3 (manga)
    await rateAll(users, videos.a.id, [5, 5, 5]);
    await rateAll(users, videos.b.id, [5, 5]);
    await rateAll(users, videos.c.id, [4, 4, 4, 4]);
    await rateAll(users, videos.d.id, [2, 2, 3]);
  });
  after(() => srv.close());

  test("top-rated uses the Bayesian average with C = 5 and n >= 3", async () => {
    // m = (15 + 10 + 16 + 7) / 12 = 4.0
    // a: (5*4 + 15) / 8 = 4.375   c: (5*4 + 16) / 9 = 4.0   d: (5*4 + 7) / 8 = 3.375
    const res = await srv.client().get("/api/top-rated");
    assert.deepEqual(res.body.map((x) => x.id), [videos.a.id, videos.c.id, videos.d.id]);
    const anime = await srv.client().get("/api/top-rated?section=anime&limit=1");
    assert.deepEqual(anime.body.map((x) => x.id), [videos.a.id]);

    srv.services.repo.setAvailability(videos.a.id, "unavailable");
    const without = await srv.client().get("/api/top-rated?section=anime");
    assert.deepEqual(without.body.map((x) => x.id), [videos.c.id]);
    srv.services.repo.setAvailability(videos.a.id, "ok");
  });

  test("trending counts ratings of the last 7 days", async () => {
    const res = await srv.client().get("/api/trending");
    assert.deepEqual(res.body.map((x) => x.id), [videos.c.id, videos.d.id, videos.a.id, videos.b.id], "ties: most recently published first");

    // Move c's activity 10 days back: it drops out of the window.
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
    srv.db.prepare("UPDATE rating_activity SET day = ? WHERE video_id = ?").run(old, videos.c.id);
    const later = await srv.client().get("/api/trending?section=anime");
    assert.deepEqual(later.body.map((x) => x.id), [videos.a.id, videos.b.id]);

    // Removing ratings lowers today's activity.
    await users[0].del(`/api/videos/${videos.a.id}/rating`);
    await users[1].del(`/api/videos/${videos.a.id}/rating`);
    const after = await srv.client().get("/api/trending?section=anime");
    assert.deepEqual(after.body.map((x) => x.id), [videos.b.id, videos.a.id]);
  });
});
