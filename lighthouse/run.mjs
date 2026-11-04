#!/usr/bin/env node
// Lighthouse CI for Crwn Animes (docs/API.md v1.7, "performance budget").
//
//   1. builds the client (production `vite build`) into lighthouse/.client-dist;
//   2. starts e2e/fake-thumb-upstream.mjs (a stand-in for i.ytimg.com) and the REAL API
//      (server/src/index.js) serving that build with its server-rendered SEO head. Not
//      NODE_ENV=production (that needs SMTP and an https APP_URL): the same non-production
//      setup as e2e — temp SQLite file and thumbnail cache, dev outbox, high rate limits,
//      THUMB_UPSTREAM pointing at the fake, every other outbound request of the API sent to
//      a closed port (it never reaches YouTube);
//   3. seeds through the HTTP API: an admin (ADMIN_EMAILS) registered and verified via
//      /api/dev/outbox, an anime series with episodes, a manga series with chapters and a
//      few verified viewers' ratings;
//   4. runs `lhci autorun` (lighthouserc.cjs: mobile preset, simulated throttling, budgets as
//      assertions, filesystem upload only) on /, the series page and an episode page;
//   5. checks the JS budget the way the contract states it: the gzip size of every script
//      the audited page downloaded must be ≤ 200 KB (independent of whether the server
//      compresses responses).
//
// Reports: lighthouse/.lighthouseci/ (raw runs) and .lighthouseci/reports/ (HTML + JSON of
// the representative run per URL, manifest.json with the scores).
//
// Usage (from the repo root, after `npm ci` in client/, server/ and lighthouse/):
//   npm test --prefix lighthouse
// Environment:
//   CHROME_PATH       Chrome/Chromium binary (default: /opt/pw-browsers/chromium when it exists,
//                     else whatever chrome-launcher finds, e.g. the CI runner's Google Chrome)
//   LH_API_PORT       API port (default 4717)    LH_THUMB_PORT  fake upstream port (default 4817)
//   LH_SKIP_BUILD=1   reuse an existing lighthouse/.client-dist
//   LH_RUNS           Lighthouse runs per URL (default 3; assertions use the median run)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const API_PORT = Number(process.env.LH_API_PORT || 4717);
const THUMB_PORT = Number(process.env.LH_THUMB_PORT || 4817);
const BASE_URL = `http://localhost:${API_PORT}`;
const CLIENT_DIST = path.join(here, ".client-dist");
const LHCI_DIR = path.join(here, ".lighthouseci");
const REPORTS_DIR = path.join(LHCI_DIR, "reports");
/** Contract: main JS ≤ 200 KB gzip for the initial route. */
const JS_BUDGET_GZIP = 200 * 1024;

const ADMIN = { email: "admin@lighthouse.test", password: "lighthouse-admin-password-1", displayName: "LH Admin" };
const ANIME = {
  name: "Crônicas do Farol",
  slug: "cronicas-do-farol",
  genres: ["Ação", "Aventura", "Fantasia"],
  synopsis:
    "Uma guardiã de farol descobre que a luz que protege os navios também mantém afastadas criaturas do mar profundo. Quando a lâmpada começa a falhar, ela parte com um aprendiz em busca da chama original.",
};
const MANGA = {
  name: "Tinta e Aço",
  slug: "tinta-e-aco",
  genres: ["Drama", "Histórico"],
  synopsis: "Um ferreiro e uma calígrafa disputam a mesma encomenda imperial — e descobrem que precisam um do outro.",
};
const EPISODES = 12;
const CHAPTERS = 6;
/** Deterministic 11-character fake YouTube ids (the API never looks them up: titles are given). */
const fakeId = (prefix, n) => `${prefix}${String(n).padStart(11 - prefix.length, "0")}`;

const AUDITED_PATHS = ["/", `/anime/${ANIME.slug}`, `/anime/${ANIME.slug}/episode/1`];

// ------------------------------------------------------------------ processes

const children = new Set();
const tempPaths = [];

function run(command, args, { cwd, env, quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: quiet ? ["ignore", "ignore", "inherit"] : "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

function startBackground(name, command, args, { cwd, env }) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  child.on("exit", (code) => {
    children.delete(child);
    if (!stopping && code !== 0) console.error(`[lighthouse] ${name} exited with ${code}\n${stderr}`);
  });
  children.add(child);
  return child;
}

let stopping = false;
function cleanup() {
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  for (const p of tempPaths) fs.rmSync(p, { recursive: true, force: true });
}
process.on("exit", cleanup);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    cleanup();
    process.exit(130);
  });
}

async function waitFor(url, { timeoutMs = 30_000 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > until) throw new Error(`${url} did not come up within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

// ------------------------------------------------------------------ API client

/** A tiny API client with its own cookie (one per seeded account). */
function apiClient() {
  let cookie = "";
  return async function call(method, url, body, { expect = [200, 201, 204] } = {}) {
    const res = await fetch(BASE_URL + url, {
      method,
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sid = res.headers.getSetCookie?.().find((c) => c.startsWith("sid="));
    if (sid) cookie = sid.split(";")[0];
    const text = await res.text();
    if (!expect.includes(res.status)) throw new Error(`${method} ${url} → ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };
}

