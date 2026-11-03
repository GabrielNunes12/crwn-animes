// Journey 4: the episode page — YouTube facade, ratings and reactions,
// the logged-out view, and /admin for a normal user.
import { test, expect, createUser, ensureSeries, ensureVideo, fakeYouTubeId, uniqueEmail, YOUTUBE_HOST } from "./fixtures.js";

const SERIES = { name: "Watch Saga", slug: "watch-saga", aliases: [], genres: ["Drama"] };

const isYouTube = (url) => YOUTUBE_HOST.test(new URL(url).hostname);
// Each test gets its own episode slot, so tests never share ratings (and the
// file stays safe under --repeat-each against the same server).
const episodeNumber = () => 100 + Math.floor(Math.random() * 9000);

test.describe("episode page", () => {
  test("facade loads nothing from YouTube; a user rates 4★ + 🔥, it persists, changes to 5★, then is removed", async ({ page, admin, externalRequests }) => {
    await ensureSeries(admin, SERIES);
    const n = episodeNumber();
    const title = `Watch Saga Episode ${n}`;
    const video = await ensureVideo(admin, { youtubeId: fakeYouTubeId("wRate"), title });
    expect(video.route).toBe(`/anime/watch-saga/episode/${n}`);
    const user = await createUser(page.request, { email: uniqueEmail("rater"), displayName: "Avaliador" });

    const ytRequests = [];
    page.on("request", (req) => {
      if (isYouTube(req.url())) ytRequests.push(req.url());
    });

    const stars = (n) => page.getByRole("radio", { name: n === 1 ? "1 estrela" : `${n} estrelas`, exact: true });
    // The radios are visually hidden; users click the star (the radio's <label>).
    const rate = (n) => page.locator("label").filter({ has: stars(n) }).click();
    const fire = page.getByRole("button", { name: /Fogo/ });
    const live = page.getByRole("status").filter({ hasText: /Avaliação (salva|removida)\./ });

    await test.step("the player is a facade: no request to YouTube before play", async () => {
      await page.goto(video.route);
      await expect(page.getByRole("heading", { level: 1, name: `Episódio ${n}` })).toBeVisible();
      await expect(page.getByRole("button", { name: `Reproduzir: ${title}` })).toBeVisible();
      await expect(page.getByLabel(`Menu da conta de ${user.displayName}`)).toBeVisible();
      await expect(stars(4)).toBeAttached(); // visually hidden radio inside a star label
      // Thumbnails (i.ytimg.com) are the only YouTube traffic allowed before play.
      const beforePlay = ytRequests.filter((u) => !/ytimg\.com/.test(new URL(u).hostname));
      expect(beforePlay, "no youtube.com / youtube-nocookie.com request before pressing play").toEqual([]);
      await expect(page.locator('iframe[src*="youtube"]')).toHaveCount(0);
    });

    await test.step("rate 4 stars and react 🔥", async () => {
      await expect(fire).toBeDisabled(); // "rate first" until there is a score
      await rate(4);
      await expect(live).toHaveText("Avaliação salva.");
      await expect(fire).toBeEnabled();
      await fire.click();
      await expect(fire).toHaveAttribute("aria-pressed", "true");
      await expect(live).toHaveText("Avaliação salva.");
      await expect(page.getByText("1 avaliação", { exact: true })).toBeVisible();
    });

    await test.step("reload: the rating persists", async () => {
      await page.reload();
      await expect(stars(4)).toBeChecked();
      await expect(fire).toHaveAttribute("aria-pressed", "true");
      const summary = await (await page.request.get(`/api/videos/${video.id}/rating`)).json();
      expect(summary.mine).toEqual({ score: 4, reaction: "fire" });
    });

    await test.step("change to 5 stars (reaction kept)", async () => {
      await rate(5);
      await expect(live).toHaveText("Avaliação salva.");
      await page.reload();
      await expect(stars(5)).toBeChecked();
      await expect(stars(4)).not.toBeChecked();
      await expect(fire).toHaveAttribute("aria-pressed", "true");
    });

    await test.step("remove the rating", async () => {
      await page.getByRole("button", { name: "Remover minha avaliação" }).click();
      await expect(live).toHaveText("Avaliação removida.");
      await page.reload();
      for (const n of [1, 2, 3, 4, 5]) await expect(stars(n)).not.toBeChecked();
      await expect(page.getByText("Sem avaliações ainda")).toBeVisible();
      await expect(fire).toBeDisabled();
    });

    await test.step("pressing play is what loads YouTube (blocked here → error UI)", async () => {
      await page.getByRole("button", { name: `Reproduzir: ${title}` }).click();
      await expect.poll(() => externalRequests.some((u) => u.startsWith("https://www.youtube.com/iframe_api"))).toBe(true);
      await expect(page.getByRole("alert").filter({ hasText: "O player do YouTube não carregou" })).toBeVisible();
    });
  });

  test("logged-out visitor sees “log in to rate” and no rating controls", async ({ page, admin }) => {
    await ensureSeries(admin, SERIES);
    const n = episodeNumber();
    const video = await ensureVideo(admin, { youtubeId: fakeYouTubeId("wAnon"), title: `Watch Saga Episode ${n}` });
    expect(video.status).toBe("published");

    await page.goto(video.route);
    await expect(page.getByRole("heading", { level: 1, name: `Episódio ${n}` })).toBeVisible();
    const login = page.getByRole("link", { name: "Entre para avaliar" });
    await expect(login).toBeVisible();
    await expect(login).toHaveAttribute("href", `/login?next=${encodeURIComponent(video.route)}`);
    await expect(page.getByRole("radio")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Fogo|Engraçado|Triste|Uau|Amei/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Remover minha avaliação" })).toHaveCount(0);
    // The API agrees: anonymous users cannot rate.
    const res = await page.request.put(`/api/videos/${video.id}/rating`, { data: { score: 5 } });
    expect(res.status()).toBe(401);
  });

  test("a normal user visiting /admin is redirected home", async ({ page }) => {
    await createUser(page.request, { email: uniqueEmail("notadmin"), displayName: "Normal" });
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("status").filter({ hasText: "Essa área é só para administradores." })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Principal" }).getByRole("link", { name: "Admin" })).toHaveCount(0);
    expect((await page.request.get("/api/admin/series")).status()).toBe(403);
  });
});
