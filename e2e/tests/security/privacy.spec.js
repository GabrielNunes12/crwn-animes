// Security / privacy: nothing leaves the site before the visitor presses Play,
// the only cookie ever set is `sid`, no personal data in web storage, and the
// login `?next=` redirect cannot send the visitor to another site.
import { expect, seedSeries, createUser, uniqueEmail, YOUTUBE_HOST, headerUser, API_ORIGIN, ADMIN } from "../fixtures.js";
import { test, withAdmin } from "./helpers.js";

const SERIES = { name: "Sec Privacy Saga", slug: "sec-privacy-saga", aliases: [], genres: ["Privacidade"] };
let videos;
test.beforeAll(async () => {
  await withAdmin(async (admin) => {
    videos = (
      await seedSeries(admin, SERIES, [
        { youtubeId: "secPriv0001", title: "Sec Privacy Saga Episode 1", section: "anime", number: 1 },
        { youtubeId: "secPriv0002", title: "Sec Privacy Saga Chapter 1", section: "manga", number: 1 },
      ])
    ).videos;
  });
});

// v1.5: thumbnails are same-origin (/api/thumbs/<id>.jpg, fetched by the server), so there is
// no exception any more: not even i.ytimg.com may be contacted before Play.
const LOCAL = ["localhost", "127.0.0.1", "[::1]"];

/** Third-party requests of a page, and the same-origin thumbnail requests (to prove thumbnails were shown). */
function trackThirdParty(page) {
  const seen = [];
  seen.thumbs = [];
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (LOCAL.includes(url.hostname) && url.pathname.startsWith("/api/thumbs/")) seen.thumbs.push(req.url());
    if (!LOCAL.includes(url.hostname) && !req.url().startsWith("data:")) seen.push({ url: req.url(), type: req.resourceType(), page: page.url() });
  });
  return seen;
}

const PAGES = (v) => ["/", "/anime", "/manga", `/anime/${SERIES.slug}`, `/manga/${SERIES.slug}`, v[0].route, v[1].route, "/search?q=sec", "/search", `/genre/${encodeURIComponent("Privacidade")}`, "/privacy", "/login", "/register", "/forgot-password", "/account", "/nao-existe"];

