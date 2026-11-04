// What same-origin thumbnails (src/thumbnails.js) and series covers
// (src/covers.js) share (docs/API.md v1.5):
//
// - createImageCache(): one on-disk LRU cache (THUMB_CACHE_DIR, THUMB_CACHE_MB).
//   A key is an 11-char YouTube ID (thumbnail) or "cover-<seriesId>-<8 hex>";
//   the file is "<key>.<jpg|png|webp|avif>", built from a validated key only.
//   Writes go to a temporary file and are renamed; just before the rename
//   `isKnown(key)` must still hold, so an image purged mid-download leaves
//   nothing. Index changes (rename, evict, remove) are synchronous. A hit
//   refreshes the file's mtime (at most once a minute) and the start-up scan
//   orders files by mtime, so least-recently-used order survives restarts.
// - createImageSource(): single-flight per key, at most `maxInFlight` upstream
//   fetches at once (a bounded queue behind them), and a failure memory: a key
//   whose fetch failed answers 502 without any upstream request for 10 minutes.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { HttpError } from "./errors.js";

/** Content types we store and serve, with their file extension. */
export const IMAGE_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/avif": "avif" };
const TYPE_OF_EXT = Object.fromEntries(Object.entries(IMAGE_TYPES).map(([type, ext]) => [ext, type]));

const KEY = String.raw`[A-Za-z0-9_-]{11}|cover-[1-9]\d{0,15}-[0-9a-f]{8}`;
/** A cache key: nothing else ever becomes a file name. */
export const CACHE_KEY = new RegExp(`^(?:${KEY})$`);
const CACHE_FILE = new RegExp(`^(${KEY})\\.(jpg|png|webp|avif)$`);
const TEMP_FILE = new RegExp(`^(?:${KEY})\\.[0-9a-f]{16}\\.tmp$`);

export const FAILURE_TTL_MS = 10 * 60 * 1000;
const MAX_FAILURES = 10_000;
const TOUCH_EVERY_MS = 60 * 1000;
export const MAX_IN_FLIGHT = 4;
const MAX_QUEUED = 256;

/** Every upstream problem looks the same from outside: no host, address, status or path. */
export const upstreamError = () => new HttpError(502, "Could not load this image.");

const ascii = (bytes, from, to) => String.fromCharCode(...bytes.subarray(from, to));

/** The image type the bytes really are (magic numbers), or null. */
export function sniffImageType(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 3) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)) return "image/png";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 16 && ascii(bytes, 4, 8) === "ftyp") {
    // ISO-BMFF "ftyp" box: major brand, minor version, compatible brands.
    const boxEnd = Math.min(new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0), bytes.length);
    const brands = [ascii(bytes, 8, 12)];
    for (let at = 16; at + 4 <= boxEnd; at += 4) brands.push(ascii(bytes, at, at + 4));
    if (brands.some((brand) => brand === "avif" || brand === "avis")) return "image/avif";
  }
  return null;
}

/** "image/JPEG; charset=x" -> "image/jpeg". */
export const mediaType = (header) => String(header ?? "").split(";")[0].trim().toLowerCase();

/** Rejects (502) once `signal` aborts, for code that might ignore it. Never an unhandled rejection. */
export function abortion(signal) {
  const promise = new Promise((resolve, reject) => {
    if (signal.aborted) reject(upstreamError());
    else signal.addEventListener("abort", () => reject(upstreamError()), { once: true });
  });
  promise.catch(() => {});
  return promise;
}

