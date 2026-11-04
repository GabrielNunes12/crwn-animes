// Same-origin YouTube thumbnails (docs/API.md v1.5). GET /api/thumbs/<id>.jpg is
// fetched by this server from i.ytimg.com, so a visitor's browser never contacts
// Google before pressing Play. Only IDs of live, available videos get here (the
// route checks the database first), so this is never an open proxy.
//
// fetchYoutubeThumbnail(): one upstream request, 5 s timeout, no redirects,
// 200 + image/jpeg + JPEG bytes + at most 512 KB (counted while streaming; the
// download is cancelled beyond that). Every failure is a 502 without upstream
// details. Caching, single-flight, the concurrency cap and the failure memory
// live in src/imageCache.js.
import { THUMB_UPSTREAM_DEFAULT } from "./config.js";
import { abortion, createImageCache, createImageSource, mediaType, sniffImageType, upstreamError } from "./imageCache.js";

/** A YouTube video ID. Nothing else ever becomes an upstream URL or a file name. */
export const THUMB_ID = /^[A-Za-z0-9_-]{11}$/;
export const THUMB_MAX_BYTES = 512 * 1024;
export const THUMB_TIMEOUT_MS = 5000;
export { MAX_IN_FLIGHT as THUMB_MAX_IN_FLIGHT } from "./imageCache.js";

/**
 * The default `fetchThumbnail(id)`: hqdefault.jpg from i.ytimg.com as a Buffer,
 * or an HttpError 502. `baseUrl` is the THUMB_UPSTREAM test override (outside
 * production only, see config.js thumbnailUpstream()); `fetchImpl`, `timeoutMs`
 * and `maxBytes` are for unit tests. The checks are the same whatever the base.
 */
export async function fetchYoutubeThumbnail(
  id,
  {
    baseUrl = THUMB_UPSTREAM_DEFAULT,
    fetchImpl = globalThis.fetch,
    timeoutMs = THUMB_TIMEOUT_MS,
    maxBytes = THUMB_MAX_BYTES,
  } = {}
) {
  if (typeof id !== "string" || !THUMB_ID.test(id)) throw upstreamError();
  const signal = AbortSignal.timeout(timeoutMs);
  let reader = null;
  // A pending read() resolves { done: true } once cancelled; the loop then sees signal.aborted.
  const cancel = () => reader?.cancel().catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const response = await Promise.race([
      fetchImpl(`${baseUrl}/vi/${id}/hqdefault.jpg`, { signal, redirect: "error" }),
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
    if (sniffImageType(body) !== "image/jpeg") throw upstreamError();
    return body;
  } catch {
    // Timeout, network error, refused redirect, bad answer: one 502, no upstream detail kept or logged.
    throw upstreamError();
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

/** Thumbnails into a shared image cache: `get(id, { onMiss })` -> { body, type: "image/jpeg" }. */
export function createThumbnailSource({ cache, fetchThumbnail = fetchYoutubeThumbnail, ...options }) {
  const source = createImageSource({
    cache,
    maxBytes: THUMB_MAX_BYTES,
    fetch: async (id) => ({ body: await fetchThumbnail(id), type: "image/jpeg" }),
    ...options,
  });
  return {
    ...source,
    get(id, opts) {
      if (typeof id !== "string" || !THUMB_ID.test(id)) return Promise.reject(upstreamError());
      return source.get(id, opts);
    },
  };
}

/**
 * A thumbnail cache of its own (unit tests): `get(id)` -> Buffer, plus remove/prune/stats.
 * The app shares one image cache between thumbnails and covers instead (src/app.js).
 */
export function createThumbnailCache({ dir, maxBytes, fetchThumbnail = fetchYoutubeThumbnail, isKnown, log, now, ...options }) {
  const cache = createImageCache({ dir, maxBytes, isKnown, log, now });
  const source = createThumbnailSource({ cache, fetchThumbnail, now, ...options });
  return {
    get: async (id, opts) => (await source.get(id, opts)).body,
    remove: (ids) => cache.remove(ids),
    prune: () => cache.prune(),
    stats: () => ({ ...cache.stats(), ...source.stats() }),
  };
}
