// Cycle 5 — PWA and same-origin thumbnails (docs/API.md v1.5).
//
// The e2e client is a production build, so it registers /sw.js. Every other spec blocks service
// workers (playwright.config.js); this file allows them. Each test has its own browser context,
// hence its own registration and Cache Storage. Thumbnails come from GET /api/thumbs/<id>.jpg,
// which the API fetches from the fake upstream (e2e/fake-thumb-upstream.mjs: a 160×90 JPEG for any
// id, 404 for ids starting with "upFail"), never from i.ytimg.com.
//
// The update flow needs a second build. Instead of rebuilding, a tiny reverse proxy in front of the
// API origin (its own port, so its own origin and registration) starts serving /sw.js with a new
// build id, exactly what a deploy changes; the browser's own update check then finds it.
import { chromium, request as playwrightRequest } from "@playwright/test";
import { randomBytes } from "node:crypto";
import http from "node:http";
import {
  test,
  expect,
  API_ORIGIN,
  ADMIN,
  FAKE_THUMB_WIDTH,
  YOUTUBE_HOST,
  asAdmin,
  createUser,
  ensureVideo,
  expectNoSeriousViolations,
  fakeYouTubeId,
  headerUser,
  newGuardedContext,
  seedSeries,
  uniqueEmail,
  upstreamHits,
  THUMB_UPSTREAM,
} from "./fixtures.js";
import { startPrivateApi } from "./security/helpers.js";

test.use({ serviceWorkers: "allow" });

const SERIES = {
  name: "Saga Offline",
  slug: "saga-offline",
  aliases: [],
  genres: ["Conectividade"],
  synopsis: "Uma saga que continua aparecendo sem internet.",
};
const EPISODES = [
  { youtubeId: "pwaOffEp001", title: "Saga Offline Episode 1", section: "anime", number: 1 },
  { youtubeId: "pwaOffEp002", title: "Saga Offline Episode 2", section: "anime", number: 2 },
  // The fake upstream answers 404 for "upFail…" ids: the API answers 502, the card shows its placeholder.
  { youtubeId: "upFailOff03", title: "Saga Offline Episode 3", section: "anime", number: 3 },
  { youtubeId: "pwaOffCh001", title: "Saga Offline Chapter 1", section: "manga", number: 1 },
];
let seeded; // { series, videos }
test.beforeAll(async ({}, testInfo) => {
  seeded = await asAdmin(testInfo, (admin) => seedSeries(admin, SERIES, EPISODES));
});
const ep = (n) => seeded.videos[n - 1];

/** The contract's never-cached routes (docs/API.md v1.5), on a lower-cased, decoded path. */
const NEVER_CACHED = [
  ["/api/auth/*", /^\/api\/auth(\/|$)/],
  ["/api/me*", /^\/api\/me/],
  ["/api/admin/*", /^\/api\/admin(\/|$)/],
  ["any /rating route", /\/ratings?(\/|$)/],
  ["/api/dev/*", /^\/api\/dev(\/|$)/],
  ["/api/random", /^\/api\/random(\/|$)/],
];

/** Waits until the service worker controls the page (it claims open pages when it activates). */
async function swControls(page) {
  const expected = new URL("/sw.js", page.url()).href;
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker?.controller?.scriptURL ?? null), { message: "the service worker controls the page", timeout: 20_000 })
    .toBe(expected);
}

/** Every entry of every cache of the origin: { cache, url, status, cacheControl, body (API JSON only) }. */
function cacheEntries(page) {
  return page.evaluate(async () => {
    const out = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        const isApiJson = new URL(request.url).pathname.startsWith("/api/") && /json/.test(response.headers.get("content-type") ?? "");
        out.push({
          cache: name,
          url: request.url,
          method: request.method,
          status: response.status,
          cacheControl: response.headers.get("cache-control"),
          body: isApiJson ? await response.text() : null,
        });
      }
    }
    return out;
  });
}

/** Waits until `pathname` (with any query) is in Cache Storage: runtime caching happens in the background. */
async function waitForCached(page, pathname) {
  await expect
    .poll(async () => (await cacheEntries(page)).some((e) => new URL(e.url).pathname === pathname), { message: `${pathname} in Cache Storage`, timeout: 15_000 })
    .toBe(true);
}

/** Cache Storage once background writes have settled (two identical listings in a row). */
async function settledCacheEntries(page) {
  let previous = null;
  let entries = [];
  await expect
    .poll(
      async () => {
        entries = await cacheEntries(page);
        const listing = JSON.stringify(entries.map((e) => `${e.cache} ${e.url}`).sort());
        const stable = listing === previous;
        previous = listing;
        return stable;
      },
      { message: "Cache Storage settles", intervals: [500, 500, 1000], timeout: 15_000 }
    )
    .toBe(true);
  return entries;
}

/** Loaded size of an <img>, 0 while it has not loaded (or failed). */
const naturalWidth = (img) => img.evaluate((el) => (el.complete ? el.naturalWidth : 0));

/** True when a same-origin request that the worker cannot answer from its cache fails, i.e. the worker is offline too. */
const workerIsOffline = (page) => page.evaluate(() => fetch(`/api/latest?limit=3&probe=${Date.now()}`).then(() => false, () => true));

/** Records CSP violations of every document of the page. */
async function trackCsp(page) {
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  return () => page.evaluate(() => window.__cspViolations ?? []);
}

