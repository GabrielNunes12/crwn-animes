// Pure routing rules of the service worker (docs/API.md v1.5, "PWA").
// No access to `self`, `caches` or `fetch` here: everything is unit-tested in Node.

/** Every cache this app owns starts with this; anything else on the origin is left alone. */
export const CACHE_PREFIX = "crwn-";
/** Navigations wait this long for the network before falling back to the cached shell. */
export const NAVIGATION_TIMEOUT_MS = 3000;
/** The app shell (index.html as the server renders it for "/"). */
export const SHELL_URL = "/";
/** Last resort for a navigation: works without the shell or any script bundle. */
export const OFFLINE_URL = "/offline.html";
/** Precached next to OFFLINE_URL: the CSP forbids inline scripts, so its tiny script is a file. */
export const OFFLINE_SCRIPT_URL = "/offline.js";
/** Unhashed public files the shell and the offline page need, precached with every build. */
export const STATIC_URLS = [OFFLINE_URL, OFFLINE_SCRIPT_URL, "/theme-init.js", "/favicon.svg"];
/**
 * Runtime (stale-while-revalidate) caches are capped; the least recently used entries go first.
 * "thumbs" is the image cache: video thumbnails and series covers share it (and its cap).
 */
export const CACHE_LIMITS = { api: 150, thumbs: 300 };
/** The runtime caches, i.e. what "Clear watch history" deletes (the shell is the app itself). */
export const RUNTIME_KINDS = ["api", "thumbs"];

export const SECTIONS = ["anime", "manga"];

/**
 * Never cached, never answered from a cache: personal, admin, dev, random and rating routes.
 * Matched against the lower-cased, percent-decoded path (Express routes case-insensitively).
 * `/api/me*` is a prefix on purpose, as written in the contract.
 */
export const NEVER_CACHE = [
  /^\/api\/auth(?:\/|$)/,
  /^\/api\/me/,
  /^\/api\/admin(?:\/|$)/,
  /^\/api\/dev(?:\/|$)/,
  /^\/api\/random(?:\/|$)/,
  /^\/api\/(?:.*\/)?ratings?(?:\/|$)/,
];

/** Public catalog GETs (stale-while-revalidate). Anything else under /api/ is bypassed. */
const CATALOG = [
  /^\/api\/sections$/,
  /^\/api\/genres$/,
  /^\/api\/latest$/,
  /^\/api\/top-rated$/,
  /^\/api\/trending$/,
  /^\/api\/search$/,
  new RegExp(`^/api/(?:${SECTIONS.join("|")})/series(?:/[^/]+)?$`),
  /^\/api\/videos\/[^/]+$/, // `/rating` below it is in NEVER_CACHE
];
const THUMB = /^\/api\/thumbs\/[A-Za-z0-9_-]{11}\.jpg$/;
const COVER = /^\/api\/covers\/\d{1,15}\.img$/; // ?v=<hash of the source URL> changes with the cover

/** Cache names for one build: every name carries the build id, so a new build never reads an old cache. */
export function cacheNamesFor(buildId) {
  return {
    shell: `${CACHE_PREFIX}shell-${buildId}`,
    api: `${CACHE_PREFIX}api-${buildId}`,
    thumbs: `${CACHE_PREFIX}thumbs-${buildId}`,
  };
}

/** Our caches that are not this build's (deleted on activate). Foreign caches are kept. */
export function staleCaches(cacheKeys, buildId) {
  const current = new Set(Object.values(cacheNamesFor(buildId)));
  return cacheKeys.filter((name) => name.startsWith(CACHE_PREFIX) && !current.has(name));
}

/** Names of runtime caches (any build): catalog data and images, never the app shell. */
export function runtimeCaches(cacheKeys) {
  return cacheKeys.filter((name) => RUNTIME_KINDS.some((kind) => name.startsWith(`${CACHE_PREFIX}${kind}-`)));
}

/** True for paths that must never be cached (see NEVER_CACHE). Malformed paths count as never-cache. */
export function isNeverCached(pathname) {
  const path = normalisedPath(pathname);
  return path === null || NEVER_CACHE.some((re) => re.test(path));
}

