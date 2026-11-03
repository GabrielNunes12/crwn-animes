// Cycle 2: /genre/:genre — every series of a genre, anime and manga together,
// sortable; reached from the genre chips of a series page.
import { test, expect, asAdmin, expectNoSeriousViolations, seedSeries } from "./fixtures.js";

const GENRE = "Ficção Espacial"; // accented + a space: exercises the URL encoding
const GENRE_PATH = "/genre/Fic%C3%A7%C3%A3o%20Espacial";
const ALFA = { name: "Alfa Estelar", slug: "alfa-estelar", aliases: [], genres: [GENRE, "Aventura Sideral"], synopsis: "Uma frota parte rumo ao desconhecido." };
const ZETA = { name: "Zeta Estelar", slug: "zeta-estelar", aliases: [], genres: [GENRE] };

let alfaVideo;
let zetaVideo;
test.beforeAll(async ({}, testInfo) => {
  await asAdmin(testInfo, async (admin) => {
    // Alfa (anime) is published before Zeta (manga): "Mais recentes" must list Zeta first,
    // the opposite of A–Z. Every worker seeds in this order, so it holds under parallel runs.
    ({ videos: [alfaVideo] } = await seedSeries(admin, ALFA, [{ youtubeId: "genAlfa0001", title: "Alfa Estelar episódio 1", section: "anime", number: 1 }]));
    ({ videos: [zetaVideo] } = await seedSeries(admin, ZETA, [{ youtubeId: "genZeta0001", title: "Zeta Estelar capítulo 1", section: "manga", number: 1 }]));
  });
});

const resultNames = (page) => page.locator("[data-result]").getByRole("heading", { level: 3 });
const sortSelect = (page) => page.getByRole("combobox", { name: "Ordenar por" });

test.describe("genre page", () => {
  test("a genre chip on a series page opens /genre/<genre> with both sections", async ({ page }) => {
    await page.goto("/anime/alfa-estelar");
    await expect(page.getByRole("heading", { level: 1, name: "Alfa Estelar" })).toBeVisible();

    await page.getByRole("list", { name: "Gêneros" }).getByRole("link", { name: GENRE, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${GENRE_PATH}$`));
    await expect(page.getByRole("heading", { level: 1, name: GENRE })).toBeVisible();
    await expect(page).toHaveTitle(`${GENRE} · Animes e mangás · Crwn Animes`);
    await expect(resultNames(page)).toHaveText(["Alfa Estelar", "Zeta Estelar"]);
    await expect(page.getByRole("status").filter({ hasText: /^\d+ resultados?$/ })).toHaveText("2 resultados");
    const cards = page.locator("[data-result]");
    await expect(cards.nth(0).getByText("Anime", { exact: true })).toBeVisible();
    await expect(cards.nth(1).getByText("Mangá", { exact: true })).toBeVisible();
    await expect(cards.nth(1).getByRole("link")).toHaveAttribute("href", "/manga/zeta-estelar");
  });

  test("sort: A–Z by default, “Mais recentes” reorders and is kept in the URL", async ({ page }) => {
    expect(Date.parse(zetaVideo.publishedAt), "Zeta must have been published after Alfa").toBeGreaterThan(Date.parse(alfaVideo.publishedAt));

    await page.goto(GENRE_PATH);
    await expect(sortSelect(page)).toHaveValue("az");
    await expect(resultNames(page)).toHaveText(["Alfa Estelar", "Zeta Estelar"]);

    await sortSelect(page).selectOption({ label: "Mais recentes" });
    await expect(page).toHaveURL(new RegExp(`${GENRE_PATH}\\?sort=new$`));
    await expect(resultNames(page)).toHaveText(["Zeta Estelar", "Alfa Estelar"]);

    await page.reload();
    await expect(sortSelect(page)).toHaveValue("new");
    await expect(resultNames(page)).toHaveText(["Zeta Estelar", "Alfa Estelar"]);

    await sortSelect(page).selectOption({ label: "A–Z" });
    await expect(page).toHaveURL(new RegExp(`${GENRE_PATH}$`));
    await expect(resultNames(page)).toHaveText(["Alfa Estelar", "Zeta Estelar"]);
  });

  test("genre names are case-insensitive in the URL; the catalogue's spelling is shown", async ({ page }) => {
    await page.goto("/genre/fic%C3%A7%C3%A3o%20espacial");
    await expect(page.getByRole("heading", { level: 1, name: GENRE })).toBeVisible();
    await expect(resultNames(page)).toHaveText(["Alfa Estelar", "Zeta Estelar"]);
  });

  test("axe: no serious/critical violations", async ({ page }) => {
    await page.goto(GENRE_PATH);
    await expect(resultNames(page)).toHaveText(["Alfa Estelar", "Zeta Estelar"]);
    await page.waitForLoadState("networkidle");
    await expectNoSeriousViolations(page, "genre page");
  });
});
