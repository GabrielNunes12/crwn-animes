// Journey 8 (API v1.4): the admin series board, the 7-day trash and the draft preview.
//
//   - /admin/series/:id: reorder a season by keyboard (Alt+↑/↓), by the row buttons and by
//     dragging the ⠿ handle; "Salvar ordem" renumbers 1..n, which the public series page and
//     the episode routes follow, and ratings stay with their video; leaving with unsaved
//     changes asks first; "Descartar". A stale board's save is refused (expected order → 409) and
//     local watch progress follows the video, not its old episode number.
//   - DELETE is a soft delete: trashed items vanish from every public surface (series page,
//     episode route, search, sitemap, aggregates) but wait in the "Lixeira" tab for 7 days with
//     their ratings; "Restaurar" brings them back; "Apagar para sempre" removes them for good;
//     re-adding a trashed YouTube video says "Na lixeira — restaure-o".
//   - /admin/preview/:id: an admin-only, noindex view of a draft (pending) video.
//
// Every test seeds its own series (unique name/slug), so the file is safe in parallel and
// under --repeat-each against one server. Public pages are always checked from a FRESH
// visitor context: catalog responses are cached by the browser for 60 s by design
// (Cache-Control: public, max-age=60), so a context that saw a page before a change may
// legitimately keep showing it for a minute.
import {
  test,
  expect,
  ADMIN_STATE,
  API_ORIGIN,
  createUser,
  expectNoSeriousViolations,
  fakeYouTubeId,
  listAll,
  newGuardedContext,
  seedSeries,
  uniqueEmail,
} from "./fixtures.js";

test.use({ storageState: ADMIN_STATE });

const tagOf = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * A fresh series with videos placed explicitly: spec = [[key, section, season, number]].
 * Each video's title is "<series name> <key>". Returns { name, slug, id, v: { key: video } }.
 */
async function seedBoardSeries(admin, prefix, spec) {
  const tag = tagOf();
  const series = { name: `${prefix} ${tag}`, slug: `${prefix.toLowerCase()}-${tag}`, aliases: [], genres: [] };
  const { series: created, videos } = await seedSeries(
    admin,
    series,
    spec.map(([key, section, season, number]) => ({ youtubeId: fakeYouTubeId("bd"), title: `${series.name} ${key}`, section, season, number }))
  );
  return { ...series, id: created.id, v: Object.fromEntries(spec.map(([key], i) => [key, videos[i]])) };
}

/**
 * An anonymous browser context with the network guard. The storage state is set explicitly:
 * contexts made with browser.newContext() inside a test pick up the test's `use` options, here
 * the shared admin session — and logging another account in from a context that carries the
 * admin's sid would rotate (kill) that shared session.
 */
const anonymousContext = (browser, baseURL) => newGuardedContext(browser, { baseURL, storageState: { cookies: [], origins: [] } });

/** A verified user in its own browser context (with the network guard), who rates videos through the API. */
async function newFan(browser, baseURL) {
  const context = await anonymousContext(browser, baseURL);
  await createUser(context.request, { email: uniqueEmail("fan"), displayName: "Fã do Quadro" });
  const rate = async (video, score, reaction = null) => {
    const res = await context.request.put(`/api/videos/${video.id}/rating`, { data: { score, reaction } });
    expect(res.status(), `rate ${video.title}`).toBe(200);
  };
  return { context, rate };
}

/** Runs fn(page) on `path` in a brand-new anonymous context (no HTTP cache from earlier visits). */
async function asVisitor(browser, baseURL, path, fn) {
  const context = await anonymousContext(browser, baseURL);
  try {
    const page = await context.newPage();
    await page.goto(path);
    await fn(page);
  } finally {
    await context.close();
  }
}

const notFoundHeading = (page) => page.getByRole("heading", { level: 1, name: "Página não encontrada" });

/** The sitemap's <loc> URLs (straight from the API origin: no browser cache). */
async function sitemapLocs(request) {
  const res = await request.get(`${API_ORIGIN}/sitemap.xml`);
  expect(res.status()).toBe(200);
  return [...(await res.text()).matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
}

/** The public search result of a series (anime section), or undefined. */
async function searchItem(request, S) {
  const res = await request.get(`/api/search?q=${encodeURIComponent(S.name)}&section=anime`);
  expect(res.status()).toBe(200);
  return (await res.json()).items.find((i) => i.slug === S.slug);
}

// ---- board locators -------------------------------------------------------------------
const boardRows = (page) => page.getByRole("listitem", { name: /^(Episódio|Capítulo) \d+ — Posição \d+$/ });
const boardRow = (page, n, position) => page.getByRole("listitem", { name: `Episódio ${n} — Posição ${position}`, exact: true });
const announcer = (page) => page.getByTestId("board-announcer");
const seasonTab = (page, n) => page.getByRole("tablist", { name: "Temporadas" }).getByRole("tab", { name: new RegExp(`^Temporada ${n}\\b`) });
const dirtyNote = (page) => page.getByText("Ordem alterada e ainda não salva.", { exact: true });

/** rows = [[key, episode number]] in display order; checks titles and accessible names. */
async function expectRows(page, rows) {
  await expect(boardRows(page)).toHaveText(rows.map(([key]) => new RegExp(`\\b${key}\\b`)));
  for (const [i, [, n]] of rows.entries()) {
    await expect(boardRows(page).nth(i)).toHaveAccessibleName(`Episódio ${n} — Posição ${i + 1}`);
  }
}

/** Presses the ⠿ handle of `row` and moves the pointer to the top edge of `target` (pointer stays down). */
async function startDrag(page, row, target) {
  const handle = row.getByTitle(/^Arraste pela alça/);
  const from = await handle.boundingBox();
  const to = await target.boundingBox();
  const viewport = page.viewportSize();
  // The board auto-scrolls while the pointer is within 64 px of the viewport's edges: stay clear of them.
  for (const y of [from.y, to.y]) expect(y > 80 && y < viewport.height - 80, `drag point ${y} is clear of the auto-scroll edges`).toBe(true);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, to.y + 4, { steps: 12 });
}

/** The board's season list as the API has it: [[title key, number]] in order. */
async function apiSeason(admin, S, season) {
  const board = await (await admin.get(`/api/admin/series/${S.id}`)).json();
  return board.sections.anime.videos.filter((v) => v.season === season).map((v) => [v.title.slice(S.name.length + 1), v.number]);
}

