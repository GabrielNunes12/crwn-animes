import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { addVideo, signUp, startServer, vid } from "./helpers.js";

describe("admin", () => {
  let srv;
  let admin;
  let user;
  before(async () => {
    srv = await startServer();
    admin = await signUp(srv, { email: "admin@example.com", displayName: "Boss" });
    user = await signUp(srv, { email: "fan@example.com", displayName: "Fan" });
  });
  after(() => srv.close());

  test("creating a series publishes the pending videos that name it", async () => {
    srv.fake.titles[vid(1)] = "Frieren Episode 1 English Sub";
    const added = await admin.post("/api/admin/videos", { url: `https://youtu.be/${vid(1)}?t=3` });
    assert.equal(added.status, 201);
    assert.equal(added.body.video.status, "pending");
    assert.equal(added.body.video.route, null);
    assert.equal(added.body.video.channel, "Test Channel");
    assert.ok(added.body.video.classification.reasons.length);

    const dup = await admin.post("/api/admin/videos", { url: vid(1) });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, "CONFLICT");
    assert.equal(dup.body.error.details.video.id, added.body.video.id);

    const created = await admin.post("/api/admin/series", {
      name: "  Frieren: Beyond Journey's End ",
      aliases: ["Frieren", " Sousou no Frieren ", "frieren"],
      genres: ["Fantasy", "Adventure", "fantasy"],
      synopsis: "An elf mage outlives her party.",
      coverUrl: "https://example.com/frieren.jpg",
    });
    assert.equal(created.status, 201);
    const { series, published } = created.body;
    assert.equal(series.slug, "frieren-beyond-journey-s-end");
    assert.equal(series.name, "Frieren: Beyond Journey's End");
    assert.deepEqual(series.aliases, ["Frieren", "Sousou no Frieren"]);
    assert.deepEqual(series.genres, ["Fantasy", "Adventure"]);
    assert.equal(published.length, 1);
    assert.equal(published[0].route, "/anime/frieren-beyond-journey-s-end/episode/1");
    assert.ok(published[0].publishedAt);

    const conflict = await admin.post("/api/admin/series", { name: "Frieren Beyond Journey S End" });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, "CONFLICT");
  });

  test("series validation", async () => {
    const res = await admin.post("/api/admin/series", {
      name: "",
      slug: "Bad Slug",
      aliases: ["ok", 3],
      genres: "Shonen",
      coverUrl: "javascript:alert(1)",
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "VALIDATION_ERROR");
    assert.deepEqual(Object.keys(res.body.error.details).sort(), ["aliases", "coverUrl", "genres", "name", "slug"]);
  });

  test("PATCH series renames, re-slugs and reclassifies", async () => {
    const created = (await admin.post("/api/admin/series", { name: "Dandadan", slug: "dan-da-dan" })).body.series;
    await addVideo(srv, 2, "Dan Da Dan Episode 4");
    const patched = await admin.patch(`/api/admin/series/${created.id}`, { aliases: ["Dan Da Dan"], genres: ["Comedy"] });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.series.slug, "dan-da-dan");
    assert.deepEqual(patched.body.series.genres, ["Comedy"]);
    assert.equal(patched.body.published.length, 1);
    assert.equal(patched.body.published[0].route, "/anime/dan-da-dan/episode/4");

    const taken = await admin.patch(`/api/admin/series/${created.id}`, { slug: "one-piece" });
    assert.equal(taken.status, 409);
    assert.equal((await admin.patch("/api/admin/series/99999", { name: "X" })).status, 404);
    assert.equal((await admin.get("/api/admin/series")).body.find((s) => s.id === created.id).name, "Dandadan");
  });

  test("slot conflict keeps the second video pending; override fixes it", async () => {
    const first = await admin.post("/api/admin/videos", { url: vid(3), title: "Bleach Episode 20" });
    const second = await admin.post("/api/admin/videos", { url: vid(4), title: "BLEACH episode 20 (reupload)" });
    assert.equal(first.body.video.status, "published");
    assert.equal(second.body.video.status, "pending");
    assert.match(second.body.video.classification.reasons.join(" "), /already has a published video/);

    const fixed = await admin.patch(`/api/admin/videos/${second.body.video.id}`, { number: 21 });
    assert.equal(fixed.status, 200);
    assert.equal(fixed.body.video.status, "published");
    assert.equal(fixed.body.video.route, "/anime/bleach/episode/21");
    assert.deepEqual(fixed.body.video.overrides, { number: 21 });

    const cleared = await admin.patch(`/api/admin/videos/${second.body.video.id}`, { number: null });
    assert.equal(cleared.body.video.status, "pending");
    assert.deepEqual(cleared.body.video.overrides, {});

    const bad = await admin.patch(`/api/admin/videos/${second.body.video.id}`, { section: "drama", season: 0, seriesSlug: "Nope!" });
    assert.equal(bad.status, 400);
    assert.deepEqual(Object.keys(bad.body.error.details).sort(), ["season", "section", "seriesSlug"]);
    const unknownSeries = await admin.patch(`/api/admin/videos/${second.body.video.id}`, { seriesSlug: "no-such-series" });
    assert.equal(unknownSeries.status, 400);
    assert.ok(unknownSeries.body.error.details.seriesSlug);

    const pending = await admin.get("/api/admin/videos?status=pending");
    assert.ok(pending.body.every((v) => v.status === "pending"));
    assert.equal((await admin.get("/api/admin/videos?status=nope")).status, 400);
  });

  test("POST videos: invalid URL 400, YouTube errors map to 404/422/502", async () => {
    const invalid = await admin.post("/api/admin/videos", { url: "https://vimeo.com/1" });
    assert.equal(invalid.status, 400);
    srv.fake.gone.add(vid(90));
    const gone = await admin.post("/api/admin/videos", { url: vid(90) });
    assert.equal(gone.status, 404);
    srv.fake.down = true;
    const down = await admin.post("/api/admin/videos", { url: vid(91) });
    srv.fake.down = false;
    assert.equal(down.status, 502);
    assert.equal(down.body.error.code, "UPSTREAM_ERROR");
  });

  test("deleting a series deletes its videos and their ratings", async () => {
    const series = (await admin.post("/api/admin/series", { name: "Sakamoto Days" })).body.series;
    const video = await addVideo(srv, 5, "Sakamoto Days Episode 1");
    assert.equal(video.status, "published");
    assert.equal((await user.put(`/api/videos/${video.id}/rating`, { score: 4 })).status, 200);
    assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM rating_activity WHERE video_id = ?").get(video.id).n, 1);

    assert.equal((await admin.del(`/api/admin/series/${series.id}`)).status, 204);
    assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM videos WHERE id = ?").get(video.id).n, 0);
    assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM ratings WHERE video_id = ?").get(video.id).n, 0);
    assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM rating_activity WHERE video_id = ?").get(video.id).n, 0);
    assert.equal((await srv.client().get(`/api/videos/${video.id}`)).status, 404);
    assert.equal((await admin.del(`/api/admin/series/${series.id}`)).status, 404);
  });

  test("DELETE video", async () => {
    const video = await addVideo(srv, 6, "Random upload with no series");
    assert.equal((await admin.del(`/api/admin/videos/${video.id}`)).status, 204);
    assert.equal((await admin.del(`/api/admin/videos/${video.id}`)).status, 404);
  });
});

