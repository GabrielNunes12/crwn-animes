// v1.4: the 7-day trash. DELETE on a series/video moves it to the trash; it
// vanishes from every public read, the normal admin lists and every aggregate,
// keeps its ratings until it is restored, deleted forever or purged.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { openDatabase } from "../src/db.js";
import { createRatingService } from "../src/ratingService.js";
import { createRepository } from "../src/repository.js";
import { TRASH_TTL_MS, purgeTrash, startRetention } from "../src/retention.js";
import { createTrashService } from "../src/trashService.js";
import { createVideoService } from "../src/videoService.js";
import { addVideo, assertFresh, quickUser, startServer, vid } from "./helpers.js";

const DAY = 86_400_000;

/** /api/top-rated as a fresh computation over live ratings (C = 5, n >= 3, m = live mean). */
function expectedTopRated(db) {
  const rows = db
    .prepare(`
      SELECT v.id, COUNT(r.score) AS n, COALESCE(SUM(r.score), 0) AS total, v.status, v.availability
      FROM videos v LEFT JOIN ratings r ON r.video_id = v.id WHERE v.deleted_at IS NULL GROUP BY v.id`)
    .all();
  const n = rows.reduce((acc, r) => acc + r.n, 0);
  const m = n ? rows.reduce((acc, r) => acc + r.total, 0) / n : 0;
  return rows
    .filter((r) => r.n >= 3 && r.status === "published" && r.availability === "ok")
    .map((r) => ({ id: r.id, n: r.n, score: (5 * m + r.total) / (5 + r.n) }))
    .sort((a, b) => b.score - a.score || b.n - a.n || b.id - a.id)
    .map((r) => r.id);
}

async function withServer(options, fn) {
  const srv = await startServer(options);
  try {
    return await fn(srv);
  } finally {
    await srv.close();
  }
}

const ids = (res) => (Array.isArray(res.body) ? res.body : res.body.items).map((v) => v.id);

// ===================================================================== authz
describe("v1.4 admin endpoints: 401 when logged out, 403 for non-admins", () => {
  const routes = [
    ["GET", "/api/admin/trash"],
    ["POST", "/api/admin/trash/series/1/restore"],
    ["POST", "/api/admin/trash/videos/1/restore"],
    ["DELETE", "/api/admin/trash/series/1"],
    ["DELETE", "/api/admin/trash/videos/1"],
    ["PUT", "/api/admin/series/1/order", { section: "anime", season: 1, videoIds: [] }],
    ["GET", "/api/admin/videos/1/preview"],
    ["DELETE", "/api/admin/series/1"],
    ["DELETE", "/api/admin/videos/1"],
  ];
  let srv;
  let user;
  before(async () => {
    srv = await startServer();
    user = quickUser(srv, "user@example.com").client;
    await addVideo(srv, 1, "One Piece Episode 1");
  });
  after(() => srv.close());

  for (const [method, url, body] of routes) {
    test(`${method} ${url}`, async () => {
      const anon = await srv.client().request(method, url, { body });
      assert.equal(anon.status, 401, "logged out");
      assert.equal(anon.body.error.code, "UNAUTHENTICATED");
      const forbidden = await user.request(method, url, { body });
      assert.equal(forbidden.status, 403, "not an admin");
      assert.equal(forbidden.body.error.code, "FORBIDDEN");
      assert.ok(srv.services.repo.getSeriesById(1), "nothing was trashed");
      assert.ok(srv.services.repo.getVideo(1), "nothing was trashed");
    });
  }
});

