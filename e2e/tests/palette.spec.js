// Cycle 2: the ⌘K / Ctrl+K quick-search palette ("Busca rápida"): a modal
// dialog holding an ARIA combobox whose suggestions come from /api/search.
import { test, expect, asAdmin, expectNoSeriousViolations, seedSeries } from "./fixtures.js";

// "paleta kaiju" is an exact name match for the first series and a prefix of
// the second, so relevance orders them deterministically.
const EXACT = { name: "Paleta Kaiju", slug: "paleta-kaiju", aliases: [], genres: ["Monstros"] };
const PREFIX = { name: "Paleta Kaiju Zero", slug: "paleta-kaiju-zero", aliases: ["PKZ"], genres: ["Monstros"] };
const QUERY = "paleta kaiju";

test.beforeAll(async ({}, testInfo) => {
  await asAdmin(testInfo, async (admin) => {
    await seedSeries(admin, EXACT, [{ youtubeId: "palKaiju001", title: "Paleta Kaiju episódio 1", section: "anime", number: 1 }]);
    await seedSeries(admin, PREFIX, [{ youtubeId: "palKaiju002", title: "Paleta Kaiju Zero episódio 1", section: "anime", number: 1 }]);
  });
});

const dialog = (page) => page.getByRole("dialog", { name: "Busca rápida" });
const combobox = (page) => dialog(page).getByRole("combobox", { name: "Buscar anime e mangá" });
const options = (page) => dialog(page).getByRole("listbox", { name: "Sugestões" }).getByRole("option");
const trigger = (page) => page.getByRole("banner").getByRole("button", { name: "Busca rápida" });

/** Opens the home page and waits until the app (and its keyboard listener) is up. */
/**
 * toBeFocused(), but on failure the error names the element that actually has focus,
 * so a rare CI failure can be diagnosed from the log alone.
 */
async function expectFocused(page, locator) {
  try {
    await expect(locator).toBeFocused();
  } catch (error) {
    const active = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? `${el.outerHTML.slice(0, 160)} (connected: ${el.isConnected})` : "none";
    });
    error.message += `\nFocused element instead: ${active}`;
    throw error;
  }
}

async function openHome(page) {
  await page.goto("/");
  await expect(trigger(page)).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

/** Types the query and waits for its two suggestions + "see all". */
async function typeQuery(page) {
  await combobox(page).fill(QUERY);
  await expect(dialog(page).getByRole("status")).toHaveText("2 séries encontradas");
  await expect(options(page)).toHaveCount(3);
  await expect(options(page).nth(0)).toContainText("Paleta Kaiju");
  await expect(options(page).nth(0)).not.toContainText("Zero");
  await expect(options(page).nth(1)).toContainText("Paleta Kaiju Zero");
  await expect(options(page).nth(2)).toHaveText(/Ver todos os resultados para “paleta kaiju”/);
}

/** The palette's <dialog> element, open or not (a closed one has no role in the accessibility tree). */
const paletteElement = (page) => page.locator("dialog").filter({ has: page.locator("h2", { hasText: "Busca rápida" }) });

/**
 * Esc, then waits for the dialog's native `close` event, which the browser fires in a later task.
 * The palette still reacts to that event, and one that arrives after the palette was reopened
 * closes it again (app bug, see the test.fail below): waiting for it keeps this race out of the
 * tests that are about something else.
 */
async function escapeAndWaitForClose(page) {
  await paletteElement(page).evaluate((d) => {
    window.__paletteClosed = new Promise((resolve) => d.addEventListener("close", () => resolve(), { once: true }));
  });
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.__paletteClosed);
  await expect(dialog(page)).toBeHidden();
}

