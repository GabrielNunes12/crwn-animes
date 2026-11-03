// Journey 3: an admin builds a series, adds videos (auto-classified and
// pending), fixes a pending one, edits the series, deletes a video and the series.
import { test, expect, ADMIN_STATE, fakeYouTubeId, listAll } from "./fixtures.js";

test.use({ storageState: ADMIN_STATE });

test("admin: series CRUD, add videos, fix a pending one, delete video and series", async ({ page, admin }) => {
  test.setTimeout(90_000);
  const ep3 = fakeYouTubeId("adEp3");
  const ch7 = fakeYouTubeId("adCh7");
  const unknown = fakeYouTubeId("adUnk");

  const tab = (name) => page.getByRole("tab", { name, exact: true });
  const panel = page.getByRole("tabpanel");
  const seriesRow = () => panel.getByRole("listitem").filter({ has: page.getByText("E2E Saga", { exact: true }) });
  // Admin lists are paginated (20 per page, API v1.3) and other specs seed many
  // series/videos in parallel: narrow each list with its search box first.
  const search = async (label, q) => {
    await panel.getByRole("searchbox", { name: label }).fill(q);
    // The search bar's live results line ("1 resultado para “q”").
    await expect(panel.locator('p.hint[aria-live="polite"]')).toHaveText(new RegExp(`^\\d+ resultados? para “${q}”$`));
  };
  const searchSeries = (q = "E2E Saga") => search("Buscar séries", q);
  const searchVideos = (q) => search("Buscar vídeos por título ou série", q);

  await test.step("open the admin area from the header", async () => {
    await page.goto("/");
    await page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Admin" }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole("heading", { level: 1, name: "Admin" })).toBeVisible();
    await expect(tab("Séries")).toHaveAttribute("aria-selected", "true");
  });

  await test.step('create series "E2E Saga" with an alias', async () => {
    await expect(page.getByRole("heading", { name: "Nova série" })).toBeVisible();
    await page.getByLabel("Nome", { exact: true }).fill("E2E Saga");
    const aliases = page.getByLabel("Apelidos (títulos alternativos)", { exact: true }).and(page.locator("input"));
    await aliases.fill("Saga do Teste");
    await aliases.press("Enter");
    await expect(page.getByRole("list", { name: "Apelidos (títulos alternativos)" }).getByRole("listitem")).toContainText(["Saga do Teste"]);
    await page.getByRole("button", { name: "Criar série" }).click();
    await expect(page.getByRole("status").filter({ hasText: "E2E Saga criada." })).toBeVisible();
    await searchSeries();
    await expect(seriesRow()).toContainText("e2e-saga");
  });

  const addVideo = async (id, title) => {
    await page.getByLabel("Link ou ID do YouTube").fill(`https://www.youtube.com/watch?v=${id}`);
    await page.getByLabel("Título (opcional)").fill(title);
    await page.getByRole("button", { name: "Adicionar vídeo", exact: true }).click();
    const result = page.getByRole("region", { name: "Resultado" });
    await expect(result.getByText(title, { exact: true })).toBeVisible();
    return result;
  };

  await test.step('add "E2E Saga Episode 3" → published at /anime/e2e-saga/episode/3', async () => {
    await tab("Adicionar vídeo").click();
    const result = await addVideo(ep3, "E2E Saga Episode 3");
    await expect(result.getByText("Publicado — encontrou seu lugar.")).toBeVisible();
    await expect(result.getByRole("link", { name: /Abrir/ })).toHaveAttribute("href", "/anime/e2e-saga/episode/3");
  });

  await test.step('add "E2E Saga Chapter 7 manga" → published at /manga/e2e-saga/chapter/7', async () => {
    const result = await addVideo(ch7, "E2E Saga Chapter 7 manga");
    await expect(result.getByText("Publicado — encontrou seu lugar.")).toBeVisible();
    await expect(result.getByRole("link", { name: /Abrir/ })).toHaveAttribute("href", "/manga/e2e-saga/chapter/7");
  });

  await test.step('add "Unknown show 12" → pending', async () => {
    const result = await addVideo(unknown, "Unknown show 12");
    await expect(result.getByText("Pendente — precisa de uma ajuda.")).toBeVisible();
    await expect(result.getByRole("link", { name: /Abrir/ })).toHaveCount(0);
  });

  await test.step("the published link opens the episode page", async () => {
    await page.goto("/admin?tab=published");
    await searchVideos("E2E Saga Episode 3");
    await panel.getByRole("link", { name: "/anime/e2e-saga/episode/3" }).click();
    await expect(page).toHaveURL(/\/anime\/e2e-saga\/episode\/3$/);
    await expect(page.getByRole("heading", { level: 1, name: "Episódio 3" })).toBeVisible();
    await page.goto("/admin");
  });

  await test.step("fix the pending video from the Pendentes tab → published", async () => {
    await tab("Pendentes").click();
    await searchVideos("Unknown show 12");
    const form = page.getByRole("form", { name: "Corrigir Unknown show 12" });
    await expect(form).toBeVisible();
    await form.getByLabel("Seção").selectOption("anime");
    await form.getByLabel("Série").selectOption({ label: "E2E Saga" });
    await form.getByLabel("Número").fill("12");
    await form.getByRole("button", { name: "Salvar" }).click();
    await expect(panel.getByRole("status")).toHaveText("Unknown show 12 publicado em /anime/e2e-saga/episode/12.");
    await expect(form).toHaveCount(0);
    const published = await listAll(admin, "/api/admin/videos", { status: "published", q: "Unknown show 12" });
    const fixed = published.find((v) => v.youtubeVideoId === unknown);
    expect(fixed).toMatchObject({ status: "published", route: "/anime/e2e-saga/episode/12" });
  });

  await test.step("edit the series", async () => {
    await tab("Séries").click();
    await searchSeries();
    await seriesRow().getByRole("button", { name: "Editar" }).click();
    await expect(page.getByRole("heading", { name: "Editar E2E Saga" })).toBeVisible();
    await page.getByLabel("Sinopse").fill("A saga criada pelos testes e2e.");
    const genres = page.getByLabel("Gêneros", { exact: true }).and(page.locator("input"));
    await genres.fill("Shonen");
    await genres.press("Enter");
    await page.getByRole("button", { name: "Salvar", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "E2E Saga salva." })).toBeVisible();
    await expect(seriesRow()).toContainText("Shonen");
    await page.goto("/anime/e2e-saga");
    await expect(page.getByRole("heading", { level: 1, name: "E2E Saga" })).toBeVisible();
    await expect(page.getByText("A saga criada pelos testes e2e.")).toBeVisible();
    await expect(page.getByText("Saga do Teste")).toBeVisible();
  });

  await test.step("delete a video (confirm dialog)", async () => {
    await page.goto("/admin?tab=published");
    await searchVideos("E2E Saga Chapter 7");
    const row = panel.getByRole("listitem").filter({ hasText: "E2E Saga Chapter 7 manga" });
    await row.getByRole("button", { name: "Excluir" }).click();
    const dialog = page.getByRole("dialog", { name: "Excluir este vídeo?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Excluir" }).click();
    await expect(dialog).toBeHidden();
    await expect(panel.getByRole("status")).toHaveText("E2E Saga Chapter 7 manga excluído.");
    await expect(row).toHaveCount(0);
    await page.goto("/manga/e2e-saga/chapter/7");
    await expect(page.getByRole("heading", { level: 1, name: "Página não encontrada" })).toBeVisible();
  });

  await test.step("delete the series (cancel first, then confirm)", async () => {
    await page.goto("/admin");
    await searchSeries();
    await seriesRow().getByRole("button", { name: "Excluir" }).click();
    const dialog = page.getByRole("dialog", { name: "Excluir E2E Saga?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancelar" }).click();
    await expect(dialog).toBeHidden();
    await expect(seriesRow()).toHaveCount(1);

    await seriesRow().getByRole("button", { name: "Excluir" }).click();
    await dialog.getByRole("button", { name: "Excluir" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("status").filter({ hasText: "E2E Saga excluída." })).toBeVisible();
    await expect(seriesRow()).toHaveCount(0);

    // v1.1: deleting a series deletes its videos.
    const all = await listAll(admin, "/api/admin/videos");
    expect(all.filter((v) => [ep3, ch7, unknown].includes(v.youtubeVideoId))).toEqual([]);
    await page.goto("/anime/e2e-saga/episode/3");
    await expect(page.getByRole("heading", { level: 1, name: "Página não encontrada" })).toBeVisible();
  });
});
