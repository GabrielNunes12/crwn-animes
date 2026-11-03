// Server-rendered <head> for crawlers and link previews (docs/API.md v1.2),
// plus /sitemap.xml and /robots.txt.
//
// resolvePage(path) works out, from the database, what a front-end path is:
// its status (200 / 301 / 404), title, description, canonical URL, Open Graph
// data and JSON-LD. renderPage() puts that into the built index.html.
//
// Safety: every value that goes into an attribute or element is passed
// through escapeHtml(); JSON-LD goes through jsonForScript(), which escapes
// "<" (and ">", "&", U+2028/9) as \uXXXX so the data can never close the
// <script> element. Nothing is spliced in with String.replace (no "$&"
// surprises): the template is split once and the tags are concatenated.
import fs from "node:fs";
import { SECTIONS } from "./classifier.js";
import { videoRoute } from "./routing.js";
import { SLUG_RE } from "./validation.js";

export const SITE_NAME = "Crwn Animes";
const DESCRIPTION_MAX = 160;
const NOT_FOUND_TITLE = `Página não encontrada · ${SITE_NAME}`;

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

const XML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
export const escapeXml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);

/** JSON that is safe inside <script type="application/ld+json">: no "<", ">" or "&" survive. */
export const jsonForScript = (data) =>
  JSON.stringify(data).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** Collapses whitespace and cuts at `max` characters on a word boundary, adding "…". */
