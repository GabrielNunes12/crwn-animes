// Journey 7 (API v1.3): local watch progress on series pages and cards
// ("N de M assistidos", Continue, season tabs) and its portability on /account
// (Export / Import watch history), including hostile import files.
//
// Progress lives only in localStorage (crwn:progress:v1) and YouTube is blocked,
// so progress is seeded directly into localStorage with the real ids/routes of
// the videos seeded through the API.
import fs from "node:fs/promises";
import { test, expect, asAdmin, fakeYouTubeId, seedSeries, expectNoSeriousViolations, FAKE_THUMB_WIDTH } from "./fixtures.js";

const KEY = "crwn:progress:v1";

// One series per worker (unique slug/name, so --repeat-each and parallel workers never share it):
// anime S1 E1–3, S2 E1–2; manga Ch 1–2.
let S;
test.beforeAll(async ({}, testInfo) => {
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const series = { name: `Progresso ${tag}`, slug: `progresso-${tag}`, genres: ["Aventura"] };
  const spec = [
    ["s1e1", "anime", 1, 1],
    ["s1e2", "anime", 1, 2],
    ["s1e3", "anime", 1, 3],
    ["s2e1", "anime", 2, 1],
    ["s2e2", "anime", 2, 2],
    ["ch1", "manga", 1, 1],
    ["ch2", "manga", 1, 2],
  ];
  const { videos } = await asAdmin(testInfo, (admin) =>
    seedSeries(
      admin,
      series,
      spec.map(([key, section, season, number]) => ({ youtubeId: fakeYouTubeId("pg"), title: `${series.name} ${key}`, section, season, number }))
    )
  );
  const v = Object.fromEntries(spec.map(([key], i) => [key, videos[i]]));
  const slug = series.slug;
  expect(v.s1e2.route).toBe(`/anime/${slug}/episode/2`);
  expect(v.s2e1.route).toBe(`/anime/${slug}/season/2/episode/1`);
  expect(v.ch2.route).toBe(`/manga/${slug}/chapter/2`);
  S = { ...series, v, anime: `/anime/${slug}`, manga: `/manga/${slug}` };
});

/** A progress entry for a seeded video (its real route and title). */
const entry = (video, { t, d = 100, at }) => ({ t, d, at, route: video.route, title: video.title, thumb: null });
const done = (video, at) => entry(video, { t: 100, at });
const started = (video, at, t = 30) => entry(video, { t, at });

/** Writes progress into localStorage once per tab, before the app boots (later navigations keep what the app stores). */
async function seedProgress(page, entries) {
  await page.addInitScript(
    ([key, value]) => {
      if (sessionStorage.getItem("e2e:progress-seeded")) return;
      localStorage.setItem(key, value);
      sessionStorage.setItem("e2e:progress-seeded", "1");
    },
    [KEY, JSON.stringify(entries)]
  );
}

const readProgress = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}"), KEY);

const seasonNav = (page) => page.getByRole("navigation", { name: "Temporadas" });
const seasonLink = (page, n) => seasonNav(page).getByRole("link", { name: `Temporada ${n}`, exact: true });
const episodes = (page) => page.getByRole("region", { name: /^Temporada \d+$/ }).getByRole("listitem");
const continueLink = (page) => page.getByRole("link", { name: /Continuar:/ });