// ===================================================================== public surfaces
// Each surface answers "is V (episode 1 of Hidden Show) / the series visible here?".
// V: anime, season 1, episode 1, rated 5 by three users (top-rated, trending).
// W: the same series, season 2 episode 1, rated once. O: a Bleach manga chapter.
const VIDEO_SURFACES = {
  "GET /api/latest": async (c) => ids(await c.anon.get("/api/latest?limit=50")).includes(c.V.id),
  "GET /api/latest?section=anime": async (c) => ids(await c.anon.get("/api/latest?section=anime")).includes(c.V.id),
  "GET /api/top-rated": async (c) => ids(await c.anon.get("/api/top-rated?limit=50")).includes(c.V.id),
  "GET /api/trending": async (c) => ids(await c.anon.get("/api/trending?limit=50")).includes(c.V.id),
  "GET /api/random?section=anime": async (c) => {
    for (let i = 0; i < 30; i++) {
      const res = await c.anon.get("/api/random?section=anime");
      if (res.body.video?.id === c.V.id) return true;
    }
    return false;
  },
  "GET /api/videos/:id": async (c) => (await c.anon.get(`/api/videos/${c.V.id}`)).status === 200,
  "prev of the next episode (GET /api/videos/:next)": async (c) => (await c.anon.get(`/api/videos/${c.W.id}`)).body.prev?.id === c.V.id,
  "GET /api/videos/:id/rating": async (c) => (await c.anon.get(`/api/videos/${c.V.id}/rating`)).status === 200,
  "PUT /api/videos/:id/rating": async (c) => (await c.raters[0].put(`/api/videos/${c.V.id}/rating`, { score: 5 })).status === 200,
  "DELETE /api/videos/:id/rating": async (c) => (await c.nonRater.del(`/api/videos/${c.V.id}/rating`)).status === 200,
  "series page videos (GET /api/anime/series/:slug)": async (c) =>
    ids({ body: (await c.anon.get("/api/anime/series/hidden-show")).body?.videos ?? [] }).includes(c.V.id),
  "series page seasons": async (c) => ((await c.anon.get("/api/anime/series/hidden-show")).body?.seasons ?? []).includes(1),
  "GET /api/search: series videoCount": async (c) =>
    (await c.anon.get("/api/search?q=hidden&section=anime")).body.items[0]?.videoCount === 2,
  "GET /api/search: series rating counts V's ratings": async (c) =>
    (await c.anon.get("/api/search?q=hidden&section=anime")).body.items[0]?.rating.count === 4,
  "GET /api/anime/series: videoCount": async (c) =>
    (await c.anon.get("/api/anime/series?q=hidden")).body.find((s) => s.slug === "hidden-show")?.videoCount === 2,
  "GET /api/sections: videoCount": async (c) =>
    (await c.anon.get("/api/sections")).body.find((s) => s.section === "anime").videoCount === 2,
  "GET /sitemap.xml: episode URL": async (c) =>
    (await c.anon.get("/sitemap.xml")).text.includes("http://app.test/anime/hidden-show/episode/1<"),
  "SEO page /anime/hidden-show/episode/1": async (c) => (await c.anon.get("/anime/hidden-show/episode/1")).status === 200,
  "GET /api/admin/videos (normal admin list)": async (c) => ids(await c.admin.get("/api/admin/videos?q=hidden")).includes(c.V.id),
  "GET /api/admin/videos?status=published": async (c) =>
    ids(await c.admin.get("/api/admin/videos?status=published")).includes(c.V.id),
  "GET /api/me/export: rating still listed, route only while live": async (c) => {
    const res = await c.raters[1].get("/api/me/export");
    const entry = JSON.parse(res.text).ratings.find((r) => r.videoId === c.V.id);
    assert.ok(entry, "the rating is always in the export");
    assert.equal(entry.score, 5);
    return entry.route === "/anime/hidden-show/episode/1";
  },
};

const SERIES_SURFACES = {
  "GET /api/search?q=hidden": async (c) => (await c.anon.get("/api/search?q=hidden")).body.total > 0,
  "GET /api/search (browse)": async (c) =>
    (await c.anon.get("/api/search?limit=50")).body.items.some((i) => i.slug === "hidden-show"),
  "GET /api/anime/series": async (c) => (await c.anon.get("/api/anime/series")).body.some((s) => s.slug === "hidden-show"),
  "GET /api/anime/series/:slug": async (c) => (await c.anon.get("/api/anime/series/hidden-show")).status === 200,
  "GET /api/genres": async (c) => (await c.anon.get("/api/genres")).body.includes("Exclusivo"),
  "GET /api/search?genre=": async (c) => (await c.anon.get("/api/search?genre=exclusivo")).body.total === 1,
  "SEO page /anime/hidden-show": async (c) => (await c.anon.get("/anime/hidden-show")).status === 200,
  "SEO page /genre/Exclusivo": async (c) => (await c.anon.get("/genre/Exclusivo")).status === 200,
  "GET /sitemap.xml: series + genre URLs": async (c) => {
    const xml = (await c.anon.get("/sitemap.xml")).text;
    return xml.includes("http://app.test/anime/hidden-show<") && xml.includes("http://app.test/genre/Exclusivo<");
  },
  "GET /api/admin/series (normal admin list)": async (c) => (await c.admin.get("/api/admin/series?q=hidden")).body.total === 1,
  "W (its other episode) on GET /api/videos/:id": async (c) => (await c.anon.get(`/api/videos/${c.W.id}`)).status === 200,
  "W in GET /api/admin/videos": async (c) => ids(await c.admin.get("/api/admin/videos?q=hidden")).includes(c.W.id),
};