test.describe("command palette", () => {
  test("Ctrl+K opens it, typing shows suggestions, ArrowDown + Enter opens the second series", async ({ page }) => {
    await openHome(page);
    await expect(dialog(page)).toBeHidden();

    await page.keyboard.press("Control+k");
    await expect(dialog(page)).toBeVisible();
    await expect(combobox(page)).toBeFocused();
    await expect(combobox(page)).toHaveAttribute("aria-expanded", "false");
    await expect(dialog(page).getByRole("status")).toHaveText("Digite o nome de uma série ou um título alternativo.");

    await typeQuery(page);
    await expect(combobox(page)).toHaveAttribute("aria-expanded", "true");
    // Automatic selection: the first suggestion is active.
    await expect(options(page).nth(0)).toHaveAttribute("aria-selected", "true");
    const firstId = await options(page).nth(0).getAttribute("id");
    await expect(combobox(page)).toHaveAttribute("aria-activedescendant", firstId);

    await page.keyboard.press("ArrowDown");
    await expect(options(page).nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(options(page).nth(0)).toHaveAttribute("aria-selected", "false");
    const secondId = await options(page).nth(1).getAttribute("id");
    await expect(combobox(page)).toHaveAttribute("aria-activedescendant", secondId);
    await expect(combobox(page)).toBeFocused(); // DOM focus never leaves the input

    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/anime\/paleta-kaiju-zero$/);
    await expect(page.getByRole("heading", { level: 1, name: "Paleta Kaiju Zero" })).toBeVisible();
    await expect(dialog(page)).toBeHidden();
  });

  test("Escape closes it and focus returns to what opened it (header button, then the header search box)", async ({ page }) => {
    await openHome(page);

    await test.step("opened with the header button", async () => {
      await trigger(page).click();
      await expect(dialog(page)).toBeVisible();
      await expect(combobox(page)).toBeFocused();
      await combobox(page).fill("pal");
      await escapeAndWaitForClose(page);
      await expectFocused(page, trigger(page));
    });

    await test.step("reopening starts empty", async () => {
      await page.keyboard.press("Control+k");
      await expect(dialog(page)).toBeVisible();
      await expect(combobox(page)).toHaveValue("");
      await expect(options(page)).toHaveCount(0);
      await escapeAndWaitForClose(page);
    });

    await test.step("Ctrl+K works while typing in the header search box, and focus goes back there", async () => {
      const siteSearch = page.getByRole("banner").getByRole("searchbox", { name: "Buscar séries" });
      await siteSearch.click();
      await siteSearch.fill("abc");
      await page.keyboard.press("Control+k");
      await expect(dialog(page)).toBeVisible();
      await expect(combobox(page)).toBeFocused();
      await escapeAndWaitForClose(page);
      await expectFocused(page, siteSearch);
      await expect(siteSearch).toHaveValue("abc");
    });
  });

  test("the last option, “Ver todos os resultados”, opens /search?q=…", async ({ page }) => {
    await openHome(page);
    await page.keyboard.press("Control+k");
    await typeQuery(page);

    await page.keyboard.press("ArrowUp"); // wraps from the first option to the last one
    await expect(options(page).nth(2)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(/\/search\?q=paleta\+kaiju$/);
    await expect(dialog(page)).toBeHidden();
    await expect(page.getByRole("heading", { level: 1, name: "Resultados para “paleta kaiju”" })).toBeVisible();
    await expect(page.locator("[data-result]").getByRole("heading", { level: 3 })).toHaveText(["Paleta Kaiju", "Paleta Kaiju Zero"]);
  });

  test("a click on a suggestion opens that series", async ({ page }) => {
    await openHome(page);
    await trigger(page).click();
    await typeQuery(page);
    await options(page).nth(0).click();
    await expect(page).toHaveURL(/\/anime\/paleta-kaiju$/);
    await expect(page.getByRole("heading", { level: 1, name: "Paleta Kaiju" })).toBeVisible();
    await expect(dialog(page)).toBeHidden();
  });

  test("axe: no serious/critical violations with the palette open (empty and with suggestions)", async ({ page }) => {
    await openHome(page);
    await page.waitForLoadState("networkidle");
    await page.keyboard.press("Control+k");
    await expect(dialog(page)).toBeVisible();
    await expectNoSeriousViolations(page, "palette (empty)");

    await typeQuery(page);
    await page.keyboard.press("ArrowDown");
    await expect(options(page).nth(1)).toHaveAttribute("aria-selected", "true");
    await expectNoSeriousViolations(page, "palette (suggestions)");
  });

  // App bug (client/src/components/CommandPalette/CommandPalette.jsx): closing calls dialog.close(),
  // whose native `close` event the browser fires in a LATER task, and the <dialog>'s
  // onClose={() => open && close()} handler does not check that the dialog is still closed. If
  // Ctrl+K reopens the palette before that event arrives (a fast Esc → Ctrl+K, or simply a busy
  // main thread: it made "Escape closes it…" flaky in full runs), the stale event closes the new
  // palette at once. Here Esc and Ctrl+K are dispatched in ONE task, so the event always comes
  // after the reopen. Fix idea: ignore `close` while dialogRef.current.open is true.
  test("Esc then Ctrl+K at once: the palette stays open (the previous close's late `close` event must not close it)", async ({ page }) => {
    test.fail(true, "CommandPalette: a late native `close` event from the previous Esc closes the reopened palette");
    await openHome(page);
    await page.keyboard.press("Control+k");
    await expect(dialog(page)).toBeVisible();
    await expect(combobox(page)).toBeFocused();
    await paletteElement(page).evaluate((d) => {
      window.__closeEvents = [];
      // Capture phase on the document: runs before React's own listener on the dialog.
      document.addEventListener("close", (e) => e.target === d && window.__closeEvents.push(d.open ? "while open" : "while closed"), true);
    });

    const steps = await paletteElement(page).evaluate(async (d) => {
      // Microtasks only (React flushes discrete updates and their effects in microtasks):
      // no new task may start, so the `close` event queued by d.close() cannot run in between.
      const flush = async (until) => {
        for (let i = 0; i < 50 && !until(); i++) await Promise.resolve();
        return until();
      };
      const input = document.activeElement;
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      const closed = await flush(() => !d.open);
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }));
      const reopened = await flush(() => d.open);
      return { closed, reopened };
    });
    expect(steps, "Esc closed the dialog and Ctrl+K reopened it within one task").toEqual({ closed: true, reopened: true });

    // The browser now delivers the first close's event, to a dialog that is open again.
    await expect.poll(() => page.evaluate(() => window.__closeEvents[0])).toBe("while open");
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 100))));
    await expect(dialog(page), "the reopened palette is still open").toBeVisible({ timeout: 2_000 });
    await expect(combobox(page)).toBeFocused();
  });
});
