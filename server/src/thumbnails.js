// Same-origin YouTube thumbnails (docs/API.md v1.5). GET /api/thumbs/<id>.jpg is
// fetched by this server from i.ytimg.com, so a visitor's browser never contacts
// Google before pressing Play. Only IDs of live videos get here (the route checks
// the database first), so this is never an open proxy.
//
// - fetchYoutubeThumbnail(): one upstream request, 5 s timeout, 200 + image/jpeg +
//   JPEG bytes + at most 512 KB (counted while streaming; the download is cancelled
//   beyond that). Every failure is a 502 without upstream details.
// - createThumbnailCache(): single-flight per ID, at most `maxInFlight` upstream
//   requests at once (more wait in a bounded queue), and an on-disk LRU cache
//   capped at `maxBytes`. Files are named "<id>.jpg" from a validated ID only and
//   written atomically (temporary file + rename). Index mutations (rename, evict,
//   remove) are synchronous, so a purge can never interleave with a commit.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { HttpError } from "./errors.js";

/** A YouTube video ID. Nothing else ever becomes an upstream URL or a file name. */
export const THUMB_ID = /^[A-Za-z0-9_-]{11}$/;
export const THUMB_MAX_BYTES = 512 * 1024;
export const THUMB_TIMEOUT_MS = 5000;
export const THUMB_MAX_IN_FLIGHT = 4;
const THUMB_MAX_QUEUED = 256;

const CACHE_FILE = /^([A-Za-z0-9_-]{11})\.jpg$/;
const TEMP_FILE = /^[A-Za-z0-9_-]{11}\.[0-9a-f]{16}\.tmp$/;

const upstreamError = () => new HttpError(502, "Could not load this thumbnail.");

