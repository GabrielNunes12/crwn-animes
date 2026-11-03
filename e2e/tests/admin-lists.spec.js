// Journey 8 (API v1.3): the admin lists are paginated (20 per page) and searchable.
// Search narrows the list (accent- and case-insensitive), Previous/Next pages show
// different items with "Página x de y", focus moves to the list heading after a
// page change, and the total is shown in the heading and the live results line.
//
// Each test seeds its own uniquely tagged series/videos through the API and only
// looks at them through a search for that tag, so other specs (and --repeat-each)
// adding series and videos in parallel never change what it sees.
import { test, expect, ADMIN_STATE, asAdmin, ensureSeries, fakeYouTubeId, listAll, seedSeries } from "./fixtures.js";

test.use({ storageState: ADMIN_STATE });

const newTag = () => `q${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 6)}`;
const pad = (n) => String(n).padStart(2, "0");

const tab = (page, name) => page.getByRole("tab", { name, exact: true });
const pageOf = (region) => region.getByRole("navigation", { name: "Páginas" }).getByText(/^Página \d+ de \d+$/);
const next = (region) => region.getByRole("button", { name: "Próxima página" });
const previous = (region) => region.getByRole("button", { name: "Página anterior" });

/** The names shown in the list rows (only the rows that match `pattern`). */
async function shownNames(region, pattern) {
  return region.locator(":scope > ul > li").getByText(pattern).allTextContents();
}

test("series list: search (accent-insensitive), 25 results over 2 pages, Previous/Next move focus to the heading", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const tag = newTag();
  // 12 "Coração <tag> NN" + 13 "Espada <tag> NN" = 25 series (list order: by name).
  const names = [...Array.from({ length: 12 }, (_, i) => `Coração ${tag} ${pad(i + 1)}`), ...Array.from({ length: 13 }, (_, i) => `Espada ${tag} ${pad(i + 1)}`)];
  await asAdmin(testInfo, async (admin) => {
    for (const [i, name] of names.entries()) await ensureSeries(admin, { name, slug: `${tag}-${i + 1}` });
    // The API agrees: { items, total }, paged by limit/offset, without repeats.
    const res = await admin.get(`/api/admin/series?q=${tag}&limit=10&offset=20`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.total).toBe(25);
    expect(body.items.map((s) => s.name)).toEqual(names.slice(20));
    expect((await listAll(admin, "/api/admin/series", { q: tag })).map((s) => s.name)).toEqual(names);
  });
  const mine = new RegExp(`^(Coração|Espada) ${tag} \\d\\d$`);

  await page.goto("/admin");
  await expect(tab(page, "Séries")).toHaveAttribute("aria-selected", "true");
  const region = page.getByRole("region", { name: /^\d+ séries?$/ });
  const heading = region.getByRole("heading", { level: 2 });
  const search = region.getByRole("searchbox", { name: "Buscar séries" });

  await test.step("without a search: heading total and page count agree", async () => {
    await expect(heading).toHaveText(/^\d+ séries$/);
    const total = Number((await heading.textContent()).match(/^(\d+)/)[1]);
    expect(total).toBeGreaterThanOrEqual(25);
    await expect(region.getByText(new RegExp(`^${total} resultados$`))).toBeVisible();
    await expect(pageOf(region)).toHaveText(`Página 1 de ${Math.ceil(total / 20)}`);
    await expect(region.locator(":scope > ul > li")).toHaveCount(20);
  });

  let first;
  await test.step("search the tag → 25 results, page 1 of 2 with the first 20 by name", async () => {
    await search.fill(tag);
    await expect(region.getByText(`25 resultados para “${tag}”`)).toBeVisible();
    await expect(heading).toHaveText("25 séries");
    await expect(pageOf(region)).toHaveText("Página 1 de 2");
    await expect(previous(region)).toHaveAttribute("aria-disabled", "true");
    await expect(next(region)).not.toHaveAttribute("aria-disabled", /.*/);
    first = await shownNames(region, mine);
    expect(first).toEqual(names.slice(0, 20));
  });

  await test.step("Next → page 2 of 2 shows the other 5; focus is on the list heading", async () => {
    await next(region).click();
    await expect(pageOf(region)).toHaveText("Página 2 de 2");
    await expect(region.locator(":scope > ul > li")).toHaveCount(5);
    await expect(heading).toBeFocused();
    await expect(heading).toHaveText("25 séries");
    const second = await shownNames(region, mine);
    expect(second).toEqual(names.slice(20));
    expect(second.filter((n) => first.includes(n))).toEqual([]);
    await expect(next(region)).toHaveAttribute("aria-disabled", "true");
    await next(region).click(); // aria-disabled: nothing happens
    await expect(pageOf(region)).toHaveText("Página 2 de 2");
  });

  await test.step("Previous → page 1 again, focus on the heading", async () => {
    await previous(region).click();
    await expect(pageOf(region)).toHaveText("Página 1 de 2");
    await expect(heading).toBeFocused();
    await expect(region.locator(":scope > ul > li")).toHaveCount(20);
    expect(await shownNames(region, mine)).toEqual(first);
  });

  await test.step("accent- and case-insensitive: “CORACAO <tag>” finds the 12 “Coração” series, “ÉSPADA” the 13 others", async () => {
    await next(region).click();
    await expect(pageOf(region)).toHaveText("Página 2 de 2");
    await search.fill(`CORACAO ${tag}`);
    await expect(region.getByText(`12 resultados para “CORACAO ${tag}”`)).toBeVisible();
    await expect(heading).toHaveText("12 séries");
    await expect(region.getByRole("navigation", { name: "Páginas" })).toHaveCount(0); // one page: no pager
    expect(await shownNames(region, mine)).toEqual(names.slice(0, 12)); // a new search starts on page 1
    await search.fill(`ÉSPADA ${tag} 1`);
    await expect(region.getByText(`4 resultados para “ÉSPADA ${tag} 1”`)).toBeVisible();
    expect(await shownNames(region, mine)).toEqual([10, 11, 12, 13].map((n) => `Espada ${tag} ${n}`));
  });

  await test.step("no match → “Nada encontrado”", async () => {
    await search.fill(`nada ${tag}`);
    await expect(region.getByText(`Nada encontrado para “nada ${tag}”.`)).toBeVisible();
    await expect(heading).toHaveText(/^0 séries?$/); // pt-BR: 0 takes the singular
    await expect(region.locator(":scope > ul > li")).toHaveCount(0);
  });
});