test.describe("privacy", () => {
  test("no third-party request at all (not even i.ytimg.com: thumbnails are same-origin) on any page before Play — anonymous and logged in", async ({ page, externalRequests }) => {
    test.setTimeout(90_000);
    const seen = trackThirdParty(page);
    const visit = async () => {
      for (const path of PAGES(videos)) {
        await page.goto(path);
        await page.waitForLoadState("networkidle");
      }
    };
    await visit();
    await createUser(page.request, { email: uniqueEmail("privacy"), displayName: "Privacy Pat" });
    await visit();
    // Opening the palette and hovering cards must not prefetch anything external either.
    await page.goto("/");
    await page.keyboard.press("Control+k");
    await page.keyboard.type("sec");
    await page.waitForLoadState("networkidle");

    // Series covers are same-origin too (/api/covers, v1.5 review fixes), even the ones other specs
    // point at i.ytimg.com (xss.spec.js) and which /, /anime and the palette show.
    expect(seen, "third-party requests before Play").toEqual([]);
    expect(externalRequests, "requests cut off by the network guard").toEqual([]);
    // Not vacuous: the pages did show video thumbnails, from this origin.
    expect(seen.thumbs.length, "same-origin /api/thumbs/ requests").toBeGreaterThan(0);
    for (const url of seen.thumbs) expect(url).toMatch(/^http:\/\/localhost:\d+\/api\/thumbs\/[A-Za-z0-9_-]{11}\.jpg$/);
    // And nothing pointed the browser at YouTube (image, script, frame or fetch).
    expect(seen.filter((r) => YOUTUBE_HOST.test(new URL(r.url).hostname))).toEqual([]);
  });

  test("zero external image requests on any page, series covers included (v1.5 review fix: same-origin covers)", async ({ page, externalRequests }) => {
    test.setTimeout(90_000);
    const COVERED = { name: "Sec Privacy Capa", slug: "sec-privacy-capa", aliases: [], genres: ["Capas Privadas"] };
    const covered = await withAdmin(async (admin) => {
      const seeded = await seedSeries(admin, COVERED, [{ youtubeId: "secPrivCov1", title: "Sec Privacy Capa Episode 1", section: "anime", number: 1 }]);
      const res = await admin.patch(`/api/admin/series/${seeded.series.id}`, { data: { coverUrl: "https://covers.e2e.example/sec-privacy-capa.jpg" } });
      expect(res.status()).toBe(200);
      return seeded;
    });
    const images = [];
    page.on("request", (req) => {
      if (req.resourceType() === "image") images.push(req.url());
    });
    const visit = async (paths) => {
      for (const path of paths) {
        await page.goto(path);
        await page.waitForLoadState("networkidle");
        for (const src of await page.locator("img").evaluateAll((imgs) => imgs.map((i) => i.src))) {
          expect(new URL(src).hostname, `${path}: <img src=${src}>`).toBe("localhost");
        }
      }
    };
    const pages = ["/", "/anime", `/anime/${COVERED.slug}`, covered.videos[0].route, "/search?q=capa", `/genre/${encodeURIComponent("Capas Privadas")}`, "/account"];
    await visit(pages);
    // The palette shows covers next to its suggestions.
    await page.keyboard.press("Control+k");
    await page.keyboard.type("privacy capa");
    await page.waitForLoadState("networkidle");
    await page.keyboard.press("Escape");

    // An admin (its own session, logged out below) sees covers in the series list, the board and the trash.
    const login = await page.request.post("/api/auth/login", { data: { email: ADMIN.email, password: ADMIN.password } });
    expect(login.status()).toBe(200);
    try {
      await visit(["/admin", "/admin?tab=series", `/admin/series/${covered.series.id}`, "/admin?tab=trash", ...pages.slice(0, 3)]);
    } finally {
      await page.request.post("/api/auth/logout");
    }

    expect(images.length, "pages did load images").toBeGreaterThan(0);
    expect(images.filter((u) => !["localhost", "127.0.0.1"].includes(new URL(u).hostname)), "external image requests").toEqual([]);
    expect(externalRequests, "requests cut off by the network guard").toEqual([]);
    expect(images.some((u) => new URL(u).pathname === `/api/covers/${covered.series.id}.img`), "the cover is requested from this origin").toBe(true);
  });

  test("only the `sid` cookie is ever set (anonymous browsing, login, preferences, logout)", async ({ page, context }) => {
    const setCookieNames = new Set();
    page.on("response", async (res) => {
      for (const h of await res.headersArray()) {
        if (h.name.toLowerCase() === "set-cookie") setCookieNames.add(h.value.split("=")[0].trim());
      }
    });
    for (const path of PAGES(videos).slice(0, 8)) await page.goto(path);
    expect(await context.cookies(), "no cookie for anonymous visitors").toEqual([]);

    const user = await createUser(page.request, { email: uniqueEmail("cookies"), displayName: "Cookie Pat" });
    await page.goto("/");
    await expect(headerUser(page, user.displayName)).toBeVisible();
    // Switch language and theme (stored per device, never as cookies).
    const lang = page.getByRole("banner").getByRole("button", { name: "EN", exact: true });
    if (await lang.count()) await lang.first().click();
    for (const path of PAGES(videos)) await page.goto(path);
    await page.request.put(`/api/videos/${videos[0].id}/rating`, { data: { score: 5 } });
    expect((await context.cookies()).map((c) => c.name)).toEqual(["sid"]);
    await page.request.post("/api/auth/logout");
    expect([...setCookieNames].filter((n) => n !== "sid"), "Set-Cookie names other than sid").toEqual([]);
    expect(await page.evaluate(() => document.cookie)).toBe("");
  });

  test("no personal data in localStorage / sessionStorage / IndexedDB after signing in and using the app", async ({ page }) => {
    const email = uniqueEmail("storage");
    const displayName = "Zelda Storage";
    await createUser(page.request, { email, displayName });
    await page.goto("/");
    await expect(headerUser(page, displayName)).toBeVisible();
    for (const path of [videos[0].route, "/account", `/anime/${SERIES.slug}`, "/search?q=sec"]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
    }
    const me = (await (await page.request.get("/api/auth/me")).json()).user;
    const dump = await page.evaluate(async () => {
      const read = (s) => Object.fromEntries(Array.from({ length: s.length }, (_, i) => s.key(i)).map((k) => [k, s.getItem(k)]));
      const dbs = indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : [];
      return { local: read(localStorage), session: read(sessionStorage), dbs, caches: "caches" in window ? await caches.keys() : [] };
    });
    const text = JSON.stringify(dump);
    for (const secret of [email, email.split("@")[0], displayName, `"id":${me.id}`, `"userId"`, "sid="]) {
      expect(text, `web storage contains ${secret}`).not.toContain(secret);
    }
    expect(dump.dbs, "no IndexedDB").toEqual([]);
    // Service workers are blocked here (playwright.config.js), so nothing else writes Cache Storage;
    // what the worker caches when it runs is checked in tests/pwa.spec.js.
    expect(dump.caches, "no Cache Storage").toEqual([]);
    for (const key of Object.keys(dump.local)) expect(key, "only the app's own namespaced keys").toMatch(/^crwn[:-]/);
  });

  // Runs on the API origin (the production server, which serves the SPA itself):
  // `vite preview` refuses some of these URLs before the app ever sees them.
  test("login ?next= cannot redirect off-site (tab/newline/backslash tricks, protocol-relative, javascript:)", async ({ page, context }) => {
    const user = await createUser(page.request, { email: uniqueEmail("next"), displayName: "Next Pat" });
    const attempts = ["//evil.example/x", "/\\evil.example/x", "/\t/evil.example/x", "/\n/evil.example/x", "/\r\n/evil.example", "\\\\evil.example", "https://evil.example", "javascript:alert(1)", "/%09/evil.example", "/ /evil.example", "/　/evil.example"];
    for (const next of attempts) {
      await page.goto(`${API_ORIGIN}/login?next=${encodeURIComponent(next)}`);
      // Logged in already: the page offers a "continue" link built from ?next=.
      const links = page.locator("main a[href]");
      await expect(links.first()).toBeVisible();
      for (const href of await links.evaluateAll((as) => as.map((a) => a.href))) {
        expect(new URL(href).hostname, `?next=${JSON.stringify(next)} → link to ${href}`).toBe("localhost");
      }
    }
    // And after a real login submit, the app stays on this origin.
    await page.request.post("/api/auth/logout");
    for (const next of ["/\t/evil.example/x", "//evil.example", "/\\evil.example"]) {
      await page.request.post("/api/auth/logout");
      await page.goto(`${API_ORIGIN}/login?next=${encodeURIComponent(next)}`);
      await page.getByLabel("E-mail").fill(user.email);
      await page.getByLabel("Senha", { exact: true }).fill(user.password);
      await page.locator("main form").getByRole("button", { name: "Entrar" }).click();
      await expect(headerUser(page, user.displayName)).toBeVisible();
      // The header updates before the router finishes navigating (the next page's chunk
      // loads first), so wait for the URL itself: a hostile ?next= must land on our own "/".
      await expect(page).toHaveURL(`${API_ORIGIN}/`);
      await loginStillHere(page, context);
    }
  });
});

async function loginStillHere(page, context) {
  expect(context.blockedRequests.filter((u) => /evil\.example/.test(u)), "no navigation to evil.example").toEqual([]);
  expect(page.url()).not.toContain("evil.example");
}
