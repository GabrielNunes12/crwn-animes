import { afterEach, describe, expect, it, vi } from "vitest";
import { createServiceWorker } from "./handlers.js";
import { CACHE_LIMITS, NAVIGATION_TIMEOUT_MS } from "./strategy.js";

const ORIGIN = "https://crwn.example";
const BUILD = "b1";

// ---- in-memory Cache Storage with the spec's ordering: keys() in insertion order, put() moves a key to the end
class FakeCache {
  entries = new Map();
  key(request) {
    return typeof request === "string" ? new URL(request, ORIGIN).href : request.url;
  }
  async match(request) {
    return this.entries.get(this.key(request))?.clone();
  }
  async put(request, response) {
    const key = this.key(request);
    this.entries.delete(key);
    this.entries.set(key, response.clone());
  }
  async delete(request) {
    return this.entries.delete(this.key(request));
  }
  async keys() {
    return [...this.entries.keys()].map((url) => new Request(url));
  }
  urls() {
    return [...this.entries.keys()].map((url) => url.slice(ORIGIN.length));
  }
}

class FakeCacheStorage {
  stores = new Map();
  async open(name) {
    if (!this.stores.has(name)) this.stores.set(name, new FakeCache());
    return this.stores.get(name);
  }
  async keys() {
    return [...this.stores.keys()];
  }
  async delete(name) {
    return this.stores.delete(name);
  }
  peek(name) {
    return this.stores.get(name) ?? new FakeCache();
  }
}

const PUBLIC = { "Cache-Control": "public, max-age=60, stale-while-revalidate=600", "Content-Type": "application/json" };
const json = (body, headers = PUBLIC, status = 200) => new Response(JSON.stringify(body), { status, headers });
const html = (body, status = 200) => new Response(body, { status, headers: { "Content-Type": "text/html", "Cache-Control": "no-cache" } });

/** Request-like objects (`new Request()` refuses mode "navigate"); the fake fetch only reads `url`. */
const get = (path, init = {}) => ({ url: ORIGIN + path, method: "GET", mode: "cors", cache: "default", headers: new Headers(), ...init });
const navigate = (path) => get(path, { mode: "navigate" });

function setup({ routes = {}, precache = ["/", "/offline.html", "/assets/index-abc.js"], ...env } = {}) {
  const caches = new FakeCacheStorage();
  const fetch = vi.fn(async (request) => {
    const url = typeof request === "string" ? request : request.url;
    const path = url.slice(ORIGIN.length);
    const route = routes[path];
    if (route === undefined) return new Response("not found", { status: 404, headers: { "Cache-Control": "private, no-store" } });
    return typeof route === "function" ? route(request) : route.clone();
  });
  const clients = { claim: vi.fn(async () => {}) };
  const skipWaiting = vi.fn(async () => {});
  const sw = createServiceWorker({ buildId: BUILD, precache, caches, fetch, origin: ORIGIN, clients, skipWaiting, ...env });
  return { sw, caches, fetch, clients, skipWaiting };
}

/** A FetchEvent stand-in: `settled()` waits for everything passed to waitUntil (background writes). */
function fetchEvent(request) {
  const pending = [];
  return {
    request,
    waitUntil: (p) => pending.push(p),
    async settled() {
      for (let i = 0; i < pending.length; i++) await pending[i];
    },
  };
}

async function respond(sw, request) {
  const event = fetchEvent(request);
  const result = sw.respond(event);
  const response = result === null ? null : await result;
  await event.settled();
  return response;
}

const offline = () => Promise.reject(new TypeError("Failed to fetch"));

describe("install / activate / message", () => {
  it("precaches every URL into this build's shell cache, bypassing the HTTP cache", async () => {
    const { sw, caches, fetch } = setup({
      routes: { "/": html("<div id=root>"), "/offline.html": html("offline"), "/assets/index-abc.js": new Response("js") },
    });
    await sw.install();
    expect(caches.peek("crwn-shell-b1").urls()).toEqual(["/", "/offline.html", "/assets/index-abc.js"]);
    expect(fetch.mock.calls.every(([r]) => r.cache === "reload")).toBe(true);
  });

  it("a failed precache fails the install (the previous worker stays in charge)", async () => {
    const { sw } = setup({ routes: { "/": html("shell") } });
    await expect(sw.install()).rejects.toThrow(/offline\.html/);
  });

  it("activate deletes older builds' caches, keeps foreign ones and claims open pages", async () => {
    const { sw, caches, clients } = setup();
    for (const name of ["crwn-shell-b0", "crwn-api-b0", "crwn-thumbs-b0", "crwn-shell-b1", "crwn-api-b1", "other-app"]) await caches.open(name);
    await sw.activate();
    expect(await caches.keys()).toEqual(["crwn-shell-b1", "crwn-api-b1", "other-app"]);
    expect(clients.claim).toHaveBeenCalled();
  });

  it("SKIP_WAITING activates the waiting worker; other messages do nothing", async () => {
    const { sw, skipWaiting } = setup();
    sw.message({ type: "PING" });
    sw.message(null);
    expect(skipWaiting).not.toHaveBeenCalled();
    await sw.message({ type: "SKIP_WAITING" });
    expect(skipWaiting).toHaveBeenCalledTimes(1);
  });
});

