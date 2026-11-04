// Playwright e2e suite for Crwn Animes.
//
// Starts BOTH apps on dedicated ports (so a developer's own `npm run dev` on
// :4000/:5173 is never reused or disturbed), plus a fake thumbnail upstream:
//   - the API (server/) with a fresh SQLite file under os.tmpdir(), the dev
//     outbox enabled (no SMTP), admin@e2e.test as admin and a huge rate limit;
//   - the client (client/), built with Vite into e2e/.client-dist and served
//     by `vite preview`, whose /api proxy points at that API (see
//     vite.e2e.config.mjs). The API also serves that build itself, with the
//     server-rendered SEO head (docs/API.md v1.2): seo.spec.js requests pages
//     from the API's own origin (API_ORIGIN in tests/fixtures.js);
//   - fake-thumb-upstream.mjs, a stand-in for i.ytimg.com: the API's same-origin
//     thumbnails (GET /api/thumbs/<id>.jpg, docs/API.md v1.5) are fetched from it
//     (THUMB_UPSTREAM) and cached in a fresh temp dir (THUMB_CACHE_DIR).
//
// The client build is a PRODUCTION build, so it registers the service worker
// (/sw.js). Service workers are blocked for every spec (`serviceWorkers: "block"`):
// the worker would answer catalog requests from its stale-while-revalidate cache
// (a spec that edits data would see the old copy) and hide requests from
// page.route(). Only tests/pwa.spec.js allows them.
//
// Run from the repo root with `npm run e2e`, or `npx playwright test` in e2e/.
import { defineConfig, devices } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

export const API_PORT = Number(process.env.E2E_API_PORT || 4517);
export const CLIENT_PORT = Number(process.env.E2E_CLIENT_PORT || 5517);
export const THUMB_PORT = Number(process.env.E2E_THUMB_PORT || 4617);
const baseURL = `http://localhost:${CLIENT_PORT}`;

// One database per `playwright test` invocation. The config is also loaded by
// every worker, so only the main process (the one that starts webServer) picks
// a new file; workers inherit it through the environment.
if (!process.env.E2E_DATABASE_FILE) {
  process.env.E2E_DATABASE_FILE = path.join(os.tmpdir(), `crwn-animes-e2e-${process.pid}-${Date.now()}.db`);
}
const databaseFile = process.env.E2E_DATABASE_FILE;
// Same for the thumbnail disk cache: an empty directory per run (the API creates it).
if (!process.env.E2E_THUMB_CACHE_DIR) {
  process.env.E2E_THUMB_CACHE_DIR = path.join(os.tmpdir(), `crwn-animes-e2e-thumbs-${process.pid}-${Date.now()}`);
}
const thumbCacheDir = process.env.E2E_THUMB_CACHE_DIR;

// The sandbox ships a pre-installed Chromium; CI installs its own with
// `npx playwright install --with-deps chromium` and leaves this undefined.
const LOCAL_CHROMIUM = "/opt/pw-browsers/chromium";
const executablePath =
  process.env.PW_CHROMIUM_PATH || (fs.existsSync(LOCAL_CHROMIUM) ? LOCAL_CHROMIUM : undefined);

const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./tests",
  outputDir: "./test-results",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: isCI,
  retries: 0, // a flaky test is a bug (in the test or the app), not something to retry away
  workers: isCI ? 2 : 3,
  reporter: isCI ? [["list"], ["html", { open: "never" }], ["github"]] : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    locale: "pt-BR", // the app's default language; tests use pt-BR accessible names
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: executablePath ? { executablePath } : {},
    // See the header: only tests/pwa.spec.js opts back in with test.use({ serviceWorkers: "allow" }).
    serviceWorkers: "block",
  },
  projects: [
    { name: "setup", testMatch: /global\.setup\.js/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], locale: "pt-BR", launchOptions: executablePath ? { executablePath } : {} },
      dependencies: ["setup"],
    },
  ],
  webServer: [
    // The fake i.ytimg.com (no dependencies; see the file's header).
    {
      name: "thumbs",
      command: "node fake-thumb-upstream.mjs",
      cwd: here,
      url: `http://127.0.0.1:${THUMB_PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 15_000,
      stdout: "ignore",
      stderr: "pipe",
      env: { E2E_THUMB_PORT: String(THUMB_PORT) },
    },
    // The client is built and served FIRST: the API serves that same build
    // (with its server-rendered SEO tags, for seo.spec.js), so the bundle must
    // exist before the API starts. Playwright starts web servers in order.
    {
      name: "client",
      // Build once, then serve the bundle with `vite preview` (same /api proxy
      // as `npm run dev`, but no HMR or dependency re-optimisation reloads).
      command:
        "npm run build -- --config ../e2e/vite.e2e.config.mjs --logLevel warn && npm run preview -- --config ../e2e/vite.e2e.config.mjs",
      cwd: path.join(root, "client"),
      url: baseURL,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
      env: { E2E_API_PORT: String(API_PORT), E2E_CLIENT_PORT: String(CLIENT_PORT), BROWSER: "none" },
    },
    {
      name: "api",
      // The real server entry point, serving the bundle this run built (CLIENT_DIST).
      command: "node src/index.js",
      cwd: path.join(root, "server"),
      url: `http://localhost:${API_PORT}/api/auth/me`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: "ignore",
      stderr: "pipe",
      env: {
        NODE_ENV: "test",
        PORT: String(API_PORT),
        CLIENT_DIST: path.join(root, "e2e", ".client-dist"),
        DATABASE_FILE: databaseFile,
        APP_URL: baseURL,
        CLIENT_ORIGIN: baseURL,
        ADMIN_EMAILS: "admin@e2e.test",
        RATE_LIMIT_MAX: "100000",
        // The per-IP limit on image cache misses (v1.5) is its own setting, not RATE_LIMIT_MAX:
        // every e2e request comes from one loopback address, and a run loads hundreds of new
        // thumbnails. Its 429 is tested on a private instance (pwa.spec.js).
        IMAGE_MISS_RATE_MAX: "100000",
        SMTP_HOST: "",
        TRUST_PROXY: "",
        // Same-origin thumbnails (v1.5): fetched from the fake upstream (127.0.0.1 is in
        // NO_PROXY below), cached in this run's own temp dir. THUMB_UPSTREAM is refused in
        // production, so this only works because NODE_ENV is "test".
        THUMB_UPSTREAM: `http://127.0.0.1:${THUMB_PORT}`,
        THUMB_CACHE_DIR: thumbCacheDir,
        // The server must never reach YouTube during e2e: route its fetch()
        // through a closed port so oEmbed (and the background health check
        // that would mark fake IDs "unavailable" on a networked CI runner)
        // fail as plain network errors, which leave videos untouched.
        NODE_USE_ENV_PROXY: "1",
        HTTPS_PROXY: "http://127.0.0.1:9",
        https_proxy: "http://127.0.0.1:9",
        HTTP_PROXY: "http://127.0.0.1:9",
        http_proxy: "http://127.0.0.1:9",
        NO_PROXY: "localhost,127.0.0.1",
        no_proxy: "localhost,127.0.0.1",
        NODE_NO_WARNINGS: "1",
      },
    },
  ],
});
