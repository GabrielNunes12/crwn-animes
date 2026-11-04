// Cycle 2: server-rendered SEO (docs/API.md v1.2, "Server-rendered meta").
//
// Crawlers and link previews get index.html from the Express server with the
// page's <head> already filled in, so these checks request the API's own
// origin (API_ORIGIN — it serves this run's client build, see
// CLIENT_DIST in playwright.config.js), never `vite preview`. The browser runs with JavaScript
// disabled: what is asserted is exactly what the server sent, not what React
// renders afterwards. Canonical URLs are absolute, built from APP_URL, which
// the e2e API gets as the client's baseURL.
import { test, expect, API_ORIGIN, asAdmin, ensureSeries, ensureVideo, seedSeries } from "./fixtures.js";

const SEO = {
  name: "Saga do SEO",
  slug: "saga-do-seo",
  aliases: [],
  genres: ["Documentário"],
  synopsis: "Uma saga sobre metadados, robôs de busca e prévias de links.",
};
const SEO_YT = "seoSagaEp01";
const EPISODE = "/anime/saga-do-seo/episode/1";

const XSS_NAME = `Saga <script>alert("xss")</script> & Cia`;
const XSS = { name: XSS_NAME, slug: "saga-xss", aliases: [], genres: ["Teste <b>"], synopsis: `</script><script>alert('synopsis')</script>` };

const PENDING = { name: "Saga Pendente", slug: "saga-pendente", aliases: [], genres: [] };

let episode;
test.beforeAll(async ({}, testInfo) => {
  await asAdmin(testInfo, async (admin) => {
    ({ videos: [episode] } = await seedSeries(admin, SEO, [{ youtubeId: SEO_YT, title: "Saga do SEO episódio 1", section: "anime", number: 1 }]));
    await seedSeries(admin, XSS, [{ youtubeId: "seoXssEp001", title: "Saga XSS episódio 1", section: "anime", number: 1 }]);
    // A video placed in a series but without a number stays pending (never public).
    await ensureSeries(admin, PENDING);
    const pending = await ensureVideo(admin, { youtubeId: "seoPend0001", title: "Saga Pendente especial sem número", section: "anime", seriesSlug: PENDING.slug });
    expect(pending.status, "the video without a number must stay pending").toBe("pending");
  });
});

// What the server sent, as a DOM, without running the app's JavaScript.
test.use({ javaScriptEnabled: false });

const meta = (page, key) => page.locator(`head meta[name="${key}"], head meta[property="${key}"]`);

