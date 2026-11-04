// v1.5 same-origin thumbnails: GET /api/thumbs/<id>.jpg (src/thumbnails.js,
// src/routes/thumbs.js). The real upstream check (fetchYoutubeThumbnail) runs
// against a fake i.ytimg.com (its fetchImpl): youtube.com / ytimg.com are never contacted.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { purgeTrash, startRetention } from "../src/retention.js";
import { THUMB_MAX_BYTES, THUMB_TIMEOUT_MS, createThumbnailCache, fetchYoutubeThumbnail } from "../src/thumbnails.js";
import { addVideo, fakeJpeg, quickUser, startServer, vid } from "./helpers.js";

const DAY = 86_400_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const thumb = (id) => `/api/thumbs/${id}.jpg`;
const upstreamUrl = (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
const idOf = (url) => /\/vi\/([^/]+)\/hqdefault\.jpg$/.exec(url)[1];
/** Size of fakeJpeg(id) for an 11-character ID (padding adds to it). */
const JPEG_SIZE = fakeJpeg(vid(0)).length;

/** Waits until `condition()` holds (polling), or fails after `ms`. */
async function until(condition, ms = 2000, what = "condition") {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** A promise with its resolve(), for holding a fake upstream answer. */
function gate() {
  let open;
  const promise = new Promise((resolve) => (open = resolve));
  return { promise, open };
}

const jpegResponse = (id, { status = 200, type = "image/jpeg", body } = {}) =>
  new Response(body ?? fakeJpeg(id), { status, headers: type ? { "content-type": type } : {} });

/** A fake i.ytimg.com: `respond(url, init)` answers (default: a JPEG); every requested URL is recorded. */
function fakeUpstream() {
  const up = { calls: [], respond: (url) => jpegResponse(idOf(url)) };
  up.fetchImpl = (url, init) => {
    up.calls.push(url);
    return up.respond(url, init);
  };
  return up;
}

/** Raw GET (binary-safe), no redirects. */
async function get(srv, p, headers = {}) {
  const res = await fetch(srv.base + p, { headers, redirect: "manual" });
  const body = Buffer.from(await res.arrayBuffer());
  let json = null;
  try {
    json = JSON.parse(body.toString("utf8"));
  } catch {
    // an image
  }
  return { status: res.status, headers: res.headers, body, json };
}

/** Files in the cache directory (none when it was never created). */
const cacheFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

/** Runs `fn` with console.log/warn/error captured; returns what was printed. */
async function captureConsole(fn) {
  const printed = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const key of Object.keys(saved)) console[key] = (...args) => printed.push(args.join(" "));
  try {
    await fn();
  } finally {
    Object.assign(console, saved);
  }
  return printed;
}

// =================================================================== HTTP
describe("GET /api/thumbs/:id.jpg", () => {
  let srv;
  let up;
  const TIMEOUT_MS = 150; // the upstream timeout while testing failures (5 s otherwise)
  before(async () => {
    up = fakeUpstream();
    up.timeoutMs = THUMB_TIMEOUT_MS;
    srv = await startServer({
      fetchThumbnail: (id) => fetchYoutubeThumbnail(id, { fetchImpl: up.fetchImpl, timeoutMs: up.timeoutMs }),
    });
    await addVideo(srv, 1, "One Piece Episode 1");
    await addVideo(srv, 2, "One Piece Episode 2");
    const trashed = await addVideo(srv, 3, "One Piece Episode 3");
    srv.services.trash.trashVideo(trashed.id);
    await addVideo(srv, 4, "Some upload nobody can classify"); // pending
    await addVideo(srv, 5, "Bleach Episode 1");
    for (let n = 101; n <= 112; n++) await addVideo(srv, n, `Naruto Episode ${n}`);
  });
  after(() => srv.close());

  test("malformed, unknown and trashed IDs: 404 JSON, ZERO upstream calls, nothing cached", async () => {
    const paths = [
      thumb(vid(99)), // well-formed, no such video
      thumb(vid(3)), // in the trash
      "/api/thumbs/short.jpg",
      `/api/thumbs/${vid(1)}x.jpg`, // 12 characters
      `/api/thumbs/${vid(1)}.png`,
      `/api/thumbs/${vid(1)}`,
      `/api/thumbs/${vid(1)}.jpg.jpg`,
      `/api/thumbs/${vid(1)}.JPG`,
      `/api/thumbs/${vid(1).toUpperCase()}.jpg`, // IDs are case-sensitive
      "/api/thumbs/..%2F..%2Fpackage.json",
      "/api/thumbs/%2e%2e%2f%2e%2e%2fsrc.jpg",
      "/api/thumbs/vid0000000%2F.jpg",
      "/api/thumbs/vid0000000%00.jpg",
      "/api/thumbs/vid0000000%20.jpg",
      `/api/thumbs/${vid(1)}.jpg%00`,
      `/api/thumbs/x/${vid(1)}.jpg`,
      "/api/thumbs/",
      "/api/thumbs",
    ];
    for (const p of paths) {
      const res = await get(srv, p);
      assert.equal(res.status, 404, p);
      assert.equal(res.json?.error?.code, "NOT_FOUND", p);
      assert.match(res.headers.get("content-type"), /^application\/json/, p);
      assert.equal(res.headers.get("cache-control"), "private, no-store", p);
    }
    assert.deepEqual(up.calls, [], "the database is asked before anything goes upstream");
    assert.deepEqual(cacheFiles(srv.thumbDir), []);
  });

  test("a live video: one upstream fetch of i.ytimg.com, the contract headers, kept on disk; repeats never go upstream", async () => {
    const before = up.calls.length;
    const res = await get(srv, thumb(vid(1)), { cookie: "sid=whatever" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, fakeJpeg(vid(1)));
    assert.equal(res.headers.get("cache-control"), "public, max-age=604800, immutable");
    assert.equal(res.headers.get("content-type"), "image/jpeg");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(res.headers.get("set-cookie"), null, "anonymous: no session work, no cookie");
    assert.deepEqual(up.calls.slice(before), [upstreamUrl(vid(1))]);
    assert.deepEqual(cacheFiles(srv.thumbDir), [`${vid(1)}.jpg`], "named after the ID, no temporary file left");
    assert.deepEqual(fs.readFileSync(path.join(srv.thumbDir, `${vid(1)}.jpg`)), fakeJpeg(vid(1)));

    for (let i = 0; i < 3; i++) {
      const again = await get(srv, thumb(vid(1)));
      assert.equal(again.status, 200);
      assert.deepEqual(again.body, fakeJpeg(vid(1)));
      assert.equal(again.headers.get("cache-control"), "public, max-age=604800, immutable");
    }
    const etag = res.headers.get("etag");
    assert.ok(etag);
    // (Node's fetch adds "Cache-Control: no-cache" to conditional requests; a browser revalidating sends max-age=0.)
    assert.equal((await get(srv, thumb(vid(1)), { "if-none-match": etag, "cache-control": "max-age=0" })).status, 304);
    assert.equal(up.calls.length, before + 1, "cache hits never go upstream");

    // Pending videos are live too (admins see them with their thumbnails).
    assert.equal((await get(srv, thumb(vid(4)))).status, 200);
    // The trashed one stays a 404 even though its ID is well-formed and known.
    assert.equal((await get(srv, thumb(vid(3)))).status, 404);
  });

  test("a cached file is served from disk by a new process, without any upstream call", async () => {
    const other = await startServer({
      config: { thumbCacheDir: srv.thumbDir },
      fetchThumbnail: async () => {
        throw new Error("must not be called");
      },
    });
    try {
      await addVideo(other, 1, "One Piece Episode 1");
      const res = await get(other, thumb(vid(1)));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, fakeJpeg(vid(1)));
      assert.equal(other.services.thumbnails.stats().files, cacheFiles(srv.thumbDir).length, "indexed from the directory");
    } finally {
      await other.close(); // the directory is the first server's: not removed
    }
    assert.ok(fs.existsSync(path.join(srv.thumbDir, `${vid(1)}.jpg`)));
  });

  test("upstream non-200, wrong type, not a JPEG, oversize, network error, timeout: 502, nothing cached, nothing logged", async () => {
    let stream = null;
    /** 64 KB chunks forever, the first starting like a JPEG; counts what was pulled. */
    const endless = () => {
      stream = { pulled: 0, cancelled: false };
      const s = stream;
      return new Response(
        new ReadableStream(
          {
            pull(controller) {
              const chunk = new Uint8Array(64 * 1024);
              if (s.pulled === 0) chunk.set([0xff, 0xd8, 0xff, 0xe0]);
              s.pulled += chunk.length;
              controller.enqueue(chunk);
            },
            cancel() {
              s.cancelled = true;
            },
          },
          { highWaterMark: 0 }
        ),
        { headers: { "content-type": "image/jpeg" } }
      );
    };
    /** Sends a JPEG start, then stalls forever. */
    const stalling = () => {
      stream = { pulled: 0, cancelled: false };
      const s = stream;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]));
          },
          pull: () => new Promise(() => {}),
          cancel() {
            s.cancelled = true;
          },
        }),
        { headers: { "content-type": "image/jpeg" } }
      );
    };
    const cases = [
      ["404 (YouTube's grey placeholder)", (url) => jpegResponse(idOf(url), { status: 404 })],
      ["500", () => new Response("oops", { status: 500, headers: { "content-type": "text/plain" } })],
      ["302", () => new Response(null, { status: 302, headers: { location: "https://evil.example/x.jpg" } })],
      ["203 with a JPEG", (url) => jpegResponse(idOf(url), { status: 203 })],
      ["image/png", (url) => jpegResponse(idOf(url), { type: "image/png" })],
      ["text/html", (url) => jpegResponse(idOf(url), { type: "text/html" })],
      ["no content-type", (url) => jpegResponse(idOf(url), { type: null })],
      ["image/jpeg that is HTML", () => jpegResponse("x", { body: "<html><script>alert(1)</script></html>" })],
      ["empty body", () => jpegResponse("x", { body: "" })],
      ["declared Content-Length over 512 KB", (url) =>
        new Response(fakeJpeg(idOf(url)), { headers: { "content-type": "image/jpeg", "content-length": String(THUMB_MAX_BYTES + 1) } })],
      ["one byte over 512 KB", (url) => jpegResponse(idOf(url), { body: fakeJpeg(idOf(url), THUMB_MAX_BYTES - JPEG_SIZE + 1) })],
      ["an endless stream (aborted past 512 KB)", endless],
      ["network error", () => Promise.reject(new TypeError("fetch failed"))],
      ["no answer within the timeout (signal honoured)", (url, init) =>
        new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)))],
      ["no answer ever (signal ignored)", () => new Promise(() => {})],
      ["a body that stalls past the timeout", stalling],
    ];
    up.timeoutMs = TIMEOUT_MS;
    const printed = await captureConsole(async () => {
      for (const [name, respond] of cases) {
        up.respond = respond;
        const before = up.calls.length;
        const started = Date.now();
        const res = await get(srv, thumb(vid(2)));
        assert.equal(res.status, 502, name);
        assert.equal(res.json?.error?.code, "UPSTREAM_ERROR", name);
        assert.doesNotMatch(res.json.error.message, /ytimg|youtube|vid0000/i, `${name}: no upstream detail`);
        assert.equal(res.headers.get("cache-control"), "private, no-store", name);
        assert.match(res.headers.get("content-type"), /^application\/json/, name);
        assert.equal(up.calls.length, before + 1, `${name}: one attempt, failures are not cached`);
        assert.ok(Date.now() - started < TIMEOUT_MS + 1500, `${name}: answered in time`);
        assert.deepEqual(cacheFiles(srv.thumbDir).filter((f) => f.startsWith(vid(2))), [], `${name}: nothing on disk`);
        if (respond === endless) {
          assert.equal(stream.cancelled, true, "the download was cancelled");
          assert.ok(stream.pulled <= THUMB_MAX_BYTES + 2 * 64 * 1024, `stopped reading at the limit (${stream.pulled} bytes)`);
        }
        if (respond === stalling) assert.equal(stream.cancelled, true, "the stalled download was cancelled");
      }
    });
    up.timeoutMs = THUMB_TIMEOUT_MS;
    assert.deepEqual(printed, [], "failures print nothing (no ID, no URL, no request detail)");
    assert.ok(cacheFiles(srv.thumbDir).every((f) => !f.endsWith(".tmp")));

    // Exactly 512 KB is allowed.
    up.respond = (url) => jpegResponse(idOf(url), { body: fakeJpeg(idOf(url), THUMB_MAX_BYTES - JPEG_SIZE) });
    const limit = await get(srv, thumb(vid(5)));
    assert.equal(limit.status, 200);
    assert.equal(limit.body.length, THUMB_MAX_BYTES);
    assert.equal(fs.statSync(path.join(srv.thumbDir, `${vid(5)}.jpg`)).size, THUMB_MAX_BYTES);

    // And the failing ID works as soon as YouTube does.
    up.respond = (url) => jpegResponse(idOf(url));
    assert.equal((await get(srv, thumb(vid(2)))).status, 200);
  });

  test("concurrent requests for one ID share ONE upstream fetch (success and failure)", async () => {
    const hold = gate();
    up.respond = async (url) => {
      await hold.promise;
      return jpegResponse(idOf(url));
    };
    const before = up.calls.length;
    const pending = Array.from({ length: 10 }, () => get(srv, thumb(vid(101))));
    await until(() => up.calls.length > before, 2000, "the upstream call");
    await sleep(30);
    hold.open();
    const results = await Promise.all(pending);
    assert.deepEqual(results.map((r) => r.status), Array(10).fill(200));
    for (const r of results) assert.deepEqual(r.body, fakeJpeg(vid(101)));
    assert.deepEqual(up.calls.slice(before), [upstreamUrl(vid(101))], "10 requests, 1 upstream fetch");

    const failing = gate();
    up.respond = async () => {
      await failing.promise;
      return new Response("no", { status: 500 });
    };
    const start = up.calls.length;
    const failed = Array.from({ length: 6 }, () => get(srv, thumb(vid(102))));
    await until(() => up.calls.length > start, 2000, "the failing upstream call");
    await sleep(30);
    failing.open();
    assert.deepEqual((await Promise.all(failed)).map((r) => r.status), Array(6).fill(502));
    assert.equal(up.calls.length, start + 1, "6 requests, 1 upstream fetch");
    up.respond = (url) => jpegResponse(idOf(url));
    assert.equal((await get(srv, thumb(vid(102)))).status, 200, "the next request tries again");
    assert.equal(up.calls.length, start + 2);
  });

  test("a burst of distinct IDs: at most 4 upstream fetches at once, the rest wait their turn", async () => {
    const holds = [];
    let open = 0;
    let peak = 0;
    up.respond = async (url) => {
      const hold = gate();
      holds.push(hold);
      peak = Math.max(peak, ++open);
      await hold.promise;
      open--;
      return jpegResponse(idOf(url));
    };
    const ids = Array.from({ length: 10 }, (_, i) => vid(103 + i));
    const before = up.calls.length;
    const pending = ids.map((id) => get(srv, thumb(id)));
    await until(() => holds.length === 4, 2000, "4 upstream fetches");
    await sleep(40);
    assert.equal(holds.length, 4, "no fifth fetch while 4 are going");
    assert.deepEqual(
      (({ inFlight, queued }) => ({ inFlight, queued }))(srv.services.thumbnails.stats()),
      { inFlight: 4, queued: 6 }
    );
    for (let released = 0; released < ids.length; released++) {
      await until(() => holds.length > released, 2000, `fetch #${released + 1}`);
      holds[released].open();
    }
    const results = await Promise.all(pending);
    assert.deepEqual(results.map((r) => r.status), Array(ids.length).fill(200));
    results.forEach((r, i) => assert.deepEqual(r.body, fakeJpeg(ids[i])));
    assert.equal(up.calls.length - before, ids.length);
    assert.equal(peak, 4, "never more than 4 at once");
    assert.deepEqual(
      (({ inFlight, queued }) => ({ inFlight, queued }))(srv.services.thumbnails.stats()),
      { inFlight: 0, queued: 0 }
    );
    up.respond = (url) => jpegResponse(idOf(url));
  });
});

