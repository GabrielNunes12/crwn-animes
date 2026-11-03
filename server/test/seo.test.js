import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { truncate } from "../src/seo.js";
import { addVideo, startServer } from "./helpers.js";

const EVIL = `</script><script>alert(1)</script> & "x"`;
const EVIL_GENRE = `<b>Evil</b> & Co`;
const EVIL_COVER = `https://img.test/c.jpg?a=1&b="2"<x>`;

// What the built client's index.html looks like: a static <title> and
// description the server must replace, not duplicate.
const TEMPLATE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="description" content="Static description" />
    <meta property="og:title" content="Static OG" />
    <title>Crwn Animes</title>
    <script type="module" crossorigin src="/assets/index-abc123.js"></script>
  </head>
  <body><div id="root"></div></body>
</html>
`;

const EXPECTED_CSP =
  "default-src 'self';script-src 'self' https://www.youtube.com https://s.ytimg.com;" +
  "frame-src https://www.youtube-nocookie.com https://www.youtube.com;img-src 'self' data: https:;" +
  "style-src 'self' 'unsafe-inline';font-src 'self';connect-src 'self';object-src 'none';base-uri 'self';" +
  "frame-ancestors 'none';form-action 'self'";

/** Decodes the few entities escapeHtml() produces. */
const unescapeHtml = (s) =>
  s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e]);

/** <head> facts of a rendered page. */
function head(html) {
  const meta = (attr, key) => {
    const all = [...html.matchAll(new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`, "g"))].map((m) => unescapeHtml(m[1]));
    assert.ok(all.length <= 1, `at most one ${key}`);
    return all[0] ?? null;
  };
  const titles = [...html.matchAll(/<title>([^<]*)<\/title>/g)].map((m) => unescapeHtml(m[1]));
  const jsonLd = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
  return {
    titles,
    title: titles[0],
    description: meta("name", "description"),
    robots: meta("name", "robots"),
    canonical: html.match(/<link rel="canonical" href="([^"]*)"/)?.[1] ?? null,
    og: Object.fromEntries(["site_name", "title", "description", "url", "image", "type", "locale"].map((k) => [k, meta("property", `og:${k}`)])),
    twitterCard: meta("name", "twitter:card"),
    jsonLd,
  };
}

/** fetch without following redirects. */
const raw = (srv, p) => fetch(srv.base + p, { redirect: "manual" });

