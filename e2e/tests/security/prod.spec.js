// Security sweep #3: this run's REAL client build (e2e/.client-dist) served by
// the real server in PRODUCTION mode (NODE_ENV=production, https APP_URL, SMTP
// configured, TRUST_PROXY=1), driven by Chromium. The rest of the suite browses
// the bundle through `vite preview`, which sends no CSP; here every page runs
// under the documented production CSP and headers.
//   - every file of the build gets the documented caching; nothing else is served;
//   - anonymous and logged-in pages raise no CSP violation, no page error and no
//     failed same-origin request;
//   - logging in through the real form gives a Secure + HttpOnly + Lax cookie.
// The private server's database is seeded (one admin) through the server's own
// modules before boot: production has no dev outbox to read e-mails from.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, headerUser } from "../fixtures.js";
import { SERVER_DIR, freePort, postJson, rawRequest, startPrivateApi, test } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, "../../.client-dist");
const ADMIN = { email: "prod-admin@e2e.test", password: "prod-admin-password-123" };
const SERIES = { name: "Prod Csp Saga", genre: "Produção" };

test.describe.configure({ mode: "serial" });

let api;
let dbFile;
let seeded;

test.beforeAll(async () => {
  dbFile = path.join(os.tmpdir(), `crwn-animes-prod-${process.pid}-${Date.now()}.db`);
  const seed = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { openDatabase } from "./src/db.js";
       import { hashPassword } from "./src/crypto.js";
       const db = openDatabase(process.env.DATABASE_FILE);
       const now = new Date().toISOString();
       db.prepare("INSERT INTO users (email, display_name, password_hash, role, email_verified_at, privacy_accepted_at, created_at) VALUES (?, 'Prod Admin', ?, 'admin', ?, ?, ?)")
         .run(process.env.SEED_EMAIL, await hashPassword(process.env.SEED_PASSWORD), now, now, now);
       db.close();`,
    ],
    { cwd: SERVER_DIR, env: { ...process.env, DATABASE_FILE: dbFile, SEED_EMAIL: ADMIN.email, SEED_PASSWORD: ADMIN.password }, encoding: "utf8" }
  );
  expect(seed.status, seed.stderr).toBe(0);

  api = await startPrivateApi({
    NODE_ENV: "production",
    DATABASE_FILE: dbFile,
    CLIENT_DIST: DIST,
    APP_URL: "https://crwn.example",
    CLIENT_ORIGIN: "https://crwn.example",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(await freePort()), // closed: no e-mail is needed here, failures are only logged
    TRUST_PROXY: "1",
  });

  // Catalog content through the admin API (raw requests: the Secure cookie is handled by hand).
  const login = await postJson(api.origin, "/api/auth/login", ADMIN);
  expect(login.status, login.body).toBe(200);
  const cookie = [].concat(login.headers["set-cookie"]).find((c) => c.startsWith("sid=")).split(";")[0];
  const asAdmin = (p, data) => postJson(api.origin, p, data, { cookie });
  expect((await asAdmin("/api/admin/series", { name: SERIES.name, genres: [SERIES.genre], synopsis: "Uma saga só para o teste de produção." })).status).toBe(201);
  const episode = await asAdmin("/api/admin/videos", { url: "prodCspEp01", title: `${SERIES.name} Episode 1` });
  const chapter = await asAdmin("/api/admin/videos", { url: "prodCspCh01", title: `${SERIES.name} Chapter 1` });
  expect([episode.status, chapter.status]).toEqual([201, 201]);
  seeded = { episode: JSON.parse(episode.body).video, chapter: JSON.parse(chapter.body).video };
  expect(seeded.episode.route).toBeTruthy();
  expect(seeded.chapter.route).toBeTruthy();
});

test.afterAll(async () => {
  await api?.stop();
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(dbFile + suffix, { force: true });
});

/** Records CSP violations (DOM event + console), page errors and failed same-origin requests of a page. */
async function watch(page, origin) {
  const problems = [];
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      window.__csp = window.__csp || [];
      window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  page.on("console", (msg) => {
    if (/Content Security Policy|Refused to (load|execute|apply|frame|connect)/i.test(msg.text())) problems.push(`console: ${msg.text()}`);
  });
  page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));
  page.on("requestfailed", (req) => {
    if (req.url().startsWith(origin)) problems.push(`failed: ${req.url()} ${req.failure()?.errorText}`);
  });
  page.on("response", (res) => {
    const url = new URL(res.url());
    if (url.origin === origin && !url.pathname.startsWith("/api/") && res.request().resourceType() !== "document" && res.status() >= 400) {
      problems.push(`${res.status()}: ${url.pathname}`);
    }
  });
  return {
    problems,
    async collect() {
      const csp = await page.evaluate(() => window.__csp || []).catch(() => []);
      return [...problems, ...csp.map((v) => `csp: ${v}`)];
    },
  };
}

/** Every file under `dir`, as POSIX paths relative to it. */
function filesOf(dir, prefix = "") {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesOf(path.join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]
  );
}

test.describe("production build served in production mode", () => {
  test("every built file gets the documented caching: hashed /assets immutable, root files revalidated, index.html → 301; no source maps", async () => {
    const files = filesOf(DIST);
    expect(files.length).toBeGreaterThan(5);
    expect(files.filter((f) => f.endsWith(".map")), "no source maps are shipped").toEqual([]);
    for (const file of files) {
      const res = await rawRequest({ origin: api.origin, path: `/${file}` });
      if (file === "index.html") {
        expect(res.status, file).toBe(301);
        expect(res.headers.location).toBe("/");
        continue;
      }
      expect(res.status, file).toBe(200);
      expect(res.headers["strict-transport-security"], file).toMatch(/max-age=\d{7,}/);
      expect(res.headers["x-content-type-options"], file).toBe("nosniff");
      if (file.startsWith("assets/")) expect(res.headers["cache-control"], file).toBe("public, max-age=31536000, immutable");
      else expect(res.headers["cache-control"] ?? "", `${file} has no content hash`).not.toMatch(/immutable|max-age=[1-9]/);
    }
    // Every file the rendered page references exists (a broken deploy would 404 here, never serve the SPA shell).
    const html = (await rawRequest({ origin: api.origin, path: "/" })).body;
    const refs = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]).filter((p) => !p.startsWith("//"));
    expect(refs.length).toBeGreaterThan(1);
    for (const ref of refs) expect((await rawRequest({ origin: api.origin, path: ref })).status, ref).toBe(200);
  });

  test("anonymous pages run under the production CSP: no violation, no page error, no failed same-origin request", async ({ page }) => {
    const watcher = await watch(page, api.origin);
    const pages = ["/", "/anime", "/manga", `/anime/${seeded.episode.seriesSlug}`, seeded.episode.route, seeded.chapter.route, `/genre/${encodeURIComponent(SERIES.genre)}`, "/search?q=prod", "/login", "/register", "/forgot-password", "/privacy", "/nao-existe"];
    for (const p of pages) {
      const res = await page.goto(api.origin + p, { waitUntil: "networkidle" });
      expect(res.status(), p).toBe(p === "/nao-existe" ? 404 : 200);
      await expect(page.locator("#root")).not.toBeEmpty();
    }
    expect(await watcher.collect()).toEqual([]);
    // The watcher is not blind: an injected inline script is a violation it reports.
    await page.evaluate(() => {
      const s = document.createElement("script");
      s.textContent = "window.__inlineRan = true";
      document.head.append(s);
    });
    await expect.poll(async () => (await watcher.collect()).some((p) => /script-src/.test(p))).toBe(true);
    expect(await page.evaluate(() => window.__inlineRan ?? false)).toBe(false);
  });

  test("logging in through the real form: Secure + HttpOnly + Lax cookie; account and admin pages run under the CSP", async ({ page, context }) => {
    const watcher = await watch(page, api.origin);
    await page.goto(`${api.origin}/login`);
    await page.getByLabel("E-mail", { exact: true }).fill(ADMIN.email);
    await page.getByLabel("Senha", { exact: true }).fill(ADMIN.password);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await expect.poll(async () => (await context.cookies(api.origin)).find((c) => c.name === "sid")?.value ?? null).not.toBeNull();
    const sid = (await context.cookies(api.origin)).find((c) => c.name === "sid");
    expect({ secure: sid.secure, httpOnly: sid.httpOnly, sameSite: sid.sameSite, path: sid.path }).toEqual({ secure: true, httpOnly: true, sameSite: "Lax", path: "/" });
    expect(await page.evaluate(() => document.cookie)).not.toContain("sid=");

    for (const p of ["/account", "/admin", seeded.episode.route]) {
      await page.goto(api.origin + p, { waitUntil: "networkidle" });
      await expect(headerUser(page, "Prod Admin")).toBeVisible();
    }
    // Play loads YouTube's IFrame API: the CSP (script-src) must let the request out; the
    // network guard is what blocks it (a CSP block would never reach the network).
    await page.getByRole("button", { name: `Reproduzir: ${SERIES.name} Episode 1` }).click();
    await expect.poll(() => context.blockedRequests.some((u) => u.startsWith("https://www.youtube.com/iframe_api"))).toBe(true);
    expect(await watcher.collect()).toEqual([]);
  });
});
