// Cycle 2: the /search page (docs/API.md v1.2, "Search & browse").
// Accent-insensitive name + alias matching, section / genre / sort filters
// mirrored in the URL (and restored by the back button), and "Carregar mais".
//
// Every series here has names and genres no other spec uses, so the expected
// result lists are exact even though all specs share one database.
import { test, expect, asAdmin, seedSeries } from "./fixtures.js";

const POKEMON = {
  name: "Pokémon Teste",
  slug: "pokemon-teste",
  aliases: ["Poke Test"],
  genres: ["Criaturas"],
  synopsis: "Série de testes da busca sem acento.",
};
// Matches "pokemon" too (in the middle of its name), but in another genre and only as anime.
const ARENA = { name: "Arena dos Pokémon", slug: "arena-dos-pokemon", aliases: [], genres: ["Tática"] };
// 25 series for pagination (the page size is 20).
const BATCH = Array.from({ length: 25 }, (_, i) => {
  const n = String(i + 1).padStart(2, "0");
  return { name: `Lote Carga ${n}`, slug: `lote-carga-${n}`, aliases: [], genres: ["Carga"], youtubeId: `loteCarga${n}` };
});

test.beforeAll(async ({}, testInfo) => {
  await asAdmin(testInfo, async (admin) => {
    await seedSeries(admin, POKEMON, [
      { youtubeId: "srchPokeA01", title: "Pokémon Teste episódio 1", section: "anime", number: 1 },
      { youtubeId: "srchPokeM01", title: "Pokémon Teste capítulo 1", section: "manga", number: 1 },
    ]);
    await seedSeries(admin, ARENA, [{ youtubeId: "srchArenA01", title: "Arena dos Pokémon episódio 1", section: "anime", number: 1 }]);
    for (const { youtubeId, ...series } of BATCH) {
      await seedSeries(admin, series, [{ youtubeId, title: `${series.name} episódio 1`, section: "anime", number: 1 }]);
    }
  });
});

const queryBox = (page) => page.getByRole("searchbox", { name: "Nome ou título alternativo" });
const results = (page) => page.locator("[data-result]");
const resultNames = (page) => results(page).getByRole("heading", { level: 3 });
const resultCount = (page) => page.getByRole("status").filter({ hasText: /^\d+ resultados?$/ });
const genreSelect = (page) => page.getByRole("combobox", { name: "Gênero", exact: true });
const sortSelect = (page) => page.getByRole("combobox", { name: "Ordenar por" });
const sectionRadio = (page, name) => page.getByRole("radio", { name, exact: true });