describe("server-rendered SEO meta", () => {
  let srv;
  let dir;
  let v;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "crwn-seo-"));
    fs.mkdirSync(path.join(dir, "assets"));
    fs.writeFileSync(path.join(dir, "index.html"), TEMPLATE);
    fs.writeFileSync(path.join(dir, "assets", "index-abc123.js"), "console.log(1)");
    srv = await startServer({ config: { nodeEnv: "production", isProduction: true, clientDist: dir } });
    srv.services.repo.createSeries({
      slug: "evil",
      name: EVIL,
      synopsis: `${EVIL} <img src=x onerror=alert(2)>`,
      aliases: [],
      genres: [EVIL_GENRE],
      coverUrl: EVIL_COVER,
    });
    v = {
      op1: await addVideo(srv, 1, "One Piece Episode 1"),
      op2: await addVideo(srv, 2, "One Piece Episode 2"),
      opS2: await addVideo(srv, 3, "One Piece 2nd Season Episode 3"),
      opManga: await addVideo(srv, 4, "One Piece Chapter 1100 Manga"),
      evil: await addVideo(srv, 5, "evil upload", { section: "anime", seriesSlug: "evil", number: 1 }),
      gone: await addVideo(srv, 6, "One Piece Episode 8"),
      hidden: await addVideo(srv, 7, "One Piece Episode 9"),
    };
    assert.equal(v.evil.status, "published");
    srv.services.repo.setAvailability(v.gone.id, "unavailable");
    srv.db.prepare("UPDATE videos SET status = 'pending' WHERE id = ?").run(v.hidden.id);
  });
  after(async () => {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const get = (p) => srv.client().get(p);

  test("home, sections, privacy: titles, description, canonical, Open Graph", async () => {
    const home = await get("/");
    assert.equal(home.status, 200);
    assert.equal(home.headers.get("cache-control"), "no-cache");
    const h = head(home.text);
    assert.deepEqual(h.titles, ["Crwn Animes · Episódios de anime e capítulos de mangá"], "the static <title> is replaced");
    assert.ok(h.description && h.description !== "Static description");
    assert.equal(h.canonical, "http://app.test/");
    assert.deepEqual(h.og, {
      site_name: "Crwn Animes",
      title: "Crwn Animes",
      description: h.description,
      url: "http://app.test/",
      image: null,
      type: "website",
      locale: "pt_BR",
    });
    assert.equal(h.twitterCard, "summary");
    assert.equal(h.robots, null);
    assert.deepEqual(h.jsonLd, []);
    assert.doesNotMatch(home.text, /Static description|Static OG/, "template tags are replaced, not duplicated");
    assert.match(home.text, /<script type="module" crossorigin src="\/assets\/index-abc123.js"><\/script>/, "rest of the template kept");

    for (const [p, title] of [
      ["/anime", "Animes · Crwn Animes"],
      ["/manga", "Mangás · Crwn Animes"],
      ["/anime?genre=Shonen", "Animes · Crwn Animes"],
      ["/privacy", "Política de privacidade · Crwn Animes"],
    ]) {
      const res = await get(p);
      assert.equal(res.status, 200, p);
      const page = head(res.text);
      assert.equal(page.title, title, p);
      assert.equal(page.canonical, `http://app.test${p.split("?")[0]}`, p);
      assert.equal(page.og.type, "website", p);
      assert.equal(page.robots, null, p);
      assert.ok(page.description.length > 20 && page.description.length <= 160, p);
    }
  });

  test("genre page: canonical spelling, 404 for an unknown genre", async () => {
    const res = await get("/genre/shonen");
    assert.equal(res.status, 200);
    const h = head(res.text);
    assert.equal(h.title, "Shonen · Animes e mangás · Crwn Animes");
    assert.equal(h.canonical, "http://app.test/genre/Shonen");
    assert.match(h.description, /Shonen/);
    assert.equal((await get("/genre/nope")).status, 404);
  });

  test("series page: video.tv_show, cover image, TVSeries / CreativeWorkSeries JSON-LD", async () => {
    const anime = await get("/anime/one-piece");
    assert.equal(anime.status, 200);
    const h = head(anime.text);
    assert.equal(h.title, "One Piece — Anime · Crwn Animes");
    assert.equal(h.og.type, "video.tv_show");
    assert.equal(h.canonical, "http://app.test/anime/one-piece");
    assert.equal(h.og.url, "http://app.test/anime/one-piece");
    assert.match(h.og.image, /^https:\/\/beta\.crunchyroll\.com\//);
    assert.equal(h.twitterCard, "summary_large_image");
    assert.ok(h.description.length <= 160);
    assert.match(h.description, /^Monkey D\. Luffy/);
    assert.equal(h.jsonLd.length, 1);
    assert.deepEqual(h.jsonLd[0], {
      "@context": "https://schema.org",
      "@type": "TVSeries",
      name: "One Piece",
      description: h.description,
      image: h.og.image,
      genre: ["Shonen", "Adventure", "Comedy"],
      url: "http://app.test/anime/one-piece",
    });

    const manga = head((await get("/manga/one-piece")).text);
    assert.equal(manga.title, "One Piece — Mangá · Crwn Animes");
    assert.equal(manga.jsonLd[0]["@type"], "CreativeWorkSeries");
  });

  test("episode and chapter pages: video.episode + VideoObject JSON-LD", async () => {
    const res = await get("/anime/one-piece/episode/2");
    assert.equal(res.status, 200);
    const h = head(res.text);
    assert.equal(h.title, "One Piece — Episódio 2 · Crwn Animes");
    assert.equal(h.og.title, "One Piece — Episódio 2");
    assert.equal(h.og.type, "video.episode");
    assert.equal(h.canonical, "http://app.test/anime/one-piece/episode/2");
    assert.match(h.description, /^Assista ao episódio 2 de One Piece/);
    assert.ok(h.description.length <= 160);
    assert.match(h.og.image, /crunchyroll/, "series cover first");
    assert.equal(h.robots, null);
    assert.equal(h.jsonLd.length, 1);
    const ld = h.jsonLd[0];
    assert.equal(ld["@context"], "https://schema.org");
    assert.equal(ld["@type"], "VideoObject");
    assert.equal(ld.name, "One Piece — Episódio 2");
    assert.equal(ld.description, h.description);
    assert.equal(ld.thumbnailUrl, v.op2.thumbnailUrl);
    assert.equal(ld.uploadDate, v.op2.publishedAt);
    assert.equal(ld.embedUrl, `https://www.youtube-nocookie.com/embed/${v.op2.youtubeVideoId}`);
    assert.deepEqual(ld.isPartOf, { "@type": "TVSeries", name: "One Piece", image: h.og.image, url: "http://app.test/anime/one-piece" });

    const s2 = head((await get("/anime/one-piece/season/2/episode/3")).text);
    assert.equal(s2.title, "One Piece — Temporada 2, Episódio 3 · Crwn Animes");
    assert.equal(s2.canonical, "http://app.test/anime/one-piece/season/2/episode/3");

    const chapter = head((await get("/manga/one-piece/chapter/1100")).text);
    assert.equal(chapter.title, "One Piece — Capítulo 1100 · Crwn Animes");
    assert.equal(chapter.jsonLd[0].isPartOf["@type"], "CreativeWorkSeries");

    // Without a series cover the episode thumbnail is the image.
    srv.db.prepare("UPDATE series SET cover_url = NULL WHERE slug = 'one-piece'").run();
    try {
      const noCover = head((await get("/anime/one-piece/episode/2")).text);
      assert.equal(noCover.og.image, v.op2.thumbnailUrl);
      assert.equal(noCover.twitterCard, "summary_large_image");
      const series = head((await get("/anime/one-piece")).text);
      assert.equal(series.og.image, null);
      assert.equal(series.twitterCard, "summary");
      assert.equal("image" in series.jsonLd[0], false);
    } finally {
      srv.db
        .prepare("UPDATE series SET cover_url = ? WHERE slug = 'one-piece'")
        .run("https://beta.crunchyroll.com/imgsrv/display/thumbnail/1200x675/catalog/crunchyroll/236f44583009506b8d9d012c4d3119a5.jpeg");
    }
  });

  test("hostile series data is escaped everywhere", async () => {
    for (const p of ["/anime/evil", "/anime/evil/episode/1", `/genre/${encodeURIComponent(EVIL_GENRE)}`, "/sitemap.xml"]) {
      const res = await get(p);
      assert.equal(res.status, 200, p);
      assert.equal(res.text.includes(EVIL), false, `${p}: raw name never appears`);
      assert.equal(res.text.includes("<script>alert"), false, p);
      assert.equal(res.text.includes("<img src=x"), false, p);
      assert.equal(res.text.includes(EVIL_GENRE), false, p);
      assert.equal(res.text.includes(EVIL_COVER), false, p);
      if (p === "/sitemap.xml") continue;
      // Exactly the template's module script plus the JSON-LD block (series/episode): nothing broke out.
      const scripts = p.startsWith("/genre/") ? 1 : 2;
      assert.equal(res.text.match(/<script\b/g).length, scripts, p);
      assert.equal(res.text.match(/<\/script>/g).length, scripts, p);
      assert.equal(res.headers.get("content-security-policy"), EXPECTED_CSP, "CSP unchanged (no 'unsafe-inline' scripts)");
    }

    const series = head((await get("/anime/evil")).text);
    assert.equal(series.title, `${EVIL} — Anime · Crwn Animes`, "round-trips once unescaped");
    assert.equal(series.og.image, EVIL_COVER);
    assert.equal(series.jsonLd[0].name, EVIL, "JSON-LD parses back to the original");
    assert.deepEqual(series.jsonLd[0].genre, [EVIL_GENRE]);

    const episode = await get("/anime/evil/episode/1");
    const ld = head(episode.text).jsonLd[0];
    assert.equal(ld.isPartOf.name, EVIL);
    const block = episode.text.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1];
    assert.doesNotMatch(block, /[<>]/, "no < or > inside the JSON-LD block");
    assert.match(block, /\\u003c\/script\\u003e/);

    const genre = head((await get(`/genre/${encodeURIComponent(EVIL_GENRE)}`)).text);
    assert.equal(genre.canonical, `http://app.test/genre/${encodeURIComponent(EVIL_GENRE)}`);
  });

  test("noindex pages", async () => {
    for (const p of [
      "/admin",
      "/admin/videos",
      "/account",
      "/login",
      "/register",
      "/check-email",
      "/verify-email?token=abc",
      "/forgot-password",
      "/reset-password?token=x",
      "/search?q=one",
    ]) {
      const res = await get(p);
      assert.equal(res.status, 200, p);
      const h = head(res.text);
      assert.equal(h.robots, "noindex", p);
      assert.match(h.title, / · Crwn Animes$/, p);
    }
    // An unavailable (but published) episode stays reachable, not indexed.
    const gone = await get("/anime/one-piece/episode/8");
    assert.equal(gone.status, 200);
    assert.equal(head(gone.text).robots, "noindex");
  });

  test("unknown pages are 404 with the SPA shell", async () => {
    for (const p of [
      "/nope",
      "/drama",
      "/anime/nope",
      "/manga/bleach", // series exists, nothing published in manga
      "/anime/naruto-shippuden", // seeded, no videos
      "/anime/one-piece/episode/99",
      "/anime/one-piece/episode/9", // pending
      "/anime/one-piece/season/2/episode/1",
      "/anime/one-piece/chapter/1",
      "/manga/one-piece/episode/1",
      "/manga/one-piece/season/2/chapter/1",
      "/anime/one-piece/episode/abc",
      "/anime/one-piece/season/0/episode/1",
      "/anime/One-Piece",
      "/anime/one-piece/extra",
      "/genre",
      "/login/extra",
      "/%E0%A4%A",
    ]) {
      const res = await get(p);
      assert.equal(res.status, 404, p);
      assert.equal(res.headers.get("cache-control"), "no-cache", p);
      assert.match(res.headers.get("content-type"), /^text\/html/, p);
      const h = head(res.text);
      assert.deepEqual(h.titles, ["Página não encontrada · Crwn Animes"], p);
      assert.equal(h.robots, "noindex", p);
      assert.equal(h.canonical, null, p);
      assert.match(res.text, /<div id="root"><\/div>/, p);
    }
  });

  test("non-canonical watch URLs are 301 to the canonical route", async () => {
    for (const [from, to] of [
      ["/anime/x/episode/01", "/anime/x/episode/1"],
      ["/anime/one-piece/episode/002", "/anime/one-piece/episode/2"],
      ["/anime/one-piece/season/1/episode/2", "/anime/one-piece/episode/2"],
      ["/anime/one-piece/season/02/episode/03?t=30", "/anime/one-piece/season/2/episode/3?t=30"],
      ["/manga/one-piece/chapter/01100", "/manga/one-piece/chapter/1100"],
      ["/anime/one-piece/episode/2/", "/anime/one-piece/episode/2"],
    ]) {
      const res = await raw(srv, from);
      assert.equal(res.status, 301, from);
      assert.equal(res.headers.get("location"), to, from);
    }
  });

  test("assets and paths with an extension stay plain 404s", async () => {
    assert.equal((await get("/assets/index-abc123.js")).status, 200);
    for (const p of ["/assets/missing.js", "/anime/one-piece.map", "/favicon.ico"]) {
      const res = await get(p);
      assert.equal(res.status, 404, p);
      assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8", p);
    }
  });

  test("the template is read once and re-read when the file changes", async () => {
    const file = path.join(dir, "index.html");
    fs.writeFileSync(file, TEMPLATE.replace('<div id="root"></div>', '<div id="root"></div><!-- v2 -->'));
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(file, future, future);
    try {
      const res = await get("/anime");
      assert.match(res.text, /<!-- v2 -->/);
      assert.deepEqual(head(res.text).titles, ["Animes · Crwn Animes"]);
    } finally {
      fs.writeFileSync(file, TEMPLATE);
    }
  });

  test("HEAD works like GET without a body", async () => {
    const res = await fetch(`${srv.base}/anime/one-piece`, { method: "HEAD" });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "");
  });
});