/**
 * A reverse proxy to `upstream` on its own port. `deploy(buildId)` makes it serve /sw.js with the
 * build id replaced (and no validators, so the browser's conditional update check gets the new
 * bytes instead of a 304), like a real deploy of a new build. Everything else passes through.
 */
async function startDeployProxy(upstream = API_ORIGIN) {
  const target = new URL(upstream);
  let nextBuild = null;
  const server = http.createServer((req, res) => {
    const rewrite = nextBuild !== null && req.method === "GET" && req.url.split("?")[0] === "/sw.js";
    const headers = { ...req.headers, host: target.host };
    if (rewrite) {
      delete headers["if-none-match"];
      delete headers["if-modified-since"];
      headers["accept-encoding"] = "identity";
    }
    const forward = http.request({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers }, (up) => {
      if (!rewrite || up.statusCode !== 200) {
        res.writeHead(up.statusCode, up.headers);
        return up.pipe(res);
      }
      const chunks = [];
      up.on("data", (c) => chunks.push(c));
      up.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const current = /service worker, build ([0-9a-f]+)/.exec(text)?.[1];
        const body = Buffer.from(current ? text.replaceAll(current, nextBuild) : text, "utf8");
        const out = { ...up.headers, "content-length": String(body.length) };
        delete out.etag;
        delete out["last-modified"];
        res.writeHead(200, out);
        res.end(body);
      });
    });
    forward.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(forward);
  });
  await new Promise((resolve) => server.listen(0, resolve)); // dual-stack: localhost resolves to ::1 or 127.0.0.1
  return {
    origin: `http://localhost:${server.address().port}`,
    deploy: (buildId) => {
      nextBuild = buildId;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

test.describe("web app manifest", () => {
  test("linked from the shell, valid for Chromium, documented fields; every icon loads at its declared size", async ({ page, context }) => {
    await page.goto("/");
    const link = page.locator('head link[rel="manifest"]');
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute("href", "/manifest.webmanifest");

    // Chromium's own parser: the manifest it found, and no parse errors.
    const cdp = await context.newCDPSession(page);
    const parsed = await cdp.send("Page.getAppManifest");
    expect(parsed.url).toBe(new URL("/manifest.webmanifest", page.url()).href);
    expect(parsed.errors, "manifest parse errors").toEqual([]);

    const res = await page.request.get("/manifest.webmanifest");
    expect(res.status()).toBe(200);
    const manifest = await res.json();
    expect(manifest).toMatchObject({ name: "Crwn Animes", short_name: "Crwn", start_url: "/", scope: "/", display: "standalone", lang: "pt-BR" });
    // Theme colours: the Midnight Sakura background, the same as the shell's dark theme-color.
    const darkThemeColor = await page.locator('head meta[name="theme-color"][media="(prefers-color-scheme: dark)"]').getAttribute("content");
    expect(manifest.theme_color).toBe(darkThemeColor);
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(manifest.shortcuts.map((s) => s.url).sort()).toEqual(["/anime", "/manga"]);

    const icons = manifest.icons;
    const has = (type, sizes, purpose) => icons.some((i) => i.type === type && i.sizes === sizes && (i.purpose ?? "any").split(/\s+/).includes(purpose));
    expect(has("image/svg+xml", "any", "any"), "an SVG icon").toBe(true);
    for (const size of ["192x192", "512x512"]) {
      expect(has("image/png", size, "any"), `${size} PNG icon`).toBe(true);
      expect(has("image/png", size, "maskable"), `${size} maskable PNG icon`).toBe(true);
    }

    // Every icon (manifest icons, shortcut icons, the apple-touch-icon) loads with its declared type and size.
    const appleTouch = await page.locator('head link[rel="apple-touch-icon"]').getAttribute("href");
    const all = [...icons, ...manifest.shortcuts.flatMap((s) => s.icons ?? []), { src: appleTouch, type: "image/png", sizes: null }];
    for (const icon of all) {
      const file = await page.request.get(icon.src);
      expect(file.status(), icon.src).toBe(200);
      expect(file.headers()["content-type"], icon.src).toMatch(new RegExp(`^${icon.type.replace("+", "\\+")}`));
      if (icon.type === "image/png" && icon.sizes) {
        const png = await file.body();
        expect(png.subarray(1, 4).toString("ascii"), `${icon.src} is a PNG`).toBe("PNG");
        expect(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, `${icon.src} pixel size`).toBe(icon.sizes);
      }
      const width = await page.evaluate(
        (src) => new Promise((resolve) => Object.assign(new Image(), { onload() { resolve(this.naturalWidth); }, onerror: () => resolve(0), src })),
        icon.src
      );
      expect(width, `${icon.src} decodes in the browser`).toBeGreaterThan(0);
    }
  });
});

test.describe("service worker", () => {
  test("registers in the production build, controls the page, precaches the shell and the offline page", async ({ page }) => {
    await page.goto("/");
    await swControls(page);
    const registration = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return { scope: reg.scope, active: reg.active?.state, script: reg.active?.scriptURL };
    });
    const origin = new URL(page.url()).origin;
    expect(registration).toEqual({ scope: `${origin}/`, active: "activated", script: `${origin}/sw.js` });

    const entries = await cacheEntries(page);
    const shell = entries.filter((e) => e.cache.startsWith("crwn-shell-"));
    const paths = shell.map((e) => new URL(e.url).pathname);
    for (const path of ["/", "/offline.html", "/offline.js", "/theme-init.js", "/favicon.svg"]) expect(paths, `precached ${path}`).toContain(path);
    // The entry script and stylesheet of the shell are precached too (the shell boots offline).
    const html = await (await page.request.get("/")).text();
    for (const asset of html.match(/\/assets\/[^"]+\.(?:js|css)/g)) expect(paths, `precached ${asset}`).toContain(asset);
    for (const name of await page.evaluate(() => caches.keys())) expect(name, "only this build's own caches").toMatch(/^crwn-(shell|api|thumbs)-[0-9a-f]{12}$/);

    // From now on, navigations and the hashed bundle are answered by the worker.
    const reloaded = await page.reload();
    expect(reloaded.fromServiceWorker(), "navigation through the worker").toBe(true);
    const [asset] = await Promise.all([
      page.waitForResponse((r) => /\/assets\/.+\.js$/.test(new URL(r.url()).pathname) && r.request().frame() === page.mainFrame()),
      page.goto("/anime"),
    ]);
    expect(asset.fromServiceWorker(), `${asset.url()} from the worker`).toBe(true);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("installable: no installability error in a normal (non-incognito) Chromium profile", async ({ baseURL }, testInfo) => {
    // Playwright's contexts are incognito, where Chromium reports only "in-incognito"; a persistent
    // profile runs every check (manifest fields, icons, a service worker with a fetch handler).
    const profile = await chromium.launchPersistentContext(testInfo.outputPath("profile"), {
      ...testInfo.project.use.launchOptions,
      serviceWorkers: "allow",
      locale: "pt-BR",
    });
    try {
      await profile.route((url) => !["localhost", "127.0.0.1"].includes(url.hostname), (route) => route.abort("blockedbyclient"));
      const page = profile.pages()[0] ?? (await profile.newPage());
      await page.goto(`${baseURL}/`);
      await swControls(page);
      const cdp = await profile.newCDPSession(page);
      expect((await cdp.send("Page.getInstallabilityErrors")).installabilityErrors).toEqual([]);
    } finally {
      await profile.close();
    }
  });

  test("under the production CSP (API origin): registers, controls the page, no CSP violation (worker-src, manifest-src)", async ({ page }) => {
    const violations = await trackCsp(page);
    const res = await page.goto(`${API_ORIGIN}/`);
    expect(res.headers()["content-security-policy"]).toMatch(/worker-src 'self'/);
    await swControls(page);
    await page.goto(`${API_ORIGIN}/anime/${SERIES.slug}`);
    await expect(page.getByRole("heading", { level: 1, name: SERIES.name })).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(await violations(), "CSP violations").toEqual([]);
  });
});

test.describe("offline", () => {
  test("a visited page renders from the cache (shell, data and thumbnails); a never-visited deep link still gets the shell", async ({ page, context }) => {
    await page.goto("/");
    await swControls(page);
    await test.step("online: visit the series page (its data and thumbnails are cached as they load)", async () => {
      await page.goto(`/anime/${SERIES.slug}`);
      await expect(page.getByRole("heading", { level: 1, name: SERIES.name })).toBeVisible();
      await waitForCached(page, `/api/anime/series/${SERIES.slug}`);
      await waitForCached(page, `/api/thumbs/${ep(1).youtubeVideoId}.jpg`);
    });

    await context.setOffline(true);
    try {
      expect(await workerIsOffline(page), "the worker's own requests fail too (really offline)").toBe(true);

      await test.step("the visited page: cached shell + cached catalog data + cached thumbnail", async () => {
        const res = await page.goto(`/anime/${SERIES.slug}`);
        expect(res.status()).toBe(200);
        expect(res.fromServiceWorker()).toBe(true);
        await expect(page.getByRole("heading", { level: 1, name: SERIES.name })).toBeVisible();
        await expect(page.getByText(SERIES.synopsis)).toBeVisible();
        const thumb = page.locator(`main img[src="/api/thumbs/${ep(1).youtubeVideoId}.jpg"]`);
        await thumb.scrollIntoViewIfNeeded();
        await expect.poll(() => naturalWidth(thumb), { message: "cached thumbnail shows offline" }).toBe(FAKE_THUMB_WIDTH);
      });

      await test.step("a deep link never visited: the shell renders (header, footer) and says the server is unreachable", async () => {
        const res = await page.goto(ep(4).route);
        expect(res.status()).toBe(200);
        expect(res.fromServiceWorker()).toBe(true);
        await expect(page.getByRole("banner")).toBeVisible();
        await expect(page.getByRole("contentinfo")).toBeVisible();
        await expect(page.getByText("Sem conexão com o servidor")).toBeVisible();
        expect(new URL(page.url()).pathname).toBe(ep(4).route);
      });
    } finally {
      await context.setOffline(false);
    }
  });

  test("without a cached shell, an offline navigation gets /offline.html: “Você está offline”, “Tentar novamente”, back online → the app", async ({ page, context }) => {
    await page.goto("/");
    await swControls(page);
    const deleted = await page.evaluate(async () => {
      const done = [];
      for (const name of await caches.keys()) {
        if (name.startsWith("crwn-shell-")) done.push(await (await caches.open(name)).delete(new URL("/", location.href).href));
      }
      return done;
    });
    expect(deleted, "the shell entry was deleted").toEqual([true]);

    await context.setOffline(true);
    try {
      const res = await page.goto("/anime");
      expect(res.status()).toBe(200);
      expect(res.fromServiceWorker()).toBe(true);
      await expect(page).toHaveTitle("Você está offline · Crwn Animes");
      await expect(page.getByRole("heading", { level: 1, name: "Você está offline" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Tentar novamente" })).toBeVisible();
      expect(new URL(page.url()).pathname, "the address bar keeps the page asked for").toBe("/anime");

      // "Tentar novamente" reloads (still offline: the offline page again).
      await page.evaluate(() => {
        window.__beforeRetry = true;
      });
      await page.getByRole("button", { name: "Tentar novamente" }).click();
      await expect.poll(() => page.evaluate(() => window.__beforeRetry ?? false).catch(() => true), { message: "the page reloaded" }).toBe(false);
      await expect(page.getByRole("heading", { level: 1, name: "Você está offline" })).toBeVisible();
    } finally {
      await context.setOffline(false);
    }
    // Back online, the page reloads by itself into the app.
    await expect(page.getByRole("banner")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Anime" })).toBeVisible();
  });
});

test.describe("Cache Storage hygiene", () => {
  test("after browsing anonymously, as a user and as an admin: no auth/me/admin/rating/dev/random entry, nothing private or personal", async ({ page }) => {
    test.setTimeout(120_000);
    const video = ep(1);
    const visit = async (paths) => {
      for (const path of paths) {
        await page.goto(path);
        await page.waitForLoadState("networkidle");
      }
    };
    // Same-origin GETs the app may or may not make, in every spelling Express accepts (it routes
    // case-insensitively): the worker must let all of them through uncached.
    const probe = (urls) =>
      page.evaluate(async (list) => {
        for (const url of list) await fetch(url, { credentials: "include" }).then((r) => r.text(), () => null);
      }, urls);
    const PROBES = [
      "/api/auth/me",
      "/API/Auth/Me",
      "/api/%61uth/me",
      "/api/me/export",
      "/api/ME/export",
      "/api/random",
      "/api/random?section=anime",
      "/api/dev/outbox",
      `/api/videos/${video.id}/rating`,
      `/api/videos/${video.id}/Rating`,
      `/api/videos/${video.id}/rating?x=1`,
      "/api/admin/series",
      "/api/admin/videos?limit=5",
    ];
    const PUBLIC_PAGES = ["/", "/anime", "/manga", `/anime/${SERIES.slug}`, video.route, ep(4).route, "/search?q=offline", `/genre/${encodeURIComponent("Conectividade")}`, "/privacy", "/login"];

    await page.goto("/");
    await swControls(page);

    await test.step("anonymous", async () => {
      await visit(PUBLIC_PAGES);
      await probe(PROBES);
    });

    const user = await createUser(page.request, { email: uniqueEmail("pwa-cache"), displayName: "Cache Curiosa" });
    await test.step("logged in: browse, rate, open the account page, export", async () => {
      await page.goto("/");
      await expect(headerUser(page, user.displayName)).toBeVisible();
      await page.evaluate(
        (url) => fetch(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ score: 5 }) }).then((r) => r.status),
        `/api/videos/${video.id}/rating`
      );
      await visit([...PUBLIC_PAGES, video.route, "/account"]);
      await probe(PROBES);
    });

    // A NEW admin session in this context (never the shared one in .auth/), logged out at the end.
    const login = await page.request.post("/api/auth/login", { data: { email: ADMIN.email, password: ADMIN.password } });
    expect(login.status(), "admin login").toBe(200);
    try {
      await test.step("as admin: dashboard tabs and the series board", async () => {
        await page.goto("/admin");
        await expect(headerUser(page, ADMIN.displayName)).toBeVisible();
        await visit(["/admin", "/admin?tab=pending", "/admin?tab=broken", "/admin?tab=add", `/admin/series/${seeded.series.id}`, video.route, `/anime/${SERIES.slug}`]);
        await probe(PROBES);
      });

      const entries = await settledCacheEntries(page);
      const origin = new URL(page.url()).origin;
      const api = entries.filter((e) => new URL(e.url).pathname.startsWith("/api/"));
      // Not vacuous: the public catalog and the thumbnails were cached while browsing.
      expect(api.some((e) => new URL(e.url).pathname === `/api/anime/series/${SERIES.slug}`), "the series data is cached").toBe(true);
      expect(entries.some((e) => e.cache.startsWith("crwn-thumbs-") && new URL(e.url).pathname === `/api/thumbs/${video.youtubeVideoId}.jpg`), "a thumbnail is cached").toBe(true);

      for (const entry of entries) {
        const url = new URL(entry.url);
        const path = decodeURIComponent(url.pathname).toLowerCase();
        expect(url.origin, `${entry.url}: only same-origin responses are cached`).toBe(origin);
        expect(entry.method, entry.url).toBe("GET");
        expect(entry.status, `${entry.url}: only complete 200s`).toBe(200);
        for (const [label, re] of NEVER_CACHED) expect(re.test(path), `${entry.url} is cached but ${label} must never be`).toBe(false);
        expect(entry.cacheControl ?? "", `${entry.url}: a private/no-store response was cached`).not.toMatch(/private|no-store/i);
      }
      // Nothing personal in what is cached: no e-mail, display name, own rating or user id.
      for (const entry of api.filter((e) => e.body)) {
        for (const secret of [user.email, user.displayName, ADMIN.email, ADMIN.displayName, '"mine"', '"email"', '"role"']) {
          expect(entry.body, `${entry.url} contains ${secret}`).not.toContain(secret);
        }
      }
    } finally {
      await page.request.post("/api/auth/logout"); // the server keeps at most 20 sessions per user
    }
  });
});

test.describe("Cache Storage: search terms and “Limpar histórico” (v1.5 review fixes)", () => {
  test("a search with a typed q is never cached (page and palette); a search without q (genre page) is", async ({ page }) => {
    await page.goto("/");
    await swControls(page);
    await page.goto("/search?q=offline");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await page.keyboard.press("Control+k");
    await page.keyboard.type("saga off");
    await expect(page.getByRole("dialog", { name: "Busca rápida" }).getByRole("option").first()).toBeVisible();
    await page.keyboard.press("Escape");
    await page.goto(`/genre/${encodeURIComponent("Conectividade")}`);
    await waitForCached(page, "/api/search"); // the genre page's search (no q) is public catalog data
    const searches = (await settledCacheEntries(page)).map((e) => new URL(e.url)).filter((u) => u.pathname.toLowerCase() === "/api/search");
    expect(searches.some((u) => u.searchParams.get("genre") === "Conectividade"), "the genre search is cached").toBe(true);
    for (const url of searches) expect(url.searchParams.getAll("q").filter((q) => q.trim()), `${url.pathname}${url.search} keeps a search term on the device`).toEqual([]);
  });

  test("“Limpar histórico” also deletes the offline catalog copy (crwn-api-*) and keeps the app shell", async ({ page }) => {
    await page.goto("/");
    await swControls(page);
    await page.goto(`/anime/${SERIES.slug}`);
    await expect(page.getByRole("heading", { level: 1, name: SERIES.name })).toBeVisible();
    const seriesData = `/api/anime/series/${SERIES.slug}`;
    await waitForCached(page, seriesData);
    // Some watch history, so the button is enabled.
    await page.evaluate((v) => localStorage.setItem("crwn:progress:v1", JSON.stringify({ [v.youtubeVideoId]: { t: 30, d: 100, at: Date.now() - 1000, route: v.route, title: v.title, thumb: null } })), ep(1));
    await page.goto("/account");
    await page.getByRole("button", { name: "Limpar histórico" }).click();
    await page.getByRole("dialog", { name: "Limpar histórico" }).getByRole("button", { name: "Limpar", exact: true }).click();
    await expect.poll(async () => (await cacheEntries(page)).some((e) => e.cache.startsWith("crwn-api-") && new URL(e.url).pathname === seriesData), { message: "the catalog copy is gone" }).toBe(false);
    const entries = await settledCacheEntries(page);
    const before = ["/api/latest", seriesData]; // cached on "/" and the series page; /account does not ask for them
    for (const e of entries.filter((x) => x.cache.startsWith("crwn-api-"))) expect(before, `${e.url} survived “Limpar histórico”`).not.toContain(new URL(e.url).pathname);
    expect(entries.some((e) => e.cache.startsWith("crwn-shell-") && new URL(e.url).pathname === "/"), "the app shell stays (offline still works)").toBe(true);
    expect(await page.evaluate(() => localStorage.getItem("crwn:progress:v1"))).toBeNull();
  });
});

test.describe("same-origin thumbnails", () => {
  test("load from this origin through the fake upstream, a failing upstream shows the placeholder, and nothing reaches YouTube before Play", async ({ page, context, externalRequests }) => {
    const youtube = [];
    const thumbs = [];
    context.on("request", (req) => {
      const url = new URL(req.url());
      if (YOUTUBE_HOST.test(url.hostname)) youtube.push(req.url());
      if (url.pathname.startsWith("/api/thumbs/")) thumbs.push(req.url());
    });
    await page.goto("/");
    await swControls(page); // the worker answers /api/thumbs (stale-while-revalidate): still same-origin

    await test.step("series page: each episode's thumbnail is /api/thumbs/<id>.jpg and decodes (160×90 from the fake upstream)", async () => {
      await page.goto(`/anime/${SERIES.slug}`);
      await expect(page.getByRole("heading", { level: 1, name: SERIES.name })).toBeVisible();
      for (const n of [1, 2]) {
        const img = page.locator(`main img[src="/api/thumbs/${ep(n).youtubeVideoId}.jpg"]`);
        await img.scrollIntoViewIfNeeded();
        await expect.poll(() => naturalWidth(img), { message: `episode ${n} thumbnail` }).toBe(FAKE_THUMB_WIDTH);
      }
      // Episode 3's upstream fails (502): its frame falls back to the gradient placeholder, no broken image.
      const row3 = page.getByRole("listitem").filter({ hasText: ep(3).title });
      await row3.scrollIntoViewIfNeeded();
      await expect(row3.locator("[data-state]")).toHaveAttribute("data-state", "error");
      await expect(row3.locator("img")).toHaveCount(0);
      for (const src of await page.locator("img").evaluateAll((imgs) => imgs.map((i) => i.src))) {
        expect(new URL(src).hostname, `img ${src}`).toBe("localhost");
      }
    });

    await test.step("episode page: the player poster is the same-origin thumbnail", async () => {
      await page.goto(ep(1).route);
      const poster = page.locator(`img[src="/api/thumbs/${ep(1).youtubeVideoId}.jpg"]`).first();
      await expect(poster).toBeVisible();
      await expect.poll(() => naturalWidth(poster)).toBe(FAKE_THUMB_WIDTH);
      await page.waitForLoadState("networkidle");
    });

    expect(thumbs.length, "thumbnails were requested").toBeGreaterThan(0);
    for (const url of thumbs) expect(url).toMatch(/^http:\/\/localhost:\d+\/api\/thumbs\/[A-Za-z0-9_-]{11}\.jpg$/);
    expect(youtube, "no request to ytimg.com / youtube.com before Play (page or worker)").toEqual([]);
    expect(externalRequests, "no third-party request at all before Play").toEqual([]);

    await test.step("pressing Play is what reaches YouTube (blocked by the network guard)", async () => {
      await page.getByRole("button", { name: /^Reproduzir:/ }).click();
      await expect.poll(() => youtube.some((u) => u.startsWith("https://www.youtube.com/iframe_api"))).toBe(true);
    });
  });

  test("GET /api/thumbs: 404 for unknown, malformed and trashed ids before any upstream call; 502 when upstream fails; one upstream fetch for concurrent requests", async ({ request, admin }) => {
    const thumb = (id) => request.get(`${API_ORIGIN}/api/thumbs/${id}.jpg`);

    await test.step("a live video: the fake upstream's JPEG, fetched once", async () => {
      const id = fakeYouTubeId("tLive");
      await ensureVideo(admin, { youtubeId: id, title: `Thumb live ${id}` });
      const responses = await Promise.all(Array.from({ length: 8 }, () => thumb(id)));
      const bodies = await Promise.all(responses.map((r) => r.body()));
      for (const r of responses) expect(r.status()).toBe(200);
      expect(bodies[0].subarray(0, 3).toString("hex"), "a JPEG").toBe("ffd8ff");
      for (const b of bodies) expect(b.equals(bodies[0])).toBe(true);
      expect(await upstreamHits(request, id), "8 concurrent requests share one upstream fetch").toBe(1);
      expect((await thumb(id)).status()).toBe(200);
      expect(await upstreamHits(request, id), "then it is served from the disk cache").toBe(1);
    });

    await test.step("unknown and malformed ids: 404, upstream never asked", async () => {
      const unknown = fakeYouTubeId("tNone");
      const res = await thumb(unknown);
      expect(res.status()).toBe(404);
      expect((await res.json()).error.code).toBe("NOT_FOUND");
      expect(await upstreamHits(request, unknown), "no upstream call for an unknown id").toBe(0);
      for (const path of [
        "/api/thumbs/short.jpg",
        `/api/thumbs/${ep(1).youtubeVideoId}.png`,
        `/api/thumbs/${ep(1).youtubeVideoId}`,
        `/api/thumbs/${ep(1).youtubeVideoId}.jpg.jpg`,
        "/api/thumbs/..%2F..%2Fpackage.json",
        "/api/thumbs/https:%2F%2Fevil.example%2Fx.jpg",
        "/api/thumbs/",
      ]) {
        expect((await request.get(`${API_ORIGIN}${path}`)).status(), path).toBe(404);
      }
    });

    await test.step("a trashed video: 404 at once (the database decides before the cache or upstream)", async () => {
      const id = fakeYouTubeId("tTrash");
      const video = await ensureVideo(admin, { youtubeId: id, title: `Thumb trash ${id}` });
      expect((await thumb(id)).status()).toBe(200);
      expect(await upstreamHits(request, id)).toBe(1);
      expect((await admin.delete(`/api/admin/videos/${video.id}`)).status()).toBe(204);
      expect((await thumb(id)).status(), "trashed").toBe(404);
      expect((await admin.delete(`/api/admin/trash/videos/${video.id}`)).status()).toBe(204);
      expect((await thumb(id)).status(), "deleted for good").toBe(404);
      expect(await upstreamHits(request, id), "no further upstream call").toBe(1);
    });

    await test.step("upstream failure: 502 without upstream details", async () => {
      const id = fakeYouTubeId("upFail");
      await ensureVideo(admin, { youtubeId: id, title: `Thumb fail ${id}` });
      const res = await thumb(id);
      expect(res.status()).toBe(502);
      expect(res.headers()["cache-control"]).toBe("private, no-store");
      const text = await res.text();
      expect(JSON.parse(text).error).toMatchObject({ message: expect.any(String) });
      expect(text, "no upstream address in the error").not.toMatch(/127\.0\.0\.1|ytimg|hqdefault|4617/);
      expect(await upstreamHits(request, id)).toBe(1);
    });
  });

  test("a failed upstream fetch is remembered (v1.5 review fix): repeat requests answer 502 without asking upstream again", async ({ request, admin }) => {
    const id = fakeYouTubeId("upFail");
    await ensureVideo(admin, { youtubeId: id, title: `Thumb fail memory ${id}` });
    for (let i = 0; i < 3; i++) expect((await request.get(`${API_ORIGIN}/api/thumbs/${id}.jpg`)).status(), `request ${i + 1}`).toBe(502);
    expect(await upstreamHits(request, id), "one upstream attempt, then the failure is remembered").toBe(1);
  });

  test("cache misses are rate-limited per IP (private instance, IMAGE_MISS_RATE_MAX=3): 429 + Retry-After; cached images and 404s do not count", async ({}, testInfo) => {
    const api = await startPrivateApi({ ADMIN_EMAILS: ADMIN.email, IMAGE_MISS_RATE_MAX: "3", THUMB_UPSTREAM, THUMB_CACHE_DIR: testInfo.outputPath("thumbs") });
    const admin = await playwrightRequest.newContext({ baseURL: api.origin });
    try {
      await createUser(admin, { ...ADMIN }); // ADMIN_EMAILS promotes it on this instance
      const ids = Array.from({ length: 4 }, () => fakeYouTubeId("lim"));
      for (const id of ids) await ensureVideo(admin, { youtubeId: id, title: `Limit ${id}` });
      const thumb = (id) => admin.get(`/api/thumbs/${id}.jpg`);
      for (const id of ids.slice(0, 3)) expect((await thumb(id)).status(), `miss ${id}`).toBe(200);
      expect((await thumb(ids[0])).status(), "a cached image is not a miss").toBe(200);
      expect((await thumb(fakeYouTubeId("limNo"))).status(), "an unknown id is decided before the limit").toBe(404);
      const limited = await thumb(ids[3]);
      expect(limited.status(), "the 4th miss in the window").toBe(429);
      expect(Number(limited.headers()["retry-after"])).toBeGreaterThan(0);
      expect((await limited.json()).error.code).toBe("RATE_LIMITED");
      expect((await thumb(ids[1])).status(), "cached images still load while limited").toBe(200);
    } finally {
      await admin.dispose();
      await api.stop();
    }
  });

  test("admin responses (v1.5 review fix): a trashed video has thumbnailUrl null", async ({ admin }) => {
    const id = fakeYouTubeId("tNull");
    const video = await ensureVideo(admin, { youtubeId: id, title: `Thumb null ${id}` });
    expect(video.thumbnailUrl).toBe(`/api/thumbs/${id}.jpg`);
    expect((await admin.delete(`/api/admin/videos/${video.id}`)).status()).toBe(204);
    try {
      const trash = await (await admin.get("/api/admin/trash")).json();
      const trashed = trash.videos.find((v) => v.id === video.id);
      expect(trashed, "the video is listed in the trash").toBeTruthy();
      expect(trashed.thumbnailUrl).toBeNull();
    } finally {
      await admin.delete(`/api/admin/trash/videos/${video.id}`);
    }
  });
});

test.describe("same-origin series covers (v1.5 review fix)", () => {
  // e2e has no external network, so every cover fetch fails: 502 and the client's placeholder are
  // the expected outcome here (the SSRF rules are covered by the server's unit tests).
  test("coverUrl is /api/covers/<id>.img?v=<hash>; the admin keeps the source URL; 404 unknown/trashed; 502 → placeholder; og:image absolute", async ({ page, request, admin, baseURL, externalRequests }) => {
    const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const source = `https://covers.e2e.example/capa-${tag}.jpg`;
    const { series } = await seedSeries(admin, { name: `Saga Capa ${tag}`, slug: `saga-capa-${tag}`, aliases: [], genres: ["Capas"] }, [
      { youtubeId: fakeYouTubeId("cov"), title: `Saga Capa ${tag} Episode 1`, section: "anime", number: 1 },
    ]);
    const patched = await admin.patch(`/api/admin/series/${series.id}`, { data: { coverUrl: source } });
    expect(patched.status()).toBe(200);
    const adminSeries = (await patched.json()).series;
    expect(adminSeries.coverSourceUrl, "admin responses keep what the admin typed").toBe(source);
    const COVER = new RegExp(`^/api/covers/${series.id}\\.img\\?v=[A-Za-z0-9_-]{8}$`);
    expect(adminSeries.coverUrl).toMatch(COVER);

    const pub = (await (await request.get(`${API_ORIGIN}/api/anime/series/${series.slug}`)).json()).series;
    expect(pub.coverUrl).toMatch(COVER);
    expect(JSON.stringify(pub), "the source URL never reaches the public API").not.toContain("covers.e2e.example");

    // A new source URL changes ?v= (browsers and the worker never keep a stale cover).
    const repatched = (await (await admin.patch(`/api/admin/series/${series.id}`, { data: { coverUrl: `${source}?2` } })).json()).series;
    expect(repatched.coverUrl).toMatch(COVER);
    expect(repatched.coverUrl).not.toBe(adminSeries.coverUrl);

    expect((await request.get(`${API_ORIGIN}${repatched.coverUrl}`)).status(), "no external network in e2e").toBe(502);
    expect((await request.get(`${API_ORIGIN}/api/covers/999999999.img`)).status(), "unknown series").toBe(404);
    expect((await request.get(`${API_ORIGIN}/api/covers/abc.img`)).status(), "malformed id").toBe(404);

    // Link previews get the same-origin copy, absolute.
    const html = await (await request.get(`${API_ORIGIN}/anime/${series.slug}`)).text();
    const ogImage = /<meta property="og:image" content="([^"]+)"/.exec(html)?.[1].replaceAll("&amp;", "&");
    expect(ogImage).toBe(`${baseURL}${repatched.coverUrl}`);
    expect(html).not.toContain("covers.e2e.example");

    // The browser: the cover is requested from this origin only and falls back to its placeholder.
    await page.goto(`/anime/${series.slug}`);
    await expect(page.getByRole("heading", { level: 1, name: series.name })).toBeVisible();
    await page.waitForLoadState("networkidle");
    for (const src of await page.locator("img").evaluateAll((imgs) => imgs.map((i) => i.src))) expect(new URL(src).hostname, src).toBe("localhost");
    expect(externalRequests, "no request to the cover's host").toEqual([]);

    expect((await admin.delete(`/api/admin/series/${series.id}`)).status()).toBe(204);
    expect((await request.get(`${API_ORIGIN}${repatched.coverUrl}`)).status(), "trashed series").toBe(404);
  });
});

test.describe("update flow", () => {
  test("a new deploy's worker waits → “Nova versão disponível”; Dispensar hides it; Atualizar activates it, reloads once, old build caches are gone", async ({ page }) => {
    const proxy = await startDeployProxy();
    try {
      const violations = await trackCsp(page);
      const toast = page.getByRole("status").filter({ hasText: "Nova versão disponível" });
      await page.goto(`${proxy.origin}/`);
      await swControls(page);
      const oldBuild = /service worker, build ([0-9a-f]+)/.exec(await (await page.request.get(`${proxy.origin}/sw.js`)).text())[1];
      await expect.poll(async () => (await page.evaluate(() => caches.keys())).every((n) => n.endsWith(`-${oldBuild}`))).toBe(true);
      await expect(toast).toHaveCount(0); // the first install is not an update

      const newBuild = `e2e${randomBytes(5).toString("hex")}`.slice(0, 12);
      proxy.deploy(newBuild);
      await test.step("the browser's update check finds the new worker; it installs and waits", async () => {
        // The app checks hourly; ask now (the same check a navigation triggers).
        await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
        await expect(toast).toBeVisible();
        await expect(page.getByRole("button", { name: "Atualizar" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Dispensar" })).toBeVisible();
        // Waiting, not active: this page is still controlled by the old build.
        expect(await page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration()).waiting))).toBe(true);
      });

      await test.step("Dispensar hides the toast; the update still waits (shown again after a reload)", async () => {
        await page.getByRole("button", { name: "Dispensar" }).click();
        await expect(toast).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Atualizar" })).toHaveCount(0);
        await page.reload();
        await expect(toast).toBeVisible();
      });

      await test.step("Atualizar: the new worker takes over and the page reloads", async () => {
        let loads = 0;
        page.on("load", () => loads++);
        await page.evaluate(() => {
          window.__beforeUpdate = true;
        });
        const reloaded = page.waitForEvent("load");
        await page.getByRole("button", { name: "Atualizar" }).click();
        await reloaded;
        expect(await page.evaluate(() => window.__beforeUpdate ?? false), "a new document").toBe(false);
        await swControls(page);
        await page.waitForLoadState("networkidle");
        expect(loads, "reloaded exactly once").toBe(1);
        await expect(page.getByRole("banner")).toBeVisible();
        await expect(toast).toHaveCount(0);
        const state = await page.evaluate(async () => {
          const reg = await navigator.serviceWorker.getRegistration();
          return { active: reg.active?.state, waiting: Boolean(reg.waiting), installing: Boolean(reg.installing) };
        });
        expect(state).toEqual({ active: "activated", waiting: false, installing: false });
        // The new build's caches only: activate deleted the old ones.
        const names = await page.evaluate(() => caches.keys());
        expect(names.length).toBeGreaterThan(0);
        for (const name of names) expect(name, "old build caches are deleted on activate").toMatch(new RegExp(`^crwn-[a-z]+-${newBuild}$`));
        const shell = (await cacheEntries(page)).filter((e) => e.cache === `crwn-shell-${newBuild}`).map((e) => new URL(e.url).pathname);
        expect(shell).toEqual(expect.arrayContaining(["/", "/offline.html"]));
      });
      expect(await violations(), "CSP violations during the update").toEqual([]);
    } finally {
      await proxy.close();
    }
  });
});

test.describe("offline page accessibility", () => {
  test("axe: /offline.html in pt-BR (light and dark) and English; its script runs under the production CSP", async ({ page, browser }) => {
    await page.goto("/offline.html");
    await expect(page.getByRole("heading", { level: 1, name: "Você está offline" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.lang)).toBe("pt-BR");
    await expect(page.getByRole("main")).toBeVisible();
    await expectNoSeriousViolations(page, "offline.html (pt-BR, light)");
    await page.emulateMedia({ colorScheme: "dark" });
    await expectNoSeriousViolations(page, "offline.html (pt-BR, dark)");
    // Keyboard: the retry button is reachable and has a visible focus ring.
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Tentar novamente" })).toBeFocused();

    // An English browser on the production server (CSP: no inline script): /offline.js picks English.
    const en = await newGuardedContext(browser, { locale: "en-US", storageState: { cookies: [], origins: [] }, serviceWorkers: "block" });
    try {
      const enPage = await en.newPage();
      const violations = await trackCsp(enPage);
      await enPage.goto(`${API_ORIGIN}/offline.html`);
      await expect(enPage.getByRole("heading", { level: 1, name: "You're offline" })).toBeVisible();
      await expect(enPage.getByRole("button", { name: "Try again" })).toBeVisible();
      await expect(enPage).toHaveTitle("You're offline · Crwn Animes");
      expect(await enPage.evaluate(() => document.documentElement.lang)).toBe("en");
      await expectNoSeriousViolations(enPage, "offline.html (en)");
      expect(await violations(), "CSP violations on offline.html").toEqual([]);
    } finally {
      await en.close();
    }
  });
});
