import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CACHE_LIMITS,
  cacheNamesFor,
  catalogKind,
  isCacheableResponse,
  isNeverCached,
  keysToEvict,
  NAVIGATION_TIMEOUT_MS,
  staleCaches,
  swStrategy,
  trimCache,
  withTimeout,
} from "./strategy.js";

const ORIGIN = "https://crwn.example";

/** A request-like object: `new Request()` refuses mode "navigate", the worker only reads these fields. */
const req = (path, { method = "GET", mode = "cors", headers = {}, cache = "default" } = {}) => ({
  url: path.startsWith("http") ? path : ORIGIN + path,
  method,
  mode,
  cache,
  headers: new Headers(headers),
});
const strategy = (path, init) => swStrategy(req(path, init), ORIGIN);
const nav = (path) => strategy(path, { mode: "navigate" });

describe("swStrategy — route classes", () => {
  it("hashed /assets/* and the precached static files are cache-first", () => {
    for (const path of [
      "/assets/index-DbReS792.js",
      "/assets/index-DaSkZ6ac.css",
      "/assets/inter-latin-wght-normal-Dx4kXJAl.woff2",
      "/icons/icon-192.png",
      "/offline.html",
      "/offline.js",
      "/theme-init.js",
      "/favicon.svg",
    ]) {
      expect(strategy(path, { mode: "no-cors" }), path).toBe("cache-first");
    }
  });

  it("page navigations are network-first", () => {
    for (const path of ["/", "/anime", "/anime/naruto/season/2/episode/3", "/manga/x/chapter/1", "/genre/Sci.Fi", "/search?q=x", "/account", "/admin/series/4", "/offline.html"]) {
      expect(nav(path), path).toBe("network-first");
    }
  });

  it("every public catalog GET is stale-while-revalidate", () => {
    for (const path of [
      "/api/sections",
      "/api/genres",
      "/api/latest",
      "/api/latest?limit=12&offset=12&section=anime",
      "/api/top-rated?section=manga&limit=12",
      "/api/trending",
      "/api/anime/series",
      "/api/manga/series?genre=A%C3%A7%C3%A3o&q=one",
      "/api/anime/series/naruto",
      "/api/anime/series/naruto?season=2",
      "/api/videos/42",
      "/api/search?q=naruto&sort=rating",
      "/api/thumbs/dQw4w9WgXcQ.jpg",
    ]) {
      expect(strategy(path), path).toBe("swr");
    }
  });

  it("thumbnails and the rest of the catalog use separate caches", () => {
    expect(catalogKind("/api/thumbs/dQw4w9WgXcQ.jpg")).toBe("thumbs");
    expect(catalogKind("/api/latest")).toBe("api");
    expect(catalogKind("/api/thumbs/short.jpg")).toBeNull();
    expect(catalogKind("/api/thumbs/dQw4w9WgXcQ.png")).toBeNull();
    expect(CACHE_LIMITS).toEqual({ api: 150, thumbs: 300 });
  });
});

describe("swStrategy — never cached", () => {
  const NEVER = [
    "/api/auth/me",
    "/api/auth/login",
    "/api/auth/verify-email?token=x",
    "/api/me",
    "/api/me/export",
    "/api/admin/series",
    "/api/admin/series/4",
    "/api/admin/videos/1/preview",
    "/api/admin/trash",
    "/api/videos/42/rating",
    "/api/dev/outbox",
    "/api/random",
    "/api/random?section=anime",
  ];

  it("auth, me, admin, rating, dev and random routes are bypassed", () => {
    for (const path of NEVER) {
      expect(strategy(path), path).toBe("bypass");
      expect(isNeverCached(new URL(path, ORIGIN).pathname), path).toBe(true);
    }
  });

  it("…even as navigations (the account export link) or spelled differently", () => {
    expect(nav("/api/me/export")).toBe("bypass");
    expect(nav("/api/auth/me")).toBe("bypass");
    for (const path of ["/API/ME", "/Api/Admin/series", "/api/%6De", "/api/%61dmin/series", "/api/anime/series/x/../../../me", "/api/videos/42/Rating", "/api/%E0%A4%A"]) {
      expect(strategy(path), path).toBe("bypass");
      expect(nav(path), path).toBe("bypass");
    }
  });

  it("does not mistake catalog routes for never-cached ones", () => {
    expect(isNeverCached("/api/latest")).toBe(false);
    expect(isNeverCached("/api/videos/42")).toBe(false);
    expect(isNeverCached("/anime/rating")).toBe(false); // a series slug, not an API route
    expect(nav("/anime/rating")).toBe("network-first");
  });

  it("non-GET requests are bypassed", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      expect(strategy("/api/latest", { method }), method).toBe("bypass");
      expect(strategy("/assets/index.js", { method }), method).toBe("bypass");
    }
    expect(strategy("/api/videos/42/rating", { method: "PUT" })).toBe("bypass");
  });

  it("other origins (YouTube, series covers) are never touched", () => {
    for (const url of ["https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg", "https://www.youtube.com/iframe_api", "https://covers.example/a.jpg", "http://crwn.example/api/latest"]) {
      expect(strategy(url, { mode: "no-cors" }), url).toBe("bypass");
    }
  });

  it("range requests, explicit no-store fetches and Authorization headers are bypassed", () => {
    expect(strategy("/assets/clip.mp4", { headers: { Range: "bytes=0-" } })).toBe("bypass");
    expect(strategy("/api/thumbs/dQw4w9WgXcQ.jpg", { headers: { Range: "bytes=100-200" } })).toBe("bypass");
    expect(strategy("/api/latest", { cache: "no-store" })).toBe("bypass");
    expect(strategy("/api/latest", { headers: { Authorization: "Bearer x" } })).toBe("bypass");
  });

  it("unknown API routes and server-only files are bypassed", () => {
    for (const path of ["/api", "/api/whatever", "/api/anime/series/x/extra", "/api/comics/series", "/api/videos", "/sw.js", "/manifest.webmanifest", "/robots.txt", "/sitemap.xml"]) {
      expect(strategy(path), path).toBe("bypass");
    }
  });
});

