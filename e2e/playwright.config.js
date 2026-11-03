// Playwright e2e suite for Crwn Animes.
//
// Starts BOTH apps on dedicated ports (so a developer's own `npm run dev` on
// :4000/:5173 is never reused or disturbed):
//   - the API (server/) with a fresh SQLite file under os.tmpdir(), the dev
//     outbox enabled (no SMTP), admin@e2e.test as admin and a huge rate limit;
//   - the client (client/), built with Vite and served by `vite preview`,
//     whose /api proxy points at that API (see vite.e2e.config.mjs).
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
const baseURL = `http://localhost:${CLIENT_PORT}`;

// One database per `playwright test` invocation. The config is also loaded by
// every worker, so only the main process (the one that starts webServer) picks
// a new file; workers inherit it through the environment.
if (!process.env.E2E_DATABASE_FILE) {
  process.env.E2E_DATABASE_FILE = path.join(os.tmpdir(), `crwn-animes-e2e-${process.pid}-${Date.now()}.db`);
}
const databaseFile = process.env.E2E_DATABASE_FILE;

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
    {
      name: "api",
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
        DATABASE_FILE: databaseFile,
        APP_URL: baseURL,
        CLIENT_ORIGIN: baseURL,
        ADMIN_EMAILS: "admin@e2e.test",
        RATE_LIMIT_MAX: "100000",
        SMTP_HOST: "",
        TRUST_PROXY: "",
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
  ],
});