test.describe("series board", () => {
  // Tall enough that the whole season fits: the drag never starts near an auto-scroll edge.
  test.use({ viewport: { width: 1280, height: 1400 } });

  test("reorder by Alt+↑/↓, the row buttons and a mouse drag; Save renumbers the public pages; ratings stay with their video; leave dialog; Discard", async ({
    page,
    admin,
    browser,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const S = await seedBoardSeries(admin, "Quadro", [
      ["Alpha", "anime", 1, 1],
      ["Bravo", "anime", 1, 2],
      ["Charlie", "anime", 1, 3],
      ["Delta", "anime", 1, 4],
      ["Echo", "anime", 1, 5],
      ["Foxtrot", "anime", 2, 1],
      ["Golf", "anime", 2, 2],
      ["Hotel", "anime", 2, 3],
    ]);
    const fan = await newFan(browser, baseURL);

    await test.step("a fan rates Echo (S1 E5) 4★ + 🔥 and Alpha (S1 E1) 2★ before the reorder", async () => {
      await fan.rate(S.v.Echo, 4, "fire");
      await fan.rate(S.v.Alpha, 2);
    });

    await test.step("open the board from the Séries tab (“Abrir quadro”)", async () => {
      await page.goto("/admin");
      const panel = page.getByRole("tabpanel");
      await panel.getByRole("searchbox", { name: "Buscar séries" }).fill(S.name);
      await expect(panel.locator('p.hint[aria-live="polite"]')).toHaveText(`1 resultado para “${S.name}”`);
      await panel.getByRole("listitem").filter({ hasText: S.slug }).getByRole("link", { name: "Abrir quadro" }).click();
      await expect(page).toHaveURL(new RegExp(`/admin/series/${S.id}(\\?|$)`));
      await expect(page.getByRole("heading", { level: 1, name: S.name })).toBeVisible();
      await expect(page).toHaveTitle(new RegExp(`Quadro: ${S.name}`));
      const sectionGroup = page.getByRole("group", { name: "Seção" });
      await expect(sectionGroup.getByRole("button", { name: "Anime" })).toHaveAttribute("aria-pressed", "true");
      await expect(sectionGroup.getByRole("button", { name: "Mangá" })).toBeDisabled(); // no chapters published
      await expect(page.getByRole("tablist", { name: "Temporadas" }).getByRole("tab")).toHaveText(["Temporada 1", "Temporada 2"]);
      await expect(seasonTab(page, 1)).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("heading", { level: 2, name: "Temporada 1 · 5 episódios" })).toBeVisible();
      await expectRows(page, [["Alpha", 1], ["Bravo", 2], ["Charlie", 3], ["Delta", 4], ["Echo", 5]]);
      await expect(dirtyNote(page)).toHaveCount(0);
    });

    await test.step("keyboard: Alt+↑ twice moves Echo to position 3, focus stays on its row; Alt+↓ moves Alpha down", async () => {
      await boardRow(page, 5, 5).focus();
      await page.keyboard.press("Alt+ArrowUp");
      await expect(boardRow(page, 5, 4)).toBeFocused();
      await expect(announcer(page)).toContainText("Episódio 5 movido para a posição 4 de 5");
      await page.keyboard.press("Alt+ArrowUp");
      await expect(boardRow(page, 5, 3)).toBeFocused();
      await expect(announcer(page)).toContainText("Episódio 5 movido para a posição 3 de 5");

      await boardRow(page, 1, 1).focus();
      await page.keyboard.press("Alt+ArrowDown");
      await expect(boardRow(page, 1, 2)).toBeFocused();
      await expect(announcer(page)).toContainText("Episódio 1 movido para a posição 2 de 5");
      await expectRows(page, [["Bravo", 2], ["Alpha", 1], ["Echo", 5], ["Charlie", 3], ["Delta", 4]]);
      // Unsaved: the toolbar says so, and the season tab and the section button carry the mark.
      await expect(dirtyNote(page)).toBeVisible();
      await expect(seasonTab(page, 1)).toHaveAccessibleName("Temporada 1 (alterações não salvas)");
      await expect(page.getByRole("group", { name: "Seção" }).getByRole("button", { name: /^Anime/ })).toHaveAccessibleName("Anime (alterações não salvas)");
    });

    await test.step("buttons: the ones at the edges are aria-disabled; “Mover para cima” moves Delta up and keeps focus on that button", async () => {
      await expect(boardRow(page, 2, 1).getByRole("button", { name: "Mover para cima" })).toHaveAttribute("aria-disabled", "true");
      await expect(boardRow(page, 4, 5).getByRole("button", { name: "Mover para baixo" })).toHaveAttribute("aria-disabled", "true");
      await boardRow(page, 4, 5).getByRole("button", { name: "Mover para cima" }).click();
      await expect(boardRow(page, 4, 4).getByRole("button", { name: "Mover para cima" })).toBeFocused();
      await expect(announcer(page)).toContainText("Episódio 4 movido para a posição 4 de 5");
      await expectRows(page, [["Bravo", 2], ["Alpha", 1], ["Echo", 5], ["Delta", 4], ["Charlie", 3]]);
    });

    await test.step("mouse: a drag cancelled with Escape puts the row back", async () => {
      await startDrag(page, boardRow(page, 3, 5), boardRows(page).first());
      await expect(boardRows(page).first()).toContainText("Charlie"); // follows the pointer while dragging
      await page.keyboard.press("Escape");
      await page.mouse.up();
      await expect(announcer(page)).toContainText("Movimento cancelado. Episódio 3 voltou para a posição 5 de 5");
      await expectRows(page, [["Bravo", 2], ["Alpha", 1], ["Echo", 5], ["Delta", 4], ["Charlie", 3]]);
    });

    await test.step("mouse: drag Delta by its ⠿ handle to the top", async () => {
      await startDrag(page, boardRow(page, 4, 4), boardRows(page).first());
      await page.mouse.up();
      await expect(announcer(page)).toContainText("Episódio 4 movido para a posição 1 de 5");
      await expect(boardRow(page, 4, 1)).toBeFocused();
      await expectRows(page, [["Delta", 4], ["Bravo", 2], ["Alpha", 1], ["Echo", 5], ["Charlie", 3]]);
    });

    await test.step("axe: the board (with unsaved changes) has no serious/critical violations", async () => {
      await expectNoSeriousViolations(page, "series board");
    });

    await test.step("leaving with unsaved changes asks first; Cancelar stays on the board with the order intact", async () => {
      await page.getByRole("link", { name: "Voltar ao admin" }).click();
      const leave = page.getByRole("dialog", { name: "Sair sem salvar a ordem?" });
      await expect(leave).toBeVisible();
      await expect(leave).toContainText("A nova ordem ainda não foi salva e será perdida.");
      await leave.getByRole("button", { name: "Cancelar" }).click();
      await expect(leave).toBeHidden();
      await expect(page).toHaveURL(new RegExp(`/admin/series/${S.id}(\\?|$)`));
      await expectRows(page, [["Delta", 4], ["Bravo", 2], ["Alpha", 1], ["Echo", 5], ["Charlie", 3]]);
      expect(await apiSeason(admin, S, 1), "nothing is saved before “Salvar ordem”").toEqual([["Alpha", 1], ["Bravo", 2], ["Charlie", 3], ["Delta", 4], ["Echo", 5]]);
    });

    await test.step("Salvar ordem → numbered 1..5 in the new order, also after a reload", async () => {
      await page.getByRole("button", { name: "Salvar ordem" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Ordem salva" })).toHaveText("Ordem salva: numerados de 1 a 5.");
      const saved = [["Delta", 1], ["Bravo", 2], ["Alpha", 3], ["Echo", 4], ["Charlie", 5]];
      await expectRows(page, saved);
      await expect(dirtyNote(page)).toHaveCount(0);
      await expect(seasonTab(page, 1)).toHaveAccessibleName("Temporada 1");
      expect(await apiSeason(admin, S, 1)).toEqual(saved);
      expect(await apiSeason(admin, S, 2), "season 2 is untouched").toEqual([["Foxtrot", 1], ["Golf", 2], ["Hotel", 3]]);
      await page.reload(); // no unsaved changes: no beforeunload prompt
      await expectRows(page, saved);
    });

    await test.step("the public series page and episode routes follow the new numbers", async () => {
      await asVisitor(browser, baseURL, `/anime/${S.slug}`, async (p) => {
        await expect(p.getByRole("heading", { level: 1, name: S.name })).toBeVisible();
        const episodes = p.getByRole("region", { name: "Temporada 1" }).getByRole("listitem");
        await expect(episodes).toHaveText([/^Episódio 1(?!\d).*Delta/, /^Episódio 2(?!\d).*Bravo/, /^Episódio 3(?!\d).*Alpha/, /^Episódio 4(?!\d).*Echo/, /^Episódio 5(?!\d).*Charlie/]);
        await expect(episodes.nth(3).getByRole("link")).toHaveAttribute("href", `/anime/${S.slug}/episode/4`);
        for (const [n, key] of [[1, "Delta"], [3, "Alpha"], [4, "Echo"], [5, "Charlie"]]) {
          await p.goto(`/anime/${S.slug}/episode/${n}`);
          const h1 = p.getByRole("heading", { level: 1, name: `Episódio ${n}`, exact: true });
          await expect(h1).toBeVisible();
          await expect(h1.locator("xpath=following-sibling::p[1]")).toHaveText(`${S.name} ${key}`);
        }
        await p.goto(`/anime/${S.slug}/season/2/episode/1`);
        await expect(p.getByRole("heading", { level: 1, name: "Temporada 2 · Episódio 1" })).toBeVisible();
        await expect(p.getByRole("heading", { level: 1 }).locator("xpath=following-sibling::p[1]")).toHaveText(`${S.name} Foxtrot`);
      });
      const res = await page.request.get(`${API_ORIGIN}/api/anime/series/${S.slug}?season=1`);
      expect((await res.json()).videos.map((v) => [v.id, v.number, v.route])).toEqual([
        [S.v.Delta.id, 1, `/anime/${S.slug}/episode/1`],
        [S.v.Bravo.id, 2, `/anime/${S.slug}/episode/2`],
        [S.v.Alpha.id, 3, `/anime/${S.slug}/episode/3`],
        [S.v.Echo.id, 4, `/anime/${S.slug}/episode/4`],
        [S.v.Charlie.id, 5, `/anime/${S.slug}/episode/5`],
      ]);
    });

    await test.step("ratings stayed with their video: Echo (now E4) is 4★ + 🔥, Alpha (now E3) 2★, Charlie (now E5) unrated", async () => {
      const p = await fan.context.newPage();
      const stars = (n) => p.getByRole("radio", { name: n === 1 ? "1 estrela" : `${n} estrelas`, exact: true });
      await p.goto(`/anime/${S.slug}/episode/4`);
      await expect(p.getByRole("heading", { level: 1, name: "Episódio 4", exact: true })).toBeVisible();
      await expect(stars(4)).toBeChecked();
      await expect(p.getByRole("button", { name: /Fogo/ })).toHaveAttribute("aria-pressed", "true");
      await p.goto(`/anime/${S.slug}/episode/3`);
      await expect(p.getByRole("heading", { level: 1, name: "Episódio 3", exact: true })).toBeVisible();
      await expect(stars(2)).toBeChecked();
      await p.goto(`/anime/${S.slug}/episode/5`);
      await expect(p.getByRole("heading", { level: 1, name: "Episódio 5", exact: true })).toBeVisible();
      await expect(stars(1)).toBeVisible();
      await expect(p.getByRole("radio", { checked: true })).toHaveCount(0);
      for (const [video, summary] of [
        [S.v.Echo, { average: 4, count: 1 }],
        [S.v.Alpha, { average: 2, count: 1 }],
        [S.v.Charlie, { average: null, count: 0 }],
      ]) {
        expect(await (await page.request.get(`${API_ORIGIN}/api/videos/${video.id}/rating`)).json(), video.title).toMatchObject(summary);
      }
      await fan.context.close();
    });

    await test.step("season 2: “Mover para baixo” + Alt+↑, then Descartar restores the saved order", async () => {
      await seasonTab(page, 2).click();
      await expect(page).toHaveURL(/[?&]season=2\b/);
      await expect(page.getByRole("heading", { level: 2, name: "Temporada 2 · 3 episódios" })).toBeVisible();
      await expectRows(page, [["Foxtrot", 1], ["Golf", 2], ["Hotel", 3]]);
      await boardRow(page, 1, 1).getByRole("button", { name: "Mover para baixo" }).click();
      await expect(boardRow(page, 1, 2).getByRole("button", { name: "Mover para baixo" })).toBeFocused();
      await boardRow(page, 3, 3).focus();
      await page.keyboard.press("Alt+ArrowUp");
      await expectRows(page, [["Golf", 2], ["Hotel", 3], ["Foxtrot", 1]]);
      await expect(seasonTab(page, 2)).toHaveAccessibleName("Temporada 2 (alterações não salvas)");
      await expect(seasonTab(page, 1)).toHaveAccessibleName("Temporada 1");

      await page.getByRole("button", { name: "Descartar" }).click();
      await expect(page.getByRole("status").filter({ hasText: "descartadas" })).toHaveText("Alterações descartadas.");
      await expectRows(page, [["Foxtrot", 1], ["Golf", 2], ["Hotel", 3]]);
      await expect(dirtyNote(page)).toHaveCount(0);
      await expect(seasonTab(page, 2)).toHaveAccessibleName("Temporada 2");
    });

    await test.step("an unsaved draft survives switching seasons; “Sair sem salvar” leaves and saves nothing", async () => {
      await boardRow(page, 3, 3).getByRole("button", { name: "Mover para cima" }).click();
      await expectRows(page, [["Foxtrot", 1], ["Hotel", 3], ["Golf", 2]]);
      await seasonTab(page, 1).click();
      await expectRows(page, [["Delta", 1], ["Bravo", 2], ["Alpha", 3], ["Echo", 4], ["Charlie", 5]]);
      await seasonTab(page, 2).click();
      await expectRows(page, [["Foxtrot", 1], ["Hotel", 3], ["Golf", 2]]);

      await page.getByRole("link", { name: "Voltar ao admin" }).click();
      const leave = page.getByRole("dialog", { name: "Sair sem salvar a ordem?" });
      await expect(leave).toBeVisible();
      await leave.getByRole("button", { name: "Sair sem salvar" }).click();
      await expect(page).toHaveURL(/\/admin\?tab=series$/);
      await expect(page.getByRole("heading", { level: 1, name: "Admin" })).toBeVisible();
      expect(await apiSeason(admin, S, 2)).toEqual([["Foxtrot", 1], ["Golf", 2], ["Hotel", 3]]);
    });
  });

  test("a stale board cannot overwrite an order saved meanwhile (expected order → 409 CONFLICT)", async ({ page, context, admin }) => {
    const S = await seedBoardSeries(admin, "Conflito", [
      ["Ana", "anime", 1, 1],
      ["Bia", "anime", 1, 2],
      ["Caio", "anime", 1, 3],
    ]);
    const ids = (...keys) => keys.map((k) => S.v[k].id);
    const putOrder = (videoIds, expected) => admin.put(`/api/admin/series/${S.id}/order`, { data: { section: "anime", season: 1, videoIds, expected } });

    await test.step("API: a wrong `expected` → 409 with the current order, nothing changes; the right one → 200", async () => {
      const stale = await putOrder(ids("Caio", "Bia", "Ana"), ids("Bia", "Ana", "Caio"));
      expect(stale.status()).toBe(409);
      const { error } = await stale.json();
      expect(error.code).toBe("CONFLICT");
      expect(error.details.current).toEqual(ids("Ana", "Bia", "Caio"));
      expect(await apiSeason(admin, S, 1)).toEqual([["Ana", 1], ["Bia", 2], ["Caio", 3]]);
      // Same order as now: a no-op that succeeds.
      expect((await putOrder(ids("Ana", "Bia", "Caio"), ids("Ana", "Bia", "Caio"))).status()).toBe(200);
    });

    await test.step("UI: two tabs load the board; tab 1 saves first; tab 2's save is refused, keeps its draft, and only a second, informed save wins", async () => {
      const second = await context.newPage();
      for (const p of [page, second]) {
        await p.goto(`/admin/series/${S.id}`);
        await expectRows(p, [["Ana", 1], ["Bia", 2], ["Caio", 3]]);
      }
      await boardRow(page, 3, 3).focus();
      await page.keyboard.press("Alt+ArrowUp");
      await page.keyboard.press("Alt+ArrowUp");
      await expectRows(page, [["Caio", 3], ["Ana", 1], ["Bia", 2]]);
      await page.getByRole("button", { name: "Salvar ordem" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Ordem salva" })).toBeVisible();
      expect(await apiSeason(admin, S, 1)).toEqual([["Caio", 1], ["Ana", 2], ["Bia", 3]]);

      await boardRow(second, 1, 1).getByRole("button", { name: "Mover para baixo" }).click();
      await expectRows(second, [["Bia", 2], ["Ana", 1], ["Caio", 3]]);
      const isReorder = (r) => r.request().method() === "PUT" && new URL(r.url()).pathname === `/api/admin/series/${S.id}/order`;
      const [res] = await Promise.all([second.waitForResponse(isReorder), second.getByRole("button", { name: "Salvar ordem" }).click()]);
      expect(res.status(), "the stale tab's save is refused").toBe(409);
      await expect(second.getByRole("status").filter({ hasText: "Outro administrador" })).toHaveText(
        "Outro administrador salvou uma ordem diferente — confira e salve de novo."
      );
      expect(await apiSeason(admin, S, 1), "tab 1's order is kept").toEqual([["Caio", 1], ["Ana", 2], ["Bia", 3]]);
      // The board reloaded (labels show the numbers tab 1 saved) and kept tab 2's order as an unsaved draft.
      await expectRows(second, [["Bia", 3], ["Ana", 2], ["Caio", 1]]);
      await expect(dirtyNote(second)).toBeVisible();
      // Saving again, now knowing the current order, is accepted.
      await second.getByRole("button", { name: "Salvar ordem" }).click();
      await expect(second.getByRole("status").filter({ hasText: "Ordem salva" })).toBeVisible();
      await expectRows(second, [["Bia", 1], ["Ana", 2], ["Caio", 3]]);
      expect(await apiSeason(admin, S, 1)).toEqual([["Bia", 1], ["Ana", 2], ["Caio", 3]]);
      await second.close();
    });
  });

  test("local watch progress follows the video, not the episode number, after a reorder", async ({ admin, browser, baseURL }) => {
    // Progress is stored per YouTube ID together with the route it was watched at. After a reorder that
    // old route belongs to another video: it must not mark that one as watched (cycle 4 review fix).
    const KEY = "crwn:progress:v1";
    const S = await seedBoardSeries(admin, "Marcado", [
      ["Ana", "anime", 1, 1],
      ["Bia", "anime", 1, 2],
      ["Caio", "anime", 1, 3],
    ]);
    const ana = S.v.Ana;
    expect(ana.route).toBe(`/anime/${S.slug}/episode/1`);
    // Ana finished, saved while she was Episódio 1.
    const progress = { [ana.youtubeVideoId]: { t: 100, d: 100, at: Date.now() - 60_000, route: ana.route, title: ana.title, thumb: null } };

    /** The series page in a fresh context whose localStorage holds `progress` (written once, before the app boots). */
    const withProgress = async (fn) => {
      const context = await anonymousContext(browser, baseURL);
      await context.addInitScript(
        ([key, value]) => {
          if (sessionStorage.getItem("e2e:progress-seeded")) return;
          localStorage.setItem(key, value);
          sessionStorage.setItem("e2e:progress-seeded", "1");
        },
        [KEY, JSON.stringify(progress)]
      );
      try {
        const page = await context.newPage();
        await page.goto(`/anime/${S.slug}`);
        await expect(page.getByRole("heading", { level: 1, name: S.name })).toBeVisible();
        await fn(page, page.getByRole("region", { name: "Episódios" }).getByRole("listitem"), page.getByRole("link", { name: /Continuar:/ }));
      } finally {
        await context.close();
      }
    };

    await test.step("before: Ana (Episódio 1) is watched; Continuar → Episódio 2 (Bia)", async () => {
      await withProgress(async (page, episodes, continueLink) => {
        await expect(page.getByText("1 de 3 assistidos", { exact: true })).toBeVisible();
        await expect(episodes.nth(0)).toContainText("Assistido");
        await expect(episodes.nth(1)).not.toContainText("Assistido");
        await expect(continueLink).toHaveText(/Continuar: Episódio 2$/);
        await expect(continueLink).toHaveAttribute("href", `/anime/${S.slug}/episode/2`);
      });
    });

    await test.step("reorder to [Bia, Ana, Caio] (API, with `expected`)", async () => {
      const res = await admin.put(`/api/admin/series/${S.id}/order`, {
        data: { section: "anime", season: 1, videoIds: [S.v.Bia.id, ana.id, S.v.Caio.id], expected: [ana.id, S.v.Bia.id, S.v.Caio.id] },
      });
      expect(res.status()).toBe(200);
    });

    await test.step("after: only Ana (now Episódio 2) is watched; Continuar → Episódio 1 (Bia); the stored route follows Ana", async () => {
      await withProgress(async (page, episodes, continueLink) => {
        await expect(episodes).toHaveText([/^Episódio 1(?!\d).*Bia/, /^Episódio 2(?!\d).*Ana/, /^Episódio 3(?!\d).*Caio/]);
        await expect(page.getByText("1 de 3 assistidos", { exact: true })).toBeVisible();
        await expect(episodes.nth(0), "Bia was never watched").not.toContainText("Assistido");
        await expect(episodes.nth(1)).toContainText("Assistido");
        await expect(episodes.nth(2)).not.toContainText("Assistido");
        await expect(continueLink).toHaveText(/Continuar: Episódio 1$/);
        await expect(continueLink).toHaveAttribute("href", `/anime/${S.slug}/episode/1`);
        await expect
          .poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}"), KEY).then((all) => all[ana.youtubeVideoId]?.route))
          .toBe(`/anime/${S.slug}/episode/2`);
      });
    });
  });
});

test.describe("trash (Lixeira)", () => {
  test("an episode trashed from the board leaves the series page, its route, search and the sitemap; Lixeira lists it (7 days); Restaurar brings it back with its rating", async ({
    page,
    admin,
    browser,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const S = await seedBoardSeries(admin, "Lixo", [
      ["Um", "anime", 1, 1],
      ["Dois", "anime", 1, 2],
      ["Tres", "anime", 1, 3],
    ]);
    const dois = S.v.Dois;
    const title = dois.title;
    const route = `/anime/${S.slug}/episode/2`;
    const fan = await newFan(browser, baseURL);
    await fan.rate(dois, 5, "love");
    const exportedRating = async () => {
      const data = await (await fan.context.request.get("/api/me/export")).json();
      return data.ratings.find((r) => r.videoId === dois.id) ?? null;
    };

    await test.step("before: the episode is public, in the sitemap and counted (3 episodes, 1 rating) in search", async () => {
      expect(await sitemapLocs(page.request)).toContain(`${baseURL}${route}`);
      expect(await searchItem(page.request, S)).toMatchObject({ videoCount: 3, rating: { average: 5, count: 1 } });
      expect(await exportedRating()).toMatchObject({ route, score: 5 });
    });

    await test.step("board: “Mover para a lixeira” on Episódio 2 → confirm → gone from the list, focus on the next row", async () => {
      await page.goto(`/admin/series/${S.id}`);
      await expectRows(page, [["Um", 1], ["Dois", 2], ["Tres", 3]]);
      await boardRow(page, 2, 2).getByRole("button", { name: "Mover para a lixeira" }).click();
      const dialog = page.getByRole("dialog", { name: "Mover este vídeo para a lixeira?" });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(`“${title}” sai do site agora e fica 7 dias na lixeira`);
      await dialog.getByRole("button", { name: "Mover para a lixeira" }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByRole("status").filter({ hasText: "lixeira" })).toHaveText(`${title} foi para a lixeira.`);
      await expectRows(page, [["Um", 1], ["Tres", 3]]);
      await expect(boardRow(page, 3, 2)).toBeFocused();
    });

    await test.step("public: not on the series page, its route is a 404, search counts 2 episodes and no rating, not in the sitemap", async () => {
      await asVisitor(browser, baseURL, `/anime/${S.slug}`, async (p) => {
        const episodes = p.getByRole("region", { name: "Episódios" }).getByRole("listitem");
        await expect(episodes).toHaveText([/^Episódio 1(?!\d).*Um/, /^Episódio 3(?!\d).*Tres/]);
        await p.goto(route);
        await expect(notFoundHeading(p)).toBeVisible();
        await p.goto(`/search?q=${encodeURIComponent(S.name)}`);
        await expect(p.locator("[data-result]").filter({ hasText: S.name })).toContainText("2 episódios");
      });
      expect((await page.request.get(`${API_ORIGIN}${route}`)).status(), "the server answers 404 for the trashed episode's page").toBe(404);
      expect((await page.request.get(`${API_ORIGIN}/api/videos/${dois.id}`)).status()).toBe(404);
      expect((await fan.context.request.put(`/api/videos/${dois.id}/rating`, { data: { score: 1 } })).status(), "a trashed video cannot be rated").toBe(404);
      expect(await searchItem(page.request, S)).toMatchObject({ videoCount: 2, rating: { count: 0 } });
      const locs = await sitemapLocs(page.request);
      expect(locs).not.toContain(`${baseURL}${route}`);
      expect(locs).toContain(`${baseURL}/anime/${S.slug}/episode/3`);
      // The fan's data export still lists the rating (kept for 7 days), without a page.
      expect(await exportedRating()).toMatchObject({ route: null, score: 5 });
    });

    await test.step("Lixeira lists it with “Apagado em 7 dias”; its preview shows “Na lixeira”", async () => {
      await page.goto("/admin");
      await page.getByRole("tab", { name: "Lixeira", exact: true }).click();
      const panel = page.getByRole("tabpanel");
      await expect(panel.getByRole("heading", { level: 2, name: "Lixeira" })).toBeVisible();
      const row = panel.getByRole("listitem").filter({ hasText: title });
      await expect(row).toContainText(`Anime · ${S.name} · Episódio 2`);
      await expect(row).toContainText("Apagado em 7 dias");
      await expectNoSeriousViolations(page, "Lixeira");

      await row.getByRole("link", { name: "Pré-visualizar" }).click();
      await expect(page).toHaveURL(`/admin/preview/${dois.id}`);
      const banner = page.getByRole("region", { name: "Pré-visualização de rascunho" });
      await expect(banner).toContainText("Na lixeira");
      await expect(banner).toContainText("Apagado em 7 dias");
      await banner.getByRole("link", { name: "Ver na Lixeira" }).click();
      await expect(page).toHaveURL(/\/admin\?tab=trash$/);
    });

    await test.step("Restaurar → back on the board, the series page, its route, search and the sitemap, rating included", async () => {
      const panel = page.getByRole("tabpanel");
      const row = panel.getByRole("listitem").filter({ hasText: title });
      await row.getByRole("button", { name: "Restaurar" }).click();
      await expect(panel.getByRole("status").filter({ hasText: "restaurado" })).toHaveText(`“${title}” restaurado.`);
      await expect(row).toHaveCount(0);

      await page.goto(`/admin/series/${S.id}`);
      await expectRows(page, [["Um", 1], ["Dois", 2], ["Tres", 3]]);
      await asVisitor(browser, baseURL, `/anime/${S.slug}`, async (p) => {
        await expect(p.getByRole("region", { name: "Episódios" }).getByRole("listitem")).toHaveText([/^Episódio 1(?!\d).*Um/, /^Episódio 2(?!\d).*Dois/, /^Episódio 3(?!\d).*Tres/]);
        await p.goto(route);
        await expect(p.getByRole("heading", { level: 1, name: "Episódio 2", exact: true })).toBeVisible();
      });
      expect(await sitemapLocs(page.request)).toContain(`${baseURL}${route}`);
      expect(await searchItem(page.request, S)).toMatchObject({ videoCount: 3, rating: { average: 5, count: 1 } });
      expect(await (await page.request.get(`${API_ORIGIN}/api/videos/${dois.id}/rating`)).json()).toMatchObject({ average: 5, count: 1 });
      expect(await exportedRating()).toMatchObject({ route, score: 5 });
    });
    await fan.context.close();
  });

  test("a whole series in the trash: public 404 everywhere, slug reserved, its videos wait with it; Restaurar brings it back with its episodes", async ({
    page,
    admin,
    browser,
    baseURL,
  }) => {
    test.setTimeout(90_000);
    const S = await seedBoardSeries(admin, "Serie", [
      ["Ep1", "anime", 1, 1],
      ["Ep2", "anime", 1, 2],
      ["Cap1", "manga", 1, 1],
    ]);
    const panel = page.getByRole("tabpanel");

    await test.step("Séries tab: “Mover para a lixeira” → confirm", async () => {
      await page.goto("/admin");
      await panel.getByRole("searchbox", { name: "Buscar séries" }).fill(S.name);
      const row = panel.getByRole("listitem").filter({ hasText: S.slug });
      await row.getByRole("button", { name: "Mover para a lixeira" }).click();
      const dialog = page.getByRole("dialog", { name: `Mover ${S.name} para a lixeira?` });
      await expect(dialog).toContainText("ficam 7 dias na lixeira");
      await dialog.getByRole("button", { name: "Mover para a lixeira" }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByRole("status").filter({ hasText: `${S.name} foi para a lixeira.` })).toBeVisible();
      await expect(row).toHaveCount(0);
    });

    await test.step("public: series pages, episode and chapter routes are 404; not in search or the sitemap", async () => {
      await asVisitor(browser, baseURL, `/anime/${S.slug}`, async (p) => {
        await expect(notFoundHeading(p)).toBeVisible();
        await p.goto(`/manga/${S.slug}/chapter/1`);
        await expect(notFoundHeading(p)).toBeVisible();
        await p.goto(`/search?q=${encodeURIComponent(S.name)}`);
        await expect(p.getByText(/^Nada encontrado\./)).toBeVisible();
        await expect(p.locator("[data-result]")).toHaveCount(0);
      });
      for (const path of [`/anime/${S.slug}`, `/manga/${S.slug}`, `/anime/${S.slug}/episode/1`, `/api/anime/series/${S.slug}`, `/api/videos/${S.v.Ep1.id}`]) {
        expect((await page.request.get(`${API_ORIGIN}${path}`)).status(), path).toBe(404);
      }
      expect((await (await page.request.get(`/api/search?q=${encodeURIComponent(S.name)}`)).json()).items).toEqual([]);
      expect((await sitemapLocs(page.request)).filter((l) => l.includes(S.slug))).toEqual([]);
    });

    await test.step("admin: the board says it is in the trash; the slug stays reserved; its videos are not restorable on their own", async () => {
      await page.goto(`/admin/series/${S.id}`);
      await expect(page.getByRole("heading", { level: 1, name: "Série não encontrada ou na lixeira" })).toBeVisible();
      expect((await admin.get(`/api/admin/series/${S.id}`)).status()).toBe(404);
      const again = await admin.post("/api/admin/series", { data: { name: `${S.name} 2`, slug: S.slug } });
      expect(again.status(), "a trashed series' slug stays reserved").toBe(409);
      const alone = await admin.post(`/api/admin/trash/videos/${S.v.Ep1.id}/restore`);
      expect(alone.status(), "a video cannot come back while its series is in the trash").toBe(409);
      expect((await alone.json()).error.code).toBe("CONFLICT");
      expect((await listAll(admin, "/api/admin/videos", { q: S.name })).filter((v) => v.seriesId === S.id)).toEqual([]);
    });

    await test.step("Lixeira: the series with its 3 videos (not listed separately) and “Apagado em 7 dias” → Restaurar", async () => {
      await page.goto("/admin?tab=trash");
      const row = panel.getByRole("listitem").filter({ hasText: S.slug });
      await expect(row).toContainText(S.name);
      await expect(row).toContainText("3 vídeos");
      await expect(row).toContainText("Apagado em 7 dias");
      await expect(panel.getByRole("listitem").filter({ hasText: `${S.name} Ep1` })).toHaveCount(0);
      await row.getByRole("button", { name: "Restaurar" }).click();
      await expect(panel.getByRole("status").filter({ hasText: "restaurada" })).toHaveText(`Série ${S.name} restaurada.`);
      await expect(row).toHaveCount(0);
    });

    await test.step("back: series page with its episodes, the chapter, the board", async () => {
      await asVisitor(browser, baseURL, `/anime/${S.slug}`, async (p) => {
        await expect(p.getByRole("heading", { level: 1, name: S.name })).toBeVisible();
        await expect(p.getByRole("region", { name: "Episódios" }).getByRole("listitem")).toHaveText([/^Episódio 1(?!\d).*Ep1/, /^Episódio 2(?!\d).*Ep2/]);
        await p.goto(`/manga/${S.slug}/chapter/1`);
        await expect(p.getByRole("heading", { level: 1, name: "Capítulo 1", exact: true })).toBeVisible();
      });
      expect((await sitemapLocs(page.request)).filter((l) => l.includes(S.slug)).length).toBeGreaterThanOrEqual(5);
      await page.goto(`/admin/series/${S.id}`);
      await expectRows(page, [["Ep1", 1], ["Ep2", 2]]);
      await page.getByRole("group", { name: "Seção" }).getByRole("button", { name: "Mangá" }).click();
      await expect(boardRows(page)).toHaveCount(1);
      await expect(boardRows(page).first()).toHaveAccessibleName("Capítulo 1 — Posição 1");
      await expect(page.getByRole("tablist", { name: "Temporadas" })).toHaveCount(0); // manga: no seasons
    });
  });

  test("“Apagar para sempre”: a video and a whole series leave the trash and the API for good, ratings included", async ({ page, admin, browser, baseURL }) => {
    test.setTimeout(90_000);
    const S = await seedBoardSeries(admin, "Apagar", [
      ["Fica", "anime", 1, 1],
      ["Vai", "anime", 1, 2],
    ]);
    const T = await seedBoardSeries(admin, "Some", [["Unico", "anime", 1, 1]]);
    const vai = S.v.Vai;
    const fan = await newFan(browser, baseURL);
    await fan.rate(vai, 3);
    await fan.rate(T.v.Unico, 4);
    expect((await admin.delete(`/api/admin/videos/${vai.id}`)).status()).toBe(204);
    expect((await admin.delete(`/api/admin/series/${T.id}`)).status()).toBe(204);
    const panel = page.getByRole("tabpanel");

    await test.step("a video: Cancelar keeps it; confirming deletes it forever", async () => {
      await page.goto("/admin?tab=trash");
      const row = panel.getByRole("listitem").filter({ hasText: vai.title });
      await row.getByRole("button", { name: "Apagar para sempre" }).click();
      const dialog = page.getByRole("dialog", { name: `Apagar “${vai.title}” para sempre?` });
      await expect(dialog).toContainText("O vídeo e todas as avaliações dele serão apagados agora. Isso não pode ser desfeito.");
      await dialog.getByRole("button", { name: "Cancelar" }).click();
      await expect(dialog).toBeHidden();
      await expect(row).toHaveCount(1);

      await row.getByRole("button", { name: "Apagar para sempre" }).click();
      await dialog.getByRole("button", { name: "Apagar para sempre" }).click();
      await expect(dialog).toBeHidden();
      await expect(panel.getByRole("status").filter({ hasText: "para sempre" })).toHaveText(`“${vai.title}” foi apagado para sempre.`);
      await expect(row).toHaveCount(0);
    });

    await test.step("the video is gone from the trash and the API; its rating too; the YouTube video can be added again", async () => {
      const trash = await (await admin.get("/api/admin/trash")).json();
      expect(trash.videos.filter((v) => v.id === vai.id)).toEqual([]);
      expect((await admin.get(`/api/admin/videos/${vai.id}/preview`)).status()).toBe(404);
      expect((await admin.post(`/api/admin/trash/videos/${vai.id}/restore`)).status()).toBe(404);
      expect((await listAll(admin, "/api/admin/videos", { q: S.name })).map((v) => v.id)).toEqual([S.v.Fica.id]);
      const ratings = (await (await fan.context.request.get("/api/me/export")).json()).ratings;
      expect(ratings.filter((r) => r.videoId === vai.id), "the rating was deleted with the video").toEqual([]);
      // Not "restore it instead" (409): nothing of it is left.
      const readd = await admin.post("/api/admin/videos", { data: { url: `https://youtu.be/${vai.youtubeVideoId}`, title: vai.title, section: "anime", seriesSlug: S.slug, number: 2 } });
      expect(readd.status()).toBe(201);
      const fresh = (await readd.json()).video;
      expect(fresh).toMatchObject({ status: "published", route: `/anime/${S.slug}/episode/2` });
      expect(fresh.id).not.toBe(vai.id);
      expect(await (await page.request.get(`${API_ORIGIN}/api/videos/${fresh.id}/rating`)).json()).toMatchObject({ average: null, count: 0 });
    });

    await test.step("a whole series: “Apagar para sempre” → gone with its video and ratings; the slug is free again", async () => {
      await page.goto("/admin?tab=trash");
      const row = panel.getByRole("listitem").filter({ hasText: T.slug });
      await row.getByRole("button", { name: "Apagar para sempre" }).click();
      const dialog = page.getByRole("dialog", { name: `Apagar “${T.name}” para sempre?` });
      await expect(dialog).toContainText(/A série, o 1 vídeo dela (na lixeira )?e todas as avaliações serão apagados agora\./);
      await dialog.getByRole("button", { name: "Apagar para sempre" }).click();
      await expect(dialog).toBeHidden();
      await expect(panel.getByRole("status").filter({ hasText: "para sempre" })).toHaveText(`“${T.name}” foi apagado para sempre.`);
      await expect(row).toHaveCount(0);

      const trash = await (await admin.get("/api/admin/trash")).json();
      expect(trash.series.filter((s) => s.id === T.id)).toEqual([]);
      expect(trash.videos.filter((v) => v.id === T.v.Unico.id)).toEqual([]);
      expect((await admin.get(`/api/admin/videos/${T.v.Unico.id}/preview`)).status()).toBe(404);
      expect((await admin.post(`/api/admin/trash/series/${T.id}/restore`)).status()).toBe(404);
      const ratings = (await (await fan.context.request.get("/api/me/export")).json()).ratings;
      expect(ratings.filter((r) => r.videoId === T.v.Unico.id)).toEqual([]);
      const recreated = await admin.post("/api/admin/series", { data: { name: T.name, slug: T.slug } });
      expect(recreated.status(), "the slug is free once the series is deleted forever").toBe(201);
    });
    await fan.context.close();
  });
});

test.describe("trash (Lixeira): edge cases", () => {
  test("delete forever counts every video of the series, including one trashed on its own before it", async ({ page, admin }) => {
    const S = await seedBoardSeries(admin, "Contagem", [
      ["Um", "anime", 1, 1],
      ["Dois", "anime", 1, 2],
    ]);
    expect((await admin.delete(`/api/admin/videos/${S.v.Dois.id}`)).status()).toBe(204);
    expect((await admin.delete(`/api/admin/series/${S.id}`)).status()).toBe(204);
    const trash = await (await admin.get("/api/admin/trash")).json();
    expect(trash.series.filter((s) => s.id === S.id)).toEqual([expect.objectContaining({ videoCount: 2 })]);
    expect(trash.videos.filter((v) => v.seriesId === S.id).map((v) => v.id), "the episode trashed on its own is listed on its own").toEqual([S.v.Dois.id]);

    await page.goto("/admin?tab=trash");
    const panel = page.getByRole("tabpanel");
    const seriesRow = panel.getByRole("listitem").filter({ hasText: S.slug });
    const videoRow = panel.getByRole("listitem").filter({ hasText: S.v.Dois.title });
    await expect(seriesRow).toContainText("2 vídeos");
    await expect(videoRow).toHaveCount(1);
    await seriesRow.getByRole("button", { name: "Apagar para sempre" }).click();
    const dialog = page.getByRole("dialog", { name: `Apagar “${S.name}” para sempre?` });
    await expect(dialog).toContainText(/A série, os 2 vídeos dela (na lixeira )?e todas as avaliações serão apagados agora\./);
    await dialog.getByRole("button", { name: "Apagar para sempre" }).click();
    await expect(dialog).toBeHidden();
    await expect(seriesRow).toHaveCount(0);
    await expect(videoRow, "the episode trashed on its own went with its series").toHaveCount(0);
    // Matched by slug / YouTube id, not by numeric id: SQLite hands a purged row's id to the next
    // insert (no AUTOINCREMENT), so a series created meanwhile by a parallel test can get S.id.
    const after = await (await admin.get("/api/admin/trash")).json();
    const ours = new Set(Object.values(S.v).map((v) => v.youtubeVideoId));
    expect(after.series.filter((s) => s.slug === S.slug)).toEqual([]);
    expect(after.videos.filter((v) => ours.has(v.youtubeVideoId))).toEqual([]);
  });

  test("re-adding a YouTube video that is in the trash → 409 “restore it instead”, and Adicionar vídeo says “Na lixeira — restaure-o”", async ({ page, admin }) => {
    const S = await seedBoardSeries(admin, "Readd", [["Um", "anime", 1, 1]]);
    const video = S.v.Um;
    expect((await admin.delete(`/api/admin/videos/${video.id}`)).status()).toBe(204);
    const again = await admin.post("/api/admin/videos", { data: { url: `https://youtu.be/${video.youtubeVideoId}`, title: video.title } });
    expect(again.status()).toBe(409);
    expect((await again.json()).error.code).toBe("CONFLICT");

    await page.goto("/admin");
    await page.getByRole("tab", { name: "Adicionar vídeo", exact: true }).click();
    await page.getByLabel("Link ou ID do YouTube").fill(`https://www.youtube.com/watch?v=${video.youtubeVideoId}`);
    await page.getByLabel("Título (opcional)").fill(video.title);
    await page.getByRole("button", { name: "Adicionar vídeo", exact: true }).click();
    const alert = page.getByRole("alert").filter({ hasText: "Na lixeira — restaure-o" });
    await expect(alert).toBeVisible();
    await expect(page.getByText("Publicado — encontrou seu lugar.")).toHaveCount(0);
    // Nothing was added: the video is still only in the trash.
    expect((await listAll(admin, "/api/admin/videos", { q: S.name })).filter((v) => v.id === video.id)).toEqual([]);
    expect((await (await admin.get("/api/admin/trash")).json()).videos.filter((v) => v.id === video.id)).toHaveLength(1);
    // Em lote: the preview says the same for that link.
    await page.getByRole("tab", { name: "Em lote", exact: true }).click();
    await page.getByLabel("Links", { exact: true }).fill(`https://youtu.be/${video.youtubeVideoId}`);
    await page.getByRole("button", { name: "Pré-visualizar", exact: true }).click();
    const bulkRow = page.getByRole("region", { name: "Prévia da importação em lote" }).getByRole("row").filter({ hasText: video.youtubeVideoId });
    await expect(bulkRow).toContainText("Na lixeira — restaure-o.");
    await expect(bulkRow.getByRole("link", { name: "Abrir a Lixeira" })).toHaveAttribute("href", "/admin?tab=trash");

    // The Adicionar vídeo alert leads to the Lixeira, where it can be restored.
    await page.getByRole("tab", { name: "Adicionar vídeo", exact: true }).click();
    await page.getByLabel("Link ou ID do YouTube").fill(video.youtubeVideoId);
    await page.getByLabel("Título (opcional)").fill(video.title);
    await page.getByRole("button", { name: "Adicionar vídeo", exact: true }).click();
    await alert.getByRole("link", { name: "Abrir a Lixeira" }).click();
    await expect(page).toHaveURL(/\/admin\?tab=trash$/);
    const row = page.getByRole("tabpanel").getByRole("listitem").filter({ hasText: video.title });
    await row.getByRole("button", { name: "Restaurar" }).click();
    await expect(row).toHaveCount(0);
    expect((await (await page.request.get(`${API_ORIGIN}/api/videos/${video.id}`)).json()).video.route).toBe(`/anime/${S.slug}/episode/1`);
  });
});

test.describe("draft preview", () => {
  test("a pending video: banner, pending reasons, the player, no rating panel, noindex; normal users and visitors are kept out", async ({
    page,
    admin,
    browser,
    baseURL,
  }) => {
    test.setTimeout(90_000);
    const title = `Rascunho ${tagOf()} sem lugar`;
    const created = await admin.post("/api/admin/videos", { data: { url: `https://youtu.be/${fakeYouTubeId("draft")}`, title } });
    expect(created.status()).toBe(201);
    const video = (await created.json()).video;
    expect(video.status, "the seed video must be pending").toBe("pending");
    expect(video.classification.reasons.length).toBeGreaterThan(0);

    await test.step("Pendentes tab → “Pré-visualizar”", async () => {
      await page.goto("/admin?tab=pending");
      const panel = page.getByRole("tabpanel");
      await panel.getByRole("searchbox", { name: "Buscar vídeos por título ou série" }).fill(title);
      await expect(panel.locator('p.hint[aria-live="polite"]')).toHaveText(`1 resultado para “${title}”`);
      await panel.getByRole("link", { name: "Pré-visualizar" }).click();
      await expect(page).toHaveURL(`/admin/preview/${video.id}`);
    });

    await test.step("banner with status and the pending reasons; the player; no rating panel; no route", async () => {
      const banner = page.getByRole("region", { name: "Pré-visualização de rascunho" });
      await expect(banner).toBeVisible();
      await expect(banner).toContainText("Pendente");
      await expect(banner).toContainText("Só administradores veem esta página. Ela não é indexada e não tem avaliações.");
      await expect(banner).toContainText("Por que está pendente");
      // The reasons as the API has them now (pending videos are re-classified whenever a series is created).
      const { video: now } = await (await admin.get(`/api/admin/videos/${video.id}/preview`)).json();
      expect(now).toMatchObject({ status: "pending", route: null });
      await expect(banner.getByRole("listitem")).toHaveText(now.classification.reasons);
      await expect(banner.getByRole("link", { name: "Voltar para Pendentes" })).toHaveAttribute("href", "/admin?tab=pending");
      await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
      await expect(page.getByRole("button", { name: `Reproduzir: ${title}` })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Avaliações e reações" })).toHaveCount(0);
      await expect(page.getByRole("radio", { name: /estrelas?$/ })).toHaveCount(0);
      await expect(page.getByRole("region", { name: "Detalhes" })).toContainText("Sem rota — não está publicado");
      await expect(page).toHaveTitle(new RegExp(`Pré-visualização: ${title}`));
    });

    await test.step("noindex: in the page head and in the server-rendered HTML", async () => {
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
      const html = await (await page.request.get(`${API_ORIGIN}/admin/preview/${video.id}`)).text();
      expect(html).toMatch(/<meta name="robots" content="noindex"\s*\/?>/);
    });

    await test.step("axe: no serious/critical violations", async () => {
      await expectNoSeriousViolations(page, "draft preview");
    });

    await test.step("a normal user is sent home (“só para administradores”) and gets 403 from the API", async () => {
      const context = await anonymousContext(browser, baseURL);
      await createUser(context.request, { email: uniqueEmail("nopreview"), displayName: "Curioso" });
      const p = await context.newPage();
      await p.goto(`/admin/preview/${video.id}`);
      await expect(p).toHaveURL(`${baseURL}/`);
      await expect(p.getByRole("status").filter({ hasText: "Essa área é só para administradores." })).toBeVisible();
      await expect(p.getByText(title)).toHaveCount(0);
      const res = await context.request.get(`/api/admin/videos/${video.id}/preview`);
      expect(res.status()).toBe(403);
      expect(await res.text()).not.toContain(title);
      expect((await context.request.get(`/api/videos/${video.id}`)).status(), "a pending video is not public").toBe(404);
      await context.close();
    });

    await test.step("a visitor is sent to the login page and gets 401 from the API", async () => {
      await asVisitor(browser, baseURL, `/admin/preview/${video.id}`, async (p) => {
        await expect(p).toHaveURL(`${baseURL}/login?next=${encodeURIComponent(`/admin/preview/${video.id}`)}`);
        await expect(p.getByText(title)).toHaveCount(0);
        expect((await p.request.get(`/api/admin/videos/${video.id}/preview`)).status()).toBe(401);
      });
    });
  });
});
