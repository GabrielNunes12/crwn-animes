// v1.4 admin board: GET /api/admin/series/:id (board data), PUT /api/admin/series/:id/order
// (reorder / renumber one season) and GET /api/admin/videos/:id/preview (draft preview).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { resolvePage } from "../src/seo.js";
import { addVideo, assertFresh, quickUser, startServer } from "./helpers.js";

/**
 * Order Show: anime season 1 = A (1), B (5), C (10), U (20, unavailable); T (7) is in the trash and
 * P (pending, slot 1 taken); season 2 = D (1); manga = M1 (1), M2 (2). Other Show: X (anime 1).
 */
async function seedBoard(srv) {
  const { repo, trash } = srv.services;
  repo.createSeries({ slug: "order-show", name: "Order Show" });
  repo.createSeries({ slug: "other-show", name: "Other Show" });
  const put = (n, section, season, number, slug = "order-show") =>
    addVideo(srv, n, `Order Show clip ${n}`, { section, seriesSlug: slug, season, number });
  const v = {
    A: await put(1, "anime", 1, 1),
    B: await put(2, "anime", 1, 5),
    C: await put(3, "anime", 1, 10),
    U: await put(4, "anime", 1, 20),
    T: await put(5, "anime", 1, 7),
    D: await put(6, "anime", 2, 1),
    M1: await put(7, "manga", 1, 1),
    M2: await put(8, "manga", 1, 2),
    P: await put(9, "anime", 1, 1),
    X: await put(10, "anime", 1, 1, "other-show"),
    Q: await addVideo(srv, 11, "an upload naming no series"),
  };
  repo.setAvailability(v.U.id, "unavailable");
  trash.trashVideo(v.T.id);
  assert.equal(v.P.status, "pending");
  assert.ok(v.P.seriesId, "pending inside the series");
  assert.equal(v.Q.status, "pending");
  return { seriesId: v.A.seriesId, otherId: v.X.seriesId, v };
}

const numbersOf = (srv, videos) => videos.map((video) => srv.services.repo.getAnyVideo(video.id).number);