test("published videos list: search by title (accent-insensitive) or series name, 22 results over 2 pages", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const tag = newTag();
  // 22 "Árvore <tag> NN" episodes in "Floresta <tag>", 3 "Pedra <tag> NN" in "Rio <tag>".
  const trees = Array.from({ length: 22 }, (_, i) => `Árvore ${tag} ${pad(i + 1)}`);
  await asAdmin(testInfo, async (admin) => {
    await seedSeries(
      admin,
      { name: `Floresta ${tag}`, slug: `floresta-${tag}` },
      trees.map((title, i) => ({ youtubeId: fakeYouTubeId("al"), title, section: "anime", number: i + 1 }))
    );
    await seedSeries(
      admin,
      { name: `Rio ${tag}`, slug: `rio-${tag}` },
      [1, 2, 3].map((n) => ({ youtubeId: fakeYouTubeId("al"), title: `Pedra ${tag} ${pad(n)}`, section: "anime", number: n }))
    );
    const body = await (await admin.get(`/api/admin/videos?status=published&q=${encodeURIComponent(`arvore ${tag}`)}&limit=20`)).json();
    expect(body.total).toBe(22);
    expect(body.items).toHaveLength(20);
  });
  const mine = new RegExp(`^(Árvore|Pedra) ${tag} \\d\\d$`);
  // Newest first: the last one added is on top.
  const newestFirst = [...trees].reverse();

  await page.goto("/admin?tab=published");
  await expect(tab(page, "Publicados")).toHaveAttribute("aria-selected", "true");
  const region = page.getByRole("region", { name: /^\d+ vídeos? publicados?$/ });
  const heading = region.getByRole("heading", { level: 2 });
  const search = region.getByRole("searchbox", { name: "Buscar vídeos por título ou série" });

  await test.step("“ARVORE <tag>” (no accent, upper case) → 22 results, page 1 of 2", async () => {
    await search.fill(`ARVORE ${tag}`);
    await expect(region.getByText(`22 resultados para “ARVORE ${tag}”`)).toBeVisible();
    await expect(heading).toHaveText("22 vídeos publicados");
    await expect(pageOf(region)).toHaveText("Página 1 de 2");
    expect(await shownNames(region, mine)).toEqual(newestFirst.slice(0, 20));
  });

  await test.step("Next → the 2 oldest, focus on the heading; Previous → back, focus on the heading", async () => {
    await next(region).click();
    await expect(pageOf(region)).toHaveText("Página 2 de 2");
    await expect(heading).toBeFocused();
    await expect(region.locator(":scope > ul > li")).toHaveCount(2);
    expect(await shownNames(region, mine)).toEqual(newestFirst.slice(20));
    await previous(region).click();
    await expect(pageOf(region)).toHaveText("Página 1 de 2");
    await expect(heading).toBeFocused();
    expect(await shownNames(region, mine)).toEqual(newestFirst.slice(0, 20));
  });

  await test.step("a series name matches its videos: “rio <tag>” → the 3 “Pedra” videos", async () => {
    await search.fill(`rio ${tag}`);
    await expect(region.getByText(`3 resultados para “rio ${tag}”`)).toBeVisible();
    await expect(heading).toHaveText("3 vídeos publicados");
    await expect(region.getByRole("navigation", { name: "Páginas" })).toHaveCount(0);
    expect(await shownNames(region, mine)).toEqual([3, 2, 1].map((n) => `Pedra ${tag} ${pad(n)}`));
  });

  await test.step("the pending list does not show published videos", async () => {
    await tab(page, "Pendentes").click();
    const pending = page.getByRole("region", { name: /^\d+ vídeos? pendentes?$/ });
    await pending.getByRole("searchbox", { name: "Buscar vídeos por título ou série" }).fill(tag);
    await expect(pending.getByText(`Nada encontrado para “${tag}”.`)).toBeVisible();
  });
});