// =================================================================== the cache
describe("thumbnail cache (src/thumbnails.js)", () => {
  const dirs = [];
  const tempDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crwn-thumb-unit-"));
    dirs.push(dir);
    return dir;
  };
  after(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });
  const A = "AAAAAAAAAAA";
  const B = "BBBBBBBBBBB";
  const C = "CCCCCCCCCCC";
  const D = "DDDDDDDDDDD";
  const SIZE = JPEG_SIZE;

  function counted(extra = {}) {
    const calls = [];
    return {
      calls,
      fetchThumbnail: async (id) => {
        calls.push(id);
        return fakeJpeg(id);
      },
      ...extra,
    };
  }

  test("LRU by size: the least recently served file is evicted first; the total never exceeds the cap", async () => {
    const dir = tempDir();
    const up = counted();
    const cache = createThumbnailCache({ dir, maxBytes: 3 * SIZE, fetchThumbnail: up.fetchThumbnail });
    for (const id of [A, B, C]) assert.deepEqual(await cache.get(id), fakeJpeg(id));
    assert.deepEqual(cacheFiles(dir), [`${A}.jpg`, `${B}.jpg`, `${C}.jpg`]);
    await cache.get(A); // a hit makes A the most recently used
    assert.deepEqual(up.calls, [A, B, C]);
    await cache.get(D);
    assert.deepEqual(cacheFiles(dir), [`${A}.jpg`, `${C}.jpg`, `${D}.jpg`], "B was the least recently used");
    assert.deepEqual(cache.stats().bytes, 3 * SIZE);
    await cache.get(B); // fetched again; now C is the oldest
    assert.deepEqual(up.calls, [A, B, C, D, B]);
    assert.deepEqual(cacheFiles(dir), [`${A}.jpg`, `${B}.jpg`, `${D}.jpg`]);
    assert.ok(cache.stats().bytes <= 3 * SIZE);
    assert.equal(cache.stats().files, 3);
  });

  test("restart: files on disk are indexed oldest-first and trimmed to the cap; interrupted writes go; other files are never touched", async () => {
    const dir = tempDir();
    const now = Date.now() / 1000;
    [A, B, C].forEach((id, i) => {
      const file = path.join(dir, `${id}.jpg`);
      fs.writeFileSync(file, fakeJpeg(id));
      fs.utimesSync(file, now - 30 + i, now - 30 + i); // A oldest
    });
    fs.writeFileSync(path.join(dir, `${D}.0123456789abcdef.tmp`), "half a write");
    fs.writeFileSync(path.join(dir, "notes.txt"), "mine");
    fs.writeFileSync(path.join(dir, "short.jpg"), "not an id");
    fs.mkdirSync(path.join(dir, `${D}.jpg`)); // a directory with a cache-like name: ignored
    const up = counted();
    const cache = createThumbnailCache({ dir, maxBytes: 2 * SIZE, fetchThumbnail: up.fetchThumbnail });
    assert.deepEqual(cache.stats().files, 2);
    assert.deepEqual(cacheFiles(dir), [`${B}.jpg`, `${C}.jpg`, `${D}.jpg`, "notes.txt", "short.jpg"]);
    assert.deepEqual(await cache.get(B), fakeJpeg(B));
    assert.deepEqual(up.calls, [], "served from disk");
  });

  test("a file that vanished from disk is fetched again", async () => {
    const dir = tempDir();
    const up = counted();
    const cache = createThumbnailCache({ dir, maxBytes: 10 * SIZE, fetchThumbnail: up.fetchThumbnail });
    await cache.get(A);
    fs.rmSync(path.join(dir, `${A}.jpg`));
    assert.deepEqual(await cache.get(A), fakeJpeg(A));
    assert.deepEqual(up.calls, [A, A]);
    assert.ok(fs.existsSync(path.join(dir, `${A}.jpg`)));
  });

  test("THUMB_CACHE_MB=0: nothing is written to disk (still one fetch per ID at a time)", async () => {
    const dir = tempDir();
    const hold = gate();
    const calls = [];
    const cache = createThumbnailCache({
      dir,
      maxBytes: 0,
      fetchThumbnail: async (id) => {
        calls.push(id);
        await hold.promise;
        return fakeJpeg(id);
      },
    });
    const both = [cache.get(A), cache.get(A)];
    await sleep(10);
    hold.open();
    for (const body of await Promise.all(both)) assert.deepEqual(body, fakeJpeg(A));
    assert.deepEqual(calls, [A]);
    assert.deepEqual(cacheFiles(dir), []);
  });

  test("a video purged while its thumbnail downloads leaves no file", async () => {
    const dir = tempDir();
    let known = true;
    const hold = gate();
    const cache = createThumbnailCache({
      dir,
      maxBytes: 10 * SIZE,
      isKnown: () => known,
      fetchThumbnail: async (id) => {
        await hold.promise;
        return fakeJpeg(id);
      },
    });
    const pending = cache.get(A);
    await sleep(10);
    known = false; // delete-forever / the 7-day purge ran meanwhile
    cache.remove([A]);
    hold.open();
    assert.deepEqual(await pending, fakeJpeg(A), "the request already accepted still gets its image");
    assert.deepEqual(cacheFiles(dir), []);
    assert.equal(cache.stats().files, 0);
  });

  test("the waiting queue is bounded: beyond it a 502 at once", async () => {
    const hold = gate();
    const cache = createThumbnailCache({
      dir: tempDir(),
      maxBytes: 10 * SIZE,
      maxInFlight: 1,
      maxQueued: 1,
      fetchThumbnail: async (id) => {
        await hold.promise;
        return fakeJpeg(id);
      },
    });
    const first = cache.get(A); // in flight
    const second = cache.get(B); // queued
    await sleep(5);
    await assert.rejects(cache.get(C), (error) => error.status === 502 && error.code === "UPSTREAM_ERROR");
    hold.open();
    assert.deepEqual(await first, fakeJpeg(A));
    assert.deepEqual(await second, fakeJpeg(B));
  });

  test("whatever an injected fetchThumbnail returns or throws, only a JPEG ≤ 512 KB is served or stored", async () => {
    const dir = tempDir();
    for (const value of [Buffer.from("<svg onload=alert(1)>"), "a string", null, Buffer.alloc(THUMB_MAX_BYTES + 1, 0xff)]) {
      const cache = createThumbnailCache({ dir, maxBytes: 10 * THUMB_MAX_BYTES, fetchThumbnail: async () => value });
      await assert.rejects(cache.get(A), (error) => error.status === 502);
    }
    const throwing = createThumbnailCache({
      dir,
      maxBytes: 10 * SIZE,
      fetchThumbnail: async () => {
        throw new Error("boom /secret/path");
      },
    });
    await assert.rejects(throwing.get(A), (error) => error.status === 502 && !/secret/.test(error.message));
    assert.deepEqual(cacheFiles(dir), []);
  });

  test("the default upstream request: GET https://i.ytimg.com/vi/<id>/hqdefault.jpg, 5 s timeout signal, no redirects", async () => {
    assert.equal(THUMB_TIMEOUT_MS, 5000);
    assert.equal(THUMB_MAX_BYTES, 512 * 1024);
    const saved = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (url, init) => {
      seen.push({ url, init });
      return jpegResponse(idOf(url));
    };
    try {
      assert.deepEqual(await fetchYoutubeThumbnail(A), fakeJpeg(A));
      for (const bad of ["../../etc/pa", "AAAAAAAAAA", "AAAAAAAAAAAA", "AAAAAAAAAA/", null]) {
        await assert.rejects(fetchYoutubeThumbnail(bad), (error) => error.status === 502);
      }
    } finally {
      globalThis.fetch = saved;
    }
    assert.equal(seen.length, 1, "invalid IDs never become a URL");
    assert.equal(seen[0].url, upstreamUrl(A));
    assert.equal(seen[0].init.redirect, "error");
    assert.ok(seen[0].init.signal instanceof AbortSignal);
    assert.equal(seen[0].init.signal.aborted, false);
  });
});