// ===================================================================== board data
describe("GET /api/admin/series/:id (board data)", () => {
  let srv;
  let admin;
  let board;
  before(async () => {
    srv = await startServer();
    admin = quickUser(srv, "admin@example.com", "admin").client;
    board = await seedBoard(srv);
  });
  after(() => srv.close());

  test("401 logged out, 403 for non-admins, 404 unknown / malformed / trashed", async () => {
    const url = `/api/admin/series/${board.seriesId}`;
    assert.equal((await srv.client().get(url)).status, 401);
    assert.equal((await quickUser(srv, "user@example.com").client.get(url)).status, 403);
    for (const bad of ["999999", "abc", "0", "1.5"]) {
      const res = await admin.get(`/api/admin/series/${bad}`);
      assert.equal(res.status, 404, bad);
      assert.equal(res.body.error.code, "NOT_FOUND");
    }
  });

  test("series with videoCounts; per section the live published videos (available or not) by season, number", async () => {
    const { v } = board;
    const res = await admin.get(`/api/admin/series/${board.seriesId}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(Object.keys(res.body).sort(), ["sections", "series"]);
    assert.equal(res.body.series.slug, "order-show");
    assert.deepEqual(res.body.series.videoCounts, { anime: 5, manga: 2 });
    assert.deepEqual(res.body.sections.anime.seasons, [1, 2]);
    assert.deepEqual(res.body.sections.anime.videos.map((x) => x.id), [v.A.id, v.B.id, v.C.id, v.U.id, v.D.id], "no trashed T, no pending P");
    assert.deepEqual(res.body.sections.manga, { seasons: [1], videos: res.body.sections.manga.videos });
    assert.deepEqual(res.body.sections.manga.videos.map((x) => x.id), [v.M1.id, v.M2.id]);
    const unavailable = res.body.sections.anime.videos.find((x) => x.id === v.U.id);
    assert.equal(unavailable.availability, "unavailable");
    for (const video of [...res.body.sections.anime.videos, ...res.body.sections.manga.videos]) {
      assert.equal(video.status, "published");
      assert.ok(video.classification && video.overrides, "admin fields");
      assert.ok(video.route);
    }
    const other = await admin.get(`/api/admin/series/${board.otherId}`);
    assert.deepEqual(other.body.sections.manga, { seasons: [], videos: [] });
  });

  test("per season it is exactly the set PUT .../order accepts", async () => {
    const res = await admin.get(`/api/admin/series/${board.seriesId}`);
    for (const section of ["anime", "manga"]) {
      for (const season of res.body.sections[section].seasons) {
        const videoIds = res.body.sections[section].videos.filter((x) => x.season === season).map((x) => x.id);
        const order = await admin.put(`/api/admin/series/${board.seriesId}/order`, { section, season, videoIds });
        assert.equal(order.status, 200, `${section} ${season}: ${order.text}`);
        assert.deepEqual(order.body.videos.map((x) => x.id), videoIds);
        // One fewer is refused.
        const short = await admin.put(`/api/admin/series/${board.seriesId}/order`, { section, season, videoIds: videoIds.slice(1) });
        assert.equal(short.status, 400);
      }
    }
  });

  test("a trashed series is a 404 (the trash endpoints show it)", async () => {
    assert.equal((await admin.del(`/api/admin/series/${board.otherId}`)).status, 204);
    assert.equal((await admin.get(`/api/admin/series/${board.otherId}`)).status, 404);
  });
});

// ===================================================================== reorder
describe("PUT /api/admin/series/:id/order", () => {
  let srv;
  let admin;
  let board;
  before(async () => {
    srv = await startServer();
    admin = quickUser(srv, "admin@example.com", "admin").client;
    board = await seedBoard(srv);
  });
  after(() => srv.close());

  const url = () => `/api/admin/series/${board.seriesId}/order`;
  const season1 = () => [board.v.A, board.v.B, board.v.C, board.v.U];

  test("strict validation: every bad body is a 400 and changes nothing", async () => {
    const { A, B, C, U, D, P, T, X, M1 } = board.v;
    const all = [A.id, B.id, C.id, U.id];
    const cases = [
      [{}, ["section", "season", "videoIds"]],
      [{ section: "movie", season: 1, videoIds: all }, ["section"]],
      [{ section: "anime", season: 0, videoIds: all }, ["season"]],
      [{ section: "anime", season: 100, videoIds: all }, ["season"]],
      [{ section: "anime", season: "1", videoIds: all }, ["season"]],
      [{ section: "anime", season: 1.5, videoIds: all }, ["season"]],
      [{ section: "anime", season: null, videoIds: all }, ["season"]],
      [{ section: "anime", videoIds: all }, ["season"]],
      [{ section: "manga", season: 2, videoIds: [M1.id] }, ["season"]],
      [{ section: "anime", season: 1 }, ["videoIds"]],
      [{ section: "anime", season: 1, videoIds: "1,2" }, ["videoIds"]],
      [{ section: "anime", season: 1, videoIds: { 0: A.id } }, ["videoIds"]],
      [{ section: "anime", season: 1, videoIds: [A.id, String(B.id), C.id, U.id] }, ["videoIds"]],
      [{ section: "anime", season: 1, videoIds: [A.id, B.id, C.id, U.id, 0] }, ["videoIds"]],
      [{ section: "anime", season: 1, videoIds: [A.id, B.id, C.id, -U.id] }, ["videoIds"]],
      [{ section: "anime", season: 1, videoIds: [A.id, B.id, C.id, U.id + 0.5] }, ["videoIds"]],
      [{ section: "anime", season: 1, videoIds: [A.id, B.id, C.id, null] }, ["videoIds"]],
      [{ section: "anime", season: 1, videoIds: [A.id, B.id, C.id, U.id, 2 ** 53] }, ["videoIds"]],
      [{ section: "anime", season: 1, videoIds: Array.from({ length: 2501 }, (_, i) => i + 1) }, ["videoIds"]],
      [{ section: "anime", season: 1, videoIds: [A.id, A.id, B.id, C.id, U.id] }, ["videoIds"], /listed twice/],
      [{ section: "anime", season: 1, videoIds: [A.id, B.id, C.id] }, ["videoIds"], /missing: \d+/],
      [{ section: "anime", season: 1, videoIds: [...all, D.id] }, ["videoIds"], /not published in this season/],
      [{ section: "anime", season: 1, videoIds: [...all, X.id] }, ["videoIds"], /not published/],
      [{ section: "anime", season: 1, videoIds: [...all, P.id] }, ["videoIds"], /not published/],
      [{ section: "anime", season: 1, videoIds: [...all, T.id] }, ["videoIds"], /not published/],
      [{ section: "anime", season: 1, videoIds: [...all, 999999] }, ["videoIds"], /not published/],
      [{ section: "anime", season: 2, videoIds: all }, ["videoIds"], /missing/],
      [{ section: "manga", season: 1, videoIds: all }, ["videoIds"]],
      [{ section: "anime", season: 3, videoIds: [A.id] }, ["videoIds"]],
    ];
    const before = numbersOf(srv, season1());
    const version = srv.services.repo.catalogVersion();
    for (const [body, fields, message] of cases) {
      const res = await admin.put(url(), body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 120));
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
      assert.deepEqual(Object.keys(res.body.error.details).sort(), [...fields].sort(), JSON.stringify(body).slice(0, 120));
      if (message) assert.match(res.body.error.details.videoIds, message);
    }
    for (const raw of ["[]", '"x"', "null"]) {
      const res = await admin.request("PUT", url(), { body: raw, raw: true, headers: { "content-type": "application/json" } });
      assert.equal(res.status, 400, raw);
    }
    assert.equal((await admin.request("PUT", url(), { body: "videoIds=1", raw: true, headers: { "content-type": "application/x-www-form-urlencoded" } })).status, 415);
    assert.deepEqual(numbersOf(srv, season1()), before, "nothing renumbered");
    assert.equal(srv.services.repo.catalogVersion(), version, "nothing written");
  });

  test("unknown, malformed and trashed series are 404", async () => {
    const body = { section: "anime", season: 1, videoIds: [] };
    assert.equal((await admin.put("/api/admin/series/999999/order", body)).status, 404);
    assert.equal((await admin.put("/api/admin/series/abc/order", body)).status, 404);
  });

  test("numbers become 1..n in the given order, atomically; routes, pages, sitemap and overrides follow", async () => {
    const { repo } = srv.services;
    const { A, B, C, U } = board.v;
    const anon = srv.client();
    const sitemapBefore = (await anon.get("/sitemap.xml")).text;
    assert.match(sitemapBefore, /\/anime\/order-show\/episode\/10</);
    const version = repo.catalogVersion();

    const res = await admin.put(url(), { section: "anime", season: 1, videoIds: [C.id, U.id, A.id, B.id] });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(res.body.videos.map((x) => [x.id, x.number, x.route]), [
      [C.id, 1, "/anime/order-show/episode/1"],
      [U.id, 2, "/anime/order-show/episode/2"],
      [A.id, 3, "/anime/order-show/episode/3"],
      [B.id, 4, "/anime/order-show/episode/4"],
    ]);
    for (const video of res.body.videos) {
      assert.equal(video.overrides.number, video.number, "pinned: re-classifying keeps it");
      assert.ok(video.classification, "admin shape");
    }
    assert.ok(repo.catalogVersion() > version, "catalog version bumped (sitemap/genre caches)");

    const page = await anon.get("/api/anime/series/order-show?season=1");
    assert.deepEqual(page.body.videos.map((x) => x.id), [C.id, U.id, A.id, B.id]);
    assert.deepEqual((await anon.get(`/api/videos/${A.id}`)).body.prev.id, U.id, "prev/next follow");
    assert.equal(resolvePage(repo, "/anime/order-show/episode/10").status, 404, "old URL: nothing there now");
    assert.equal(resolvePage(repo, "/anime/order-show/episode/5").status, 404);
    assert.equal(resolvePage(repo, "/anime/order-show/episode/1").status, 200);
    assert.equal(resolvePage(repo, "/anime/order-show/season/1/episode/3").location, "/anime/order-show/episode/3", "301 to the canonical form");
    const sitemap = (await anon.get("/sitemap.xml")).text;
    assert.doesNotMatch(sitemap, /\/anime\/order-show\/episode\/10</, "sitemap cache invalidated");
    assert.match(sitemap, /\/anime\/order-show\/episode\/4</);

    // A swap (A 3 <-> C 1) needs the temporary negative numbers: no unique-slot conflict.
    const swap = await admin.put(url(), { section: "anime", season: 1, videoIds: [A.id, U.id, C.id, B.id] });
    assert.equal(swap.status, 200, swap.text);
    assert.deepEqual(numbersOf(srv, [A, U, C, B]), [1, 2, 3, 4]);
    assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM videos WHERE number < 0").get().n, 0);

    // Later edits keep the order: the number is an admin override now.
    const patched = await admin.patch(`/api/admin/videos/${C.id}`, { season: 1 });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.video.number, 3);
    assert.equal(patched.body.video.status, "published");
    assertFresh(srv.db, "after reorders");
  });

  test("the trashed episode keeps its own number and slot check; manga and single-video seasons", async () => {
    const { T, D, M1, M2 } = board.v;
    const restored = await admin.post(`/api/admin/trash/videos/${T.id}/restore`);
    assert.equal(restored.body.video.status, "published", "slot 7 is free");
    assert.equal(restored.body.video.route, "/anime/order-show/episode/7");

    const manga = await admin.put(url(), { section: "manga", season: 1, videoIds: [M2.id, M1.id] });
    assert.deepEqual(manga.body.videos.map((x) => [x.id, x.route]), [
      [M2.id, "/manga/order-show/chapter/1"],
      [M1.id, "/manga/order-show/chapter/2"],
    ]);
    const single = await admin.put(url(), { section: "anime", season: 2, videoIds: [D.id] });
    assert.equal(single.status, 200);
    assert.equal(single.body.videos[0].route, "/anime/order-show/season/2/episode/1");
    assert.equal(single.body.videos[0].overrides.number, 1);
    assert.deepEqual((await admin.put(url(), { section: "anime", season: 3, videoIds: [] })).body, { videos: [] }, "an empty season");
  });

  test("a failure mid-way rolls everything back", async () => {
    const { repo, videos } = srv.services;
    const list = repo.listPublishedInSeries(board.seriesId, "anime", 1);
    assert.equal(list.length, 5, "A, B, C, U and the restored T");
    const before = numbersOf(srv, list);
    const version = repo.catalogVersion();
    const renumber = repo.renumber;
    repo.renumber = (rows) => {
      renumber(rows);
      throw new Error("disk full");
    };
    try {
      assert.throws(
        () => videos.reorder(board.seriesId, { section: "anime", season: 1, videoIds: [...list].reverse().map((x) => x.id) }),
        /disk full/
      );
    } finally {
      repo.renumber = renumber;
    }
    assert.deepEqual(numbersOf(srv, list), before);
    assert.equal(repo.catalogVersion(), version);
  });
});

// ===================================================================== preview
describe("GET /api/admin/videos/:id/preview", () => {
  let srv;
  let admin;
  let board;
  before(async () => {
    srv = await startServer();
    admin = quickUser(srv, "admin@example.com", "admin").client;
    board = await seedBoard(srv);
  });
  after(() => srv.close());

  const preview = (id) => admin.get(`/api/admin/videos/${id}/preview`);

  test("published: the admin video and its series", async () => {
    const res = await preview(board.v.A.id);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(Object.keys(res.body).sort(), ["series", "video"]);
    assert.equal(res.body.video.route, "/anime/order-show/episode/1");
    assert.ok(res.body.video.classification.reasons);
    assert.deepEqual(res.body.video.overrides, { section: "anime", seriesSlug: "order-show", season: 1, number: 1 });
    assert.equal(res.body.video.deletedAt, undefined);
    assert.equal(res.body.series.slug, "order-show");
  });

  test("pending: no route; with its series when it has one, else null", async () => {
    const inSeries = await preview(board.v.P.id);
    assert.equal(inSeries.body.video.status, "pending");
    assert.equal(inSeries.body.video.route, null);
    assert.match(inSeries.body.video.classification.reasons.join("\n"), /already has a published video/);
    assert.equal(inSeries.body.series.slug, "order-show");
    const lone = await preview(board.v.Q.id);
    assert.equal(lone.status, 200);
    assert.equal(lone.body.video.status, "pending");
    assert.equal(lone.body.series, null);
  });

  test("trashed video, and a video of a trashed series: deletedAt/purgeAt, no route", async () => {
    const trashed = await preview(board.v.T.id);
    assert.equal(trashed.status, 200);
    assert.ok(trashed.body.video.deletedAt);
    assert.equal(Date.parse(trashed.body.video.purgeAt) - Date.parse(trashed.body.video.deletedAt), 7 * 86_400_000);
    assert.equal(trashed.body.video.route, null);
    assert.equal(trashed.body.video.status, "published");
    assert.equal(trashed.body.series.deletedAt, undefined, "its series is live");

    assert.equal((await admin.del(`/api/admin/series/${board.otherId}`)).status, 204);
    const withSeries = await preview(board.v.X.id);
    assert.equal(withSeries.status, 200);
    assert.ok(withSeries.body.video.deletedAt);
    assert.ok(withSeries.body.series.deletedAt);
    assert.equal(withSeries.body.series.slug, "other-show");
  });

  test("purged, unknown or malformed: 404", async () => {
    assert.equal((await admin.del(`/api/admin/trash/videos/${board.v.T.id}`)).status, 204);
    for (const id of [board.v.T.id, 999999, "abc", "0", "-1"]) {
      const res = await preview(id);
      assert.equal(res.status, 404, String(id));
      assert.equal(res.body.error.code, "NOT_FOUND");
    }
  });
});