test.describe("search page", () => {
  test("accent-insensitive: “pokemon” finds “Pokémon Teste” (both sections), and so does its alias", async ({ page }) => {
    await page.goto("/search");
    await expect(page.getByRole("heading", { level: 1, name: "Busca" })).toBeVisible();

    await queryBox(page).fill("pokemon");
    await expect(page).toHaveURL(/\/search\?q=pokemon$/);
    await expect(page.getByRole("heading", { level: 1, name: "Resultados para “pokemon”" })).toBeVisible();
    // Relevance: names starting with the query first, then a word inside a name;
    // a series published in both sections is two results (anime first).
    await expect(resultNames(page)).toHaveText(["Pokémon Teste", "Pokémon Teste", "Arena dos Pokémon"]);
    await expect(resultCount(page)).toHaveText("3 resultados");
    await expect(results(page).nth(0).getByText("Anime", { exact: true })).toBeVisible();
    await expect(results(page).nth(1).getByText("Mangá", { exact: true })).toBeVisible();
    await expect(results(page).nth(0).getByRole("link")).toHaveAttribute("href", "/anime/pokemon-teste");
    await expect(results(page).nth(1).getByRole("link")).toHaveAttribute("href", "/manga/pokemon-teste");

    await queryBox(page).fill("Poke Test");
    await expect(page).toHaveURL(/\/search\?q=Poke\+Test$/);
    await expect(resultNames(page)).toHaveText(["Pokémon Teste", "Pokémon Teste"]);
    await expect(resultCount(page)).toHaveText("2 resultados");

    await queryBox(page).fill("POKÉMON TESTE");
    await expect(resultNames(page)).toHaveText(["Pokémon Teste", "Pokémon Teste"]);
  });

  test("section, genre and sort filters narrow / reorder the results and are mirrored in the URL", async ({ page }) => {
    await page.goto("/search?q=pokemon");
    await expect(resultNames(page)).toHaveText(["Pokémon Teste", "Pokémon Teste", "Arena dos Pokémon"]);
    await expect(sectionRadio(page, "Todas")).toBeChecked();
    await expect(sortSelect(page)).toHaveValue("relevance");

    await test.step("section: Mangá, then Anime, then Todas", async () => {
      await sectionRadio(page, "Mangá").check();
      await expect(page).toHaveURL(/[?&]section=manga(&|$)/);
      await expect(resultNames(page)).toHaveText(["Pokémon Teste"]);
      await expect(results(page).getByText("Mangá", { exact: true })).toBeVisible();

      await sectionRadio(page, "Anime").check();
      await expect(page).toHaveURL(/[?&]section=anime(&|$)/);
      await expect(resultNames(page)).toHaveText(["Pokémon Teste", "Arena dos Pokémon"]);
      await expect(resultCount(page)).toHaveText("2 resultados");

      await sectionRadio(page, "Todas").check();
      await expect(page).not.toHaveURL(/section=/);
      await expect(resultNames(page)).toHaveText(["Pokémon Teste", "Pokémon Teste", "Arena dos Pokémon"]);
    });

    await test.step("genre: Tática keeps only Arena, Criaturas only Pokémon Teste", async () => {
      await genreSelect(page).selectOption("Tática");
      await expect(page).toHaveURL(/[?&]genre=T%C3%A1tica(&|$)/);
      await expect(resultNames(page)).toHaveText(["Arena dos Pokémon"]);
      await expect(resultCount(page)).toHaveText("1 resultado");

      await genreSelect(page).selectOption("Criaturas");
      await expect(page).toHaveURL(/[?&]genre=Criaturas(&|$)/);
      await expect(resultNames(page)).toHaveText(["Pokémon Teste", "Pokémon Teste"]);

      await genreSelect(page).selectOption({ label: "Todos os gêneros" });
      await expect(page).not.toHaveURL(/genre=/);
      await expect(resultNames(page)).toHaveText(["Pokémon Teste", "Pokémon Teste", "Arena dos Pokémon"]);
    });

    await test.step("sort: A–Z puts Arena first, Relevância puts it back last", async () => {
      await sortSelect(page).selectOption("az");
      await expect(page).toHaveURL(/[?&]sort=az(&|$)/);
      await expect(resultNames(page)).toHaveText(["Arena dos Pokémon", "Pokémon Teste", "Pokémon Teste"]);

      await sortSelect(page).selectOption("relevance");
      await expect(page).toHaveURL(/[?&]sort=relevance(&|$)/);
      await expect(resultNames(page)).toHaveText(["Pokémon Teste", "Pokémon Teste", "Arena dos Pokémon"]);
    });
  });

  test("a shared URL restores every control; back/forward restore the previous query and filters", async ({ page }) => {
    await test.step("opening a URL with all params sets every control", async () => {
      await page.goto(`/search?q=pokemon&section=manga&genre=Criaturas&sort=az`);
      await expect(queryBox(page)).toHaveValue("pokemon");
      await expect(sectionRadio(page, "Mangá")).toBeChecked();
      await expect(genreSelect(page)).toHaveValue("Criaturas");
      await expect(sortSelect(page)).toHaveValue("az");
      await expect(resultNames(page)).toHaveText(["Pokémon Teste"]);
    });

    await test.step("type a query, change a filter, type another query", async () => {
      await page.goto("/search");
      await expect(resultCount(page)).toBeVisible(); // browse-everything results are in
      await queryBox(page).fill("pokemon");
      await expect(page).toHaveURL(/\/search\?q=pokemon$/);
      await expect(resultNames(page)).toHaveText(["Pokémon Teste", "Pokémon Teste", "Arena dos Pokémon"]);

      await sectionRadio(page, "Anime").check();
      await expect(page).toHaveURL(/\/search\?q=pokemon&section=anime$/);
      await expect(resultNames(page)).toHaveText(["Pokémon Teste", "Arena dos Pokémon"]);

      await queryBox(page).fill("poke test");
      await expect(page).toHaveURL(/\/search\?q=poke\+test&section=anime$/);
      await expect(resultNames(page)).toHaveText(["Pokémon Teste"]);
    });

    await test.step("back: the previous query and filter come back (box, radio and results)", async () => {
      await page.goBack();
      await expect(page).toHaveURL(/\/search\?q=pokemon&section=anime$/);
      await expect(queryBox(page)).toHaveValue("pokemon");
      await expect(sectionRadio(page, "Anime")).toBeChecked();
      await expect(resultNames(page)).toHaveText(["Pokémon Teste", "Arena dos Pokémon"]);

      await page.goBack();
      await expect(page).toHaveURL(/\/search\?q=pokemon$/);
      await expect(sectionRadio(page, "Todas")).toBeChecked();
      await expect(resultNames(page)).toHaveText(["Pokémon Teste", "Pokémon Teste", "Arena dos Pokémon"]);

      await page.goForward();
      await expect(page).toHaveURL(/\/search\?q=pokemon&section=anime$/);
      await expect(resultNames(page)).toHaveText(["Pokémon Teste", "Arena dos Pokémon"]);
    });
  });

  test("back after typing a second query (after the first one's results were shown) restores the first query", async ({ page }) => {
    await page.goto("/search");
    await expect(resultCount(page)).toBeVisible();

    await queryBox(page).fill("pokemon");
    await expect(page).toHaveURL(/\/search\?q=pokemon$/);
    await expect(resultNames(page)).toHaveText(["Pokémon Teste", "Pokémon Teste", "Arena dos Pokémon"]);

    await queryBox(page).fill("poke test");
    await expect(page).toHaveURL(/\/search\?q=poke\+test$/);
    await expect(resultNames(page)).toHaveText(["Pokémon Teste", "Pokémon Teste"]);

    await page.goBack();
    await expect(page).toHaveURL(/\/search\?q=pokemon$/);
    await expect(queryBox(page)).toHaveValue("pokemon");
    await expect(resultNames(page)).toHaveText(["Pokémon Teste", "Pokémon Teste", "Arena dos Pokémon"]);
  });

  test("“Carregar mais” appends the next page (25 results, 20 per page) and then disappears", async ({ page }) => {
    await page.goto("/search?q=lote%20carga");
    await expect(resultCount(page)).toHaveText("25 resultados");
    await expect(results(page)).toHaveCount(20);
    await expect(resultNames(page).first()).toHaveText("Lote Carga 01");
    await expect(resultNames(page).last()).toHaveText("Lote Carga 20");
    await expect(page.getByText("Mostrando 20 de 25", { exact: true })).toBeVisible();

    const more = page.getByRole("button", { name: "Carregar mais" });
    await more.click();
    await expect(results(page)).toHaveCount(25);
    await expect(resultNames(page)).toHaveText(BATCH.map((s) => s.name)); // appended in order, no duplicates
    await expect(more).toHaveCount(0); // last page: no more button
    await expect(page.getByRole("status").filter({ hasText: "Mais 5 resultados carregados. Mostrando 25 de 25." })).toBeAttached();
    // Focus moves to the first new result (the button it was on is gone).
    await expect(results(page).nth(20).getByRole("link")).toBeFocused();
    await expect(resultCount(page)).toHaveText("25 resultados");
  });
});