describe("a trashed video/series vanishes from every public surface and the admin lists; restoring brings it back", () => {
  let srv;
  let dir;
  const seen = {};
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "crwn-trash-"));
    fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><html><head><title>Crwn Animes</title></head><body></body></html>");
    srv = await startServer({ config: { clientDist: dir } });
    const { db } = srv;
    const c = { anon: srv.client(), admin: quickUser(srv, "admin@example.com", "admin").client };
    const series = await c.admin.post("/api/admin/series", { name: "Hidden Show", genres: ["Exclusivo"] });
    assert.equal(series.status, 201);
    c.series = series.body.series;
    c.V = await addVideo(srv, 1, "Hidden Show Episode 1", { section: "anime", seriesSlug: "hidden-show", season: 1, number: 1 });
    c.W = await addVideo(srv, 2, "Hidden Show S2 Episode 1", { section: "anime", seriesSlug: "hidden-show", season: 2, number: 1 });
    await addVideo(srv, 3, "x", { section: "manga", seriesSlug: "bleach", number: 1 });
    assert.equal(c.V.status, "published");
    assert.equal(c.W.status, "published");
    const raters = [0, 1, 2].map((i) => quickUser(srv, `rater${i}@example.com`));
    c.raters = raters.map((r) => r.client);
    c.nonRater = quickUser(srv, "nobody@example.com").client;
    for (const r of c.raters) assert.equal((await r.put(`/api/videos/${c.V.id}/rating`, { score: 5 })).status, 200);
    assert.equal((await c.raters[0].put(`/api/videos/${c.W.id}/rating`, { score: 3 })).status, 200);

    const snapshot = async () => {
      const out = {};
      for (const [name, check] of Object.entries({ ...VIDEO_SURFACES, ...SERIES_SURFACES })) out[name] = await check(c);
      return out;
    };
    const scenarios = {
      video: [() => c.admin.del(`/api/admin/videos/${c.V.id}`), () => c.admin.post(`/api/admin/trash/videos/${c.V.id}/restore`)],
      series: [() => c.admin.del(`/api/admin/series/${c.series.id}`), () => c.admin.post(`/api/admin/trash/series/${c.series.id}/restore`)],
    };
    for (const [scenario, [trash, restore]] of Object.entries(scenarios)) {
      const states = [await snapshot()];
      assertFresh(db, `${scenario}: before`);
      assert.equal((await trash()).status, 204);
      assertFresh(db, `${scenario}: trashed`);
      states.push(await snapshot());
      const restored = await restore();
      assert.equal(restored.status, 200, restored.text);
      assertFresh(db, `${scenario}: restored`);
      states.push(await snapshot());
      seen[scenario] = states;
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ratings WHERE video_id = ?").get(c.V.id).n, 3, "ratings survived both trips");
  });
  after(async () => {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const column = (states, name) => states.map((s) => s[name]);
  for (const name of Object.keys(VIDEO_SURFACES)) {
    test(`V: ${name}`, () => {
      assert.deepEqual(column(seen.video, name), [true, false, true], "V trashed, then restored");
      assert.deepEqual(column(seen.series, name), [true, false, true], "its series trashed, then restored");
    });
  }
  for (const name of Object.keys(SERIES_SURFACES)) {
    test(`series: ${name}`, () => {
      assert.deepEqual(column(seen.video, name), [true, true, true], "only one of its videos was trashed");
      assert.deepEqual(column(seen.series, name), [true, false, true], "series trashed, then restored");
    });
  }
});