export function truncate(text, max = DESCRIPTION_MAX) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  const chars = [...clean];
  if (chars.length <= max) return clean;
  const cut = chars.slice(0, max - 1).join("");
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?—–-]+$/, "")}…`;
}

// ---------------------------------------------------------------- template

// Tags the template may already carry that every rendered page sets itself.
const OWNED_TAGS = [
  /[ \t]*<meta\b[^>]*\b(?:name|property)\s*=\s*["']?(?:description|robots|og:[\w:]+|twitter:[\w:]+)["']?[^>]*>[ \t]*\r?\n?/gi,
  /[ \t]*<link\b[^>]*\brel\s*=\s*["']?canonical["']?[^>]*>[ \t]*\r?\n?/gi,
  /[ \t]*<script\b[^>]*application\/ld\+json[^>]*>[\s\S]*?<\/script>[ \t]*\r?\n?/gi,
];
const TITLE_RE = /<title\b[^>]*>[\s\S]*?<\/title>/i;

/** Splits index.html where the generated tags go (the old <title> is removed). */
function splitTemplate(html) {
  let stripped = html;
  for (const re of OWNED_TAGS) stripped = stripped.replace(re, "");
  const title = TITLE_RE.exec(stripped);
  if (title) {
    return { before: stripped.slice(0, title.index), after: stripped.slice(title.index + title[0].length) };
  }
  const at = stripped.search(/<\/head>/i);
  const index = at >= 0 ? at : 0;
  return { before: stripped.slice(0, index), after: stripped.slice(index) };
}

/**
 * Reads the built index.html once and keeps it; re-reads it when the file's
 * mtime or size changes (a new deploy). If the file disappears, the last good
 * copy keeps being served.
 */
export function createTemplate(file) {
  let cache = null;
  return () => {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (error) {
      if (cache) return cache.parts;
      throw error;
    }
    if (!cache || cache.mtimeMs !== stat.mtimeMs || cache.size !== stat.size) {
      cache = { mtimeMs: stat.mtimeMs, size: stat.size, parts: splitTemplate(fs.readFileSync(file, "utf8")) };
    }
    return cache.parts;
  };
}

// ---------------------------------------------------------------- pages

// Pages that must never be indexed (title only, pt-BR).
const NOINDEX_PAGES = {
  login: "Entrar",
  register: "Criar conta",
  "check-email": "Confirme seu e-mail",
  "verify-email": "Confirmar e-mail",
  "forgot-password": "Esqueci minha senha",
  "reset-password": "Nova senha",
  account: "Minha conta",
  search: "Buscar",
};

const SECTION_COPY = {
  anime: {
    label: "Anime",
    title: "Animes",
    description: "Todas as séries de anime do Crwn Animes, com episódios organizados por temporada. Assista, avalie e reaja.",
    seriesFallback: (name) => `Assista aos episódios de ${name} no Crwn Animes, organizados por temporada.`,
    jsonLdType: "TVSeries",
  },
  manga: {
    label: "Mangá",
    title: "Mangás",
    description: "Todas as séries de mangá do Crwn Animes, com capítulos em vídeo em ordem. Assista, avalie e reaja.",
    seriesFallback: (name) => `Assista aos capítulos de ${name} em vídeo no Crwn Animes, em ordem.`,
    jsonLdType: "CreativeWorkSeries",
  },
};

const HOME_DESCRIPTION =
  "Episódios de anime e capítulos de mangá do YouTube, organizados por série e temporada. Assista, avalie e reaja no Crwn Animes.";

const NUMBER_RE = /^\d{1,9}$/;

const notFoundPage = () => ({ status: 404, title: NOT_FOUND_TITLE, description: "Esta página não existe no Crwn Animes.", noindex: true });

const page = ({ headline, ...rest }) => ({
  status: 200,
  title: `${headline} · ${SITE_NAME}`,
  headline,
  ogType: "website",
  ...rest,
});

/** Path segments, decoded; null when the path is malformed (bad %-escape, empty segment). */
function segmentsOf(pathname) {
  const raw = pathname.split("/").slice(1);
  if (raw.length > 1 && raw.at(-1) === "") raw.pop(); // one trailing slash is fine
  if (raw.length === 1 && raw[0] === "") return [];
  if (raw.some((s) => s === "")) return null;
  try {
    return raw.map((s) => decodeURIComponent(s));
  } catch {
    return null;
  }
}

/**
 * Resolves a front-end path to page data:
 *   { status: 200|404, title, headline, description, canonicalPath?, ogType, image?, noindex?, jsonLd? }
 *   { status: 301, location }
 */
export function resolvePage(repo, pathname) {
  const seg = segmentsOf(pathname);
  if (!seg) return notFoundPage();
  const [first, second] = seg;

  if (seg.length === 0) {
    return page({
      headline: SITE_NAME,
      title: `${SITE_NAME} · Episódios de anime e capítulos de mangá`,
      description: HOME_DESCRIPTION,
      canonicalPath: "/",
    });
  }
  if (first === "admin") {
    return page({ headline: "Administração", description: HOME_DESCRIPTION, canonicalPath: pathname, noindex: true });
  }
  if (seg.length === 1 && Object.hasOwn(NOINDEX_PAGES, first)) {
    return page({ headline: NOINDEX_PAGES[first], description: HOME_DESCRIPTION, canonicalPath: `/${first}`, noindex: true });
  }
  if (seg.length === 1 && first === "privacy") {
    return page({
      headline: "Política de privacidade",
      description: "Quais dados o Crwn Animes guarda, por quê e por quanto tempo, e como exportar ou apagar sua conta (LGPD / RGPD).",
      canonicalPath: "/privacy",
    });
  }
  if (seg.length === 2 && first === "genre") {
    const genre = repo.listGenres().find((g) => g.toLowerCase() === second.toLowerCase());
    if (!genre) return notFoundPage();
    return page({
      headline: `${genre} · Animes e mangás`,
      description: `Séries de anime e mangá do gênero ${genre} no Crwn Animes. Ordene por nota, novidades ou A–Z.`,
      canonicalPath: genrePath(genre),
    });
  }
  if (!SECTIONS.includes(first)) return notFoundPage();
  const section = first;
  const copy = SECTION_COPY[section];

  if (seg.length === 1) {
    return page({ headline: copy.title, description: copy.description, canonicalPath: `/${section}` });
  }
  if (!SLUG_RE.test(second)) return notFoundPage();
  const slug = second;

  if (seg.length === 2) {
    const series = repo.getSeries(slug);
    if (!series || repo.seriesSectionStats(series.id, section).videoCount === 0) return notFoundPage();
    const canonicalPath = `/${section}/${slug}`;
    const description = truncate(series.synopsis || copy.seriesFallback(series.name));
    return page({
      headline: `${series.name} — ${copy.label}`,
      description,
      canonicalPath,
      ogType: "video.tv_show",
      image: series.coverUrl,
      jsonLd: seriesJsonLd(series, section, description, canonicalPath),
    });
  }

  // Watch pages: /anime/:slug/episode/:n, /anime/:slug/season/:s/episode/:n, /manga/:slug/chapter/:n
  const rest = seg.slice(2);
  let season = 1;
  let number;
  if (section === "anime" && rest.length === 2 && rest[0] === "episode") number = rest[1];
  else if (section === "anime" && rest.length === 4 && rest[0] === "season" && rest[2] === "episode") {
    if (!NUMBER_RE.test(rest[1])) return notFoundPage();
    season = Number(rest[1]);
    number = rest[3];
  } else if (section === "manga" && rest.length === 2 && rest[0] === "chapter") number = rest[1];
  else return notFoundPage();
  if (!NUMBER_RE.test(number) || season < 1) return notFoundPage();
  number = Number(number);

  const canonicalPath = videoRoute({ section, seriesSlug: slug, season, number });
  if (canonicalPath !== pathname) return { status: 301, location: canonicalPath };

  const series = repo.getSeries(slug);
  const video = series && repo.findPublishedVideo({ seriesId: series.id, section, season, number });
  if (!video) return notFoundPage();

  const unit = section === "anime" ? "Episódio" : "Capítulo";
  const where = season > 1 ? `Temporada ${season}, ${unit} ${number}` : `${unit} ${number}`;
  const lead =
    section === "anime"
      ? `Assista ao episódio ${number}${season > 1 ? ` da temporada ${season}` : ""} de ${series.name} no Crwn Animes.`
      : `Assista ao capítulo ${number} de ${series.name} em vídeo no Crwn Animes.`;
  const description = truncate(series.synopsis ? `${lead} ${series.synopsis}` : lead);
  const headline = `${series.name} — ${where}`;
  return page({
    headline,
    description,
    canonicalPath,
    ogType: "video.episode",
    image: series.coverUrl || video.thumbnailUrl,
    // A video YouTube no longer serves stays reachable (series pages grey it out) but is not indexed.
    noindex: video.availability !== "ok",
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "VideoObject",
      name: headline,
      description,
      thumbnailUrl: video.thumbnailUrl,
      ...(video.publishedAt ? { uploadDate: video.publishedAt } : {}),
      embedUrl: `https://www.youtube-nocookie.com/embed/${video.youtubeVideoId}`,
      url: canonicalPath, // made absolute by renderPage
      isPartOf: seriesJsonLd(series, section, null, `/${section}/${slug}`, { context: false }),
    },
  });
}

