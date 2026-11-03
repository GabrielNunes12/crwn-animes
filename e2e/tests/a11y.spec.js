// Journeys 7 and 8: axe-core on the main pages (serious/critical violations
// fail the test) and a phone-sized smoke test for horizontal overflow.
import { test, expect, ADMIN_STATE, createUser, ensureSeries, ensureVideo, expectNoSeriousViolations, uniqueEmail } from "./fixtures.js";

const SERIES = { name: "Axe Saga", slug: "axe-saga", aliases: ["Saga Axe"], genres: ["Fantasy"], synopsis: "Uma série para testes de acessibilidade." };
const EPISODE_ROUTE = "/anime/axe-saga/episode/1";

test.beforeEach(async ({ admin }) => {
  await ensureSeries(admin, SERIES);
  await ensureVideo(admin, { youtubeId: "axeSagaEp01", title: "Axe Saga Episode 1" });
  await ensureVideo(admin, { youtubeId: "axeSagaEp02", title: "Axe Saga Episode 2" });
});

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
  });

  test("episode, logged in (star radios, reaction buttons, account menu)", async ({ page }) => {
    await createUser(page.request, { email: uniqueEmail("axe"), displayName: "Leitor de Tela" });
    await page.goto(EPISODE_ROUTE);
    await expect(page.getByRole("radiogroup").or(page.getByRole("group", { name: "Sua avaliação" })).first()).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expectNoSeriousViolations(page, "episode (logged in)");
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