describe("description truncation", () => {
  test("160 chars max, cut on a word boundary with an ellipsis", () => {
    const long = `${"palavra ".repeat(40)}fim`;
    const out = truncate(long);
    assert.ok([...out].length <= 160);
    assert.match(out, /palavra…$/);
    assert.equal(truncate("  curto \n texto "), "curto texto");
    assert.equal(truncate("x".repeat(200)).length, 160, "no space: hard cut");
  });
});

describe("sitemap.xml and robots.txt", () => {
  let srv;
  let v;
  before(async () => {
    // No client/dist: both are still served. An "&" in APP_URL must be escaped.
    srv = await startServer({ config: { appUrl: "https://crwn.example/a&b" } });
    srv.services.repo.createSeries({ slug: "sol", name: "Sol", genres: ["Slice of Life & Drama"] });
    v = {
      op1: await addVideo(srv, 1, "One Piece Episode 1"),
      opS2: await addVideo(srv, 2, "One Piece 2nd Season Episode 3"),
      opManga: await addVideo(srv, 3, "One Piece Chapter 1100 Manga"),
      pending: await addVideo(srv, 4, "Top 10 anime fights"),
      gone: await addVideo(srv, 5, "Bleach Episode 7"),
    };
    srv.services.repo.setAvailability(v.gone.id, "unavailable");
  });
  after(() => srv.close());

  test("lists home, sections, genres, series and published available videos", async () => {
    const res = await srv.client().get("/sitemap.xml");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/xml; charset=utf-8");
    assert.equal(res.headers.get("cache-control"), "public, max-age=3600");
    const xml = res.text;
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
    assert.match(xml, /<\/urlset>\n$/);

    // Well-formed: every & is an entity, no stray < inside text.
    assert.doesNotMatch(xml, /&(?!(amp|lt|gt|quot|apos);)/);
    const locs = [...xml.matchAll(/<url><loc>([^<]*)<\/loc>(?:<lastmod>([^<]*)<\/lastmod>)?<\/url>/g)];
    assert.equal(locs.length, xml.match(/<url>/g).length, "every <url> has the expected shape");
    const urls = locs.map((m) => m[1].replaceAll("&amp;", "&"));
    const base = "https://crwn.example/a&b";
    for (const u of urls) assert.ok(u.startsWith(`${base}/`), u);
    const paths = urls.map((u) => u.slice(base.length));

    for (const p of [
      "/",
      "/anime",
      "/manga",
      "/genre/Shonen",
      "/genre/Slice%20of%20Life%20%26%20Drama",
      "/anime/one-piece",
      "/manga/one-piece",
      "/anime/one-piece/episode/1",
      "/anime/one-piece/season/2/episode/3",
      "/manga/one-piece/chapter/1100",
    ]) {
      assert.ok(paths.includes(p), p);
    }
    assert.equal(paths.includes("/anime/bleach/episode/7"), false, "unavailable video excluded");
    assert.equal(paths.some((p) => p.startsWith("/anime/sol")), false, "series without published videos excluded");
    assert.equal(new Set(paths).size, paths.length, "no duplicates");
    // Pending videos have no route, so nothing beyond the published ones is listed.
    const watchPages = paths.filter((p) => /\/(episode|chapter)\//.test(p));
    assert.deepEqual(watchPages.sort(), ["/anime/one-piece/episode/1", "/anime/one-piece/season/2/episode/3", "/manga/one-piece/chapter/1100"]);

    const lastmod = Object.fromEntries(locs.map((m) => [m[1].replaceAll("&amp;", "&").slice(base.length), m[2]]));
    assert.equal(lastmod["/anime/one-piece/episode/1"], srv.services.repo.getVideo(v.op1.id).publishedAt);
    assert.match(lastmod["/anime/one-piece"], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });

  test("a pending video never shows up, even once it has a route-like slot", async () => {
    srv.db.prepare("UPDATE videos SET status = 'pending' WHERE id = ?").run(v.op1.id);
    try {
      const xml = (await srv.client().get("/sitemap.xml")).text;
      assert.equal(xml.includes("/anime/one-piece/episode/1<"), false);
    } finally {
      srv.db.prepare("UPDATE videos SET status = 'published' WHERE id = ?").run(v.op1.id);
    }
  });

  test("robots.txt", async () => {
    const res = await srv.client().get("/robots.txt");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
    const lines = res.text.split("\n");
    assert.ok(lines.includes("User-agent: *"));
    for (const p of ["/admin", "/account", "/api/"]) assert.ok(lines.includes(`Disallow: ${p}`), p);
    assert.ok(lines.includes("Sitemap: https://crwn.example/a&b/sitemap.xml"));
  });
});