// =================================================================== purge
describe("cached thumbnails of videos deleted for good are removed", () => {
  test("delete forever (video, series), the 7-day purge, and the retention job's prune of unused files", async () => {
    const srv = await startServer();
    try {
      const { trash, repo, thumbnails } = srv.services;
      const admin = quickUser(srv, "admin@example.com", "admin").client;
      const v = {};
      for (const [n, title] of [
        [1, "Bleach Episode 1"],
        [2, "Bleach Episode 2"],
        [3, "One Piece Episode 1"],
        [4, "One Piece Episode 2"],
        [5, "Naruto Episode 1"],
        [6, "Naruto Episode 2"],
      ]) {
        v[n] = await addVideo(srv, n, title);
        assert.equal((await get(srv, thumb(vid(n)))).status, 200);
      }
      const file = (n) => `${vid(n)}.jpg`;
      assert.deepEqual(cacheFiles(srv.thumbDir), [1, 2, 3, 4, 5, 6].map(file));

      // The trash keeps the file (restore brings the video back) but serves nothing.
      assert.equal((await admin.del(`/api/admin/videos/${v[1].id}`)).status, 204);
      assert.equal((await get(srv, thumb(vid(1)))).status, 404);
      assert.ok(cacheFiles(srv.thumbDir).includes(file(1)));
      assert.equal((await admin.del(`/api/admin/trash/videos/${v[1].id}`)).status, 204);
      assert.deepEqual(cacheFiles(srv.thumbDir), [2, 3, 4, 5, 6].map(file), "delete forever (video)");

      const onePiece = repo.getSeries("one-piece");
      assert.equal((await admin.del(`/api/admin/videos/${v[4].id}`)).status, 204); // trashed on its own first
      assert.equal((await admin.del(`/api/admin/series/${onePiece.id}`)).status, 204);
      assert.equal((await admin.del(`/api/admin/trash/series/${onePiece.id}`)).status, 204);
      assert.deepEqual(cacheFiles(srv.thumbDir), [2, 5, 6].map(file), "delete forever (series): every video of it");

      // The 7-day purge.
      trash.trashVideo(v[2].id);
      srv.db.prepare("UPDATE videos SET deleted_at = ? WHERE id = ?").run(new Date(Date.now() - 8 * DAY).toISOString(), v[2].id);
      const removed = [];
      assert.deepEqual(purgeTrash(srv.db, new Date(), { onPurged: (ids) => removed.push(...ids) }), { series: 0, videos: 1 });
      assert.deepEqual(removed, [vid(2)]);
      thumbnails.remove(removed);
      assert.deepEqual(cacheFiles(srv.thumbDir), [5, 6].map(file));

      // An admin points a video at another upload: the old ID's file is pruned by the hourly job.
      assert.equal((await admin.patch(`/api/admin/videos/${v[5].id}`, { url: vid(55) })).status, 200);
      assert.equal((await get(srv, thumb(vid(5)))).status, 404, "the old ID is no video any more");
      trash.trashVideo(v[6].id);
      srv.db.prepare("UPDATE videos SET deleted_at = ? WHERE id = ?").run(new Date(Date.now() - 8 * DAY).toISOString(), v[6].id);
      startRetention(srv.db, { intervalMs: 3_600_000, thumbnails })(); // runs once now, then stopped
      assert.equal(repo.getAnyVideo(v[6].id), null, "purged by the job");
      assert.deepEqual(cacheFiles(srv.thumbDir), [], "purged video's file and the swapped-out upload's file are gone");
      assert.deepEqual(thumbnails.stats().files, 0);
      assert.equal(thumbnails.stats().bytes, 0);
    } finally {
      await srv.close();
    }
  });
});