describe("isCacheableResponse", () => {
  const res = (status = 200, headers = {}, type = "basic") => ({ status, type, headers: new Headers(headers) });

  it("accepts complete same-origin 200s, including public and no-cache ones", () => {
    expect(isCacheableResponse(res())).toBe(true);
    expect(isCacheableResponse(res(200, { "Cache-Control": "public, max-age=60, stale-while-revalidate=600" }))).toBe(true);
    expect(isCacheableResponse(res(200, { "Cache-Control": "no-cache" }))).toBe(true); // the shell
    expect(isCacheableResponse(new Response("{}", { status: 200 }))).toBe(true); // type "default"
  });

  it("rejects private / no-store responses, whatever the spelling", () => {
    expect(isCacheableResponse(res(200, { "Cache-Control": "private, no-store" }))).toBe(false);
    expect(isCacheableResponse(res(200, { "Cache-Control": "no-store" }))).toBe(false);
    expect(isCacheableResponse(res(200, { "Cache-Control": "Private, max-age=0" }))).toBe(false);
    expect(isCacheableResponse(res(200, { "Cache-Control": "max-age=60, NO-STORE" }))).toBe(false);
  });

  it("rejects partial, opaque, error and Vary: * responses", () => {
    expect(isCacheableResponse(res(206))).toBe(false);
    expect(isCacheableResponse(res(0, {}, "opaque"))).toBe(false);
    expect(isCacheableResponse(res(200, {}, "opaqueredirect"))).toBe(false);
    expect(isCacheableResponse(res(200, {}, "cors"))).toBe(false);
    expect(isCacheableResponse(res(404))).toBe(false);
    expect(isCacheableResponse(res(500))).toBe(false);
    expect(isCacheableResponse(res(304))).toBe(false);
    expect(isCacheableResponse(res(200, { Vary: "Origin, *" }))).toBe(false);
    expect(isCacheableResponse(res(200, { Vary: "Origin" }))).toBe(true);
    expect(isCacheableResponse(null)).toBe(false);
  });
});

describe("cache names", () => {
  it("every cache name carries the build id", () => {
    expect(cacheNamesFor("abc123")).toEqual({ shell: "crwn-shell-abc123", api: "crwn-api-abc123", thumbs: "crwn-thumbs-abc123" });
  });

  it("activate deletes only our caches from other builds", () => {
    const keys = ["crwn-shell-old", "crwn-api-old", "crwn-thumbs-old", "crwn-shell-new", "crwn-api-new", "crwn-thumbs-new", "someone-else"];
    expect(staleCaches(keys, "new")).toEqual(["crwn-shell-old", "crwn-api-old", "crwn-thumbs-old"]);
    expect(staleCaches(["crwn-shell-new"], "new")).toEqual([]);
  });
});

describe("LRU trimming", () => {
  it("keysToEvict drops the head of the insertion-ordered list", () => {
    expect(keysToEvict(["a", "b", "c", "d"], 2)).toEqual(["a", "b"]);
    expect(keysToEvict(["a", "b"], 2)).toEqual([]);
    expect(keysToEvict([], 5)).toEqual([]);
  });

  it("trimCache deletes the least recently used entries above the cap", async () => {
    const order = ["a", "b", "c", "d", "e"];
    const cache = {
      keys: async () => [...order],
      delete: vi.fn(async (k) => order.splice(order.indexOf(k), 1).length > 0),
    };
    expect(await trimCache(cache, 3)).toBe(2);
    expect(cache.delete.mock.calls.map(([k]) => k)).toEqual(["a", "b"]);
    expect(order).toEqual(["c", "d", "e"]);
    expect(await trimCache(cache, 3)).toBe(0);
  });
});

describe("withTimeout", () => {
  afterEach(() => vi.useRealTimers());

  it("resolves with the promise when it is fast enough", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 10)).resolves.toBe("ok");
  });

  it("rejects after the timeout (3 s for navigations)", async () => {
    vi.useFakeTimers();
    const slow = new Promise(() => {});
    const out = withTimeout(slow, NAVIGATION_TIMEOUT_MS);
    const assertion = expect(out).rejects.toThrow("timeout");
    await vi.advanceTimersByTimeAsync(NAVIGATION_TIMEOUT_MS);
    await assertion;
    expect(NAVIGATION_TIMEOUT_MS).toBe(3000);
  });
});
