// v1.7 responsive thumbnails: GET /api/thumbs/<id>-m.jpg serves YouTube's mqdefault
// (320×180) next to <id>.jpg (hqdefault, 480×360) through the same machinery
// (src/thumbnails.js, src/imageCache.js, src/routes/images.js), and every Video has
// thumbnailSrcSet. The real upstream check runs against a fake i.ytimg.com (its
// fetchImpl, or a local HTTP server for THUMB_UPSTREAM): ytimg.com is never contacted.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { purgeTrash, startRetention } from "../src/retention.js";
import {
  THUMB_MAX_BYTES,
  THUMB_SIZES,
  createThumbnailCache,
  fetchYoutubeThumbnail,
  parseThumbKey,
  thumbKey,
  thumbKeys,
  thumbnailSrcSet,
} from "../src/thumbnails.js";
import { addVideo, fakeJpeg, quickUser, startServer, vid } from "./helpers.js";

const DAY = 86_400_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hq = (id) => `/api/thumbs/${id}.jpg`;
const mq = (id) => `/api/thumbs/${id}-m.jpg`;
const srcSetOf = (id) => `/api/thumbs/${id}-m.jpg 320w, /api/thumbs/${id}.jpg 480w`;
const upstreamUrl = (id, size) => `https://i.ytimg.com/vi/${id}/${size}default.jpg`;
/** What a fake upstream answers for one size: fakeJpeg of the cache key ("<id>" or "<id>-m"), so sizes differ. */
const keyOf = (id, size) => (size === "mq" ? `${id}-m` : id);
const bodyOf = (id, size) => fakeJpeg(keyOf(id, size));
function parseUpstream(url) {
  const [, id, size] = /\/vi\/([^/]+)\/(hq|mq)default\.jpg$/.exec(url);
  return { id, size, key: keyOf(id, size) };
}
/** Size of fakeJpeg(key) for an 11-character key; a "-m" key is 2 bytes longer. */
const HQ_SIZE = fakeJpeg(vid(0)).length;
const MQ_SIZE = fakeJpeg(`${vid(0)}-m`).length;

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

const jpegResponse = (key, { status = 200, type = "image/jpeg", body, headers = {} } = {}) =>
  new Response(body ?? fakeJpeg(key), { status, headers: { ...(type ? { "content-type": type } : {}), ...headers } });