// =================================================================== thumbnailUrl
describe("Video.thumbnailUrl is same-origin everywhere (v1.5)", () => {
  test("public and admin responses: /api/thumbs/<id>.jpg; nothing points at ytimg.com", async () => {
    const srv = await startServer();
    try {
      const admin = quickUser(srv, "admin@example.com", "admin").client;
      const published = await addVideo(srv, 1, "One Piece Episode 1");
      await addVideo(srv, 2, "Unclassifiable upload");
      const trashed = await addVideo(srv, 3, "One Piece Episode 3");
      srv.services.trash.trashVideo(trashed.id);
      const series = srv.services.repo.getSeries("one-piece");
      const paths = [
        "/api/latest",
        "/api/top-rated",
        "/api/trending",
        "/api/random",
        `/api/videos/${published.id}`,
        "/api/anime/series/one-piece",
        "/api/admin/videos",
        "/api/admin/videos?status=pending",
        `/api/admin/videos/${published.id}/preview`,
        `/api/admin/series/${series.id}`,
        "/api/admin/trash",
      ];
      let seen = 0;
      const walk = (node, where) => {
        if (Array.isArray(node)) return node.forEach((n) => walk(n, where));
        if (!node || typeof node !== "object") return;
        if ("youtubeVideoId" in node) {
          assert.equal(node.thumbnailUrl, `/api/thumbs/${node.youtubeVideoId}.jpg`, where);
          seen++;
        }
        Object.values(node).forEach((n) => walk(n, where));
      };
      for (const p of paths) {
        const res = await admin.get(p);
        assert.equal(res.status, 200, p);
        assert.doesNotMatch(res.text, /ytimg/, p);
        walk(res.body, p);
      }
      assert.ok(seen >= 10, `checked ${seen} videos`);
    } finally {
      await srv.close();
    }
  });
});