/** JPEG files start with the SOI marker followed by another marker. */
const looksLikeJpeg = (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

/** Rejects once `signal` aborts (for an fetchImpl that would ignore it). Never an unhandled rejection. */
function abortion(signal) {
  const promise = new Promise((resolve, reject) => {
    if (signal.aborted) reject(upstreamError());
    else signal.addEventListener("abort", () => reject(upstreamError()), { once: true });
  });
  promise.catch(() => {});
  return promise;
}

/**
 * The default `fetchThumbnail(id)`: hqdefault.jpg from i.ytimg.com as a Buffer,
 * or an HttpError 502. `fetchImpl`, `timeoutMs` and `maxBytes` are for tests.
 */
export async function fetchYoutubeThumbnail(
  id,
  { fetchImpl = globalThis.fetch, timeoutMs = THUMB_TIMEOUT_MS, maxBytes = THUMB_MAX_BYTES } = {}
) {
  if (typeof id !== "string" || !THUMB_ID.test(id)) throw upstreamError();
  const signal = AbortSignal.timeout(timeoutMs);
  let reader = null;
  // A pending read() resolves { done: true } once cancelled; the loop then sees signal.aborted.
  const cancel = () => reader?.cancel().catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const response = await Promise.race([
      fetchImpl(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`, { signal, redirect: "error" }),
      abortion(signal),
    ]);
    const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (response.status !== 200 || type !== "image/jpeg" || declared > maxBytes || !response.body) {
      response.body?.cancel().catch(() => {});
      throw upstreamError();
    }
    reader = response.body.getReader();
    if (signal.aborted) cancel();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw upstreamError();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        cancel();
        throw upstreamError();
      }
      chunks.push(value);
    }
    const body = Buffer.concat(chunks, size);
    if (!looksLikeJpeg(body)) throw upstreamError();
    return body;
  } catch {
    // Timeout, network error, refused redirect, bad answer: one 502, no upstream detail kept or logged.
    throw upstreamError();
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

/** Runs at most `max` tasks at once; up to `maxQueued` more wait their turn, beyond that a 502 at once. */
function createLimiter(max, maxQueued) {
  let active = 0;
  const queue = [];
  const next = () => {
    while (active < max && queue.length > 0) {
      const { task, resolve, reject } = queue.shift();
      active++;
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          active--;
          next();
        });
    }
  };
  return {
    run(task) {
      if (queue.length >= maxQueued) return Promise.reject(upstreamError());
      return new Promise((resolve, reject) => {
        queue.push({ task, resolve, reject });
        next();
      });
    },
    get active() {
      return active;
    },
    get queued() {
      return queue.length;
    },
  };
}

/**
 * @param dir             cache directory (created on the first write)
 * @param maxBytes        size cap of the cached files; 0 keeps nothing on disk
 * @param fetchThumbnail  async (id) => Buffer, throws on failure (default: fetchYoutubeThumbnail)
 * @param isKnown         (id) => true while a video (live or trashed) has this YouTube ID:
 *                        checked right before a fetched file is committed, so a video purged
 *                        while its thumbnail was downloading leaves nothing behind
 * @param log             where a failed cache write is reported (its error code only)
 */
export function createThumbnailCache({
  dir,
  maxBytes,
  fetchThumbnail = fetchYoutubeThumbnail,
  isKnown = () => true,
  maxInFlight = THUMB_MAX_IN_FLIGHT,
  maxQueued = THUMB_MAX_QUEUED,
  log = (message) => console.error(message),
}) {
  const index = new Map(); // id -> size in bytes; iteration order = least recently used first
  let total = 0;
  let loaded = false;
  const inflight = new Map(); // id -> Promise<Buffer> (single-flight)
  const limiter = createLimiter(maxInFlight, maxQueued);
  const fileOf = (id) => path.join(dir, `${id}.jpg`);

  const unlink = (file) => {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // EBUSY/EPERM: it is out of the index anyway; the next start-up scan sees it again.
    }
  };

  /** Drops `id` from the index and the disk; false when it was not indexed. */
  function forget(id) {
    const size = index.get(id);
    if (size === undefined) return false;
    index.delete(id);
    total -= size;
    unlink(fileOf(id));
    return true;
  }

  function evict() {
    for (const id of index.keys()) {
      if (total <= maxBytes) break;
      forget(id);
    }
  }

  /** Indexes what a previous run left on disk (oldest write first), once, synchronously. */
  function load() {
    if (loaded) return;
    loaded = true;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // no cache yet
    }
    const found = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const file = path.join(dir, entry.name);
      if (TEMP_FILE.test(entry.name)) {
        unlink(file); // a write interrupted by a crash
        continue;
      }
      const match = CACHE_FILE.exec(entry.name);
      if (!match) continue; // not ours: never touched
      try {
        const stat = fs.statSync(file);
        found.push({ id: match[1], size: stat.size, at: stat.mtimeMs });
      } catch {
        // vanished meanwhile
      }
    }
    found.sort((a, b) => a.at - b.at);
    for (const { id, size } of found) {
      index.set(id, size);
      total += size;
    }
    evict();
  }

  async function readCached(id) {
    if (!index.has(id)) return null;
    try {
      const body = await fsp.readFile(fileOf(id));
      const size = index.get(id);
      if (size !== undefined) {
        index.delete(id); // most recently used now
        index.set(id, size);
      }
      return body;
    } catch {
      forget(id); // gone from disk: fetch it again
      return null;
    }
  }

  async function store(id, body) {
    if (body.length > maxBytes) return; // also: maxBytes 0 = no disk cache
    const temp = path.join(dir, `${id}.${randomBytes(8).toString("hex")}.tmp`);
    try {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(temp, body, { flag: "wx" });
      // Synchronous from here: no purge can run between this check and the rename.
      if (!isKnown(id)) {
        unlink(temp);
        return;
      }
      fs.renameSync(temp, fileOf(id));
    } catch (error) {
      unlink(temp);
      log(`[thumbs] could not write the thumbnail cache (${error?.code ?? "unknown error"})`);
      return;
    }
    const previous = index.get(id);
    if (previous !== undefined) {
      index.delete(id);
      total -= previous;
    }
    index.set(id, body.length);
    total += body.length;
    evict();
  }

  /** One upstream request per ID at a time, all callers share it; nothing is kept on failure. */
  function fetchShared(id) {
    let pending = inflight.get(id);
    if (!pending) {
      pending = limiter
        .run(() => fetchThumbnail(id))
        .then(async (body) => {
          if (!(body instanceof Uint8Array) || body.length > THUMB_MAX_BYTES || !looksLikeJpeg(body)) throw upstreamError();
          const buffer = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
          await store(id, buffer);
          return buffer;
        })
        .catch((error) => {
          throw error instanceof HttpError && error.status === 502 ? error : upstreamError();
        })
        .finally(() => inflight.delete(id));
      inflight.set(id, pending);
    }
    return pending;
  }

  return {
    /** The JPEG bytes of `id` (cache first). The caller has checked that `id` is a live video. */
    async get(id) {
      if (!THUMB_ID.test(id)) throw upstreamError();
      load();
      return (await readCached(id)) ?? fetchShared(id);
    },

    /** Deletes the cached files of these YouTube IDs (videos deleted for good). */
    remove(ids) {
      load();
      for (const id of ids) {
        if (typeof id !== "string" || !THUMB_ID.test(id)) continue;
        if (!forget(id)) unlink(fileOf(id));
      }
    },

    /** Deletes cached files whose ID no video uses any more (swapped uploads, crashes); returns how many. */
    prune() {
      load();
      let removed = 0;
      for (const id of [...index.keys()]) {
        if (!isKnown(id)) {
          forget(id);
          removed++;
        }
      }
      return removed;
    },

    /** For tests and diagnostics. */
    stats: () => {
      load();
      return { files: index.size, bytes: total, maxBytes, inFlight: limiter.active, queued: limiter.queued };
    },
  };
}