/** Runs at most `max` tasks at once; up to `maxQueued` more wait, beyond that a 502 at once (not remembered). */
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
      if (queue.length >= maxQueued) return Promise.reject(Object.assign(upstreamError(), { busy: true }));
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
 * @param dir       cache directory (created on the first write)
 * @param maxBytes  size cap of the cached files; 0 keeps nothing on disk
 * @param isKnown   (key) => true while the image still belongs to something (a video,
 *                  a series' current cover); checked before a commit and by prune()
 * @param log       where a failed write is reported (its error code only)
 */
export function createImageCache({ dir, maxBytes, isKnown = () => true, log = (message) => console.error(message), now = Date.now }) {
  const index = new Map(); // key -> { size, type, touchedAt }; iteration order = least recently used first
  let total = 0;
  let loaded = false;
  const fileOf = (key, type) => path.join(dir, `${key}.${IMAGE_TYPES[type]}`);

  const unlink = (file) => {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // EBUSY/EPERM: out of the index anyway; the next start-up scan sees it again.
    }
  };

  function forget(key) {
    const entry = index.get(key);
    if (!entry) return false;
    index.delete(key);
    total -= entry.size;
    unlink(fileOf(key, entry.type));
    return true;
  }

  function evict() {
    for (const key of index.keys()) {
      if (total <= maxBytes) break;
      forget(key);
    }
  }

  /** Indexes what a previous run left (least recently used first), once, synchronously. */
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
        found.push({ key: match[1], type: TYPE_OF_EXT[match[2]], size: stat.size, at: stat.mtimeMs, file });
      } catch {
        // vanished meanwhile
      }
    }
    found.sort((a, b) => a.at - b.at);
    for (const { key, type, size, at, file } of found) {
      const previous = index.get(key);
      if (previous) {
        unlink(fileOf(key, previous.type)); // same key, older type: keep the newest file only
        total -= previous.size;
        index.delete(key);
      }
      if (!fs.existsSync(file)) continue;
      index.set(key, { size, type, touchedAt: at });
      total += size;
    }
    evict();
  }

  return {
    /** { body, type } from disk (and now the most recently used), or null. */
    async read(key) {
      load();
      const entry = index.get(key);
      if (!entry) return null;
      const file = fileOf(key, entry.type);
      let body;
      try {
        body = await fsp.readFile(file);
      } catch {
        if (index.get(key) === entry) forget(key); // gone from disk: fetch it again
        return null;
      }
      if (index.get(key) === entry) {
        index.delete(key);
        index.set(key, entry);
        const at = now();
        if (at - entry.touchedAt >= TOUCH_EVERY_MS) {
          entry.touchedAt = at;
          try {
            fs.utimesSync(file, at / 1000, at / 1000); // the LRU order a restart will see
          } catch {
            // read-only or vanished: the in-memory order still holds
          }
        }
      }
      return { body, type: entry.type };
    },

    async store(key, body, type) {
      load();
      if (!CACHE_KEY.test(key) || !IMAGE_TYPES[type] || body.length > maxBytes) return; // also: maxBytes 0 = no disk cache
      const temp = path.join(dir, `${key}.${randomBytes(8).toString("hex")}.tmp`);
      try {
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(temp, body, { flag: "wx" });
        // Synchronous from here: no purge can run between this check and the rename.
        if (!isKnown(key)) {
          unlink(temp);
          return;
        }
        fs.renameSync(temp, fileOf(key, type));
      } catch (error) {
        unlink(temp);
        log(`[images] could not write the image cache (${error?.code ?? "unknown error"})`);
        return;
      }
      const previous = index.get(key);
      if (previous) {
        index.delete(key);
        total -= previous.size;
        if (previous.type !== type) unlink(fileOf(key, previous.type));
      }
      index.set(key, { size: body.length, type, touchedAt: now() });
      total += body.length;
      evict();
    },

    /** Deletes these keys' files (also files the index lost track of). */
    remove(keys) {
      load();
      for (const key of keys) {
        if (typeof key !== "string" || !CACHE_KEY.test(key)) continue;
        if (!forget(key)) for (const type of Object.keys(IMAGE_TYPES)) unlink(fileOf(key, type));
      }
    },

    /** Deletes every cached file whose key matches. */
    removeMatching(predicate) {
      load();
      for (const key of [...index.keys()]) if (predicate(key)) forget(key);
    },

    /** Deletes cached files that belong to nothing any more; returns how many. */
    prune() {
      load();
      let removed = 0;
      for (const key of [...index.keys()]) {
        if (!isKnown(key)) {
          forget(key);
          removed++;
        }
      }
      return removed;
    },

    stats() {
      load();
      return { files: index.size, bytes: total, maxBytes };
    },
  };
}

/**
 * Fetches images into `cache`: `fetch(key, context)` resolves { body, type } or throws
 * (`context`: what the request that starts the fetch passed to get(), e.g. a cover's URL).
 * The result must be one of IMAGE_TYPES, really be that type (magic bytes) and
 * fit in `maxBytes`, whatever the fetcher says. Every failure is a 502.
 */
export function createImageSource({
  cache,
  fetch,
  maxBytes,
  maxInFlight = MAX_IN_FLIGHT,
  maxQueued = MAX_QUEUED,
  failureTtlMs = FAILURE_TTL_MS,
  maxFailures = MAX_FAILURES,
  now = Date.now,
}) {
  const inflight = new Map(); // key -> Promise<{ body, type }>
  const failures = new Map(); // key -> time the memory ends; insertion order = oldest first
  const limiter = createLimiter(maxInFlight, maxQueued);

  function failedRecently(key) {
    const until = failures.get(key);
    if (until === undefined) return false;
    if (until > now()) return true;
    failures.delete(key);
    return false;
  }

  function rememberFailure(key) {
    failures.delete(key);
    failures.set(key, now() + failureTtlMs);
    while (failures.size > maxFailures) failures.delete(failures.keys().next().value);
  }

  function fetchShared(key, context) {
    let pending = inflight.get(key);
    if (!pending) {
      pending = limiter
        .run(() => fetch(key, context))
        .then(
          async (result) => {
            const { body, type } = result ?? {};
            if (!(body instanceof Uint8Array) || body.length > maxBytes || !IMAGE_TYPES[type] || sniffImageType(body) !== type) {
              rememberFailure(key);
              throw upstreamError();
            }
            const buffer = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
            await cache.store(key, buffer, type);
            return { body: buffer, type };
          },
          (error) => {
            if (!error?.busy) rememberFailure(key); // a full queue is our problem, not the upstream's
            throw upstreamError();
          }
        )
        .finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    return pending;
  }

  return {
    /**
     * { body, type }: from the cache, else (unless this key failed in the last 10 minutes)
     * from upstream. `onMiss()` runs before an upstream fetch starts or is joined and may
     * throw (the per-IP miss limit).
     */
    async get(key, { onMiss, context } = {}) {
      const hit = await cache.read(key);
      if (hit) return hit;
      if (failedRecently(key)) throw upstreamError();
      onMiss?.();
      return fetchShared(key, context);
    },
    forgetFailures: () => failures.clear(),
    stats: () => ({ inFlight: limiter.active, queued: limiter.queued, failures: failures.size }),
  };
}
