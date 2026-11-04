// Same-origin YouTube thumbnails (docs/API.md v1.5, v1.7). GET /api/thumbs/<id>.jpg
// (YouTube's hqdefault, 480 wide) and GET /api/thumbs/<id>-m.jpg (mqdefault, 320
// wide) are fetched by this server from i.ytimg.com, so a visitor's browser never
// contacts Google before pressing Play. Only IDs of live, available videos get
// here (the route checks the database first), so this is never an open proxy.
//
// fetchYoutubeThumbnail(): one upstream request, 5 s timeout, no redirects,
// 200 + image/jpeg + JPEG bytes + at most 512 KB (counted while streaming; the
// download is cancelled beyond that). Every failure is a 502 without upstream
// details. Caching, single-flight, the concurrency cap and the failure memory
// live in src/imageCache.js; each size is a key of its own there (thumbKey()).
import { THUMB_UPSTREAM_DEFAULT } from "./config.js";
import { abortion, createImageCache, createImageSource, deadline, mediaType, sniffImageType, upstreamError } from "./imageCache.js";

/** A YouTube video ID. Nothing else ever becomes an upstream URL or a file name. */
export const THUMB_ID = /^[A-Za-z0-9_-]{11}$/;
export const THUMB_MAX_BYTES = 512 * 1024;
export const THUMB_TIMEOUT_MS = 5000;
export { MAX_IN_FLIGHT as THUMB_MAX_IN_FLIGHT } from "./imageCache.js";

/**
 * The sizes we serve: YouTube's file under /vi/<id>/, the suffix of our URL and
 * cache key ("<id><suffix>.jpg"), and the image width (the srcset descriptor).
 */
export const THUMB_SIZES = Object.freeze({
  hq: Object.freeze({ upstream: "hqdefault.jpg", suffix: "", width: 480 }),
  mq: Object.freeze({ upstream: "mqdefault.jpg", suffix: "-m", width: 320 }),
});
const isSize = (size) => typeof size === "string" && Object.hasOwn(THUMB_SIZES, size);

/** The cache key (and file name stem) of one size of a thumbnail: "<id>" or "<id>-m". */
export const thumbKey = (id, size = "hq") => `${id}${THUMB_SIZES[size].suffix}`;
/** The cache keys of every size of these videos' thumbnails (what a purge removes). */
export const thumbKeys = (ids) =>
  ids
    .filter((id) => typeof id === "string" && THUMB_ID.test(id))
    .flatMap((id) => Object.keys(THUMB_SIZES).map((size) => thumbKey(id, size)));
/** { id, size } of a thumbnail cache key or URL file stem ("<11 chars>" or "<11 chars>-m"), or null. */
export function parseThumbKey(key) {
  const match = /^([A-Za-z0-9_-]{11})(-m)?$/.exec(key);
  return match ? { id: match[1], size: match[2] ? "mq" : "hq" } : null;
}

/** Video.thumbnailUrl (hq) or the URL of another size: GET /api/thumbs/<id><suffix>.jpg (src/routes/images.js). */
export const thumbnailPath = (id, size = "hq") => `/api/thumbs/${thumbKey(id, size)}.jpg`;
/** Video.thumbnailSrcSet (v1.7): "/api/thumbs/<id>-m.jpg 320w, /api/thumbs/<id>.jpg 480w", narrowest first. */
export const thumbnailSrcSet = (id) =>
  Object.entries(THUMB_SIZES)
    .sort(([, a], [, b]) => a.width - b.width)
    .map(([size, { width }]) => `${thumbnailPath(id, size)} ${width}w`)
    .join(", ");

/**
 * The default `fetchThumbnail(id, size)`: <size>default.jpg (`size` "hq", the
 * default, or "mq") from i.ytimg.com as a Buffer, or an HttpError 502. `baseUrl`
 * is the THUMB_UPSTREAM test override (outside production only, see config.js
 * thumbnailUpstream()); `fetchImpl`, `timeoutMs` and `maxBytes` are for unit
 * tests. The checks are the same whatever the base and the size.
 */
export async function fetchYoutubeThumbnail(
  id,
  {
    size = "hq",
    baseUrl = THUMB_UPSTREAM_DEFAULT,
    fetchImpl = globalThis.fetch,
    timeoutMs = THUMB_TIMEOUT_MS,
    maxBytes = THUMB_MAX_BYTES,
  } = {}
) {
  if (typeof id !== "string" || !THUMB_ID.test(id) || !isSize(size)) throw upstreamError();
  const timer = deadline(timeoutMs);
  const { signal } = timer;
  let reader = null;
  // A pending read() resolves { done: true } once cancelled; the loop then sees signal.aborted.
  const cancel = () => reader?.cancel().catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const response = await Promise.race([
      fetchImpl(`${baseUrl}/vi/${id}/${THUMB_SIZES[size].upstream}`, { signal, redirect: "error" }),
      abortion(signal),
    ]);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (response.status !== 200 || mediaType(response.headers.get("content-type")) !== "image/jpeg" || declared > maxBytes || !response.body) {
      response.body?.cancel().catch(() => {});
      throw upstreamError();
    }
    reader = response.body.getReader();
    if (signal.aborted) cancel();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw upstreamError();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        cancel();
        throw upstreamError();
      }
      chunks.push(value);
    }
    const body = Buffer.concat(chunks, received);
    if (sniffImageType(body) !== "image/jpeg") throw upstreamError();
    return body;
  } catch {
    // Timeout, network error, refused redirect, bad answer: one 502, no upstream detail kept or logged.
    throw upstreamError();
  } finally {
    timer.clear();
    signal.removeEventListener("abort", cancel);
  }
}

const fetchDefault = (id, size) => fetchYoutubeThumbnail(id, { size });

/**
 * Thumbnails into a shared image cache: `get(id, { size, onMiss })` -> { body, type: "image/jpeg" }
 * (`size` "hq", the default, or "mq"). `fetchThumbnail(id, size)` resolves the JPEG bytes. Each
 * size is its own cache key, so single-flight and the failure memory are per ID and size.
 */
export function createThumbnailSource({ cache, fetchThumbnail = fetchDefault, ...options }) {
  const source = createImageSource({
    cache,
    maxBytes: THUMB_MAX_BYTES,
    fetch: async (key) => {
      const { id, size } = parseThumbKey(key);
      return { body: await fetchThumbnail(id, size), type: "image/jpeg" };
    },
    ...options,
  });
  return {
    ...source,
    get(id, { size = "hq", ...opts } = {}) {
      if (typeof id !== "string" || !THUMB_ID.test(id) || !isSize(size)) return Promise.reject(upstreamError());
      return source.get(thumbKey(id, size), opts);
    },
  };
}

/**
 * A thumbnail cache of its own (unit tests): `get(id, { size })` -> Buffer, plus remove (every
 * size of these IDs)/prune/stats. The app shares one image cache between thumbnails and covers
 * instead (src/app.js).
 */
export function createThumbnailCache({ dir, maxBytes, fetchThumbnail = fetchDefault, isKnown, log, now, ...options }) {
  const cache = createImageCache({ dir, maxBytes, isKnown, log, now });
  const source = createThumbnailSource({ cache, fetchThumbnail, now, ...options });
  return {
    get: async (id, opts) => (await source.get(id, opts)).body,
    remove: (ids) => cache.remove(thumbKeys(ids)),
    prune: () => cache.prune(),
    stats: () => ({ ...cache.stats(), ...source.stats() }),
  };
}
