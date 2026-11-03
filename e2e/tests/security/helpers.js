// Shared helpers for the security specs (e2e/tests/security/*.spec.js).
// Not a spec file itself (Playwright only collects *.spec.js).
import { request as playwrightRequest, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { API_ORIGIN, ADMIN, createUser, uniqueEmail, test as baseTest } from "../fixtures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_DIR = path.resolve(here, "../../../server");
export const API_PORT = Number(new URL(API_ORIGIN).port);

/** Elements that only exist if an injected payload was parsed as HTML. */
export const INJECTED = 'img[src="x"], svg[onload], [onerror], [onload], a[href^="javascript:" i], iframe[src^="javascript:" i], script:not([src]):not([type="application/ld+json"])';

/** Records every alert/confirm/prompt a page opens (and dismisses it). */
export function trapDialogs(page) {
  const dialogs = [];
  page.on("dialog", async (d) => {
    dialogs.push(`${d.type()}: ${d.message()}`);
    await d.dismiss().catch(() => {});
  });
  return dialogs;
}

/** An API client (not a browser) talking straight to the API origin. */
export function apiClient(extra = {}) {
  return playwrightRequest.newContext({ baseURL: API_ORIGIN, ...extra });
}

/** A fresh, verified, logged-in user with its own API client: { ctx, user, me }. */
export async function newUserClient({ displayName = "Sec Tester", ...rest } = {}) {
  const ctx = await apiClient();
  const user = await createUser(ctx, { email: uniqueEmail("sec"), displayName, ...rest });
  const me = (await (await ctx.get("/api/auth/me")).json()).user;
  return { ctx, user, me };
}

/** A NEW admin session (its own sid; never touches the shared admin session in .auth/). */
export async function newAdminClient() {
  const ctx = await apiClient();
  const res = await ctx.post("/api/auth/login", { data: { email: ADMIN.email, password: ADMIN.password } });
  expect(res.status(), "admin login").toBe(200);
  return ctx;
}

/** The sid value a request/browser context currently holds for localhost (or null). */
export async function sidOf(ctx) {
  const state = await ctx.storageState();
  return state.cookies.find((c) => c.name === "sid")?.value ?? null;
}

/** GET /api/auth/me with only the given sid cookie (null = anonymous). */
export async function whoIs(sid) {
  const res = await rawRequest({ path: "/api/auth/me", headers: sid ? { cookie: `sid=${sid}` } : {} });
  return JSON.parse(res.body).user;
}

/**
 * A raw HTTP request (node:http), so paths are sent byte-for-byte (no URL
 * normalisation of "..", "%2e", "\\") and any header (Host, Origin) can be set.
 */
export function rawRequest({ origin = API_ORIGIN, method = "GET", path: p = "/", headers = {}, body = null }) {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: url.hostname, port: url.port, method, path: p, headers: { ...(body != null ? { "content-length": Buffer.byteLength(body) } : {}), ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      }
    );
    req.on("error", reject);
    req.setTimeout(15_000, () => req.destroy(new Error(`timeout: ${method} ${p}`)));
    if (body != null) req.write(body);
    req.end();
  });
}

/**
 * A tiny "attacker" web server on its own port. It is reachable both as
 * http://127.0.0.1:<port> (a different SITE from localhost: SameSite cookies
 * are not sent on cross-site subrequests/POSTs) and http://localhost:<port>
 * (same site, different ORIGIN). `pages` maps a path to an HTML string.
 */
export async function startAttackerServer() {
  const pages = new Map();
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const pathname = new URL(req.url, "http://x").pathname;
      hits.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString("utf8") });
      const html = pages.get(pathname);
      if (html == null) {
        res.writeHead(404, { "content-type": "text/plain" });
        return res.end("nope");
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
    });
  });
  await new Promise((resolve) => server.listen(0, resolve)); // dual-stack: 127.0.0.1 and ::1
  const port = server.address().port;
  return {
    pages,
    hits,
    crossSite: `http://127.0.0.1:${port}`,
    sameSite: `http://localhost:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** An HTML page with a form that submits itself (a classic CSRF page). */
export function autoSubmitForm({ action, enctype = "application/x-www-form-urlencoded", fields = [] }) {
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const inputs = fields.map(([name, value]) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`).join("");
  return `<!doctype html><html><body><form id="f" method="POST" action="${esc(action)}" enctype="${esc(enctype)}">${inputs}</form>
<script>document.getElementById("f").submit();</script></body></html>`;
}

/** A free TCP port on localhost. */
export async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

/**
 * Starts a SECOND, private instance of the real API (own temp database, own
 * port) with extra env, e.g. a low RATE_LIMIT_MAX. Returns { origin, stop }.
 */
export async function startPrivateApi(env = {}) {
  const port = await freePort();
  const origin = `http://localhost:${port}`;
  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: SERVER_DIR,
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      DATABASE_FILE: path.join(os.tmpdir(), `crwn-animes-sec-${process.pid}-${port}-${Date.now()}.db`),
      APP_URL: origin,
      CLIENT_ORIGIN: origin,
      ADMIN_EMAILS: "",
      SMTP_HOST: "",
      TRUST_PROXY: "",
      CLIENT_DIST: path.join(os.tmpdir(), "crwn-animes-sec-no-client"),
      HTTPS_PROXY: "http://127.0.0.1:9",
      HTTP_PROXY: "http://127.0.0.1:9",
      NODE_USE_ENV_PROXY: "1",
      NO_PROXY: "localhost,127.0.0.1",
      NODE_NO_WARNINGS: "1",
      ...env,
    },
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await rawRequest({ origin, path: "/api/auth/me" });
      if (res.status === 200) break;
    } catch {
      // not listening yet
    }
    if (child.exitCode != null || Date.now() > deadline) {
      child.kill();
      throw new Error(`private API did not start: ${stderr}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    origin,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode != null) return resolve();
        child.once("exit", resolve);
        child.kill("SIGTERM");
      }),
  };
}

/** POST JSON with a raw request (to a private API instance). */
export function postJson(origin, p, data, headers = {}) {
  return rawRequest({ origin, method: "POST", path: p, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(data) });
}

/**
 * Runs `fn(admin)` with a fresh admin session made by logging in with the
 * password (not .auth/admin.json, which a concurrent run may overwrite).
 */
export async function withAdmin(fn) {
  const ctx = await newAdminClient();
  try {
    return await fn(ctx);
  } finally {
    await ctx.dispose();
  }
}

/**
 * The suite's `test`, with `admin` overridden: an admin API client with its OWN
 * session (password login) instead of .auth/admin.json, so these specs stay
 * correct when another Playwright run shares the e2e/.auth folder.
 */
export const test = baseTest.extend({
  admin: async ({}, use) => {
    const ctx = await newAdminClient();
    await use(ctx);
    await ctx.dispose();
  },
});