// ===================================================================== aggregates
describe("aggregates equal fresh recounts through trash / restore / purge cycles", () => {
  test("trash, rate, account deletion, series trash, 409, restores, purge, delete forever, hard deletes", () =>
    withServer({}, async (srv) => {
      const { db } = srv;
      const { repo, ratings, trash } = srv.services;
      const check = (step) => {
        assertFresh(db, step);
        assert.deepEqual(repo.listTopRated({ limit: 50 }).map((v) => v.id), expectedTopRated(db), `${step}: /top-rated`);
      };
      repo.createSeries({ slug: "alpha", name: "Alpha" });
      repo.createSeries({ slug: "beta", name: "Beta" });
      const put = (n, slug, section, number, season = 1) => addVideo(srv, n, "t", { section, seriesSlug: slug, number, season });
      const a1 = await put(1, "alpha", "anime", 1);
      const a2 = await put(2, "alpha", "anime", 2);
      const a3 = await put(3, "alpha", "manga", 1);
      const a4 = await put(4, "alpha", "anime", 1, 2);
      const b1 = await put(5, "beta", "anime", 1);
      const pending = await addVideo(srv, 6, "no series named here");
      assert.equal(pending.status, "pending");
      const users = Array.from({ length: 5 }, (_, i) => quickUser(srv, `u${i}@example.com`).id);
      const rate = (u, video, score) => ratings.set(users[u], video.id, { score, reaction: "fire" });
      for (let u = 0; u < 5; u++) {
        rate(u, a1, 5);
        rate(u, b1, 1 + u);
        if (u < 3) rate(u, a2, 4);
        if (u < 4) rate(u, a3, 2);
        rate(u, a4, 3);
      }
      check("start");

      trash.trashVideo(a1.id);
      check("a1 trashed");
      rate(0, b1, 5);
      ratings.remove(users[1], b1.id);
      check("ratings changed while a1 is in the trash");
      ratings.removeAllForUser(users[2]); // had ratings on trashed a1 and live videos
      srv.services.auth.users.deleteUser(users[2]);
      check("account with ratings on a trashed video deleted");
      trash.trashSeries(repo.getSeries("alpha").id);
      check("series alpha trashed (a1 already in the trash on its own)");
      assert.throws(() => trash.restoreVideo(a2.id), (e) => e.status === 409, "trashed with its series");
      assert.throws(() => trash.restoreVideo(a1.id), (e) => e.status === 409, "its series is in the trash");
      check("refused restores change nothing");
      const back = trash.restoreSeries(repo.getAnySeriesById(a2.seriesId).id);
      assert.deepEqual(back.published.map((v) => v.id).sort(), [a2.id, a3.id, a4.id].sort());
      assert.deepEqual(back.pending, []);
      assert.equal(repo.getVideo(a1.id), null, "a1 was trashed on its own: still in the trash");
      check("series alpha restored");
      assert.equal(trash.restoreVideo(a1.id).status, "published");
      check("a1 restored");
      rate(3, a1, 1);
      check("rated after the restore");

      trash.trashVideo(a2.id);
      trash.trashSeries(repo.getSeries("beta").id);
      check("a2 and series beta trashed");
      assert.deepEqual(purgeTrash(db, new Date(Date.now() + 6 * DAY)), { series: 0, videos: 0 });
      check("nothing is 7 days old yet");
      assert.deepEqual(purgeTrash(db, new Date(Date.now() + TRASH_TTL_MS + 60_000)), { series: 1, videos: 1 });
      for (const v of [a2, b1]) {
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM videos WHERE id = ?").get(v.id).n, 0);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ratings WHERE video_id = ?").get(v.id).n, 0, "ratings purged");
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rating_activity WHERE video_id = ?").get(v.id).n, 0);
      }
      check("purged after 7 days");

      trash.trashVideo(a3.id);
      trash.deleteVideoForever(a3.id);
      check("a3 deleted forever");
      trash.trashVideo(a4.id);
      repo.deleteVideo(a4.id); // a hard delete of a trashed video
      check("trashed video hard-deleted");
      repo.deleteVideo(a1.id); // a hard delete of a live, rated video (BEFORE DELETE takes it out of the totals)
      check("live video hard-deleted");
      const c1 = await put(7, "chainsaw-man", "anime", 1);
      for (let u = 0; u < 4; u++) if (u !== 2) rate(u, c1, 4);
      check("new rated video");
      repo.deleteSeries(repo.getSeries("chainsaw-man").id); // hard delete: cascade
      check("live series hard-deleted");
      assert.deepEqual(db.prepare("SELECT n, total FROM rating_totals").get(), { n: 0, total: 0 });
    }));
});