describe("admin bulk add, health check and URL swap", () => {
  let srv;
  let admin;
  beforeEach(async () => {
    if (srv) await srv.close();
    srv = await startServer();
    admin = await signUp(srv, { email: "admin@example.com" });
  });
  after(() => srv.close());

  test("dryRun previews without storing; then create", async () => {
    srv.fake.titles[vid(10)] = "One Piece Episode 1100";
    srv.fake.titles[vid(11)] = "One Piece Episode 1101";
    srv.fake.titles[vid(12)] = "One Piece Episode 1100 reupload";
    srv.fake.gone.add(vid(13));
    await addVideo(srv, 14, "One Piece Episode 5");

    const text = [
      `New episodes: https://www.youtube.com/watch?v=${vid(10)}, https://youtu.be/${vid(11)}`,
      vid(12),
      `https://youtu.be/${vid(10)}?t=1 (same as the first)`,
      `https://youtube.com/watch?v=broken`,
      `https://youtu.be/${vid(13)}`,
    ].join("\n");
    const body = { text, urls: [vid(14)], dryRun: true };

    const preview = await admin.post("/api/admin/videos/bulk", body);
    assert.equal(preview.status, 200);
    const outcomes = preview.body.results.map((r) => [r.youtubeVideoId, r.outcome]);
    assert.deepEqual(outcomes, [
      [vid(10), "would-create"],
      [vid(11), "would-create"],
      [vid(12), "would-create"],
      [null, "invalid"],
      [vid(13), "unavailable"],
      [vid(14), "duplicate"],
    ]);
    const [p10, , p12] = preview.body.results;
    assert.equal(p10.preview.route, "/anime/one-piece/episode/1100");
    assert.equal(p10.preview.status, "published");
    assert.equal(p12.preview.status, "pending", "same slot as an earlier row in the batch");
    assert.ok(Array.isArray(p12.preview.reasons));
    assert.equal(preview.body.results[5].video.youtubeVideoId, vid(14));
    assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM videos").get().n, 1, "dry run stores nothing");

    const created = await admin.post("/api/admin/videos/bulk", { ...body, dryRun: false });
    const createdOutcomes = created.body.results.map((r) => r.outcome);
    assert.deepEqual(createdOutcomes, ["created", "created", "created", "invalid", "unavailable", "duplicate"]);
    assert.equal(created.body.results[0].video.route, "/anime/one-piece/episode/1100");
    assert.equal(created.body.results[2].video.status, "pending");
    assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM videos").get().n, 4);
  });

  test("bulk: defaults apply, limits and validation", async () => {
    srv.fake.titles[vid(20)] = "Chapter 12 full reading";
    const res = await admin.post("/api/admin/videos/bulk", {
      urls: [vid(20)],
      defaults: { section: "manga", seriesSlug: "chainsaw-man" },
    });
    assert.equal(res.body.results[0].video.route, "/manga/chainsaw-man/chapter/12");

    const tooMany = await admin.post("/api/admin/videos/bulk", { urls: Array.from({ length: 51 }, (_, i) => vid(100 + i)) });
    assert.equal(tooMany.status, 400);
    const none = await admin.post("/api/admin/videos/bulk", { text: "nothing here" });
    assert.equal(none.status, 400);
    const badDefaults = await admin.post("/api/admin/videos/bulk", { urls: [vid(21)], defaults: { seriesSlug: "missing" } });
    assert.equal(badDefaults.status, 400);
    assert.ok(badDefaults.body.error.details["defaults.seriesSlug"]);
  });

  test("bulk lookups run at most 3 at a time", async () => {
    let active = 0;
    let peak = 0;
    const { createVideoService } = await import("../src/videoService.js");
    const slow = createVideoService({
      repo: srv.services.repo,
      fetchVideoInfo: async (id) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return { title: `Title ${id}`, channel: null };
      },
    });
    const results = await slow.bulk(
      Array.from({ length: 10 }, (_, i) => ({ input: vid(200 + i), youtubeVideoId: vid(200 + i) })),
      { dryRun: true }
    );
    assert.equal(results.length, 10);
    assert.equal(peak, 3);
  });

  test("health check marks removed videos unavailable and hides them from discovery", async () => {
    const a = await addVideo(srv, 30, "One Piece Episode 30");
    const b = await addVideo(srv, 31, "One Piece Episode 31");
    srv.fake.gone.add(vid(31));

    const res = await admin.post("/api/admin/videos/health-check");
    assert.equal(res.status, 200);
    assert.equal(res.body.checked, 2);
    assert.deepEqual(res.body.unavailable.map((v) => v.id), [b.id]);
    assert.equal(res.body.unavailable[0].availability, "unavailable");

    const filtered = await admin.get("/api/admin/videos?availability=unavailable&status=published");
    assert.deepEqual(filtered.body.map((v) => v.id), [b.id]);
    const latest = await srv.client().get("/api/latest");
    assert.deepEqual(latest.body.map((v) => v.id), [a.id]);
    const page = await srv.client().get("/api/anime/series/one-piece");
    assert.equal(page.body.videos.length, 2, "series pages still list unavailable videos");
    assert.equal(page.body.videos.find((v) => v.id === b.id).availability, "unavailable");

    // A network failure does not mark anything.
    srv.fake.down = true;
    const down = await admin.post("/api/admin/videos/health-check");
    assert.equal(down.body.checked, 0);
    assert.equal(down.body.unavailable.length, 1);
  });

  test("PATCH { url } swaps the YouTube ID, keeping route and ratings", async () => {
    const fan = await signUp(srv, { email: "fan2@example.com" });
    const video = await addVideo(srv, 40, "Bleach Episode 40");
    await fan.put(`/api/videos/${video.id}/rating`, { score: 5, reaction: "fire" });
    srv.services.repo.setAvailability(video.id, "unavailable");

    srv.fake.gone.add(vid(41));
    const gone = await admin.patch(`/api/admin/videos/${video.id}`, { url: vid(41) });
    assert.equal(gone.status, 404);

    const other = await addVideo(srv, 42, "Something else");
    const taken = await admin.patch(`/api/admin/videos/${video.id}`, { url: vid(42) });
    assert.equal(taken.status, 409);
    assert.equal(taken.body.error.details.video.id, other.id);

    const swapped = await admin.patch(`/api/admin/videos/${video.id}`, { url: `https://www.youtube.com/watch?v=${vid(43)}` });
    assert.equal(swapped.status, 200);
    assert.equal(swapped.body.video.youtubeVideoId, vid(43));
    assert.equal(swapped.body.video.thumbnailUrl, `https://i.ytimg.com/vi/${vid(43)}/hqdefault.jpg`);
    assert.equal(swapped.body.video.route, video.route);
    assert.equal(swapped.body.video.availability, "ok");
    assert.deepEqual(swapped.body.video.rating, { average: 5, count: 1 });
  });
});
