// Shared fixtures and helpers for the e2e suite.
//
// Every browser context gets a network guard: only localhost is reachable.
// youtube.com / youtube-nocookie.com / *.ytimg.com (blocked in the sandbox,
// and slow/flaky in CI anyway) and any other third-party host are cut off;
// images are answered with a 1x1 PNG so thumbnails and covers still "load".
// Every request that was cut off is recorded in `externalRequests`.
import AxeBuilder from "@axe-core/playwright";
import { test as base, expect, request as playwrightRequest } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ADMIN_STATE = path.resolve(here, "../.auth/admin.json");
/**
 * The API's own origin. It also serves the e2e client build with the
 * server-rendered SEO head (see CLIENT_DIST in playwright.config.js); `vite preview` (baseURL)
 * only serves the static bundle, so SEO checks must request this origin.
 */
export const API_ORIGIN = `http://localhost:${Number(process.env.E2E_API_PORT || 4517)}`;
/**
 * The fake i.ytimg.com the e2e API fetches thumbnails from (THUMB_UPSTREAM, see
 * e2e/fake-thumb-upstream.mjs). `GET /__hits?id=<id>` says how often the API asked for an id.
 */
export const THUMB_UPSTREAM = `http://127.0.0.1:${Number(process.env.E2E_THUMB_PORT || 4617)}`;
/** The JPEG the fake upstream serves is 160×90: a loaded thumbnail of that width came through it. */
export const FAKE_THUMB_WIDTH = 160;

/** How many times the API fetched this YouTube id from the (fake) upstream. */
export async function upstreamHits(request, id) {
  const res = await request.get(`${THUMB_UPSTREAM}/__hits?id=${encodeURIComponent(id)}`);
  expect(res.ok(), "fake thumbnail upstream is running").toBeTruthy();
  return (await res.json()).hits;
}
export const ADMIN = { email: "admin@e2e.test", password: "admin-e2e-password-123", displayName: "E2E Admin" };

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
export const YOUTUBE_HOST = /(^|\.)(youtube\.com|youtube-nocookie\.com|ytimg\.com|googlevideo\.com|ggpht\.com)$/i;

/** Blocks every non-local request of a browser context; returns the list of blocked URLs. */
export async function guardNetwork(context) {
  const blocked = [];
  await context.route(
    (url) => !LOCAL_HOSTS.has(url.hostname),
    async (route) => {
      const req = route.request();
      blocked.push(req.url());
      if (req.resourceType() === "image") {
        await route.fulfill({ status: 200, contentType: "image/png", body: TINY_PNG });
      } else {
        await route.abort("blockedbyclient");
      }
    }
  );
  return blocked;
}

/** A new browser context with the network guard (for a second "device"). */
export async function newGuardedContext(browser, options = {}) {
  const context = await browser.newContext({ locale: "pt-BR", ...options });
  context.blockedRequests = await guardNetwork(context);
  return context;
}