// ===================================================================== restore paths
describe("restore", () => {
  let srv;
  let admin;
  before(async () => {
    srv = await startServer();
    admin = quickUser(srv, "admin@example.com", "admin").client;
    srv.services.repo.createSeries({ slug: "slot-show", name: "Slot Show" });
  });
  after(() => srv.close());

  test("a video whose slot was taken meanwhile comes back pending, with the reason", async () => {
    const first = await addVideo(srv, 1, "Slot Show Episode 1");
    assert.equal(first.route, "/anime/slot-show/episode/1");
    assert.equal((await admin.del(`/api/admin/videos/${first.id}`)).status, 204);
    const second = await addVideo(srv, 2, "Slot Show Episode 1 (reupload)");
    assert.equal(second.status, "published", "the trashed video does not hold the slot");
    const res = await admin.post(`/api/admin/trash/videos/${first.id}/restore`);
    assert.equal(res.status, 200);
    assert.equal(res.body.video.id, first.id);
    assert.equal(res.body.video.status, "pending");
    assert.equal(res.body.video.route, null);
    assert.match(res.body.video.classification.reasons.at(-1), /trash.*Episode 1 \(season 1\) of slot-show already has a published video/);
    assert.equal(res.body.video.deletedAt, undefined, "live again");
    assert.equal(srv.services.repo.getVideo(second.id).status, "published", "the new one keeps the slot");
    assert.equal((await admin.post(`/api/admin/trash/videos/${first.id}/restore`)).status, 404, "not in the trash any more");
    assertFresh(srv.db, "slot conflict");
  });

  test("a video whose series is in the trash: 409 CONFLICT, it stays in the trash", async () => {
    const lone = await addVideo(srv, 10, "Slot Show Episode 10");
    const withSeries = await addVideo(srv, 11, "Slot Show Episode 11");
    assert.equal((await admin.del(`/api/admin/videos/${lone.id}`)).status, 204);
    const seriesId = lone.seriesId;
    assert.equal((await admin.del(`/api/admin/series/${seriesId}`)).status, 204);
    for (const video of [lone, withSeries]) {
      const res = await admin.post(`/api/admin/trash/videos/${video.id}/restore`);
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, "CONFLICT");
      assert.equal(res.body.error.details.series.slug, "slot-show");
      assert.ok(res.body.error.details.series.deletedAt);
      assert.equal(srv.services.repo.getVideo(video.id), null);
    }
    const trash = (await admin.get("/api/admin/trash")).body;
    assert.deepEqual(trash.videos.map((v) => v.id).filter((id) => id === lone.id || id === withSeries.id), [lone.id], "only the lone one is listed apart");
    assert.equal(trash.series.find((s) => s.id === seriesId).videoCount, 3, "episodes 1 (pending), 1 (reupload) and 11 went with the series");

    const res = await admin.post(`/api/admin/trash/series/${seriesId}/restore`);
    assert.equal(res.status, 200);
    assert.equal(res.body.series.slug, "slot-show");
    assert.equal(res.body.series.deletedAt, undefined);
    assert.deepEqual(res.body.published.map((v) => v.route).sort(), ["/anime/slot-show/episode/1", "/anime/slot-show/episode/11"]);
    assert.deepEqual(res.body.pending.map((v) => v.title), ["Slot Show Episode 1"], "it was pending when the series went");
    assert.equal(srv.services.repo.getVideo(lone.id), null, "trashed on its own: stays in the trash");
    assert.equal((await admin.post(`/api/admin/trash/videos/${lone.id}/restore`)).body.video.status, "published");
    assertFresh(srv.db, "series restored");
  });

  test("restoring a series re-classifies pending videos that name it", async () => {
    srv.services.repo.createSeries({ slug: "comeback", name: "Comeback Kid" });
    const ep = await addVideo(srv, 20, "Comeback Kid Episode 1");
    assert.equal((await admin.del(`/api/admin/series/${ep.seriesId}`)).status, 204);
    const waiting = await admin.post("/api/admin/videos", { url: vid(21), title: "Comeback Kid Episode 2" });
    assert.equal(waiting.body.video.status, "pending", "a trashed series is not in the classifier's catalog");
    const named = await admin.post("/api/admin/videos", { url: vid(22), title: "x", section: "anime", seriesSlug: "comeback", number: 3 });
    assert.equal(named.status, 400, "nor can an admin route into it");
    const res = await admin.post(`/api/admin/trash/series/${ep.seriesId}/restore`);
    assert.deepEqual(res.body.published.map((v) => v.id).sort(), [ep.id, waiting.body.video.id].sort());
    assert.equal(srv.services.repo.getVideo(waiting.body.video.id).route, "/anime/comeback/episode/2");
  });

  test("unknown, live and malformed ids are 404", async () => {
    const live = await addVideo(srv, 30, "Slot Show Episode 30");
    for (const url of [
      "/api/admin/trash/videos/999999/restore",
      `/api/admin/trash/videos/${live.id}/restore`,
      "/api/admin/trash/videos/abc/restore",
      "/api/admin/trash/series/999999/restore",
      `/api/admin/trash/series/${live.seriesId}/restore`,
      "/api/admin/trash/series/0/restore",
    ]) {
      const res = await admin.post(url);
      assert.equal(res.status, 404, url);
      assert.equal(res.body.error.code, "NOT_FOUND");
    }
    assert.equal(srv.services.repo.getVideo(live.id).status, "published");
  });
});