describe("cache-first assets", () => {
  it("serves a cached asset without touching the network", async () => {
    const { sw, caches, fetch } = setup();
    await (await caches.open("crwn-shell-b1")).put("/assets/index-abc.js", new Response("cached js"));
    const res = await respond(sw, get("/assets/index-abc.js", { mode: "no-cors" }));
    expect(await res.text()).toBe("cached js");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fetches and stores a miss (e.g. a font subset), but never a no-store answer", async () => {
    const { sw, caches } = setup({
      routes: { "/assets/inter-greek.woff2": new Response("font"), "/assets/gone.js": new Response("x", { headers: { "Cache-Control": "no-store" } }) },
    });
    expect(await (await respond(sw, get("/assets/inter-greek.woff2"))).text()).toBe("font");
    await respond(sw, get("/assets/gone.js"));
    expect(caches.peek("crwn-shell-b1").urls()).toEqual(["/assets/inter-greek.woff2"]);
  });
});

describe("network-first navigations", () => {
  afterEach(() => vi.useRealTimers());

  async function installed(routes) {
    const ctx = setup({ routes: { "/": html("SHELL"), "/offline.html": html("OFFLINE"), "/assets/index-abc.js": new Response("js"), ...routes } });
    await ctx.sw.install();
    ctx.fetch.mockClear();
    return ctx;
  }

  it("online: the server's page, and nothing new is cached", async () => {
    const { sw, caches } = await installed({ "/anime/naruto": html("NARUTO PAGE") });
    const res = await respond(sw, navigate("/anime/naruto"));
    expect(await res.text()).toBe("NARUTO PAGE");
    expect(caches.peek("crwn-shell-b1").urls()).toEqual(["/", "/offline.html", "/assets/index-abc.js"]);
  });

  it("offline: the cached shell", async () => {
    const { sw, fetch } = await installed();
    fetch.mockImplementation(offline);
    expect(await (await respond(sw, navigate("/anime/naruto/episode/1"))).text()).toBe("SHELL");
  });

  it("no answer within 3 s: the cached shell", async () => {
    vi.useFakeTimers();
    const { sw, fetch } = await installed();
    fetch.mockImplementation(() => new Promise(() => {}));
    const pending = sw.respond(fetchEvent(navigate("/manga")));
    await vi.advanceTimersByTimeAsync(NAVIGATION_TIMEOUT_MS - 1);
    let done = false;
    pending.then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await (await pending).text()).toBe("SHELL");
  });

  it("a gateway error (502/503/504) also falls back to the shell; a 404 page does not", async () => {
    const { sw } = await installed({
      "/anime": new Response("bad gateway", { status: 502 }),
      "/anime/nope": html("NOT FOUND PAGE", 404),
    });
    expect(await (await respond(sw, navigate("/anime"))).text()).toBe("SHELL");
    const notFound = await respond(sw, navigate("/anime/nope"));
    expect(notFound.status).toBe(404);
    expect(await notFound.text()).toBe("NOT FOUND PAGE");
  });

  it("offline without a cached shell: /offline.html; with nothing cached: a network error", async () => {
    const { sw, caches, fetch } = await installed();
    fetch.mockImplementation(offline);
    await (await caches.open("crwn-shell-b1")).delete("/");
    expect(await (await respond(sw, navigate("/search"))).text()).toBe("OFFLINE");
    await caches.delete("crwn-shell-b1");
    await expect(respond(sw, navigate("/search"))).rejects.toThrow("Failed to fetch");
  });
});