/** Registers and verifies an account through /api/dev/outbox; returns its logged-in client. */
async function verifiedUser({ email, password, displayName }) {
  const call = apiClient();
  await call("POST", "/api/auth/register", { email, password, displayName, acceptPrivacy: true }, { expect: [201] });
  let link = null;
  for (let i = 0; i < 40 && !link; i++) {
    const outbox = await call("GET", "/api/dev/outbox");
    link = outbox.filter((m) => m.to === email).at(-1)?.text.match(/https?:\/\/\S+[?&]token=\S+/)?.[0] ?? null;
    if (!link) await new Promise((r) => setTimeout(r, 250));
  }
  if (!link) throw new Error(`no verification e-mail for ${email} in /api/dev/outbox`);
  const token = new URL(link).searchParams.get("token");
  await call("POST", "/api/auth/verify-email", { token, password });
  return call;
}

async function seed() {
  const admin = await verifiedUser(ADMIN);
  const me = await admin("GET", "/api/auth/me");
  if (me.user?.role !== "admin") throw new Error("ADMIN_EMAILS did not promote the seeded admin");

  const videoIds = [];
  for (const [series, section, count, prefix, noun] of [
    [ANIME, "anime", EPISODES, "lhAnim", "Episódio"],
    [MANGA, "manga", CHAPTERS, "lhMang", "Capítulo"],
  ]) {
    await admin("POST", "/api/admin/series", series, { expect: [201] });
    for (let n = 1; n <= count; n++) {
      const { video } = await admin(
        "POST",
        "/api/admin/videos",
        {
          url: `https://youtu.be/${fakeId(prefix, n)}`,
          title: `${series.name} — ${noun} ${n}: ${["A chama", "Maré alta", "O aprendiz", "Sal e ferro", "Ventos do norte", "A última luz"][n % 6]}`,
          section,
          seriesSlug: series.slug,
          season: 1,
          number: n,
        },
        { expect: [201] }
      );
      if (video.status !== "published") throw new Error(`seeded video ${video.youtubeVideoId} is ${video.status}, not published`);
      videoIds.push(video.id);
    }
  }

  // Ratings feed the "Top rated" rows and the rating badges on cards.
  for (let u = 0; u < 3; u++) {
    const viewer = await verifiedUser({ email: `viewer${u}@lighthouse.test`, password: `lighthouse-viewer-${u}-pass`, displayName: `Viewer ${u}` });
    for (const [i, id] of videoIds.entries()) {
      if ((i + u) % 3 === 2) continue;
      await viewer("PUT", `/api/videos/${id}/rating`, { score: 3 + ((i + u) % 3), reaction: ["fire", "love", "wow"][(i + u) % 3] });
    }
  }
  console.log(`[lighthouse] seeded 2 series, ${videoIds.length} videos and ratings from 3 viewers`);
}

// ------------------------------------------------------------------ JS budget

/** gzip size of every same-origin script the page downloaded (from the Lighthouse network log). */
function scriptBudget(lhr) {
  const requests = lhr.audits["network-requests"]?.details?.items ?? [];
  const scripts = requests.filter((r) => r.resourceType === "Script" && r.url.startsWith(BASE_URL));
  let gzip = 0;
  let raw = 0;
  const files = [];
  for (const r of scripts) {
    const file = path.join(CLIENT_DIST, new URL(r.url).pathname);
    if (!file.startsWith(CLIENT_DIST) || !fs.existsSync(file)) continue;
    const body = fs.readFileSync(file);
    const size = zlib.gzipSync(body, { level: 9 }).length;
    gzip += size;
    raw += body.length;
    files.push({ file: path.basename(file), gzip: size });
  }
  const external = requests.filter((r) => !r.url.startsWith(BASE_URL) && !r.url.startsWith("data:")).map((r) => r.url);
  return { gzip, raw, files, external };
}

// ------------------------------------------------------------------ main