/** Lower-cased and percent-decoded, or null when the escapes are malformed. */
function normalisedPath(pathname) {
  try {
    return decodeURIComponent(pathname).toLowerCase();
  } catch {
    return null;
  }
}

/** "thumbs" for /api/thumbs/<id>.jpg and /api/covers/<id>.img, "api" for the other catalog GETs, else null. */
export function catalogKind(pathname) {
  if (THUMB.test(pathname) || COVER.test(pathname)) return "thumbs";
  return CATALOG.some((re) => re.test(pathname)) ? "api" : null;
}

const header = (request, name) => request.headers?.get?.(name) ?? null;

/** A non-blank `q` is something the visitor typed: search terms are never stored on the device. */
export function hasSearchTerm(url) {
  return url.searchParams.getAll("q").some((q) => q.trim() !== "");
}

/**
 * How the service worker answers `request` (a Request, or anything with url/method/mode/headers/cache):
 *   "cache-first"   hashed /assets/* and the precached static files;
 *   "network-first" page navigations (3 s timeout → cached shell → /offline.html);
 *   "swr"           public catalog GETs (searches only without a typed `q`), thumbnails and covers;
 *   "bypass"        everything else: the browser handles it and nothing is cached.
 * The never-cache list wins over every other rule, navigations included (e.g. /api/me/export).
 */
export function swStrategy(request, origin) {
  if ((request.method ?? "GET").toUpperCase() !== "GET") return "bypass";
  let url;
  try {
    url = new URL(request.url, origin);
  } catch {
    return "bypass";
  }
  if (url.origin !== origin) return "bypass";
  // Partial content (media seeking), explicit no-store fetches and credentials in headers.
  if (header(request, "range") || header(request, "authorization") || request.cache === "no-store") return "bypass";

  const { pathname } = url;
  if (isNeverCached(pathname)) return "bypass";
  // Express also answers /API/… or /api/%6De: only the exact catalog spellings are ever cached.
  const path = normalisedPath(pathname);
  if (path === "/api" || path.startsWith("/api/")) {
    const kind = catalogKind(pathname);
    return kind && !(kind === "api" && hasSearchTerm(url)) ? "swr" : "bypass";
  }
  if (request.mode === "navigate") return "network-first";
  if (pathname.startsWith("/assets/") || pathname.startsWith("/icons/") || STATIC_URLS.includes(pathname)) return "cache-first";
  return "bypass"; // /sw.js, /manifest.webmanifest, /robots.txt, sitemaps…
}

/** Cache-Control directives, lower-cased (`max-age=60` → "max-age"). */
function cacheControl(response) {
  const value = response.headers?.get?.("cache-control") ?? "";
  return new Set(
    value
      .split(",")
      .map((d) => d.split("=")[0].trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Only complete, same-origin 200 responses that the server allows to be shared:
 * never opaque/cors/redirect-filtered responses, partial content (206), `Vary: *`,
 * or anything marked `Cache-Control: private` / `no-store`.
 */
export function isCacheableResponse(response) {
  if (!response || response.status !== 200) return false;
  if (response.type !== "basic" && response.type !== "default") return false;
  const cc = cacheControl(response);
  if (cc.has("no-store") || cc.has("private")) return false;
  const vary = response.headers?.get?.("vary") ?? "";
  return !vary.split(",").some((v) => v.trim() === "*");
}

/**
 * LRU trimming. Cache Storage lists keys in insertion order and `put` moves a key to
 * the end, so the head of the list is the least recently used: keep the last `max`.
 */
export function keysToEvict(keys, max) {
  return keys.length > max ? keys.slice(0, keys.length - max) : [];
}

/** Deletes the least recently used entries above `max`. Resolves with how many went. */
export async function trimCache(cache, max) {
  const evict = keysToEvict(await cache.keys(), max);
  await Promise.all(evict.map((key) => cache.delete(key)));
  return evict.length;
}

/** Rejects with a "timeout" error when `promise` takes longer than `ms`. */
export function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