test.describe("series page progress", () => {
  test("“N de M assistidos” per section; Continue resumes the in-progress episode", async ({ page }) => {
    const { v } = S;
    await seedProgress(page, {
      [v.s1e1.youtubeVideoId]: done(v.s1e1, 1_000),
      [v.s2e1.youtubeVideoId]: done(v.s2e1, 2_000),
      [v.s1e2.youtubeVideoId]: started(v.s1e2, 3_000), // most recent, unfinished
      [v.ch1.youtubeVideoId]: done(v.ch1, 4_000),
    });

    await test.step("anime: 2 of 5 watched, Continue → S1 E2 (resume)", async () => {
      await page.goto(S.anime);
      await expect(page.getByRole("heading", { level: 1, name: S.name })).toBeVisible();
      await expect(page.getByText("2 de 5 assistidos", { exact: true })).toBeVisible();
      await expect(continueLink(page)).toHaveText(/Continuar: Episódio 2$/);
      await expect(continueLink(page)).toHaveAttribute("href", v.s1e2.route);
      await expect(continueLink(page)).toHaveAttribute("data-resume", "true");
      // Opens on the Continue target's season; ✓ on the finished episode.
      await expect(seasonLink(page, 1)).toHaveAttribute("aria-current", "true");
      await expect(episodes(page)).toHaveCount(3);
      await expect(episodes(page).nth(0)).toContainText("Assistido");
      await expect(episodes(page).nth(1)).toContainText("Continuar em 0:30");
      await expect(episodes(page).nth(2)).not.toContainText("Assistido");
    });

    await test.step("manga: its own count (1 of 2 read), Continue → Ch 2", async () => {
      await page.goto(S.manga);
      await expect(page.getByText("1 de 2 lidos", { exact: true })).toBeVisible();
      await expect(continueLink(page)).toHaveText(/Continuar: Capítulo 2$/);
      await expect(continueLink(page)).toHaveAttribute("href", v.ch2.route);
      await expect(seasonNav(page)).toHaveCount(0); // one season: no tabs
    });

    await test.step("Continue opens the episode page", async () => {
      await page.goto(S.anime);
      await continueLink(page).click();
      await expect(page).toHaveURL(v.s1e2.route);
      await expect(page.getByRole("heading", { level: 1, name: "Episódio 2" })).toBeVisible();
    });
  });

  test("Continue goes to the first unwatched episode across seasons; all watched → “Você assistiu tudo”", async ({ page }) => {
    const { v } = S;
    await seedProgress(page, {
      [v.s1e1.youtubeVideoId]: done(v.s1e1, 1_000),
      [v.s1e2.youtubeVideoId]: done(v.s1e2, 2_000),
      [v.s1e3.youtubeVideoId]: done(v.s1e3, 3_000),
    });
    await page.goto(S.anime);
    await expect(page.getByText("3 de 5 assistidos", { exact: true })).toBeVisible();
    await expect(continueLink(page)).toHaveText(/Continuar: Temporada 2 · Episódio 1$/);
    await expect(continueLink(page)).toHaveAttribute("href", v.s2e1.route);
    await expect(continueLink(page)).not.toHaveAttribute("data-resume", /.*/);
    // No ?season=: the page opens on the Continue target's season.
    await expect(seasonLink(page, 2)).toHaveAttribute("aria-current", "true");
    await expect(page.getByRole("heading", { level: 3, name: "Temporada 2" })).toBeVisible();

    await continueLink(page).click();
    await expect(page).toHaveURL(v.s2e1.route);

    // Finish the series (another tab wrote it: the page follows localStorage).
    await page.evaluate(
      ([key, extra]) => localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key)), ...extra })),
      [KEY, { [v.s2e1.youtubeVideoId]: done(v.s2e1, 4_000), [v.s2e2.youtubeVideoId]: done(v.s2e2, 5_000) }]
    );
    await page.goto(S.anime);
    await expect(page.getByText("5 de 5 assistidos", { exact: true })).toBeVisible();
    await expect(page.getByText("Você assistiu tudo")).toBeVisible();
    await expect(continueLink(page)).toHaveCount(0);
  });

  test("without progress: no count, “Começar a assistir” → S1 E1; season 1 shown", async ({ page }) => {
    await page.goto(S.anime);
    await expect(page.getByRole("link", { name: /Começar a assistir/ })).toHaveAttribute("href", S.v.s1e1.route);
    await expect(page.getByText(/de 5 assistidos/)).toHaveCount(0);
    await expect(seasonLink(page, 1)).toHaveAttribute("aria-current", "true");
  });

  test("season tabs: ?season= in the URL, direct links, unknown season, back/forward", async ({ page }) => {
    await page.goto(S.anime);
    await expect(seasonLink(page, 1)).toHaveAttribute("aria-current", "true");
    await expect(episodes(page)).toHaveCount(3);

    await seasonLink(page, 2).click();
    await expect(page).toHaveURL(`${S.anime}?season=2`);
    await expect(seasonLink(page, 2)).toHaveAttribute("aria-current", "true");
    await expect(seasonLink(page, 1)).not.toHaveAttribute("aria-current", /.*/);
    await expect(page.getByRole("heading", { level: 3, name: "Temporada 2" })).toBeVisible();
    await expect(episodes(page)).toHaveCount(2);
    await expect(episodes(page).first().getByRole("link")).toHaveAttribute("href", S.v.s2e1.route);

    await seasonLink(page, 1).click();
    await expect(page).toHaveURL(`${S.anime}?season=1`);
    await expect(episodes(page)).toHaveCount(3);

    // A shared ?season= URL opens that season; history entries switch seasons.
    await page.goto(`${S.anime}?season=2`);
    await expect(seasonLink(page, 2)).toHaveAttribute("aria-current", "true");
    await expect(episodes(page)).toHaveCount(2);
    await page.goto(`${S.anime}?season=1`);
    await expect(episodes(page)).toHaveCount(3);
    await page.goBack();
    await expect(page).toHaveURL(`${S.anime}?season=2`);
    await expect(seasonLink(page, 2)).toHaveAttribute("aria-current", "true");
    await expect(episodes(page)).toHaveCount(2);
    await page.goForward();
    await expect(seasonLink(page, 1)).toHaveAttribute("aria-current", "true");
    await expect(episodes(page)).toHaveCount(3);

    // An unknown or invalid season falls back to the first one (no crash, no 404).
    for (const bad of ["9", "abc"]) {
      await page.goto(`${S.anime}?season=${bad}`);
      await expect(page.getByRole("heading", { level: 1, name: S.name })).toBeVisible();
      await expect(seasonLink(page, 1)).toHaveAttribute("aria-current", "true");
      await expect(episodes(page)).toHaveCount(3);
    }
  });

  test("Back after clicking a season tab returns to the previous season", async ({ page }) => {
    // Regression (found in cycle 3): the season links used <Link replace>, so Back left the series page.
    await page.goto("/anime");
    await expect(page.getByRole("heading", { level: 1, name: "Anime" })).toBeVisible();
    await page.goto(S.anime);
    await expect(seasonLink(page, 1)).toHaveAttribute("aria-current", "true");
    await seasonLink(page, 2).click();
    await expect(page).toHaveURL(`${S.anime}?season=2`);
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${S.anime}(\\?season=1)?$`));
    await expect(seasonLink(page, 1)).toHaveAttribute("aria-current", "true");
    await page.goBack();
    await expect(page).toHaveURL("/anime");
  });

  test("series cards on /anime and /manga show N/M watched / read", async ({ page }) => {
    const { v } = S;
    await seedProgress(page, {
      [v.s1e1.youtubeVideoId]: done(v.s1e1, 1_000),
      [v.s2e2.youtubeVideoId]: done(v.s2e2, 2_000),
      [v.s1e3.youtubeVideoId]: started(v.s1e3, 3_000), // started, not watched
      [v.ch1.youtubeVideoId]: done(v.ch1, 4_000),
      [v.ch2.youtubeVideoId]: done(v.ch2, 5_000),
    });
    const card = (name) => page.getByRole("article").filter({ has: page.getByRole("heading", { name, exact: true }) });

    await page.goto(`/anime?q=${encodeURIComponent(S.name)}`);
    await expect(card(S.name)).toContainText("2/5 assistidos");
    await expect(card(S.name)).toContainText("5 episódios");

    await page.goto(`/manga?q=${encodeURIComponent(S.name)}`);
    await expect(card(S.name)).toContainText("✓ 2/2 lidos");
  });

  const stale = (route, at) => ({ t: 100, d: 100, at, route, title: "old link", thumb: null });
  const seriesCard = (page) => page.getByRole("article").filter({ has: page.getByRole("heading", { name: S.name, exact: true }) });

  test("card and series page agree when an episode's YouTube link was swapped (old + new id, one route)", async ({ page }) => {
    // Regression (found in cycle 3): the card counted history entries by route, the page by id → 2/5 vs 1 de 5.
    const { v } = S;
    await seedProgress(page, {
      [v.s1e1.youtubeVideoId]: done(v.s1e1, 1_000),
      [fakeYouTubeId("old")]: stale(v.s1e1.route, 500), // same episode, previous YouTube link
      [fakeYouTubeId("old")]: stale(v.s1e2.route, 600), // only the old link of S1 E2 was watched
    });
    await page.goto(S.anime);
    await expect(page.getByText("2 de 5 assistidos", { exact: true })).toBeVisible();
    await page.goto(`/anime?q=${encodeURIComponent(S.name)}`);
    await expect(seriesCard(page)).toContainText("2/5 assistidos");
  });

  test("card and series page agree when local history holds an episode that no longer exists", async ({ page }) => {
    // Cards only know videoCount, so a deleted episode's entry may count on a card until the series
    // page is visited: that page prunes entries for episodes that no longer exist
    // (pruneSeriesProgress in client/src/lib/progress.js). After the visit both must agree.
    const { v } = S;
    await seedProgress(page, {
      [v.s1e1.youtubeVideoId]: done(v.s1e1, 1_000),
      [fakeYouTubeId("del")]: stale(`${S.anime}/episode/99`, 600), // an episode that was deleted
    });
    await page.goto(S.anime);
    await expect(page.getByText("1 de 5 assistidos", { exact: true })).toBeVisible();
    await page.goto(`/anime?q=${encodeURIComponent(S.name)}`);
    await expect(seriesCard(page)).toContainText("/5 assistidos");
    await expect(seriesCard(page)).toContainText("1/5 assistidos");
  });

  test("axe: series page with progress and season tabs", async ({ page }) => {
    const { v } = S;
    await seedProgress(page, { [v.s1e1.youtubeVideoId]: done(v.s1e1, 1_000), [v.s1e2.youtubeVideoId]: started(v.s1e2, 2_000) });
    await page.goto(`${S.anime}?season=1`);
    await expect(page.getByText("1 de 5 assistidos", { exact: true })).toBeVisible();
    await expect(episodes(page)).toHaveCount(3);
    await expectNoSeriousViolations(page, "series page (progress + seasons)");
  });
});

test.describe("/account: export / import watch history", () => {
  const exportButton = (page) => page.getByRole("button", { name: "Exportar histórico" });
  const importInput = (page) => page.getByLabel("Importar histórico");
  const status = (page) => page.getByRole("status").filter({ hasText: /Importados:|Nada foi importado|exportad/ });
  const file = (name, data) => ({ name, mimeType: "application/json", buffer: Buffer.from(typeof data === "string" ? data : JSON.stringify(data)) });

  test("Export downloads crwn-animes-progress.json (version 1, every entry), logged out", async ({ page }) => {
    const { v } = S;
    const entries = {
      [v.s1e1.youtubeVideoId]: done(v.s1e1, 1_700_000_000_000),
      [v.s2e1.youtubeVideoId]: started(v.s2e1, 1_700_000_100_000, 42.5),
    };
    await seedProgress(page, entries);
    await page.goto("/account");
    await expect(page.getByText("2 vídeos no seu histórico.")).toBeVisible();

    const [download] = await Promise.all([page.waitForEvent("download"), exportButton(page).click()]);
    expect(download.suggestedFilename()).toBe("crwn-animes-progress.json");
    const data = JSON.parse(await fs.readFile(await download.path(), "utf8"));
    expect(data.version).toBe(1);
    expect(new Date(data.exportedAt).toISOString()).toBe(data.exportedAt);
    expect(data.entries).toEqual(entries);
    await expect(status(page)).toHaveText("2 vídeos exportados.");
  });

  test("Import merges a valid file: newest `at` wins per video, new entries added", async ({ page }) => {
    const { v } = S;
    await seedProgress(page, {
      [v.s1e1.youtubeVideoId]: started(v.s1e1, 1_000, 10), // older here → replaced
      [v.s1e2.youtubeVideoId]: done(v.s1e2, 9_000), // newer here → kept
    });
    await page.goto("/account");
    await expect(page.getByText("2 vídeos no seu histórico.")).toBeVisible();

    await importInput(page).setInputFiles(
      file("crwn-animes-progress.json", {
        version: 1,
        exportedAt: new Date().toISOString(),
        entries: {
          [v.s1e1.youtubeVideoId]: done(v.s1e1, 2_000),
          [v.s1e2.youtubeVideoId]: started(v.s1e2, 5_000, 20),
          [v.s2e1.youtubeVideoId]: { ...done(v.s2e1, 3_000), extra: "ignored key" },
        },
      })
    );
    await expect(status(page)).toHaveText("Importados: 2. Ignorados: 1.");
    await expect(page.getByText("3 vídeos no seu histórico.")).toBeVisible();

    const stored = await readProgress(page);
    expect(stored[v.s1e1.youtubeVideoId]).toEqual(done(v.s1e1, 2_000));
    expect(stored[v.s1e2.youtubeVideoId]).toEqual(done(v.s1e2, 9_000));
    expect(stored[v.s2e1.youtubeVideoId]).toEqual(done(v.s2e1, 3_000)); // unknown key dropped

    // The series page reflects the imported history.
    await page.goto(S.anime);
    await expect(page.getByText("3 de 5 assistidos", { exact: true })).toBeVisible();
  });

  test("hostile files are rejected or sanitised: __proto__, javascript: routes, third-party thumbs, 2 MB, not JSON", async ({ page, externalRequests }) => {
    const { v } = S;
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));
    const dialogs = [];
    page.on("dialog", async (d) => {
      dialogs.push(d.message());
      await d.dismiss();
    });
    const original = { [v.s1e1.youtubeVideoId]: done(v.s1e1, 1_000) };
    await seedProgress(page, original);
    await page.goto("/account");
    await expect(page.getByText("1 vídeo no seu histórico.")).toBeVisible();

    await test.step("2 MB file → refused before reading, nothing changes", async () => {
      const big = JSON.stringify({ version: 1, entries: {}, pad: "x".repeat(2 * 1024 * 1024) });
      await importInput(page).setInputFiles(file("big.json", big));
      await expect(status(page)).toHaveText("Esse arquivo passa de 1 MB. Nada foi importado.");
      expect(await readProgress(page)).toEqual(original);
    });

    await test.step("not a history file (not JSON / wrong version / array) → refused", async () => {
      for (const bad of ["not json {", JSON.stringify({ version: 2, entries: {} }), JSON.stringify([1, 2]), JSON.stringify({ version: 1, entries: [] })]) {
        await importInput(page).setInputFiles(file("bad.json", bad));
        await expect(status(page)).toHaveText("Esse arquivo não é um histórico do Crwn Animes. Nada foi importado.");
        await expect(page.getByText("1 vídeo no seu histórico.")).toBeVisible();
      }
      expect(await readProgress(page)).toEqual(original);
    });

    const evilId = fakeYouTubeId("evil");
    const AT = Date.now() - 60_000; // a believable timestamp (far-future ones are rejected)
    await test.step("crafted entries are skipped; a third-party thumb is dropped; no prototype pollution", async () => {
      // Raw JSON so "__proto__" is a real own key of the parsed objects.
      const evil = `{
        "version": 1,
        "__proto__": { "polluted": "top" },
        "entries": {
          "__proto__": { "t": 1, "d": 100, "at": ${AT}, "route": "${v.s1e3.route}", "polluted": "entries" },
          "constructor": { "t": 1, "d": 100, "at": ${AT}, "route": "${v.s1e3.route}" },
          "${fakeYouTubeId("js")}": { "t": 30, "d": 100, "at": ${AT}, "route": "javascript:alert(document.domain)", "title": "x" },
          "${fakeYouTubeId("ext")}": { "t": 30, "d": 100, "at": ${AT}, "route": "https://evil.example/anime/x/episode/1" },
          "${fakeYouTubeId("pr")}": { "t": 30, "d": 100, "at": ${AT}, "route": "//evil.example/anime/x/episode/1" },
          "${fakeYouTubeId("trv")}": { "t": 30, "d": 100, "at": ${AT}, "route": "/anime/../../evil/episode/1" },
          "short": { "t": 30, "d": 100, "at": ${AT}, "route": "${v.s1e3.route}" },
          "${fakeYouTubeId("neg")}": { "t": -5, "d": 100, "at": ${AT}, "route": "${v.s1e3.route}" },
          "${fakeYouTubeId("str")}": { "t": "30", "d": 100, "at": ${AT}, "route": "${v.s1e3.route}" },
          "${fakeYouTubeId("fut")}": { "t": 30, "d": 100, "at": 99999999999999, "route": "${v.s1e3.route}" },
          "${fakeYouTubeId("big")}": { "t": 1e300, "d": 1e300, "at": ${AT}, "route": "${v.s1e3.route}" },
          "${v.s1e1.youtubeVideoId}": { "t": 0, "d": 100, "at": 500, "route": "${v.s1e1.route}" },
          "${evilId}": { "t": 30, "d": 100, "at": ${AT}, "route": "${v.s1e3.route}", "title": "<img src=x onerror=alert(1)>",
                         "thumb": "https://evil.example/track.png?c=1", "__proto__": { "polluted": "entry" } }
        }
      }`;
      await importInput(page).setInputFiles(file("evil.json", evil));
      // "constructor" is 11 [A-Za-z0-9_-] characters, i.e. a well-formed video id: it is
      // kept, but only as plain data (Object.prototype.constructor is untouched).
      await expect(status(page)).toHaveText("Importados: 2. Ignorados: 11.");
      await expect(page.getByText("3 vídeos no seu histórico.")).toBeVisible();

      const stored = await readProgress(page);
      expect(Object.keys(stored).sort()).toEqual([evilId, v.s1e1.youtubeVideoId, "constructor"].sort());
      expect(stored.constructor).toEqual({ t: 1, d: 100, at: AT, route: v.s1e3.route, title: null, thumb: null });
      expect(await page.evaluate(() => ({}).constructor === Object && typeof Object.prototype.constructor === "function")).toBe(true);
      expect(stored[v.s1e1.youtubeVideoId]).toEqual(original[v.s1e1.youtubeVideoId]); // older `at` lost
      expect(stored[evilId]).toEqual({ t: 30, d: 100, at: AT, route: v.s1e3.route, title: "<img src=x onerror=alert(1)>", thumb: null });
      expect(await page.evaluate(() => ({}).polluted ?? Object.prototype.polluted ?? null)).toBeNull();
    });

    await test.step("the imported entry renders safely where progress is shown; nothing leaves localhost", async () => {
      // The page still works: export still runs.
      const [download] = await Promise.all([page.waitForEvent("download"), exportButton(page).click()]);
      expect(Object.keys(JSON.parse(await fs.readFile(await download.path(), "utf8")).entries)).toHaveLength(3);
      // Home's "Continuar assistindo" shows the imported title as text, with no third-party thumbnail.
      await page.goto("/");
      const row = page.getByRole("region", { name: "Continuar assistindo" });
      await expect(row.getByRole("heading", { level: 3, name: "<img src=x onerror=alert(1)>" })).toBeVisible();
      await expect(row.getByRole("link").filter({ hasText: "<img src=x" })).toHaveAttribute("href", v.s1e3.route);
      await page.goto(S.anime);
      await expect(page.getByText("1 de 5 assistidos", { exact: true })).toBeVisible();
      await expect(page.locator('img[src*="evil.example"]')).toHaveCount(0);
      expect(dialogs, "no alert() ran").toEqual([]);
      expect(errors, "no uncaught page errors").toEqual([]);
      // v1.5: thumbnails are same-origin, so not even YouTube's image host is contacted.
      expect(externalRequests, "no request to any non-local host").toEqual([]);
    });
  });

  test("v1.5: legacy i.ytimg.com thumbs (old local history or an imported file) are shown through /api/thumbs; nothing leaves localhost", async ({ page, externalRequests }) => {
    const { v } = S;
    const legacy = (video) => `https://i.ytimg.com/vi/${video.youtubeVideoId}/hqdefault.jpg`;
    const own = (video) => `/api/thumbs/${video.youtubeVideoId}.jpg`;
    // History written before v1.5 holds the YouTube URL.
    await seedProgress(page, { [v.s1e2.youtubeVideoId]: { ...started(v.s1e2, Date.now() - 120_000), thumb: legacy(v.s1e2) } });

    await test.step("Home's “Continuar assistindo” loads the same-origin copy", async () => {
      await page.goto("/");
      const row = page.getByRole("region", { name: "Continuar assistindo" });
      const img = row.locator(`img[src="${own(v.s1e2)}"]`);
      await expect(img).toBeVisible();
      await expect.poll(() => img.evaluate((el) => (el.complete ? el.naturalWidth : 0))).toBe(FAKE_THUMB_WIDTH);
      await expect(row.locator('img[src*="ytimg"]')).toHaveCount(0);
    });

    await test.step("an imported legacy thumb is stored as /api/thumbs/<id>.jpg; a look-alike host is dropped", async () => {
      await page.goto("/account");
      await page.getByLabel("Importar histórico").setInputFiles({
        name: "old.json",
        mimeType: "application/json",
        buffer: Buffer.from(
          JSON.stringify({
            version: 1,
            entries: {
              [v.ch1.youtubeVideoId]: { ...started(v.ch1, Date.now() - 60_000), thumb: legacy(v.ch1) },
              [v.ch2.youtubeVideoId]: { ...started(v.ch2, Date.now() - 60_000), thumb: `https://i.ytimg.com.evil.example/vi/${v.ch2.youtubeVideoId}/hqdefault.jpg` },
            },
          })
        ),
      });
      await expect(page.getByRole("status").filter({ hasText: /Importados:/ })).toHaveText("Importados: 2. Ignorados: 0.");
      const stored = await readProgress(page);
      expect(stored[v.ch1.youtubeVideoId].thumb).toBe(own(v.ch1));
      expect(stored[v.ch2.youtubeVideoId].thumb).toBeNull();
    });

    expect(externalRequests, "no request to i.ytimg.com or any other host").toEqual([]);
  });

  test("axe: /account with history (logged out)", async ({ page }) => {
    await seedProgress(page, { [S.v.s1e1.youtubeVideoId]: done(S.v.s1e1, 1_000) });
    await page.goto("/account");
    await expect(exportButton(page)).toBeEnabled();
    await importInput(page).setInputFiles(file("x.json", "nope"));
    await expect(status(page)).toHaveText(/Nada foi importado/);
    await expectNoSeriousViolations(page, "/account");
  });
});