let counter = 0;
/** A unique, valid e-mail address (also unique across workers and runs). */
export function uniqueEmail(prefix = "user") {
  counter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${process.pid}-${Date.now().toString(36)}-${counter}${rand}@e2e.test`.toLowerCase();
}

/** An 11-char fake YouTube ID (the server never looks it up when a title is given). */
export function fakeYouTubeId(prefix = "e2e") {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  let id = prefix.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 6);
  while (id.length < 11) id += alphabet[Math.floor(Math.random() * alphabet.length)];
  return id;
}

/**
 * Waits for an e-mail in GET /api/dev/outbox and returns it.
 * `after` (ms epoch) ignores older messages, `subject` is a RegExp.
 */
export async function waitForEmail(request, { to, subject, after = 0 }) {
  let found = null;
  await expect
    .poll(
      async () => {
        const res = await request.get("/api/dev/outbox");
        expect(res.ok(), "GET /api/dev/outbox must exist (NODE_ENV != production, no SMTP)").toBeTruthy();
        const mails = await res.json();
        found =
          mails
            .filter((m) => m.to === to && (!subject || subject.test(m.subject)) && Date.parse(m.sentAt) >= after)
            .at(-1) ?? null;
        return Boolean(found);
      },
      { message: `e-mail to ${to} matching ${subject}`, timeout: 10_000 }
    )
    .toBe(true);
  return found;
}

/** The tokenised link inside an e-mail (text version). */
export function linkFrom(mail) {
  const link = mail.text.match(/https?:\/\/\S+[?&]token=[^\s]+/)?.[0];
  expect(link, `a ?token= link in "${mail.subject}"`).toBeTruthy();
  return link;
}

export const SUBJECT = {
  verify: /Confirme seu e-mail|Confirm your e-mail/,
  reset: /Redefina sua senha|Reset your Crwn Animes password/,
};

/** POSTs JSON and fails the test with the server's error body on a non-2xx. */
export async function api(request, method, url, data, { expectStatus } = {}) {
  const res = await request.fetch(url, { method, data });
  if (expectStatus != null) {
    expect(res.status(), `${method} ${url} → ${await res.text()}`).toBe(expectStatus);
  } else if (!res.ok()) {
    throw new Error(`${method} ${url} failed: ${res.status()} ${await res.text()}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/**
 * Registers an account through the API and (unless verify === false) verifies
 * it with the e-mailed token + password (API contract v1.1). When `request`
 * belongs to a browser context (page.request), that context ends up logged in.
 */
export async function createUser(request, { email = uniqueEmail(), password = "correct-horse-battery", displayName = "Tester", verify = true } = {}) {
  const startedAt = Date.now() - 1000;
  await api(request, "POST", "/api/auth/register", { email, password, displayName, acceptPrivacy: true }, { expectStatus: 201 });
  const mail = await waitForEmail(request, { to: email, subject: SUBJECT.verify, after: startedAt });
  const link = linkFrom(mail);
  if (verify) {
    const token = new URL(link).searchParams.get("token");
    await api(request, "POST", "/api/auth/verify-email", { token, password }, { expectStatus: 200 });
  }
  return { email, password, displayName, verifyLink: link };
}

/** Logs a browser context in through the API (sets the sid cookie). */
export async function loginViaApi(request, { email, password }) {
  return api(request, "POST", "/api/auth/login", { email, password }, { expectStatus: 200 });
}

/**
 * Every item of a paginated admin list (`{ items, total }`, API v1.3):
 * GET /api/admin/videos or /api/admin/series, following limit/offset to the end.
 * `params` are extra query parameters (q, status, availability).
 */
export async function listAll(admin, endpoint, params = {}) {
  const items = [];
  for (let offset = 0; ; offset += 100) {
    const query = new URLSearchParams({ ...params, limit: "100", offset: String(offset) });
    const res = await admin.get(`${endpoint}?${query}`);
    if (!res.ok()) throw new Error(`GET ${endpoint}?${query} → ${res.status()} ${await res.text()}`);
    const page = await res.json();
    expect(page, `${endpoint} returns { items, total }`).toMatchObject({ items: expect.any(Array), total: expect.any(Number) });
    items.push(...page.items);
    if (page.items.length === 0 || offset + 100 >= page.total) return items;
  }
}

/** Creates a series (or returns the existing one with that slug). */
export async function ensureSeries(admin, { name, slug, aliases = [], genres = [], synopsis = null }) {
  const res = await admin.post("/api/admin/series", { data: { name, slug, aliases, genres, synopsis } });
  if (res.status() === 201) return (await res.json()).series;
  if (res.status() === 409) {
    const found = (await listAll(admin, "/api/admin/series", { q: name })).find((s) => s.slug === slug);
    return found ?? (await listAll(admin, "/api/admin/series")).find((s) => s.slug === slug);
  }
  throw new Error(`POST /api/admin/series → ${res.status()} ${await res.text()}`);
}

/** Adds a video by title (no oEmbed lookup) or returns the existing one. */
export async function ensureVideo(admin, { youtubeId, title, ...overrides }) {
  const res = await admin.post("/api/admin/videos", { data: { url: `https://youtu.be/${youtubeId}`, title, ...overrides } });
  if (res.status() === 201) return (await res.json()).video;
  if (res.status() === 409) return (await res.json()).error.details.video;
  throw new Error(`POST /api/admin/videos → ${res.status()} ${await res.text()}`);
}

/**
 * Runs `fn(admin)` with a fresh API client logged in as admin@e2e.test, for
 * test.beforeAll() seeding (the test-scoped `admin` fixture is not available there).
 */
export async function asAdmin(testInfo, fn) {
  const ctx = await playwrightRequest.newContext({ baseURL: testInfo.project.use.baseURL, storageState: ADMIN_STATE });
  try {
    return await fn(ctx);
  } finally {
    await ctx.dispose();
  }
}

/**
 * Creates a series (idempotent) and places each video explicitly in it:
 * videos = [{ youtubeId, title, section, number, season? }]. Fails unless every
 * video ends up published. Safe to run concurrently from several workers.
 */
export async function seedSeries(admin, series, videos = []) {
  const created = await ensureSeries(admin, series);
  const placed = [];
  for (const { youtubeId, title, section, number, season = 1 } of videos) {
    const video = await ensureVideo(admin, { youtubeId, title, section, seriesSlug: series.slug, season, number });
    expect(video.status, `${youtubeId} (${title}) must be published, got ${JSON.stringify(video.classification?.reasons)}`).toBe("published");
    placed.push(video);
  }
  return { series: created, videos: placed };
}

/** The logged-in user's name as shown in the header's account menu. */
export const headerUser = (page, displayName) => page.getByRole("banner").getByText(displayName, { exact: true });
/** The header's "Entrar" link (only shown when logged out). */
export const headerLogin = (page) => page.getByRole("banner").getByRole("link", { name: "Entrar", exact: true });

/** axe-core with the WCAG 2.x A/AA + best-practice rule sets the suite checks. */
export const axe = (page) => new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]);

/** Runs axe and fails on serious/critical violations, with a readable message. */
export async function expectNoSeriousViolations(page, name, builder = axe(page)) {
  const results = await builder.analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  const report = serious
    .map((v) => `[${v.impact}] ${v.id}: ${v.help}\n${v.nodes.slice(0, 5).map((n) => `    ${n.target.join(" ")} — ${n.failureSummary?.split("\n").slice(0, 2).join(" ")}`).join("\n")}`)
    .join("\n");
  expect(serious, `${name}: serious/critical axe violations\n${report}`).toEqual([]);
}

export const test = base.extend({
  // Every context (and so every page) gets the network guard.
  context: async ({ context }, use) => {
    context.blockedRequests = await guardNetwork(context);
    await use(context);
  },
  /** URLs of every blocked third-party request made by the default context. */
  externalRequests: async ({ context }, use) => {
    await use(context.blockedRequests);
  },
  /** An API client logged in as admin@e2e.test (created by global.setup.js). */
  admin: async ({ baseURL }, use) => {
    const ctx = await playwrightRequest.newContext({ baseURL, storageState: ADMIN_STATE });
    await use(ctx);
    await ctx.dispose();
  },
});

export { expect };