// ===================================================================== list, delete forever, slugs
describe("trash list, delete forever, reserved slugs", () => {
  let srv;
  let admin;
  let user;
  before(async () => {
    srv = await startServer();
    admin = quickUser(srv, "admin@example.com", "admin").client;
    user = quickUser(srv, "fan@example.com");
  });
  after(() => srv.close());

  test("GET /api/admin/trash: newest first, purgeAt = deletedAt + 7 days, videos of a trashed series counted under it", async () => {
    const one = await addVideo(srv, 1, "One Piece Episode 1");
    const two = await addVideo(srv, 2, "Bleach Episode 1");
    const three = await addVideo(srv, 3, "Bleach Episode 2");
    assert.deepEqual((await admin.get("/api/admin/trash")).body, { series: [], videos: [] });
    assert.equal((await admin.del(`/api/admin/videos/${one.id}`)).status, 204);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await admin.del(`/api/admin/videos/${two.id}`)).status, 204);
    assert.equal((await admin.del(`/api/admin/series/${three.seriesId}`)).status, 204);
    const res = await admin.get("/api/admin/trash");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(res.body.videos.map((v) => v.id), [two.id, one.id], "newest first; episode 2 is under its series");
    const [series] = res.body.series;
    assert.equal(series.slug, "bleach");
    assert.equal(series.videoCount, 1, "episode 1 was trashed on its own before");
    for (const item of [series, ...res.body.videos]) {
      assert.equal(Date.parse(item.purgeAt) - Date.parse(item.deletedAt), 7 * DAY);
      assert.ok(Math.abs(Date.parse(item.deletedAt) - Date.now()) < 60_000);
    }
    const video = res.body.videos[0];
    assert.equal(video.route, null, "a trashed video has no page");
    assert.equal(video.status, "published", "what restoring brings back");
    assert.ok(video.classification && video.overrides, "admin fields");
    // Gone from the normal admin views: DELETE/PATCH again is 404.
    assert.equal((await admin.del(`/api/admin/videos/${one.id}`)).status, 404);
    assert.equal((await admin.patch(`/api/admin/videos/${one.id}`, { number: 9 })).status, 404);
    assert.equal((await admin.del(`/api/admin/series/${series.id}`)).status, 404);
    assert.equal((await admin.patch(`/api/admin/series/${series.id}`, { synopsis: "x" })).status, 404);
    assert.equal((await admin.put(`/api/admin/series/${series.id}/order`, { section: "anime", season: 1, videoIds: [] })).status, 404);
  });

  test("adding a YouTube video that is in the trash: 409, restore it instead", async () => {
    const res = await admin.post("/api/admin/videos", { url: vid(1), title: "One Piece Episode 1" });
    assert.equal(res.status, 409);
    assert.match(res.body.error.message, /trash/);
    assert.ok(res.body.error.details.video.deletedAt);
    const bulk = await admin.post("/api/admin/videos/bulk", { urls: [vid(1)] });
    assert.equal(bulk.body.results[0].outcome, "duplicate");
  });

  test("delete forever: 204, ratings go; 404 for live or unknown items", async () => {
    const { db } = srv;
    const live = await addVideo(srv, 40, "One Piece Episode 40");
    const doomed = await addVideo(srv, 41, "One Piece Episode 41");
    for (const v of [live, doomed]) srv.services.ratings.set(user.id, v.id, { score: 4, reaction: null });
    assert.equal((await admin.del(`/api/admin/trash/videos/${live.id}`)).status, 404, "not in the trash");
    assert.equal((await admin.del("/api/admin/trash/videos/999999")).status, 404);
    assert.equal((await admin.del(`/api/admin/trash/series/${live.seriesId}`)).status, 404, "live series");
    assert.equal(srv.services.repo.getVideo(live.id).status, "published");

    assert.equal((await admin.del(`/api/admin/videos/${doomed.id}`)).status, 204);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ratings WHERE video_id = ?").get(doomed.id).n, 1, "kept in the trash");
    assert.equal((await admin.del(`/api/admin/trash/videos/${doomed.id}`)).status, 204);
    assert.equal((await admin.del(`/api/admin/trash/videos/${doomed.id}`)).status, 404);
    assert.equal((await admin.get(`/api/admin/videos/${doomed.id}/preview`)).status, 404, "purged");
    for (const table of ["videos", "ratings", "rating_activity", "video_rating_stats"]) {
      const column = table === "videos" ? "id" : "video_id";
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(doomed.id).n, 0, table);
    }

    // A series: every video it still has goes, including one trashed on its own before.
    const series = srv.services.repo.getSeries("one-piece");
    assert.equal((await admin.del(`/api/admin/videos/${live.id}`)).status, 204);
    assert.equal((await admin.del(`/api/admin/series/${series.id}`)).status, 204);
    assert.equal((await admin.del(`/api/admin/trash/series/${series.id}`)).status, 204);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM videos WHERE series_id = ?").get(series.id).n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ratings WHERE video_id = ?").get(live.id).n, 0);
    assert.equal((await admin.get("/api/admin/trash")).body.videos.some((v) => v.seriesId === series.id), false);
    assertFresh(db, "deleted forever");
  });

  test("a trashed series keeps its slug reserved until deleted forever", async () => {
    const created = await admin.post("/api/admin/series", { name: "Kaiju Show" });
    assert.equal(created.status, 201);
    const id = created.body.series.id;
    assert.equal((await admin.del(`/api/admin/series/${id}`)).status, 204);
    for (const body of [{ name: "Kaiju Show" }, { name: "Káiju  show!" }, { name: "Other", slug: "kaiju-show" }]) {
      const res = await admin.post("/api/admin/series", body);
      assert.equal(res.status, 409, JSON.stringify(body));
      assert.match(res.body.error.details.slug, /trash/);
    }
    const other = (await admin.post("/api/admin/series", { name: "Other Show" })).body.series;
    const rename = await admin.patch(`/api/admin/series/${other.id}`, { slug: "kaiju-show" });
    assert.equal(rename.status, 409);
    assert.equal((await srv.client().get("/api/anime/series/kaiju-show")).status, 404, "but it is not on the site");
    assert.equal((await admin.del(`/api/admin/trash/series/${id}`)).status, 204);
    assert.equal((await admin.post("/api/admin/series", { name: "Kaiju Show" })).status, 201, "free again");
  });
});