async function main() {
  const chromePath = process.env.CHROME_PATH || (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);

  if (process.env.LH_SKIP_BUILD !== "1" || !fs.existsSync(path.join(CLIENT_DIST, "index.html"))) {
    console.log("[lighthouse] building the client…");
    const code = await run("npm", ["run", "build", "--", "--outDir", CLIENT_DIST, "--emptyOutDir", "--logLevel", "warn"], { cwd: path.join(root, "client") });
    if (code !== 0) throw new Error(`client build failed (${code})`);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "crwn-animes-lighthouse-"));
  tempPaths.push(tmp);

  startBackground("thumbs", process.execPath, [path.join(root, "e2e", "fake-thumb-upstream.mjs")], {
    cwd: path.join(root, "e2e"),
    env: { E2E_THUMB_PORT: String(THUMB_PORT) },
  });
  await waitFor(`http://127.0.0.1:${THUMB_PORT}/healthz`);

  startBackground("api", process.execPath, ["src/index.js"], {
    cwd: path.join(root, "server"),
    env: {
      NODE_ENV: "test",
      PORT: String(API_PORT),
      CLIENT_DIST,
      DATABASE_FILE: path.join(tmp, "lighthouse.db"),
      APP_URL: BASE_URL,
      CLIENT_ORIGIN: BASE_URL,
      ADMIN_EMAILS: ADMIN.email,
      RATE_LIMIT_MAX: "100000",
      IMAGE_MISS_RATE_MAX: "100000",
      SMTP_HOST: "",
      TRUST_PROXY: "",
      THUMB_UPSTREAM: `http://127.0.0.1:${THUMB_PORT}`,
      THUMB_CACHE_DIR: path.join(tmp, "thumbs"),
      // Never reach YouTube (oEmbed, health checks): every other outbound request hits a closed port.
      NODE_USE_ENV_PROXY: "1",
      HTTPS_PROXY: "http://127.0.0.1:9",
      https_proxy: "http://127.0.0.1:9",
      HTTP_PROXY: "http://127.0.0.1:9",
      http_proxy: "http://127.0.0.1:9",
      NO_PROXY: "localhost,127.0.0.1",
      no_proxy: "localhost,127.0.0.1",
      NODE_NO_WARNINGS: "1",
    },
  });
  await waitFor(`${BASE_URL}/api/auth/me`);
  await seed();

  // Warm the thumbnail cache so every audited run sees cache hits, as a visitor of a live site would.
  for (const p of AUDITED_PATHS) {
    const res = await fetch(BASE_URL + p);
    if (res.status !== 200) throw new Error(`GET ${p} → ${res.status}`);
  }

  fs.rmSync(LHCI_DIR, { recursive: true, force: true });
  console.log(`[lighthouse] lhci autorun on ${AUDITED_PATHS.join(", ")}${chromePath ? ` (Chrome: ${chromePath})` : ""}`);
  const lhciCode = await run(path.join(here, "node_modules", ".bin", "lhci"), ["autorun", `--config=${path.join(here, "lighthouserc.cjs")}`], {
    cwd: here,
    env: {
      LH_BASE_URL: BASE_URL,
      LH_PATHS: JSON.stringify(AUDITED_PATHS),
      ...(chromePath ? { CHROME_PATH: chromePath } : {}),
      // lhci must talk to localhost directly, never through the sandbox/CI proxy.
      NO_PROXY: "localhost,127.0.0.1",
      no_proxy: "localhost,127.0.0.1",
    },
  });

  // ---- summary: scores of the representative run per URL + the gzip JS budget ----
  const manifestFile = path.join(REPORTS_DIR, "manifest.json");
  if (!fs.existsSync(manifestFile)) {
    console.error("[lighthouse] no reports/manifest.json: lhci did not produce results");
    return 1;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")).filter((e) => e.isRepresentativeRun);
  let budgetFailed = false;
  const rows = [];
  for (const entry of manifest) {
    const lhr = JSON.parse(fs.readFileSync(entry.jsonPath, "utf8"));
    const js = scriptBudget(lhr);
    const over = js.gzip > JS_BUDGET_GZIP;
    if (over || js.external.length) budgetFailed = true;
    const pct = (k) => Math.round((lhr.categories[k]?.score ?? 0) * 100);
    rows.push({
      url: new URL(entry.url).pathname,
      perf: pct("performance"),
      a11y: pct("accessibility"),
      bp: pct("best-practices"),
      seo: pct("seo"),
      LCP: `${Math.round(lhr.audits["largest-contentful-paint"].numericValue)} ms`,
      CLS: Number(lhr.audits["cumulative-layout-shift"].numericValue.toFixed(3)),
      TBT: `${Math.round(lhr.audits["total-blocking-time"].numericValue)} ms`,
      "JS gzip": `${(js.gzip / 1024).toFixed(1)} KB${over ? " ✗" : ""}`,
      "JS raw": `${(js.raw / 1024).toFixed(1)} KB`,
    });
    if (js.external.length) console.error(`[lighthouse] ${entry.url} made third-party requests:\n  ${js.external.join("\n  ")}`);
    if (over) console.error(`[lighthouse] ${entry.url}: ${js.files.map((f) => `${f.file} ${(f.gzip / 1024).toFixed(1)} KB`).join(", ")}`);
  }
  console.table(rows);
  if (budgetFailed) console.error(`[lighthouse] JS budget: ≤ ${JS_BUDGET_GZIP / 1024} KB gzip per audited page, no third-party requests`);
  console.log(`[lighthouse] reports: ${path.relative(process.cwd(), REPORTS_DIR) || REPORTS_DIR}`);
  return lhciCode !== 0 || budgetFailed ? 1 : 0;
}

main()
  .then((code) => {
    cleanup();
    process.exit(code);
  })
  .catch((error) => {
    console.error(`[lighthouse] ${error.stack ?? error}`);
    cleanup();
    process.exit(1);
  });
