// Security: stored and reflected XSS. An admin-created series/videos and a
// user's display name carry HTML/JS payloads; every page that shows them is
// visited and must render them as inert text: no dialog fires, no injected
// element exists. The client is tested on the `vite preview` origin (NO CSP
// there, so a DOM-XSS bug in React code would really execute) and the
// server-rendered HTML on the API origin with JavaScript disabled.
import { expect, API_ORIGIN, ADMIN, seedSeries, createUser, uniqueEmail, newGuardedContext, headerUser } from "../fixtures.js";
import { INJECTED, trapDialogs, test, withAdmin } from "./helpers.js";

const NAME = `SecXSS <img src=x onerror=alert('name')> "><svg onload=alert('name2')>`;
const SLUG = "sec-xss-saga";
const SYNOPSIS = `<script>alert('synopsis')</script><img src=x onerror=alert('synopsis2')> <a href="javascript:alert('syn3')">link</a> {{constructor.constructor('alert(4)')()}} \${alert(5)}`;
const ALIASES = [`"><svg onload=alert('alias')>`, "secxssalias", "javascript:alert('alias2')"];
const GENRE = `<img src=x onerror=alert('g')>`;
const COVER = `https://i.ytimg.com/vi/secxss/hqdefault.jpg?"onerror="alert('cover')`;
const TITLES = [
  `<img src=x onerror=alert('title1')>`,
  `"><svg onload=alert('title2')>`,
  `javascript:alert('title3')`,
  `</script><script>alert('title4')</script><!--`,
];
const DISPLAY_NAME = `<img src=x onerror=alert(9)>`;
let videos;

test.beforeAll(async () => {
  await withAdmin(async (admin) => {
    // Dangerous cover URL schemes are refused outright.
    for (const coverUrl of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:msgbox(1)", "//evil.example/x.png", "file:///etc/passwd"]) {
      const res = await admin.post("/api/admin/series", { data: { name: "Sec Bad Cover", slug: "sec-bad-cover", coverUrl } });
      expect(res.status(), `coverUrl ${coverUrl}`).toBe(400);
    }
    const seeded = await seedSeries(
      admin,
      { name: NAME, slug: SLUG, synopsis: SYNOPSIS, aliases: ALIASES, genres: [GENRE] },
      TITLES.map((title, i) => ({ youtubeId: `secXss${i}Vid0`.padEnd(11, "x"), title, section: "anime", number: i + 1 }))
    );
    // A cover URL with quotes is stored as a normalised URL.
    const patched = await admin.patch(`/api/admin/series/${seeded.series.id}`, { data: { coverUrl: COVER } });
    expect(patched.status()).toBe(200);
    expect((await patched.json()).series.coverUrl).not.toContain('"');
    videos = seeded.videos;
  });
});

const SERIES_PATH = `/anime/${SLUG}`;
const episode = (n) => `${SERIES_PATH}/episode/${n}`;

/** Goes to `path`, lets the app settle, and asserts nothing was injected. */
async function visitAndCheck(page, dialogs, path, { ready } = {}) {
  await page.goto(path);
  if (ready) await ready();
  await page.waitForLoadState("networkidle");
  await expectClean(page, dialogs, path);
}

async function expectClean(page, dialogs, where) {
  expect(await page.locator(INJECTED).count(), `${where}: injected element in the DOM`).toBe(0);
  expect(await page.evaluate(() => window.__xss ?? null), `${where}: payload executed`).toBeNull();
  expect(dialogs, `${where}: a dialog fired`).toEqual([]);
}