// ===================================================================== retention
describe("retention: the trash is purged after 7 days", () => {
  test("purgeTrash(now) removes what was trashed >= 7 days before now, with its ratings; startRetention runs it", () =>
    withServer({}, async (srv) => {
      const { db } = srv;
      const { trash, ratings, repo } = srv.services;
      const user = quickUser(srv, "fan@example.com").id;
      const kept = await addVideo(srv, 1, "Bleach Episode 1");
      const old = await addVideo(srv, 2, "Bleach Episode 2");
      const series = await addVideo(srv, 3, "One Piece Episode 1");
      for (const v of [kept, old, series]) ratings.set(user, v.id, { score: 5, reaction: "love" });
      trash.trashVideo(old.id);
      trash.trashSeries(series.seriesId);
      const t0 = Date.now();
      assert.deepEqual(purgeTrash(db, new Date(t0 + 7 * DAY - 60_000)), { series: 0, videos: 0 }, "6 days 23:59");
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ratings").get().n, 3, "ratings kept while in the trash");
      assert.deepEqual(purgeTrash(db, new Date(t0 + 7 * DAY + 60_000)), { series: 1, videos: 1 });
      assert.deepEqual(db.prepare("SELECT video_id FROM ratings").all(), [{ video_id: kept.id }], "their ratings are gone");
      assert.deepEqual(db.prepare("SELECT DISTINCT video_id FROM rating_activity").all(), [{ video_id: kept.id }]);
      assert.equal(repo.getAnySeriesById(series.seriesId), null);
      assert.deepEqual(repo.listTrash(), { series: [], videos: [] });
      assert.equal(repo.getVideo(kept.id).rating.count, 1, "live videos untouched");
      assertFresh(db, "purged");

      // The hourly job: an item trashed 8 days ago goes on its first run.
      const stale = await addVideo(srv, 4, "Bleach Episode 4");
      trash.trashVideo(stale.id);
      db.prepare("UPDATE videos SET deleted_at = ? WHERE id = ?").run(new Date(t0 - 8 * DAY).toISOString(), stale.id);
      startRetention(db, { intervalMs: 3_600_000 })();
      assert.equal(repo.getAnyVideo(stale.id), null);
    }));

  test("purging leaves no copy in the write-ahead log (checkpoint, like an account deletion)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crwn-trash-wal-"));
    const file = path.join(dir, "trash.db");
    const db = openDatabase(file);
    try {
      const repo = createRepository(db);
      const videos = createVideoService({ repo, fetchVideoInfo: async () => ({ title: "x", channel: null }) });
      const trash = createTrashService({ db, repo, videos, now: () => new Date(Date.now() - 8 * DAY) });
      const ratingService = createRatingService({ db });
      db.prepare("INSERT INTO users (id, email, display_name, password_hash, privacy_accepted_at, created_at) VALUES (1, 'a@b.c', 'A', 'x', 'now', 'now')").run();
      db.pragma("wal_autocheckpoint = 0"); // keep everything in the WAL until purgeTrash checkpoints
      const ids = [];
      return (async () => {
        for (let i = 0; i < 3; i++) ids.push((await videos.add({ url: vid(i + 1), title: `Bleach Episode ${i + 1}` })).id);
        for (const id of ids) ratingService.set(1, id, { score: 3, reaction: null });
        trash.trashVideo(ids[0]);
        trash.trashSeries(repo.getSeries("bleach").id);
        assert.ok(fs.statSync(`${file}-wal`).size > 0, "writes are in the WAL");
        // The video trashed on its own belongs to the series: it goes with it (FK cascade).
        assert.deepEqual(purgeTrash(db), { series: 1, videos: 0 });
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM videos").get().n, 0);
        assert.equal(fs.statSync(`${file}-wal`).size, 0, "WAL truncated");
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ratings").get().n, 0);
      })().finally(() => {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
      });
    } catch (error) {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  });
});