/** A fake i.ytimg.com: `respond(url, init)` answers (default: the size's JPEG); every URL and init is recorded. */
function fakeUpstream() {
  const up = { calls: [], inits: [], respond: (url) => jpegResponse(parseUpstream(url).key) };
  up.fetchImpl = (url, init) => {
    up.calls.push(url);
    up.inits.push(init);
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

const assertContractHeaders = (res, where) => {
  assert.equal(res.headers.get("cache-control"), "public, max-age=604800, immutable", where);
  assert.equal(res.headers.get("content-type"), "image/jpeg", where);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff", where);
  assert.equal(res.headers.get("cross-origin-resource-policy"), "same-origin", where);
  assert.equal(res.headers.get("set-cookie"), null, `${where}: anonymous, no cookie`);
};

// =================================================================== HTTP
describe("GET /api/thumbs/:id-m.jpg (v1.7, mqdefault)", () => {
  let srv;
  let up;
  before(async () => {
    up = fakeUpstream();
    up.timeoutMs = 5000;
    srv = await startServer({
      fetchThumbnail: (id, size) => fetchYoutubeThumbnail(id, { size, fetchImpl: up.fetchImpl, timeoutMs: up.timeoutMs }),
    });
    await addVideo(srv, 1, "One Piece Episode 1");
    await addVideo(srv, 2, "One Piece Episode 2");
    const trashed = await addVideo(srv, 3, "One Piece Episode 3");
    srv.services.trash.trashVideo(trashed.id);
    await addVideo(srv, 4, "Some upload nobody can classify"); // pending
    await addVideo(srv, 5, "Bleach Episode 1");
    const gone = await addVideo(srv, 6, "One Piece Episode 6");
    srv.services.repo.setAvailability(gone.id, "unavailable");
    for (let n = 101; n <= 115; n++) await addVideo(srv, n, `Naruto Episode ${n}`);
  });
  after(() => srv.close());

  test("strict routing: only <id>.jpg and <id>-m.jpg; every other spelling, unknown, trashed, unavailable: 404 JSON, ZERO upstream calls", async () => {
    const id = vid(1);
    const paths = [
      mq(vid(99)), // well-formed, no such video
      mq(vid(3)), // in the trash
      mq(vid(6)), // YouTube no longer serves it
      `/api/thumbs/${id.slice(0, 9)}-m-m.jpg`, // the -m size of the (unknown) 11-char ID "vid0000000-m"
      `/api/thumbs/${id}-M.jpg`,
      `/api/thumbs/${id}-m.JPG`,
      `/api/thumbs/${id}-mq.jpg`,
      `/api/thumbs/${id}-hq.jpg`,
      `/api/thumbs/${id}-s.jpg`,
      `/api/thumbs/${id}-l.jpg`,
      `/api/thumbs/${id}-m-m.jpg`,
      `/api/thumbs/${id}--m.jpg`,
      `/api/thumbs/${id}-.jpg`,
      `/api/thumbs/${id}m.jpg`, // 12 characters
      `/api/thumbs/${id}_m.jpg`,
      `/api/thumbs/${id}.m.jpg`,
      `/api/thumbs/${id}-m.png`,
      `/api/thumbs/${id}-m.webp`,
      `/api/thumbs/${id}-m`,
      `/api/thumbs/${id}-m.`,
      `/api/thumbs/${id}-m.jpg.jpg`,
      `/api/thumbs/${id}.jpg-m.jpg`,
      `/api/thumbs/${id}-m.jpg/`, // no trailing slash variant
      `/api/thumbs/${id}.jpg/`,
      `/api/thumbs/${id}-m.jpg;x`,
      `/api/thumbs/${id}-m.jpg%00`,
      `/api/thumbs/${id}%2Dm.jpg`, // %-escapes are not another spelling of the same image
      `/api/thumbs/${id}%2dm.jpg`,
      `/api/thumbs/${id}-%6D.jpg`,
      `/api/thumbs/${id}-m%2Ejpg`,
      "/api/thumbs/vid0000000%31-m.jpg",
      "/api/thumbs/vid0000000%31.jpg",
      `/api/thumbs/${id}%2F-m.jpg`,
      `/api/thumbs/m/${id}.jpg`,
      `/api/thumbs/${id}/-m.jpg`,
      `/api/THUMBS/${id}-m.jpg`, // the path is case-sensitive
      `/api/Thumbs/${id}.jpg`,
      "/api/thumbs/-m.jpg",
    ];
    for (const p of paths) {
      const res = await get(srv, p, { cookie: "sid=whatever" });
      assert.equal(res.status, 404, p);
      assert.equal(res.json?.error?.code, "NOT_FOUND", p);
      assert.match(res.headers.get("content-type"), /^application\/json/, p);
      assert.equal(res.headers.get("cache-control"), "private, no-store", p);
    }
    assert.deepEqual(up.calls, [], "nothing goes upstream for any of them");
    assert.deepEqual(cacheFiles(srv.thumbDir), []);

    // Control: the exact spellings of the same live video do work.
    assert.equal((await get(srv, mq(id))).status, 200);
    assert.equal((await get(srv, hq(id))).status, 200);
    assert.deepEqual(up.calls, [upstreamUrl(id, "mq"), upstreamUrl(id, "hq")]);
  });

  test("a live video: <id>-m.jpg is ONE fetch of /vi/<id>/mqdefault.jpg, the contract headers, its own file next to <id>.jpg; repeats are hits", async () => {
    const id = vid(2);
    const before = up.calls.length;
    const res = await get(srv, mq(id), { cookie: "sid=whatever" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, bodyOf(id, "mq"));
    assertContractHeaders(res, "-m.jpg");
    assert.deepEqual(up.calls.slice(before), [upstreamUrl(id, "mq")]);
    assert.ok(cacheFiles(srv.thumbDir).includes(`${id}-m.jpg`), "named <id>-m.jpg");
    assert.ok(!cacheFiles(srv.thumbDir).includes(`${id}.jpg`), "the 480w file is not fetched along with it");
    assert.deepEqual(fs.readFileSync(path.join(srv.thumbDir, `${id}-m.jpg`)), bodyOf(id, "mq"));

    const big = await get(srv, hq(id));
    assert.equal(big.status, 200);
    assert.deepEqual(big.body, bodyOf(id, "hq"), "<id>.jpg is still hqdefault");
    assertContractHeaders(big, ".jpg");
    assert.deepEqual(up.calls.slice(before), [upstreamUrl(id, "mq"), upstreamUrl(id, "hq")]);
    assert.deepEqual(fs.readFileSync(path.join(srv.thumbDir, `${id}.jpg`)), bodyOf(id, "hq"));
    assert.ok(cacheFiles(srv.thumbDir).every((f) => !f.endsWith(".tmp")));

    for (let i = 0; i < 3; i++) {
      const again = await get(srv, mq(id));
      assert.equal(again.status, 200);
      assert.deepEqual(again.body, bodyOf(id, "mq"));
      assertContractHeaders(again, "hit");
      assert.deepEqual((await get(srv, hq(id))).body, bodyOf(id, "hq"));
    }
    const etag = res.headers.get("etag");
    assert.ok(etag);
    assert.notEqual(etag, big.headers.get("etag"), "two different images");
    assert.equal((await get(srv, mq(id), { "if-none-match": etag, "cache-control": "max-age=0" })).status, 304);
    assert.equal(up.calls.length, before + 2, "cache hits never go upstream");

    // Pending videos are live too.
    assert.equal((await get(srv, mq(vid(4)))).status, 200);
  });

  test("a cached <id>-m.jpg is served from disk by a new process, without any upstream call", async () => {
    assert.ok(cacheFiles(srv.thumbDir).includes(`${vid(2)}-m.jpg`));
    const other = await startServer({
      config: { thumbCacheDir: srv.thumbDir },
      fetchThumbnail: async () => {
        throw new Error("must not be called");
      },
    });
    try {
      await addVideo(other, 2, "One Piece Episode 2");
      const small = await get(other, mq(vid(2)));
      assert.equal(small.status, 200);
      assert.deepEqual(small.body, bodyOf(vid(2), "mq"));
      assert.deepEqual((await get(other, hq(vid(2)))).body, bodyOf(vid(2), "hq"));
      assert.equal(other.services.images.stats().files, cacheFiles(srv.thumbDir).length, "both sizes indexed from the directory");
    } finally {
      await other.close();
    }
  });

  test("mqdefault gets every upstream check: non-200, redirect, wrong type, not a JPEG, > 512 KB, network error, timeout -> 502, nothing cached, nothing logged", async () => {
    const TIMEOUT_MS = 150;
    const cases = [
      ["404", (url) => jpegResponse(parseUpstream(url).key, { status: 404 })],
      ["500", () => new Response("oops", { status: 500, headers: { "content-type": "text/plain" } })],
      ["302 (not followed)", () => new Response(null, { status: 302, headers: { location: "https://evil.example/x.jpg" } })],
      ["203 with a JPEG", (url) => jpegResponse(parseUpstream(url).key, { status: 203 })],
      ["image/png", (url) => jpegResponse(parseUpstream(url).key, { type: "image/png" })],
      ["no content-type", (url) => jpegResponse(parseUpstream(url).key, { type: null })],
      ["image/jpeg that is HTML", () => jpegResponse("x", { body: "<html><script>alert(1)</script></html>" })],
      ["empty body", () => jpegResponse("x", { body: "" })],
      ["declared Content-Length over 512 KB", (url) =>
        jpegResponse(parseUpstream(url).key, { headers: { "content-length": String(THUMB_MAX_BYTES + 1) } })],
      ["one byte over 512 KB", (url) => jpegResponse("x", { body: fakeJpeg(parseUpstream(url).key, THUMB_MAX_BYTES - MQ_SIZE + 1) })],
      ["network error", () => Promise.reject(new TypeError("fetch failed"))],
      ["no answer within the timeout", (url, init) =>
        new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)))],
      ["no answer ever (signal ignored)", () => new Promise(() => {})],
    ];
    const id = vid(5);
    up.timeoutMs = TIMEOUT_MS;
    const printed = await captureConsole(async () => {
      for (const [name, respond] of cases) {
        up.respond = respond;
        srv.services.images.thumbnails.forgetFailures();
        const before = up.calls.length;
        const started = Date.now();
        const res = await get(srv, mq(id));
        assert.equal(res.status, 502, name);
        assert.equal(res.json?.error?.code, "UPSTREAM_ERROR", name);
        assert.doesNotMatch(res.json.error.message, /ytimg|youtube|mqdefault|vid0000/i, `${name}: no upstream detail`);
        assert.equal(res.headers.get("cache-control"), "private, no-store", name);
        assert.deepEqual(up.calls.slice(before), [upstreamUrl(id, "mq")], `${name}: one attempt at mqdefault`);
        assert.equal(up.inits.at(-1).redirect, "error", `${name}: redirects refused`);
        assert.ok(up.inits.at(-1).signal instanceof AbortSignal, `${name}: a timeout signal`);
        assert.ok(Date.now() - started < TIMEOUT_MS + 1500, `${name}: answered in time`);
        assert.deepEqual(cacheFiles(srv.thumbDir).filter((f) => f.startsWith(id)), [], `${name}: nothing on disk`);
      }
    });
    up.timeoutMs = 5000;
    assert.deepEqual(printed, [], "failures print nothing");

    // Exactly 512 KB is allowed.
    up.respond = (url) => jpegResponse("x", { body: fakeJpeg(parseUpstream(url).key, THUMB_MAX_BYTES - MQ_SIZE) });
    srv.services.images.thumbnails.forgetFailures();
    const limit = await get(srv, mq(id));
    assert.equal(limit.status, 200);
    assert.equal(limit.body.length, THUMB_MAX_BYTES);
    assert.equal(fs.statSync(path.join(srv.thumbDir, `${id}-m.jpg`)).size, THUMB_MAX_BYTES);
    up.respond = (url) => jpegResponse(parseUpstream(url).key);
  });

  test("single-flight is per ID AND size: concurrent -m requests share one fetch, the two sizes of one ID are one fetch each", async () => {
    const id = vid(101);
    const hold = gate();
    up.respond = async (url) => {
      await hold.promise;
      return jpegResponse(parseUpstream(url).key);
    };
    const before = up.calls.length;
    const small = Array.from({ length: 8 }, () => get(srv, mq(id)));
    const big = Array.from({ length: 8 }, () => get(srv, hq(id)));
    await until(() => up.calls.length >= before + 2, 2000, "both upstream calls");
    await sleep(30);
    assert.equal(up.calls.length, before + 2, "16 requests, 2 fetches so far");
    hold.open();
    for (const r of await Promise.all(small)) {
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, bodyOf(id, "mq"));
    }
    for (const r of await Promise.all(big)) {
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, bodyOf(id, "hq"));
    }
    assert.deepEqual(up.calls.slice(before).sort(), [upstreamUrl(id, "hq"), upstreamUrl(id, "mq")]);

    // A failing -m fetch is shared too.
    const failing = gate();
    up.respond = async () => {
      await failing.promise;
      return new Response("no", { status: 500 });
    };
    const start = up.calls.length;
    const failed = Array.from({ length: 6 }, () => get(srv, mq(vid(102))));
    await until(() => up.calls.length > start, 2000, "the failing upstream call");
    await sleep(30);
    failing.open();
    assert.deepEqual((await Promise.all(failed)).map((r) => r.status), Array(6).fill(502));
    assert.equal(up.calls.length, start + 1, "6 requests, 1 upstream fetch");
    up.respond = (url) => jpegResponse(parseUpstream(url).key);
  });

  test("failure memory is per ID AND size: a failed -m answers 502 without upstream while <id>.jpg still loads, and vice versa", async () => {
    srv.services.images.thumbnails.forgetFailures();
    const failingSize = { current: "mq" };
    up.respond = (url) => {
      const { key, size } = parseUpstream(url);
      return size === failingSize.current ? new Response("no", { status: 500 }) : jpegResponse(key);
    };
    const a = vid(103);
    const start = up.calls.length;
    assert.equal((await get(srv, mq(a))).status, 502);
    assert.equal((await get(srv, mq(a))).status, 502, "remembered");
    assert.deepEqual(up.calls.slice(start), [upstreamUrl(a, "mq")], "no second attempt at the -m");
    assert.equal((await get(srv, hq(a))).status, 200, "the other size of the same ID is not affected");
    assert.deepEqual(up.calls.slice(start), [upstreamUrl(a, "mq"), upstreamUrl(a, "hq")]);
    assert.equal(srv.services.images.thumbnails.stats().failures, 1);

    failingSize.current = "hq";
    const b = vid(104);
    const next = up.calls.length;
    assert.equal((await get(srv, hq(b))).status, 502);
    assert.equal((await get(srv, hq(b))).status, 502, "remembered");
    assert.equal((await get(srv, mq(b))).status, 200);
    assert.deepEqual(up.calls.slice(next), [upstreamUrl(b, "hq"), upstreamUrl(b, "mq")]);
    assert.equal(srv.services.images.thumbnails.stats().failures, 2);

    up.respond = (url) => jpegResponse(parseUpstream(url).key);
    assert.equal((await get(srv, mq(a))).status, 502, "still remembered (10 minutes)");
    srv.services.images.thumbnails.forgetFailures();
    assert.equal((await get(srv, mq(a))).status, 200, "then it tries again");
    assert.equal((await get(srv, hq(b))).status, 200);
  });

  test("both sizes share the cap of 4 upstream fetches at once", async () => {
    const holds = [];
    let open = 0;
    let peak = 0;
    up.respond = async (url) => {
      const hold = gate();
      holds.push(hold);
      peak = Math.max(peak, ++open);
      await hold.promise;
      open--;
      return jpegResponse(parseUpstream(url).key);
    };
    const ids = [vid(105), vid(106), vid(107)];
    const pending = ids.flatMap((id) => [get(srv, mq(id)), get(srv, hq(id))]);
    await until(() => holds.length === 4, 2000, "4 upstream fetches");
    await sleep(40);
    assert.equal(holds.length, 4, "no fifth fetch while 4 are going");
    for (let released = 0; released < 6; released++) {
      await until(() => holds.length > released, 2000, `fetch #${released + 1}`);
      holds[released].open();
    }
    assert.deepEqual((await Promise.all(pending)).map((r) => r.status), Array(6).fill(200));
    assert.equal(peak, 4);
    up.respond = (url) => jpegResponse(parseUpstream(url).key);
  });
});