test.describe("server-rendered SEO head", () => {
  test("episode page: title, description, canonical, Open Graph, Twitter and one VideoObject JSON-LD", async ({ page, baseURL }) => {
    const response = await page.goto(`${API_ORIGIN}${EPISODE}`);
    expect(response.status()).toBe(200);

    const headline = "Saga do SEO — Episódio 1";
    const description = `Assista ao episódio 1 de Saga do SEO no Crwn Animes. ${SEO.synopsis}`;
    const canonical = `${baseURL}${EPISODE}`;
    // v1.5: the same-origin thumbnail, made absolute with APP_URL (link previews need an absolute
    // URL). Never i.ytimg.com: even crawlers are pointed at our own copy.
    const thumbnail = `${baseURL}/api/thumbs/${SEO_YT}.jpg`;

    await expect(page).toHaveTitle(`${headline} · Crwn Animes`);
    await expect(page.locator("title")).toHaveCount(1); // the static <title> was replaced, not duplicated
    await expect(meta(page, "description")).toHaveCount(1);
    await expect(meta(page, "description")).toHaveAttribute("content", description);
    await expect(page.locator('head link[rel="canonical"]')).toHaveCount(1);
    await expect(page.locator('head link[rel="canonical"]')).toHaveAttribute("href", canonical);
    expect(canonical.startsWith("http://localhost:"), "canonical is absolute (APP_URL)").toBe(true);
    await expect(meta(page, "robots")).toHaveCount(0);

    const expected = {
      "og:site_name": "Crwn Animes",
      "og:locale": "pt_BR",
      "og:type": "video.episode",
      "og:title": headline,
      "og:description": description,
      "og:url": canonical,
      "og:image": thumbnail, // no series cover: the episode thumbnail
      "twitter:card": "summary_large_image",
    };
    for (const [key, content] of Object.entries(expected)) {
      await expect(meta(page, key), key).toHaveCount(1);
      await expect(meta(page, key), key).toHaveAttribute("content", content);
    }

    const ldScripts = page.locator('script[type="application/ld+json"]');
    await expect(ldScripts).toHaveCount(1);
    const ld = JSON.parse(await ldScripts.textContent());
    expect(ld).toMatchObject({
      "@context": "https://schema.org",
      "@type": "VideoObject",
      name: headline,
      description,
      thumbnailUrl: thumbnail,
      uploadDate: episode.publishedAt,
      embedUrl: `https://www.youtube-nocookie.com/embed/${SEO_YT}`,
      url: canonical,
      isPartOf: { "@type": "TVSeries", name: SEO.name, url: `${baseURL}/anime/saga-do-seo` },
    });
    expect(new URL(ld.embedUrl).hostname).toBe("www.youtube-nocookie.com");
    expect(await page.content(), "no i.ytimg.com link anywhere in the head").not.toContain("ytimg.com");
    // The absolute thumbnail URL really serves the image (asked from the API origin, which serves APP_URL's /api).
    const image = await page.request.get(`${API_ORIGIN}${new URL(thumbnail).pathname}`);
    expect(image.status()).toBe(200);
    expect(image.headers()["content-type"]).toBe("image/jpeg");
  });

  test("series page: TVSeries JSON-LD with genre; manga route of the same series is a 404 (nothing published there)", async ({ page, baseURL, request }) => {
    const response = await page.goto(`${API_ORIGIN}/anime/saga-do-seo`);
    expect(response.status()).toBe(200);
    await expect(page).toHaveTitle("Saga do SEO — Anime · Crwn Animes");
    await expect(meta(page, "og:type")).toHaveAttribute("content", "video.tv_show");
    await expect(page.locator('head link[rel="canonical"]')).toHaveAttribute("href", `${baseURL}/anime/saga-do-seo`);
    const ld = JSON.parse(await page.locator('script[type="application/ld+json"]').textContent());
    expect(ld).toMatchObject({ "@type": "TVSeries", name: SEO.name, description: SEO.synopsis, genre: ["Documentário"] });

    expect((await request.get(`${API_ORIGIN}/manga/saga-do-seo`)).status()).toBe(404);
  });

  test("a series named with <script> is HTML-escaped everywhere (raw “<script>alert” never appears)", async ({ page, request }) => {
    for (const path of ["/anime/saga-xss", "/anime/saga-xss/episode/1", "/genre/Teste%20%3Cb%3E"]) {
      const res = await request.get(`${API_ORIGIN}${path}`);
      expect(res.status(), path).toBe(200);
      const html = await res.text();
      expect(html, path).not.toContain("<script>alert");
      expect(html, path).not.toContain("</script><script>");
      expect(html, path).not.toContain("<b>");
    }

    const html = await (await request.get(`${API_ORIGIN}/anime/saga-xss/episode/1`)).text();
    expect(html).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; &amp; Cia"); // escaped, not stripped

    // Parsed by a browser: the text survives intact and no extra element appears.
    await page.goto(`${API_ORIGIN}/anime/saga-xss/episode/1`);
    await expect(page).toHaveTitle(`${XSS_NAME} — Episódio 1 · Crwn Animes`);
    await expect(meta(page, "og:title")).toHaveAttribute("content", `${XSS_NAME} — Episódio 1`);
    await expect(page.locator('script:not([type="application/ld+json"])', { hasText: "alert" })).toHaveCount(0);
    await expect(page.locator("head b, body b")).toHaveCount(0);
    const ld = page.locator('script[type="application/ld+json"]');
    await expect(ld).toHaveCount(1);
    const data = JSON.parse(await ld.textContent());
    expect(data.isPartOf.name).toBe(XSS_NAME);
    expect(data.description).toContain(XSS.synopsis);
  });

  test("private pages are noindex: /admin, /account, /login, /search", async ({ request }) => {
    for (const path of ["/admin", "/account", "/login", "/search?q=pokemon"]) {
      const res = await request.get(`${API_ORIGIN}${path}`);
      expect(res.status(), path).toBe(200);
      expect(await res.text(), path).toMatch(/<meta name="robots" content="noindex"\s*\/?>/);
    }
    const home = await (await request.get(`${API_ORIGIN}/`)).text();
    expect(home).not.toMatch(/name="robots"/);
  });

  test("unknown section / series / episode → HTTP 404 with the SPA shell, noindex", async ({ request }) => {
    for (const path of ["/anime/serie-que-nao-existe", "/anime/saga-do-seo/episode/99", "/novela/saga-do-seo", "/genre/genero-inexistente", "/anime/saga-pendente"]) {
      const res = await request.get(`${API_ORIGIN}${path}`);
      expect(res.status(), path).toBe(404);
      expect(res.headers()["content-type"], path).toMatch(/^text\/html/);
      const html = await res.text();
      expect(html, path).toContain("<title>Página não encontrada · Crwn Animes</title>");
      expect(html, path).toMatch(/<meta name="robots" content="noindex"\s*\/?>/);
      expect(html, path).not.toContain('rel="canonical"');
      expect(html, path).toContain('<div id="root">'); // the app still boots and shows its own 404 page
    }
  });

  test("non-canonical watch URLs → 301 to the canonical route (query kept)", async ({ request }) => {
    const cases = [
      ["/anime/saga-do-seo/episode/01", EPISODE],
      ["/anime/saga-do-seo/season/1/episode/1", EPISODE],
      ["/anime/saga-do-seo/season/01/episode/001?t=30", `${EPISODE}?t=30`],
    ];
    for (const [from, to] of cases) {
      const res = await request.get(`${API_ORIGIN}${from}`, { maxRedirects: 0 });
      expect(res.status(), from).toBe(301);
      expect(res.headers().location, from).toBe(to);
    }
    // Following it lands on the real page.
    const followed = await request.get(`${API_ORIGIN}/anime/saga-do-seo/episode/01`);
    expect(followed.status()).toBe(200);
    expect(followed.url()).toBe(`${API_ORIGIN}${EPISODE}`);
  });

  test("sitemap.xml lists the episode, its series and genre, but nothing pending", async ({ request, baseURL }) => {
    const res = await request.get(`${API_ORIGIN}/sitemap.xml`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toMatch(/^application\/xml/);
    expect(res.headers()["cache-control"]).toBe("public, max-age=3600");
    const xml = await res.text();
    expect(xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);

    const locs = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
    for (const path of ["/", "/anime", "/manga", "/anime/saga-do-seo", EPISODE, "/genre/Document%C3%A1rio"]) {
      expect(locs, path).toContain(`${baseURL}${path}`);
    }
    expect(xml).toContain(`<url><loc>${baseURL}${EPISODE}</loc><lastmod>${episode.publishedAt}</lastmod></url>`);
    expect(locs.filter((l) => l.includes("saga-pendente")), "a series with only a pending video is not listed").toEqual([]);
    expect(locs.filter((l) => l.includes("/manga/saga-do-seo")), "no manga page for an anime-only series").toEqual([]);
    expect(new Set(locs).size, "no duplicate URLs").toBe(locs.length);
    // The <script> series is there, XML-escaped.
    expect(xml).not.toContain("<script>");
  });

  test("robots.txt disallows /admin, /account, /api/ and links the sitemap", async ({ request, baseURL }) => {
    const res = await request.get(`${API_ORIGIN}/robots.txt`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toMatch(/^text\/plain/);
    const lines = (await res.text()).split("\n").map((l) => l.trim());
    expect(lines).toContain("User-agent: *");
    expect(lines).toContain("Disallow: /admin");
    expect(lines).toContain("Disallow: /account");
    expect(lines).toContain("Disallow: /api/");
    expect(lines).toContain(`Sitemap: ${baseURL}/sitemap.xml`);
  });

  test("robots.txt (v1.5 review fix): Allow /api/thumbs/ and /api/covers/ before Disallow /api/, so crawlers can read og:image", async ({ request }) => {
    const lines = (await (await request.get(`${API_ORIGIN}/robots.txt`)).text()).split("\n").map((l) => l.trim());
    const disallowApi = lines.indexOf("Disallow: /api/");
    expect(disallowApi).toBeGreaterThan(-1);
    for (const allow of ["Allow: /api/thumbs/", "Allow: /api/covers/"]) {
      const at = lines.indexOf(allow);
      expect(at, allow).toBeGreaterThan(-1);
      expect(at, `${allow} comes before Disallow: /api/ (first match wins for some crawlers)`).toBeLessThan(disallowApi);
    }
  });
});