// ===================================================================== migration
describe("migration 13", () => {
  test("upgrades a v12 database: same aggregates, partial indexes, trash works", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crwn-m13-"));
    const file = path.join(dir, "old.db");
    try {
      const old = openDatabase(file, { seedCatalog: false, migrateTo: 12 });
      old.prepare("INSERT INTO series (id, slug, name) VALUES (1, 'mg', 'Mg')").run();
      const insert = old.prepare(`
        INSERT INTO videos (id, youtube_video_id, source_title, section, series_id, season, number, status, published_at)
        VALUES (?, ?, 't', 'anime', 1, 1, ?, ?, '2026-01-01T00:00:00.000Z')`);
      insert.run(1, "aaaaaaaaaaa", 1, "published");
      insert.run(2, "bbbbbbbbbbb", 2, "published");
      insert.run(3, "ccccccccccc", 3, "pending");
      old.prepare("INSERT INTO users (id, email, display_name, password_hash, privacy_accepted_at, created_at) VALUES (1, 'a@b.c', 'A', 'x', 'n', 'n')").run();
      for (const v of [1, 2, 3]) old.prepare("INSERT INTO ratings (user_id, video_id, score, updated_at) VALUES (1, ?, ?, '2026-01-01T00:00:00.000Z')").run(v, v);
      const before = old.prepare("SELECT * FROM series_stats").all();
      old.close();

      const db = openDatabase(file);
      try {
        assert.equal(db.pragma("user_version", { simple: true }), 13);
        assert.deepEqual(db.prepare("SELECT * FROM series_stats").all(), before);
        assert.deepEqual(db.prepare("SELECT n, total FROM rating_totals").get(), { n: 3, total: 6 });
        const sql = (name) => db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name).sql;
        for (const name of ["videos_published_slot", "videos_status", "videos_created", "videos_status_created", "series_name"]) {
          assert.match(sql(name), /WHERE .*deleted_at IS NULL/, name);
        }
        const repo = createRepository(db);
        const trash = createTrashService({ db, repo, videos: createVideoService({ repo, fetchVideoInfo: async () => ({}) }) });
        trash.trashVideo(1);
        assert.deepEqual(db.prepare("SELECT n, total FROM rating_totals").get(), { n: 2, total: 5 });
        trash.trashSeries(1);
        assert.deepEqual(db.prepare("SELECT * FROM series_stats").all(), []);
        assert.deepEqual(db.prepare("SELECT n, total FROM rating_totals").get(), { n: 0, total: 0 });
        trash.restoreSeries(1);
        trash.restoreVideo(1);
        assert.deepEqual(db.prepare("SELECT * FROM series_stats").all(), before);
        assert.deepEqual(db.prepare("SELECT n, total FROM rating_totals").get(), { n: 3, total: 6 });
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