describe("the per-IP limit on cache misses counts -m misses like any other", () => {
  test("beyond it a 429 without upstream; hits of either size never count", async () => {
    const srv = await startServer({ config: { imageMissRateLimit: { max: 3, windowMs: 60_000 } } });
    try {
      for (let n = 1; n <= 3; n++) await addVideo(srv, n, `One Piece Episode ${n}`);
      const status = async (p) => (await fetch(srv.base + p)).status;
      assert.equal(await status(hq(vid(1))), 200);
      assert.equal(await status(mq(vid(1))), 200, "the other size is a miss of its own");
      assert.equal(await status(mq(vid(2))), 200);
      const limited = await fetch(srv.base + mq(vid(3)));
      assert.equal(limited.status, 429);
      assert.equal((await limited.json()).error.code, "RATE_LIMITED");
      assert.ok(Number(limited.headers.get("retry-after")) > 0);
      assert.equal(limited.headers.get("cache-control"), "private, no-store");
      assert.equal(await status(hq(vid(3))), 429);
      assert.deepEqual(srv.fake.thumbCalls, [vid(1), `${vid(1)}-m`, `${vid(2)}-m`], "no upstream call for the limited ones");
      for (let i = 0; i < 5; i++) {
        assert.equal(await status(mq(vid(1))), 200, "cache hits are never limited");
        assert.equal(await status(hq(vid(1))), 200);
        assert.equal(await status(mq(vid(2))), 200);
      }
    } finally {
      await srv.close();
    }
  });
});

