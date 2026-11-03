import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { addVideo, signUp, startServer } from "./helpers.js";

describe("ratings", () => {
  let srv;
  let ana;
  let bob;
  let cy;
  let video;
  let pending;
  before(async () => {
    srv = await startServer();
    [ana, bob, cy] = await Promise.all([
      signUp(srv, { email: "ana@example.com" }),
      signUp(srv, { email: "bob@example.com" }),
      signUp(srv, { email: "cy@example.com" }),
    ]);
    video = await addVideo(srv, 1, "One Piece Episode 1");
    pending = await addVideo(srv, 2, "Some upload without a series");
  });
  after(() => srv.close());

  test("empty summary", async () => {
    const res = await srv.client().get(`/api/videos/${video.id}/rating`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      average: null,
      count: 0,
      distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      reactions: { fire: 0, laugh: 0, cry: 0, wow: 0, love: 0 },
      mine: null,
    });
    assert.equal(res.headers.get("cache-control"), "private, no-store");
  });

  test("summary math, replace on PUT, delete", async () => {
    assert.equal((await ana.put(`/api/videos/${video.id}/rating`, { score: 5, reaction: "fire" })).status, 200);
    await bob.put(`/api/videos/${video.id}/rating`, { score: 4, reaction: "fire" });
    const third = await cy.put(`/api/videos/${video.id}/rating`, { score: 4 });
    assert.equal(third.body.average, 4.3, "13 / 3 = 4.333 -> 4.3");
    assert.equal(third.body.count, 3);
    assert.deepEqual(third.body.distribution, { 1: 0, 2: 0, 3: 0, 4: 2, 5: 1 });
    assert.deepEqual(third.body.reactions, { fire: 2, laugh: 0, cry: 0, wow: 0, love: 0 });
    assert.deepEqual(third.body.mine, { score: 4, reaction: null });

    // PUT replaces (one rating per user per video).
    const replaced = await ana.put(`/api/videos/${video.id}/rating`, { score: 1, reaction: "cry" });
    assert.equal(replaced.body.count, 3);
    assert.equal(replaced.body.average, 3, "(1 + 4 + 4) / 3");
    assert.deepEqual(replaced.body.reactions, { fire: 1, laugh: 0, cry: 1, wow: 0, love: 0 });
    assert.deepEqual(replaced.body.mine, { score: 1, reaction: "cry" });

    // Anonymous sees no `mine`; a rater sees theirs.
    assert.equal((await srv.client().get(`/api/videos/${video.id}/rating`)).body.mine, null);
    assert.deepEqual((await bob.get(`/api/videos/${video.id}/rating`)).body.mine, { score: 4, reaction: "fire" });

    // The video object carries { average, count } everywhere.
    const page = await srv.client().get(`/api/videos/${video.id}`);
    assert.deepEqual(page.body.video.rating, { average: 3, count: 3 });
    const series = await srv.client().get("/api/anime/series");
    assert.deepEqual(series.body.find((s) => s.slug === "one-piece").rating, { average: 3, count: 3 });

    const removed = await ana.del(`/api/videos/${video.id}/rating`);
    assert.equal(removed.status, 200);
    assert.equal(removed.body.count, 2);
    assert.equal(removed.body.average, 4);
    assert.equal(removed.body.mine, null);
    assert.equal((await ana.del(`/api/videos/${video.id}/rating`)).status, 200, "deleting twice is fine");
  });

  test("invalid score / reaction -> 400", async () => {
    for (const body of [{}, { score: 0 }, { score: 6 }, { score: 4.5 }, { score: "5" }, { score: 3, reaction: "angry" }]) {
      const res = await ana.put(`/api/videos/${video.id}/rating`, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    }
    assert.equal((await ana.put(`/api/videos/${video.id}/rating`, { score: 3, reaction: null })).status, 200);
  });

  test("pending or unknown videos -> 404", async () => {
    assert.equal(pending.status, "pending");
    for (const id of [pending.id, 9999, "abc"]) {
      const put = await ana.put(`/api/videos/${id}/rating`, { score: 5 });
      assert.equal(put.status, 404);
      assert.equal(put.body.error.code, "NOT_FOUND");
      assert.equal((await srv.client().get(`/api/videos/${id}/rating`)).status, 404);
    }
  });

  test("rating_activity is anonymous and follows PUT/DELETE", async () => {
    const columns = srv.db.prepare("PRAGMA table_info(rating_activity)").all().map((c) => c.name);
    assert.deepEqual(columns, ["video_id", "day", "count", "score_sum"]);
    const row = srv.db.prepare("SELECT SUM(count) AS n, SUM(score_sum) AS s FROM rating_activity WHERE video_id = ?").get(video.id);
    const live = srv.db.prepare("SELECT COUNT(*) AS n, SUM(score) AS s FROM ratings WHERE video_id = ?").get(video.id);
    assert.deepEqual(row, live);
  });
});