const genrePath = (genre) => `/genre/${encodeURIComponent(genre)}`;

function seriesJsonLd(series, section, description, path, { context = true } = {}) {
  return {
    ...(context ? { "@context": "https://schema.org" } : {}),
    "@type": SECTION_COPY[section].jsonLdType,
    name: series.name,
    ...(description ? { description } : {}),
    ...(series.coverUrl ? { image: series.coverUrl } : {}),
    ...(context ? { genre: series.genres } : {}),
    url: path,
  };
}

/** Turns relative "url" fields of JSON-LD into absolute ones. */
function absolutize(node, appUrl) {
  if (Array.isArray(node)) return node.map((n) => absolutize(n, appUrl));
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = key === "url" && typeof value === "string" && value.startsWith("/") ? appUrl + value : absolutize(value, appUrl);
  }
  return out;
}

/** The <head> tags of a resolved page, HTML-escaped. */
export function headTags(pageData, appUrl) {
  const canonical = pageData.canonicalPath ? appUrl + pageData.canonicalPath : null;
  const headline = pageData.headline ?? pageData.title;
  const attr = escapeHtml;
  const tags = [
    `<title>${escapeHtml(pageData.title)}</title>`,
    `<meta name="description" content="${attr(pageData.description)}" />`,
  ];
  if (pageData.noindex) tags.push(`<meta name="robots" content="noindex" />`);
  if (canonical && pageData.status === 200) tags.push(`<link rel="canonical" href="${attr(canonical)}" />`);
  tags.push(
    `<meta property="og:site_name" content="${attr(SITE_NAME)}" />`,
    `<meta property="og:locale" content="pt_BR" />`,
    `<meta property="og:type" content="${attr(pageData.ogType ?? "website")}" />`,
    `<meta property="og:title" content="${attr(headline)}" />`,
    `<meta property="og:description" content="${attr(pageData.description)}" />`
  );
  if (canonical && pageData.status === 200) tags.push(`<meta property="og:url" content="${attr(canonical)}" />`);
  if (pageData.image) tags.push(`<meta property="og:image" content="${attr(pageData.image)}" />`);
  tags.push(`<meta name="twitter:card" content="${pageData.image ? "summary_large_image" : "summary"}" />`);
  if (pageData.jsonLd) {
    tags.push(`<script type="application/ld+json">${jsonForScript(absolutize(pageData.jsonLd, appUrl))}</script>`);
  }
  return tags.join("\n    ");
}

/** index.html with the page's head tags in place of the static <title>. */
export function renderPage(template, pageData, appUrl) {
  return template.before + headTags(pageData, appUrl) + template.after;
}

// ---------------------------------------------------------------- sitemap / robots

export function sitemapXml(repo, appUrl) {
  const urls = [];
  const add = (path, lastmod) => urls.push({ loc: appUrl + path, lastmod });
  add("/", repo.latestPublishedAt());
  for (const section of SECTIONS) add(`/${section}`, repo.latestPublishedAt(section));
  for (const genre of repo.listGenres()) add(genrePath(genre), null);
  const { series, videos } = repo.sitemapEntries();
  for (const s of series) add(s.route, s.lastmod);
  for (const v of videos) if (v.route) add(v.route, v.lastmod);

  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'];
  for (const { loc, lastmod } of urls) {
    lines.push(`  <url><loc>${escapeXml(loc)}</loc>${lastmod ? `<lastmod>${escapeXml(lastmod)}</lastmod>` : ""}</url>`);
  }
  lines.push("</urlset>", "");
  return lines.join("\n");
}

export function robotsTxt(appUrl) {
  return ["User-agent: *", "Disallow: /admin", "Disallow: /account", "Disallow: /api/", "", `Sitemap: ${appUrl}/sitemap.xml`, ""].join(
    "\n"
  );
}