// =================================================================== the cache
describe("thumbnail cache with two sizes (src/thumbnails.js)", () => {
  const dirs = [];
  const tempDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crwn-thumb-m-"));
    dirs.push(dir);
    return dir;
  };
  after(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });
  const A = "AAAAAAAAAAA";
  const B = "BBBBBBBBBBB";

  function counted(extra = {}) {
    const calls = [];
    return {
      calls,
      fetchThumbnail: async (id, size) => {
        calls.push(`${id}:${size}`);
        return bodyOf(id, size);
      },
      ...extra,
    };
  }

  test("keys, paths and the srcset", () => {
    assert.deepEqual(Object.keys(THUMB_SIZES), ["hq", "mq"]);
    assert.equal(THUMB_SIZES.hq.upstream, "hqdefault.jpg");
    assert.equal(THUMB_SIZES.mq.upstream, "mqdefault.jpg");
    assert.equal(thumbKey(A), A);
    assert.equal(thumbKey(A, "mq"), `${A}-m`);
    assert.deepEqual(thumbKeys([A, B, "short", null, "../../etc/pa"]), [A, `${A}-m`, B, `${B}-m`]);
    assert.deepEqual(parseThumbKey(A), { id: A, size: "hq" });
    assert.deepEqual(parseThumbKey(`${A}-m`), { id: A, size: "mq" });
    // An ID may itself end in "-m": lengths keep the two apart.
    assert.deepEqual(parseThumbKey("AAAAAAAAA-m"), { id: "AAAAAAAAA-m", size: "hq" });
    assert.deepEqual(parseThumbKey("AAAAAAAAA-m-m"), { id: "AAAAAAAAA-m", size: "mq" });
    for (const bad of ["", `${A}-M`, `${A}-mq`, `${A}-m-m`, `${A}m`, "AAAAAAAAAA", "cover-1-0123abcd"]) assert.equal(parseThumbKey(bad), null, bad);
    assert.equal(thumbnailSrcSet(A), srcSetOf(A));
  });

  test("LRU by size: <id>.jpg and <id>-m.jpg are separate entries, evicted least-recently-used first", async () => {
    const dir = tempDir();
    const up = counted();
    const cache = createThumbnailCache({ dir, maxBytes: 3 * MQ_SIZE, fetchThumbnail: up.fetchThumbnail });
    assert.deepEqual(await cache.get(A), bodyOf(A, "hq"));
    assert.deepEqual(await cache.get(A, { size: "mq" }), bodyOf(A, "mq"));
    assert.deepEqual(await cache.get(B, { size: "mq" }), bodyOf(B, "mq"));
    assert.deepEqual(cacheFiles(dir), [`${A}-m.jpg`, `${A}.jpg`, `${B}-m.jpg`]);
    assert.equal(cache.stats().bytes, HQ_SIZE + 2 * MQ_SIZE);
    await cache.get(A); // a hit: A (hq) is now the most recently used
    await cache.get(B); // over the cap: A-m, the least recently used, goes
    assert.deepEqual(cacheFiles(dir), [`${A}.jpg`, `${B}-m.jpg`, `${B}.jpg`]);
    assert.ok(cache.stats().bytes <= 3 * MQ_SIZE);
    await cache.get(A, { size: "mq" }); // fetched again; now B-m is the oldest
    assert.deepEqual(cacheFiles(dir), [`${A}-m.jpg`, `${A}.jpg`, `${B}.jpg`]);
    assert.deepEqual(up.calls, [`${A}:hq`, `${A}:mq`, `${B}:mq`, `${B}:hq`, `${A}:mq`]);
    assert.equal(cache.stats().files, 3);
  });

  test("restart: <id>-m.jpg files are indexed oldest-first and trimmed; interrupted -m writes go; look-alike names are never touched", async () => {
    const dir = tempDir();
    const now = Date.now() / 1000;
    [`${A}-m`, A, `${B}-m`].forEach((key, i) => {
      const file = path.join(dir, `${key}.jpg`);
      fs.writeFileSync(file, fakeJpeg(key));
      fs.utimesSync(file, now - 30 + i, now - 30 + i); // A-m oldest
    });
    fs.writeFileSync(path.join(dir, `${B}-m.0123456789abcdef.tmp`), "half a write");
    const strangers = [`${A}-M.jpg`, `${A}-mq.jpg`, `${A}_m.jpg`, `${A}-m-m.jpg`, `${A}-m.jpeg`];
    for (const name of strangers) fs.writeFileSync(path.join(dir, name), "not ours");
    const up = counted();
    const cache = createThumbnailCache({ dir, maxBytes: HQ_SIZE + MQ_SIZE, fetchThumbnail: up.fetchThumbnail });
    assert.equal(cache.stats().files, 2);
    assert.deepEqual(cacheFiles(dir), [`${A}.jpg`, `${B}-m.jpg`, ...strangers].sort(), "A-m (oldest) trimmed, the .tmp deleted");
    assert.deepEqual(await cache.get(B, { size: "mq" }), fakeJpeg(`${B}-m`));
    assert.deepEqual(await cache.get(A), fakeJpeg(A));
    assert.deepEqual(up.calls, [], "served from disk");
  });

  test("remove() deletes both sizes; a video purged while its -m downloads leaves no file", async () => {
    const dir = tempDir();
    const up = counted();
    const cache = createThumbnailCache({ dir, maxBytes: 10 * MQ_SIZE, fetchThumbnail: up.fetchThumbnail });
    for (const id of [A, B]) for (const size of ["hq", "mq"]) await cache.get(id, { size });
    cache.remove([A]);
    assert.deepEqual(cacheFiles(dir), [`${B}-m.jpg`, `${B}.jpg`]);
    assert.equal(cache.stats().files, 2);

    let known = true;
    const keysAsked = [];
    const hold = gate();
    const purging = createThumbnailCache({
      dir: tempDir(),
      maxBytes: 10 * MQ_SIZE,
      isKnown: (key) => {
        keysAsked.push(key);
        return known;
      },
      fetchThumbnail: async (id, size) => {
        await hold.promise;
        return bodyOf(id, size);
      },
    });
    const pending = purging.get(A, { size: "mq" });
    await sleep(10);
    known = false;
    purging.remove([A]);
    hold.open();
    assert.deepEqual(await pending, bodyOf(A, "mq"), "the request already accepted still gets its image");
    assert.deepEqual(keysAsked, [`${A}-m`], "ownership is checked for the -m key");
    assert.equal(purging.stats().files, 0);
  });

  test("the size is validated: anything but hq/mq is a 502 that never reaches upstream", async () => {
    const up = counted();
    const cache = createThumbnailCache({ dir: tempDir(), maxBytes: 10 * MQ_SIZE, fetchThumbnail: up.fetchThumbnail });
    for (const size of ["lq", "m", "-m", "maxres", "sd", "__proto__", "constructor", "toString", "", null, 1]) {
      await assert.rejects(cache.get(A, { size }), (error) => error.status === 502, String(size));
    }
    assert.deepEqual(up.calls, []);

    const seen = [];
    const fetchImpl = async (url) => {
      seen.push(url);
      return jpegResponse(parseUpstream(url).key);
    };
    for (const size of ["maxres", "sd", "__proto__", "constructor", "", null]) {
      await assert.rejects(fetchYoutubeThumbnail(A, { size, fetchImpl }), (error) => error.status === 502, String(size));
    }
    assert.deepEqual(seen, [], "an unknown size never becomes a URL");
  });

  test("the default upstream request for -m: GET https://i.ytimg.com/vi/<id>/mqdefault.jpg, 5 s timeout signal, no redirects", async () => {
    const saved = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (url, init) => {
      seen.push({ url, init });
      return jpegResponse(parseUpstream(url).key);
    };
    try {
      assert.deepEqual(await fetchYoutubeThumbnail(A, { size: "mq" }), bodyOf(A, "mq"));
      assert.deepEqual(await fetchYoutubeThumbnail(A), bodyOf(A, "hq"), "hq stays the default");
      // createThumbnailCache's default fetcher passes the size through.
      const cache = createThumbnailCache({ dir: tempDir(), maxBytes: 10 * MQ_SIZE });
      assert.deepEqual(await cache.get(B, { size: "mq" }), bodyOf(B, "mq"));
    } finally {
      globalThis.fetch = saved;
    }
    assert.deepEqual(seen.map((s) => s.url), [upstreamUrl(A, "mq"), upstreamUrl(A, "hq"), upstreamUrl(B, "mq")]);
    assert.equal(seen[0].init.redirect, "error");
    assert.ok(seen[0].init.signal instanceof AbortSignal);
  });

  test("a failed -m answers 502 without upstream for 10 minutes, then is tried again; the hq of that ID is unaffected", async () => {
    let clock = 1_000_000;
    let fails = true;
    const calls = [];
    const cache = createThumbnailCache({
      dir: tempDir(),
      maxBytes: 10 * MQ_SIZE,
      now: () => clock,
      fetchThumbnail: async (id, size) => {
        calls.push(`${id}:${size}`);
        if (fails && size === "mq") throw new Error("upstream down");
        return bodyOf(id, size);
      },
    });
    await assert.rejects(cache.get(A, { size: "mq" }), (error) => error.status === 502);
    fails = false;
    clock += 9 * 60_000;
    await assert.rejects(cache.get(A, { size: "mq" }), (error) => error.status === 502, "still remembered after 9 minutes");
    assert.deepEqual(await cache.get(A), bodyOf(A, "hq"));
    assert.deepEqual(calls, [`${A}:mq`, `${A}:hq`]);
    clock += 60_001;
    assert.deepEqual(await cache.get(A, { size: "mq" }), bodyOf(A, "mq"), "after 10 minutes: one new attempt");
    assert.deepEqual(calls, [`${A}:mq`, `${A}:hq`, `${A}:mq`]);
    assert.equal(cache.stats().failures, 0);
  });
});

