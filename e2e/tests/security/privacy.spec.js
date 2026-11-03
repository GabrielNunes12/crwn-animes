// Security / privacy: nothing leaves the site before the visitor presses Play,
// the only cookie ever set is `sid`, no personal data in web storage, and the
// login `?next=` redirect cannot send the visitor to another site.
import { expect, seedSeries, createUser, uniqueEmail, YOUTUBE_HOST, headerUser, API_ORIGIN } from "../fixtures.js";
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

/** Thumbnails from i.ytimg.com are the documented exception (docs/API.md: thumbnailUrl). */
const allowedBeforePlay = (url) => new URL(url).hostname === "i.ytimg.com";

function trackThirdParty(page) {
  const seen = [];
  page.on("request", (req) => {
    const host = new URL(req.url()).hostname;
    if (!["localhost", "127.0.0.1", "[::1]"].includes(host) && !req.url().startsWith("data:")) seen.push({ url: req.url(), type: req.resourceType(), page: page.url() });
  });
  return seen;
}

const PAGES = (v) => ["/", "/anime", "/manga", `/anime/${SERIES.slug}`, `/manga/${SERIES.slug}`, v[0].route, v[1].route, "/search?q=sec", "/search", `/genre/${encodeURIComponent("Privacidade")}`, "/privacy", "/login", "/register", "/forgot-password", "/account", "/nao-existe"];

test.describe("privacy", () => {
  test("no third-party request (other than i.ytimg.com thumbnails) on any page before Play — anonymous and logged in", async ({ page, externalRequests }) => {
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

    const offending = seen.filter((r) => !allowedBeforePlay(r.url));
    expect(offending, "third-party requests before Play").toEqual([]);
    expect(externalRequests.filter((u) => !allowedBeforePlay(u))).toEqual([]);
    expect(seen.filter((r) => /fonts\.(googleapis|gstatic)\.com|google-analytics|googletagmanager|doubleclick|facebook|hotjar|sentry/.test(r.url))).toEqual([]);
    // Thumbnails are images only: no script/frame/xhr ever goes to YouTube before Play.
    expect(seen.filter((r) => YOUTUBE_HOST.test(new URL(r.url).hostname) && r.type !== "image")).toEqual([]);
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
      expect(new URL(page.url()).hostname).toBe("localhost");
      await loginStillHere(page, context);
    }
  });
});

async function loginStillHere(page, context) {
  expect(context.blockedRequests.filter((u) => /evil\.example/.test(u)), "no navigation to evil.example").toEqual([]);
  expect(page.url()).not.toContain("evil.example");
}