test.describe("stored / reflected XSS in the SPA", () => {
  test("public pages, search, genre, palette, 404 and watch pages render payloads as text", async ({ page }) => {
    test.setTimeout(90_000);
    const dialogs = trapDialogs(page);
    const user = await createUser(page.request, { email: uniqueEmail("xss"), displayName: DISPLAY_NAME });

    await visitAndCheck(page, dialogs, "/", { ready: () => expect(headerUser(page, user.displayName)).toBeVisible() });
    await visitAndCheck(page, dialogs, "/anime");
    await visitAndCheck(page, dialogs, SERIES_PATH, { ready: () => expect(page.getByRole("heading", { level: 1 })).toHaveText(NAME) });
    await expect(page.getByText("<script>alert('synopsis')</script>", { exact: false }).first()).toBeVisible();
    for (let n = 1; n <= TITLES.length; n++) {
      await visitAndCheck(page, dialogs, episode(n), { ready: () => expect(page.locator("main p.muted").filter({ hasText: TITLES[n - 1] }).first()).toHaveText(TITLES[n - 1]) });
    }
    await visitAndCheck(page, dialogs, "/search?q=secxssalias", { ready: () => expect(page.getByText(NAME).first()).toBeVisible() });
    await visitAndCheck(page, dialogs, `/search?q=${encodeURIComponent(`"><img src=x onerror=alert('q')>`)}&genre=${encodeURIComponent(`<svg onload=alert('qg')>`)}&sort=${encodeURIComponent("<b>")}`);
    await visitAndCheck(page, dialogs, `/anime?q=${encodeURIComponent(`<img src=x onerror=alert('sq')>`)}&genre=${encodeURIComponent(GENRE)}`);
    await visitAndCheck(page, dialogs, `/genre/${encodeURIComponent(GENRE)}`, { ready: () => expect(page.getByText(NAME).first()).toBeVisible() });
    await visitAndCheck(page, dialogs, `/anime/${encodeURIComponent(`<img src=x onerror=alert('404')>`)}`);
    await visitAndCheck(page, dialogs, `/anime/${SLUG}/episode/${encodeURIComponent(`<svg onload=alert('ep')>`)}`);
    await visitAndCheck(page, dialogs, `/login?next=${encodeURIComponent("javascript:alert('next')")}`);
    await visitAndCheck(page, dialogs, `/reset-password?token=${encodeURIComponent(`"><img src=x onerror=alert('tok')>`)}`);
    await visitAndCheck(page, dialogs, `/verify-email?token=${encodeURIComponent(`"><img src=x onerror=alert('vtok')>`)}`);
    await visitAndCheck(page, dialogs, `/check-email?email=${encodeURIComponent(`<img src=x onerror=alert('ce')>@x.io`)}`);

    // Command palette (Ctrl+K) with the alias.
    await visitAndCheck(page, dialogs, "/", { ready: () => expect(headerUser(page, user.displayName)).toBeVisible() });
    await page.keyboard.press("Control+k");
    const box = page.getByRole("dialog", { name: "Busca rápida" }).getByRole("combobox");
    await expect(box).toBeFocused();
    await box.fill("secxssalias");
    // The series suggestion (not the trailing "Ver todos os resultados para …" option, whose text also contains the query).
    const seriesOption = page.getByRole("dialog", { name: "Busca rápida" }).getByRole("option").filter({ hasText: "SecXSS <img" });
    await expect(seriesOption).toHaveCount(1);
    await expectClean(page, dialogs, "palette");
    await seriesOption.click();
    await expect(page).toHaveURL(new RegExp(`${SERIES_PATH}$`));
    await expectClean(page, dialogs, "palette → series");

    // Account page with a hostile display name.
    await visitAndCheck(page, dialogs, "/account", { ready: () => expect(page.getByRole("textbox", { name: "Nome de exibição" })).toHaveValue(DISPLAY_NAME) });
    // Renaming to another payload via the API, then reloading.
    expect((await page.request.patch("/api/me", { data: { displayName: `"><svg onload=alert(8)>` } })).status()).toBe(200);
    await visitAndCheck(page, dialogs, "/account", { ready: () => expect(headerUser(page, `"><svg onload=alert(8)>`)).toBeVisible() });
  });

  test("admin pages render hostile series/video data as text", async ({ browser }) => {
    const context = await newGuardedContext(browser);
    const page = await context.newPage();
    expect((await page.request.post("/api/auth/login", { data: { email: ADMIN.email, password: ADMIN.password } })).status()).toBe(200);
    const dialogs = trapDialogs(page);
    const panel = page.getByRole("tabpanel");
    await visitAndCheck(page, dialogs, "/admin", { ready: () => expect(panel).toBeVisible() });
    await panel.getByRole("searchbox", { name: "Buscar séries" }).fill("SecXSS");
    await expect(panel.getByText(NAME, { exact: true }).first()).toBeVisible();
    await expectClean(page, dialogs, "/admin series");
    await visitAndCheck(page, dialogs, "/admin?tab=published", { ready: () => expect(panel).toBeVisible() });
    await panel.getByRole("searchbox", { name: "Buscar vídeos por título ou série" }).fill("SecXSS");
    await expect(panel.getByText(TITLES[0], { exact: true }).first()).toBeVisible();
    await expectClean(page, dialogs, "/admin published");
    for (const tab of ["pending", "broken", "add", "bulk"]) await visitAndCheck(page, dialogs, `/admin?tab=${tab}`);
    await context.close();
  });

  test("progress import with hostile JSON (titles, javascript:/data: routes and thumbs) stays inert", async ({ page }) => {
    const dialogs = trapDialogs(page);
    const now = Date.now();
    const entry = (route, title, thumb) => ({ t: 30, d: 100, at: now, route, title, thumb });
    const hostile = {
      version: 1,
      exportedAt: new Date().toISOString(),
      entries: {
        [videos[0].youtubeVideoId]: entry(videos[0].route, `<img src=x onerror=alert('pt1')>`, `https://i.ytimg.com/vi/x/hq.jpg"onerror="alert('th')`),
        [videos[1].youtubeVideoId]: entry(videos[1].route, `"><svg onload=alert('pt2')>`, "javascript:alert('thumb')"),
        secXssImp01: entry("javascript:alert('route')", "js route", null),
        secXssImp02: entry("data:text/html,<script>alert(1)</script>", "data route", null),
        secXssImp03: entry("/anime/x/episode/1?<img src=x onerror=alert(1)>", "query route", null),
        secXssImp04: entry("/\\evil.example/anime/x/episode/1", "backslash route", null),
        secXssImp05: entry(videos[2].route, "x".repeat(5000), "data:image/svg+xml,<svg onload=alert(1)>"),
      },
    };
    await page.goto("/account");
    await page.getByLabel("Importar histórico").setInputFiles({ name: "evil.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(hostile)) });
    await expect(page.getByRole("status").filter({ hasText: /Importados:|Nada foi importado/ })).toBeVisible();
    await expectClean(page, dialogs, "/account after import");
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("crwn:progress:v1") ?? "{}"));
    for (const [id, e] of Object.entries(stored)) {
      expect(e.route, `${id} route`).toMatch(/^\/(anime|manga)\/[a-z0-9-]+\/(episode|season|chapter)\//);
      if (e.thumb != null) expect(e.thumb, `${id} thumb`).toMatch(/^https:\/\/i\.ytimg\.com\/[^"'<> ]+$/);
    }
    await visitAndCheck(page, dialogs, "/");
    await visitAndCheck(page, dialogs, SERIES_PATH);
    expect(await page.locator('a[href^="javascript:" i], a[href^="data:" i], img[src^="javascript:" i], img[src^="data:text" i]').count()).toBe(0);
  });
});

test.describe("server-rendered HTML (JavaScript disabled, API origin)", () => {
  test("SEO head + JSON-LD escape every payload; no injected element; CSP header present", async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, baseURL: API_ORIGIN });
    const page = await context.newPage();
    const dialogs = trapDialogs(page);
    const paths = [
      SERIES_PATH,
      ...TITLES.map((_, i) => episode(i + 1)),
      `/genre/${encodeURIComponent(GENRE)}`,
      `/search?q=${encodeURIComponent(`"><img src=x onerror=alert('q')>`)}`,
      `/anime/${encodeURIComponent(`"><img src=x onerror=alert('404')>`)}`,
      `/genre/${encodeURIComponent(`"><svg onload=alert('g404')>`)}`,
      `/${encodeURIComponent(`"><img src=x onerror=alert('root')>`)}`,
    ];
    for (const path of paths) {
      const res = await page.goto(path);
      expect([200, 404], path).toContain(res.status());
      expect(res.headers()["content-security-policy"], `${path}: CSP`).toMatch(/default-src 'self'/);
      const html = await res.text();
      // (escaped text such as "&lt;img src=x onerror=alert(&#39;" is fine: it is inert)
      for (const raw of ["<img src=x", "<svg onload", "</script><script>", "<script>alert"]) {
        expect(html, `${path}: raw "${raw}" in the HTML`).not.toContain(raw);
      }
      await expectClean(page, dialogs, path);
      // Every JSON-LD block is valid JSON and contains no raw "<".
      for (const block of await page.locator('script[type="application/ld+json"]').allTextContents()) {
        expect(block).not.toContain("<");
        expect(() => JSON.parse(block)).not.toThrow();
      }
    }
    // Values round-trip as text.
    await page.goto(SERIES_PATH);
    expect(await page.title()).toContain(NAME);
    expect(await page.locator('meta[property="og:title"]').getAttribute("content")).toContain(NAME);
    await page.goto(episode(4));
    const ld = JSON.parse(await page.locator('script[type="application/ld+json"]').first().textContent());
    expect(JSON.stringify(ld)).toContain(TITLES[3].slice(0, 10));
    await context.close();
  });
});