// =================================================================== purge
describe("cached files of BOTH sizes go when a video is deleted for good", () => {
  test("delete forever (video, series), the 7-day purge and the retention prune remove <id>.jpg and <id>-m.jpg; the trash keeps both but serves neither", async () => {
    const srv = await startServer();
    try {
      const { trash, repo, images } = srv.services;
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
        assert.equal((await get(srv, hq(vid(n)))).status, 200);
        assert.equal((await get(srv, mq(vid(n)))).status, 200);
      }
      const files = (...ns) => ns.flatMap((n) => [`${vid(n)}-m.jpg`, `${vid(n)}.jpg`]).sort();
      assert.deepEqual(cacheFiles(srv.thumbDir), files(1, 2, 3, 4, 5, 6));
      assert.equal(images.stats().files, 12);

      assert.equal((await admin.del(`/api/admin/videos/${v[1].id}`)).status, 204);
      assert.equal((await get(srv, hq(vid(1)))).status, 404);
      assert.equal((await get(srv, mq(vid(1)))).status, 404, "a trashed video's -m is a 404 too");
      assert.deepEqual(cacheFiles(srv.thumbDir), files(1, 2, 3, 4, 5, 6), "the trash keeps both files (restore)");
      assert.equal((await admin.del(`/api/admin/trash/videos/${v[1].id}`)).status, 204);
      assert.deepEqual(cacheFiles(srv.thumbDir), files(2, 3, 4, 5, 6), "delete forever (video): both sizes");

      const onePiece = repo.getSeries("one-piece");
      assert.equal((await admin.del(`/api/admin/videos/${v[4].id}`)).status, 204);
      assert.equal((await admin.del(`/api/admin/series/${onePiece.id}`)).status, 204);
      assert.equal((await admin.del(`/api/admin/trash/series/${onePiece.id}`)).status, 204);
      assert.deepEqual(cacheFiles(srv.thumbDir), files(2, 5, 6), "delete forever (series): both sizes of every video");

      trash.trashVideo(v[2].id);
      srv.db.prepare("UPDATE videos SET deleted_at = ? WHERE id = ?").run(new Date(Date.now() - 8 * DAY).toISOString(), v[2].id);
      const removed = [];
      purgeTrash(srv.db, new Date(), { onPurged: (gone) => removed.push(gone) });
      images.purge(removed[0]);
      assert.deepEqual(cacheFiles(srv.thumbDir), files(5, 6), "the 7-day purge: both sizes");

      // A swapped-out upload's files (both sizes) are pruned by the hourly job, like a purged video's.
      assert.equal((await admin.patch(`/api/admin/videos/${v[5].id}`, { url: vid(55) })).status, 200);
      assert.equal((await get(srv, mq(vid(5)))).status, 404, "the old ID is no video any more");
      trash.trashVideo(v[6].id);
      srv.db.prepare("UPDATE videos SET deleted_at = ? WHERE id = ?").run(new Date(Date.now() - 8 * DAY).toISOString(), v[6].id);
      startRetention(srv.db, { intervalMs: 3_600_000, images })();
      assert.deepEqual(cacheFiles(srv.thumbDir), []);
      assert.equal(images.stats().files, 0);
      assert.equal(images.stats().bytes, 0);
    } finally {
      await srv.close();
    }
  });

  test("prune keeps both sizes of live and trashed videos", async () => {
    const srv = await startServer();
    try {
      const live = await addVideo(srv, 1, "Bleach Episode 1");
      const trashed = await addVideo(srv, 2, "Bleach Episode 2");
      for (const n of [1, 2]) for (const p of [hq(vid(n)), mq(vid(n))]) assert.equal((await get(srv, p)).status, 200);
      srv.services.trash.trashVideo(trashed.id);
      assert.equal(srv.services.images.prune(), 0);
      assert.equal(cacheFiles(srv.thumbDir).length, 4);
      assert.ok(live.id);
    } finally {
      await srv.close();
    }
  });
});

