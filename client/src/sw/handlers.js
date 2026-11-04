// The service worker's behaviour with its environment injected, so it can be tested with
// fake caches and a fake fetch. src/sw/sw.js wires it to the real `self`.
import {
  CACHE_LIMITS,
  cacheNamesFor,
  catalogKind,
  isCacheableResponse,
  NAVIGATION_TIMEOUT_MS,
  OFFLINE_URL,
  SHELL_URL,
  staleCaches,
  swStrategy,
  trimCache,
  withTimeout,
} from "./strategy.js";

/** Gateway errors mean "the server is unreachable" as much as a failed fetch does. */
const UNREACHABLE = new Set([502, 503, 504]);
const ignore = () => {};

/**
 * @param {object} env
 * @param {string} env.buildId      changes with every build (cache names carry it)
 * @param {string[]} env.precache   same-origin URLs stored at install ("/", /offline.html, hashed assets…)
 * @param {CacheStorage} env.caches
 * @param {typeof fetch} env.fetch
 * @param {string} env.origin       the worker's origin; other origins are never touched
 * @param {Clients} [env.clients]
 * @param {() => Promise<void>} [env.skipWaiting]
 */
export function createServiceWorker({ buildId, precache, caches, fetch, origin, clients, skipWaiting, navigationTimeout = NAVIGATION_TIMEOUT_MS }) {
  const names = cacheNamesFor(buildId);
  const abs = (url) => new URL(url, origin).href;

  // A navigation must not be answered with a redirected response (the browser rejects it).
  async function unredirect(response) {
    if (!response.redirected) return response;
    return new Response(await response.blob(), { status: response.status, statusText: response.statusText, headers: response.headers });
  }

  /** Stores the precache list in this build's shell cache; any failure fails the install (the old worker stays). */
  async function install() {
    const cache = await caches.open(names.shell);
    await Promise.all(
      precache.map(async (url) => {
        const response = await fetch(new Request(abs(url), { cache: "reload", credentials: "same-origin" }));
        if (!response.ok) throw new Error(`Precache of ${url} failed (${response.status})`);
        await cache.put(abs(url), await unredirect(response));
      }),
    );
  }

  /** Deletes every older build's caches, then takes control of open pages. */
  async function activate() {
    const old = staleCaches(await caches.keys(), buildId);
    await Promise.all(old.map((name) => caches.delete(name)));
    await clients?.claim?.();
  }

  /** The page's "Update" button posts { type: "SKIP_WAITING" }. */
  function message(data) {
    if (data?.type === "SKIP_WAITING") return skipWaiting?.();
    return undefined;
  }

  /** Writes a fresh response in the background; caching problems (quota, aborted body) never fail a request. */
  function remember(event, cache, request, response, limit) {
    if (isCacheableResponse(response)) {
      const copy = response.clone();
      event.waitUntil(
        (async () => {
          await cache.put(request, copy);
          if (limit) await trimCache(cache, limit);
        })().catch(ignore),
      );
    } else if (limit && (response.status === 404 || response.status === 410)) {
      // Unpublished or trashed: forget the stale copy.
      event.waitUntil(cache.delete(request, { ignoreVary: true }).catch(ignore));
    }
  }

  async function cacheFirst(event) {
    const { request } = event;
    const cache = await caches.open(names.shell);
    const cached = await cache.match(request, { ignoreVary: true });
    if (cached) return cached;
    const response = await fetch(request);
    remember(event, cache, request, response);
    return response;
  }

  async function networkFirst(event) {
    const network = fetch(event.request);
    let response = null;
    try {
      response = await withTimeout(network, navigationTimeout);
      if (!UNREACHABLE.has(response.status)) return response;
    } catch {
      network.catch(ignore); // a timed-out request may still fail later
    }
    const cache = await caches.open(names.shell);
    const fallback = (await cache.match(abs(SHELL_URL), { ignoreVary: true })) ?? (await cache.match(abs(OFFLINE_URL), { ignoreVary: true }));
    // Nothing cached: the gateway's answer, or keep waiting for the slow network.
    return fallback ?? response ?? network;
  }

  async function staleWhileRevalidate(event) {
    const { request } = event;
    const kind = catalogKind(new URL(request.url, origin).pathname);
    const cache = await caches.open(names[kind]);
    const cached = await cache.match(request, { ignoreVary: true });
    const revalidate = fetch(request).then((response) => {
      remember(event, cache, request, response, CACHE_LIMITS[kind]);
      return response;
    });
    if (!cached) return revalidate;
    // Answer from the cache now and refresh it in the background. When the refresh fails
    // (offline), put the copy back so it still counts as recently used for the LRU.
    const copy = cached.clone();
    event.waitUntil(revalidate.catch(() => cache.put(request, copy).catch(ignore)));
    return cached;
  }

  /** A Promise<Response> for event.respondWith(), or null to let the browser handle the request. */
  function respond(event) {
    switch (swStrategy(event.request, origin)) {
      case "cache-first":
        return cacheFirst(event);
      case "network-first":
        return networkFirst(event);
      case "swr":
        return staleWhileRevalidate(event);
      default:
        return null;
    }
  }

  return { names, install, activate, message, respond };
}
