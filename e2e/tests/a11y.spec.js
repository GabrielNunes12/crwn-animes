// Journeys 7 and 8: axe-core on the main pages (serious/critical violations
// fail the test) and a phone-sized smoke test for horizontal overflow.
import AxeBuilder from "@axe-core/playwright";
import { test, expect, ADMIN_STATE, ensureSeries, ensureVideo, fakeYouTubeId } from "./fixtures.js";

const SERIES = { name: "Axe Saga", slug: "axe-saga", aliases: ["Saga Axe"], genres: ["Fantasy"], synopsis: "Uma série para testes de acessibilidade." };
const EPISODE_ROUTE = "/anime/axe-saga/episode/1";

test.beforeEach(async ({ admin }) => {
  await ensureSeries(admin, SERIES);
  await ensureVideo(admin, { youtubeId: "axeSagaEp01", title: "Axe Saga Episode 1" });
  await ensureVideo(admin, { youtubeId: "axeSagaEp02", title: "Axe Saga Episode 2" });
});

// The logged-in header's account menu (<summary aria-label="Menu da conta de X">)
// fails label-content-name-mismatch: a known app bug with its own expected-to-fail
// test below. It is excluded from the page scans so they keep guarding everything else.
const USER_MENU = "header details > summary";

const axe = (page) => new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]);

/** Runs axe and fails on serious/critical violations, with a readable message. */
async function expectNoSeriousViolations(page, name, builder = axe(page).exclude(USER_MENU)) {
  const results = await builder.analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  const report = serious
    .map((v) => `[${v.impact}] ${v.id}: ${v.help}\n${v.nodes.slice(0, 5).map((n) => `    ${n.target.join(" ")} — ${n.failureSummary?.split("\n").slice(0, 2).join(" ")}`).join("\n")}`)
    .join("\n");
  expect(serious, `${name}: serious/critical axe violations\n${report}`).toEqual([]);
}

const PAGES = [
  { name: "home", path: "/", ready: (page) => page.getByRole("heading", { level: 1 }) },
  { name: "series", path: "/anime/axe-saga", ready: (page) => page.getByRole("heading", { level: 1, name: "Axe Saga" }) },
  { name: "episode", path: EPISODE_ROUTE, ready: (page) => page.getByRole("heading", { level: 1, name: "Episódio 1" }) },
  { name: "login", path: "/login", ready: (page) => page.getByRole("heading", { level: 1, name: "Entrar" }) },
  { name: "register", path: "/register", ready: (page) => page.getByRole("heading", { level: 1, name: "Crie sua conta" }) },
];

test.describe("accessibility (axe-core: no serious/critical violations)", () => {
  for (const { name, path, ready } of PAGES) {
    test(name, async ({ page }) => {
      await page.goto(path);
      await expect(ready(page)).toBeVisible();
      await page.waitForLoadState("networkidle");
      await expectNoSeriousViolations(page, name);
    });
  }

  test.describe("as admin", () => {
    test.use({ storageState: ADMIN_STATE });
    test("admin", async ({ page }) => {
      await page.goto("/admin");
      await expect(page.getByRole("heading", { level: 1, name: "Admin" })).toBeVisible();
      await expect(page.getByRole("listitem").filter({ hasText: "axe-saga" })).toBeVisible();
      await expectNoSeriousViolations(page, "admin (series tab)");
      await page.getByRole("tab", { name: "Pendentes" }).click();
      await expect(page.getByRole("heading", { level: 2, name: /pendente/ })).toBeVisible();
      await expectNoSeriousViolations(page, "admin (pending tab)");
    });

    // BUG (client/src/components/Layout/Header.jsx:58-63): the account menu's
    // <summary> has aria-label "Menu da conta de {name}" while its visible text is
    // the avatar initial + the name ("E" + "E2E Admin"), so axe reports
    // label-content-name-mismatch (serious, WCAG 2.5.3 Label in Name) on every
    // logged-in page. Remove test.fail() once the label contains the visible text.
    test("logged-in header account menu: visible label is part of its accessible name", async ({ page }) => {
      test.fail();
      await page.goto("/login");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.locator(USER_MENU)).toBeVisible();
      await expectNoSeriousViolations(page, "header account menu", axe(page).include(USER_MENU));
    });
  });
});

test.describe("mobile 390×844: no horizontal scroll", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  const noHorizontalScroll = async (page) => {
    const sizes = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
    }));
    expect(sizes.scrollWidth, JSON.stringify(sizes)).toBeLessThanOrEqual(sizes.clientWidth);
    expect(sizes.bodyScrollWidth, JSON.stringify(sizes)).toBeLessThanOrEqual(sizes.clientWidth);
  };

  test("home", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await noHorizontalScroll(page);
  });

  test("episode page", async ({ page }) => {
    await page.goto(EPISODE_ROUTE);
    await expect(page.getByRole("heading", { level: 1, name: "Episódio 1" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Reproduzir:/ })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await noHorizontalScroll(page);
  });
});