// =================================================================== Video.thumbnailSrcSet
describe("Video.thumbnailSrcSet (v1.7)", () => {
  test("every video object, public and admin: '<id>-m.jpg 320w, <id>.jpg 480w'; null exactly when thumbnailUrl is null", async () => {
    const srv = await startServer();
    try {
      const admin = quickUser(srv, "admin@example.com", "admin").client;
      const anonymous = srv.client();
      const published = await addVideo(srv, 1, "One Piece Episode 1");
      await addVideo(srv, 2, "Unclassifiable upload");
      const trashed = await addVideo(srv, 3, "One Piece Episode 3");
      const gone = await addVideo(srv, 4, "One Piece Episode 4");
      srv.services.repo.setAvailability(gone.id, "unavailable");
      srv.services.trash.trashVideo(trashed.id);
      const series = srv.services.repo.getSeries("one-piece");
      const publicPaths = ["/api/latest", "/api/top-rated", "/api/trending", "/api/random", `/api/videos/${published.id}`, "/api/anime/series/one-piece"];
      const adminPaths = [
        "/api/admin/videos",
        "/api/admin/videos?status=pending",
        `/api/admin/videos/${published.id}/preview`,
        `/api/admin/videos/${trashed.id}/preview`,
        `/api/admin/series/${series.id}`,
        "/api/admin/trash",
      ];
      let seen = 0;
      let nulls = 0;
      const walk = (node, where) => {
        if (Array.isArray(node)) return node.forEach((n) => walk(n, where));
        if (!node || typeof node !== "object") return;
        if ("youtubeVideoId" in node) {
          assert.ok("thumbnailSrcSet" in node, `${where}: present on every video`);
          if (node.thumbnailUrl === null) {
            assert.equal(node.thumbnailSrcSet, null, `${where}: null with thumbnailUrl`);
            nulls++;
          } else {
            assert.equal(node.thumbnailUrl, `/api/thumbs/${node.youtubeVideoId}.jpg`, where);
            assert.equal(node.thumbnailSrcSet, srcSetOf(node.youtubeVideoId), where);
          }
          seen++;
        }
        Object.values(node).forEach((n) => walk(n, where));
      };
      for (const [client, paths] of [
        [anonymous, publicPaths],
        [admin, [...publicPaths, ...adminPaths]],
      ]) {
        for (const p of paths) {
          const res = await client.get(p);
          assert.equal(res.status, 200, p);
          walk(res.body, p);
        }
      }
      assert.ok(seen >= 12, `checked ${seen} videos`);
      assert.ok(nulls >= 2, "trashed videos were among them");

      // Mutation responses too: 409 for a trashed video, restore, admin patch.
      const again = await admin.post("/api/admin/videos", { url: vid(3) });
      assert.equal(again.status, 409);
      assert.equal(again.body.error.details.video.thumbnailSrcSet, null);
      const restored = await admin.post(`/api/admin/trash/videos/${trashed.id}/restore`);
      assert.equal(restored.body.video.thumbnailSrcSet, srcSetOf(vid(3)));
      const swapped = await admin.patch(`/api/admin/videos/${published.id}`, { url: vid(43) });
      assert.equal(swapped.body.video.thumbnailSrcSet, srcSetOf(vid(43)));

      // Every candidate of a live video's srcset is served.
      const live = (await anonymous.get(`/api/videos/${published.id}`)).body;
      const video = live.video ?? live;
      for (const candidate of video.thumbnailSrcSet.split(", ")) {
        const [url, width] = candidate.split(" ");
        assert.match(width, /^(320|480)w$/);
        const res = await get(srv, url);
        assert.equal(res.status, 200, url);
        assert.equal(res.headers.get("content-type"), "image/jpeg");
      }
      assert.deepEqual(srv.fake.thumbCalls.slice(-2), [`${vid(43)}-m`, vid(43)]);
    } finally {
      await srv.close();
    }
  });

  test("SEO is unchanged: og:image and JSON-LD thumbnailUrl keep the 480w <id>.jpg; the srcset never reaches the page", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crwn-srcset-seo-"));
    fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><html><head><title>Crwn Animes</title></head><body><div id=\"root\"></div></body></html>");
    const srv = await startServer({ config: { clientDist: dir } });
    try {
      const video = await addVideo(srv, 1, "One Piece Episode 1");
      assert.ok(video.route, "published");
      srv.db.prepare("UPDATE series SET cover_url = NULL WHERE slug = 'one-piece'").run(); // the thumbnail is the image
      const res = await fetch(srv.base + video.route);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, new RegExp(`<meta property="og:image" content="http://app\\.test/api/thumbs/${vid(1)}\\.jpg"`));
      const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)[1]);
      assert.equal(ld.thumbnailUrl, `http://app.test/api/thumbs/${vid(1)}.jpg`);
      assert.doesNotMatch(html, /-m\.jpg|320w|srcset|thumbnailSrcSet/i);
    } finally {
      await srv.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// =================================================================== THUMB_UPSTREAM (tests only)
/**
 * A local fake i.ytimg.com over real HTTP serving /vi/<id>/hqdefault.jpg and
 * /vi/<id>/mqdefault.jpg (different bytes); `routes[key](res)` overrides one
 * ("<id>" or "<id>-m"). Every requested path is recorded.
 */
async function startFakeYtimg(routes = {}) {
  const paths = [];
  const server = http.createServer((req, res) => {
    paths.push(req.url);
    const match = /^\/vi\/([^/]+)\/(hq|mq)default\.jpg$/.exec(req.url);
    if (!match) return res.writeHead(404).end();
    const key = keyOf(match[1], match[2]);
    if (routes[key]) return routes[key](res);
    const body = fakeJpeg(key);
    res.writeHead(200, { "content-type": "image/jpeg", "content-length": body.length }).end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    paths,
    base: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

describe("THUMB_UPSTREAM and the -m size", () => {
  test("outside production <id>-m.jpg is fetched from <THUMB_UPSTREAM>/vi/<id>/mqdefault.jpg, with every check", async () => {
    const fake = await startFakeYtimg({
      [`${vid(2)}-m`]: (res) => res.writeHead(302, { location: `/vi/${vid(1)}/mqdefault.jpg` }).end(),
      [`${vid(3)}-m`]: (res) => res.writeHead(200, { "content-type": "image/png" }).end(fakeJpeg(vid(3))),
      [`${vid(4)}-m`]: (res) => {
        const body = fakeJpeg("x", THUMB_MAX_BYTES);
        res.writeHead(200, { "content-type": "image/jpeg" }).end(body); // chunked, too big
      },
      [`${vid(5)}-m`]: (res) => res.writeHead(200, { "content-type": "image/jpeg" }).end("<html>not a jpeg</html>"),
    });
    const srv = await startServer({ fetchThumbnail: null, config: { thumbUpstream: `${fake.base}/` } });
    try {
      for (let n = 1; n <= 5; n++) await addVideo(srv, n, `One Piece Episode ${n}`);
      const small = await get(srv, mq(vid(1)));
      assert.equal(small.status, 200);
      assert.deepEqual(small.body, bodyOf(vid(1), "mq"));
      assertContractHeaders(small, "via THUMB_UPSTREAM");
      const big = await get(srv, hq(vid(1)));
      assert.deepEqual(big.body, bodyOf(vid(1), "hq"));
      assert.equal((await get(srv, mq(vid(1)))).status, 200, "then from the cache");
      assert.deepEqual(fake.paths, [`/vi/${vid(1)}/mqdefault.jpg`, `/vi/${vid(1)}/hqdefault.jpg`]);

      for (const n of [2, 3, 4, 5]) {
        const res = await get(srv, mq(vid(n)));
        assert.equal(res.status, 502, `vid(${n})`);
        assert.equal(res.json?.error?.code, "UPSTREAM_ERROR", `vid(${n})`);
      }
      assert.equal(fake.paths.filter((p) => p === `/vi/${vid(1)}/mqdefault.jpg`).length, 1, "the redirect was not followed");
      assert.deepEqual(cacheFiles(srv.thumbDir), [`${vid(1)}-m.jpg`, `${vid(1)}.jpg`], "only the good answers were cached");
      assert.equal((await get(srv, mq(vid(99)))).status, 404);
      assert.equal(fake.paths.some((p) => p.includes(vid(99))), false);
    } finally {
      await srv.close();
      await fake.close();
    }
  });

  test("in production THUMB_UPSTREAM is ignored: <id>-m.jpg comes from https://i.ytimg.com/vi/<id>/mqdefault.jpg", async () => {
    const fake = await startFakeYtimg();
    const realFetch = globalThis.fetch;
    const ytimg = [];
    globalThis.fetch = (url, init) => {
      if (String(url).startsWith("https://i.ytimg.com/")) {
        ytimg.push(String(url));
        return Promise.resolve(jpegResponse(parseUpstream(String(url)).key));
      }
      return realFetch(url, init);
    };
    let srv;
    try {
      srv = await startServer({
        fetchThumbnail: null,
        config: { nodeEnv: "production", isProduction: true, appUrl: "https://crwn.example", thumbUpstream: fake.base },
      });
      await addVideo(srv, 1, "One Piece Episode 1");
      const res = await get(srv, mq(vid(1)));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, bodyOf(vid(1), "mq"));
      assert.deepEqual(ytimg, [upstreamUrl(vid(1), "mq")]);
      assert.deepEqual(fake.paths, [], "the override was not used");
    } finally {
      globalThis.fetch = realFetch;
      await srv?.close();
      await fake.close();
    }
  });
});