describe("stale-while-revalidate catalog", () => {
  it("first request goes to the network and is stored; later ones are served from the cache and refreshed", async () => {
    let version = 1;
    const { sw, caches, fetch } = setup({ routes: { "/api/latest?limit=12": () => json({ version: version++ }) } });
    expect(await (await respond(sw, get("/api/latest?limit=12"))).json()).toEqual({ version: 1 });
    expect(caches.peek("crwn-api-b1").urls()).toEqual(["/api/latest?limit=12"]);
    // Stale copy now, fresh copy stored in the background…
    expect(await (await respond(sw, get("/api/latest?limit=12"))).json()).toEqual({ version: 1 });
    // …and served next time.
    expect(await (await respond(sw, get("/api/latest?limit=12"))).json()).toEqual({ version: 2 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("offline: the cached copy; a never-fetched route fails like the network", async () => {
    const { sw, fetch } = setup({ routes: { "/api/genres": json(["Ação"]) } });
    await respond(sw, get("/api/genres"));
    fetch.mockImplementation(offline);
    expect(await (await respond(sw, get("/api/genres"))).json()).toEqual(["Ação"]);
    await expect(respond(sw, get("/api/sections"))).rejects.toThrow("Failed to fetch");
  });

  it("thumbnails are cached in their own cache", async () => {
    const jpeg = () => new Response("jpeg", { headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=604800, immutable" } });
    const { sw, caches } = setup({ routes: { "/api/thumbs/dQw4w9WgXcQ.jpg": jpeg } });
    await respond(sw, get("/api/thumbs/dQw4w9WgXcQ.jpg", { mode: "no-cors" }));
    expect(caches.peek("crwn-thumbs-b1").urls()).toEqual(["/api/thumbs/dQw4w9WgXcQ.jpg"]);
    expect(caches.peek("crwn-api-b1").urls()).toEqual([]);
  });

  it("never stores private / no-store answers", async () => {
    const { sw, caches } = setup({
      routes: {
        "/api/videos/1": json({ video: 1 }, { "Cache-Control": "private, no-store" }),
        "/api/search?q=x": json({ items: [] }, { "Cache-Control": "no-store" }),
      },
    });
    expect((await respond(sw, get("/api/videos/1"))).status).toBe(200);
    await respond(sw, get("/api/search?q=x"));
    expect(caches.peek("crwn-api-b1").urls()).toEqual([]);
  });

  it("forgets a cached entry once the server answers 404 (unpublished or trashed)", async () => {
    let gone = false;
    const { sw, caches } = setup({
      routes: { "/api/videos/7": () => (gone ? new Response("{}", { status: 404, headers: { "Cache-Control": "private, no-store" } }) : json({ video: 7 })) },
    });
    await respond(sw, get("/api/videos/7"));
    gone = true;
    await respond(sw, get("/api/videos/7")); // stale copy served, 404 in the background
    expect(caches.peek("crwn-api-b1").urls()).toEqual([]);
  });

  it("keeps at most 150 catalog entries, evicting the least recently used", async () => {
    const routes = {};
    for (let i = 0; i <= CACHE_LIMITS.api; i++) routes[`/api/videos/${i}`] = () => json({ i });
    const { sw, caches } = setup({ routes });
    for (let i = 0; i < CACHE_LIMITS.api; i++) await respond(sw, get(`/api/videos/${i}`));
    // Using /api/videos/0 again makes it the most recently used…
    await respond(sw, get("/api/videos/0"));
    // …so the 151st entry evicts /api/videos/1 instead.
    await respond(sw, get(`/api/videos/${CACHE_LIMITS.api}`));
    const urls = caches.peek("crwn-api-b1").urls();
    expect(urls).toHaveLength(CACHE_LIMITS.api);
    expect(urls).toContain("/api/videos/0");
    expect(urls).not.toContain("/api/videos/1");
    expect(urls.at(-1)).toBe(`/api/videos/${CACHE_LIMITS.api}`);
  });

  it("an offline hit still counts as recently used", async () => {
    const { sw, caches, fetch } = setup({ routes: { "/api/videos/1": json({ v: 1 }), "/api/videos/2": json({ v: 2 }) } });
    await respond(sw, get("/api/videos/1"));
    await respond(sw, get("/api/videos/2"));
    fetch.mockImplementation(offline);
    await respond(sw, get("/api/videos/1"));
    expect(caches.peek("crwn-api-b1").urls()).toEqual(["/api/videos/2", "/api/videos/1"]);
  });

  it("caps thumbnails at 300", async () => {
    const id = (n) => `thumb${String(n).padStart(6, "0")}`; // 11 characters
    const routes = {};
    for (let i = 0; i < CACHE_LIMITS.thumbs + 2; i++) routes[`/api/thumbs/${id(i)}.jpg`] = () => new Response("jpeg");
    const { sw, caches } = setup({ routes });
    for (let i = 0; i < CACHE_LIMITS.thumbs + 2; i++) await respond(sw, get(`/api/thumbs/${id(i)}.jpg`));
    const urls = caches.peek("crwn-thumbs-b1").urls();
    expect(urls).toHaveLength(300);
    expect(urls[0]).toBe(`/api/thumbs/${id(2)}.jpg`);
  });
});

describe("bypassed requests", () => {
  it("never answers or caches personal, admin, rating, dev and random routes", async () => {
    const { sw, caches, fetch } = setup();
    for (const request of [
      get("/api/auth/me"),
      get("/api/me/export", { mode: "navigate" }),
      get("/api/admin/series"),
      get("/api/videos/1/rating"),
      get("/api/dev/outbox"),
      get("/api/random?section=anime"),
      get("/api/latest", { method: "POST" }),
      get("/api/thumbs/dQw4w9WgXcQ.jpg", { headers: new Headers({ Range: "bytes=0-99" }) }),
      { ...get("/"), url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" },
      get("/sw.js"),
    ]) {
      expect(sw.respond(fetchEvent(request)), request.url).toBeNull();
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(await caches.keys()).toEqual([]);
  });

  it("an opaque response is passed through but never stored", async () => {
    const opaque = { status: 0, type: "opaque", headers: new Headers(), clone: () => opaque };
    const { sw, caches, fetch } = setup();
    fetch.mockResolvedValue(opaque);
    expect(await respond(sw, get("/api/thumbs/dQw4w9WgXcQ.jpg"))).toBe(opaque);
    expect(await respond(sw, get("/assets/x.js"))).toBe(opaque);
    expect(caches.peek("crwn-thumbs-b1").urls()).toEqual([]);
    expect(caches.peek("crwn-shell-b1").urls()).toEqual([]);
  });
});
