// Security sweep #3: the real server (node src/index.js) in PRODUCTION mode,
// end to end: start-up refusals, the retention job at boot, Secure cookies and
// HSTS (also behind a TLS-terminating proxy, TRUST_PROXY=1), no dev outbox,
// static caching and 404 rules, error pages, APP_URL in crawler files and
// e-mail links whatever the Host / X-Forwarded-* headers say, rate limiting
// keyed on the address the proxy saw, SMTP over TLS only, and the process
// output: no e-mail address, name, token, password, cookie or IP may ever be printed.
// A local SMTP server stands in for the real one; it offers STARTTLS with the
// test-only certificate below (trusted by the spawned server through
// NODE_EXTRA_CA_CERTS), or no STARTTLS at all (a stripped connection).
// Each test asserts the SAFE behaviour; a real defect is kept as
// { todo: "<what is wrong, where>" } (it runs and reports, but does not fail the suite).
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import tls from "node:tls";
import { SERVER_DIR } from "../src/config.js";
import { openDatabase } from "../src/db.js";
import { TEST_TLS } from "./tls-fixture.js";

const APP_URL = "https://crwn.example";
const SMTP_PASS = "smtp-secret-Zx81qq";

// The fake SMTP server's STARTTLS uses the test-only certificate of tls-fixture.js.
const SMTP_TLS = TEST_TLS;
/** A file with the test certificate, for the spawned server's NODE_EXTRA_CA_CERTS. */
const SMTP_CA_FILE = path.join(os.tmpdir(), `crwn-test-smtp-ca-${process.pid}.pem`);
fs.writeFileSync(SMTP_CA_FILE, SMTP_TLS.cert);
process.on("exit", () => fs.rmSync(SMTP_CA_FILE, { force: true }));
/** THUMB_CACHE_DIR of every spawned server (created only if a thumbnail is ever cached). */
const THUMB_DIR = path.join(os.tmpdir(), `crwn-test-thumbs-${process.pid}`);
process.on("exit", () => fs.rmSync(THUMB_DIR, { recursive: true, force: true }));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Quoted-printable (what nodemailer uses for pt-BR text) back to UTF-8. */
const decodeQp = (raw) =>
  Buffer.from(raw.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(Number.parseInt(h, 16))), "latin1").toString("utf8");

/**
 * A minimal SMTP server. It records every command line (`lines`: { line, tls })
 * and message (`messages`: { to, text, tls }), and accepts any AUTH.
 * `starttls`: offer STARTTLS (with SMTP_TLS); false is a server, or an on-path
 * attacker, that does not. `reject(address)` answers RCPT with a 550 that
 * echoes the address, as real servers do.
 */
async function startSmtp({ starttls = true, reject = () => false } = {}) {
  const lines = [];
  const messages = [];
  const sockets = new Set();
  const server = net.createServer((plain) => {
    sockets.add(plain);
    plain.on("close", () => sockets.delete(plain));
    plain.on("error", () => {});
    let sock = plain;
    let encrypted = false;
    let buf = "";
    let inData = false;
    let to = [];
    const onData = (chunk) => {
      buf += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end === -1) return;
          messages.push({ to, text: decodeQp(buf.slice(0, end)), tls: encrypted });
          buf = buf.slice(end + 5);
          inData = false;
          to = [];
          sock.write("250 2.0.0 queued\r\n");
          continue;
        }
        const i = buf.indexOf("\r\n");
        if (i === -1) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        lines.push({ line, tls: encrypted });
        const verb = line.split(" ")[0].toUpperCase();
        if (verb === "EHLO") sock.write(`250-smtp.test\r\n${starttls && !encrypted ? "250-STARTTLS\r\n" : ""}250-AUTH PLAIN\r\n250 8BITMIME\r\n`);
        else if (verb === "STARTTLS" && starttls && !encrypted) {
          sock.write("220 2.0.0 ready to start TLS\r\n");
          plain.removeListener("data", onData);
          buf = "";
          sock = new tls.TLSSocket(plain, { isServer: true, key: SMTP_TLS.key, cert: SMTP_TLS.cert });
          sock.on("error", () => {});
          sock.on("data", onData);
          encrypted = true;
          return;
        } else if (verb === "AUTH") sock.write("235 2.7.0 accepted\r\n");
        else if (verb === "RCPT") {
          const address = /<([^>]*)>/.exec(line)?.[1] ?? "";
          if (reject(address)) sock.write(`550 5.1.1 <${address}>: recipient address rejected\r\n`);
          else {
            to.push(address);
            sock.write("250 2.1.5 ok\r\n");
          }
        } else if (verb === "DATA") {
          inData = true;
          sock.write("354 end with <CRLF>.<CRLF>\r\n");
        } else if (verb === "QUIT") {
          sock.end("221 bye\r\n");
          return;
        } else sock.write("250 ok\r\n");
      }
    };
    plain.write("220 smtp.test ESMTP\r\n");
    plain.on("data", onData);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    lines,
    messages,
    /** Waits for the newest message to `to` whose text matches `re`. */
    async waitFor(to, re = /./, after = 0) {
      for (let i = 0; i < 100; i++) {
        const found = messages.slice(after).filter((m) => m.to.includes(to) && re.test(m.text)).at(-1);
        if (found) return found;
        await sleep(50);
      }
      throw new Error(`no e-mail to ${to} matching ${re}`);
    },
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(resolve);
      }),
  };
}

/** The token of the first verify/reset link in an e-mail. */
function tokenIn(message, page) {
  const match = new RegExp(`/${page}\\?token=([A-Za-z0-9_-]+)`).exec(message.text);
  assert.ok(match, `no ${page} link in the e-mail`);
  return match[1];
}

/** Every variable the server reads, so a developer's server/.env can never leak in (dotenv does not override). */
function prodEnv(overrides = {}) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME ?? os.tmpdir(),
    NODE_ENV: "production",
    PORT: "0",
    DATABASE_FILE: ":memory:",
    CLIENT_DIST: path.join(os.tmpdir(), "crwn-prod-no-client"),
    // Never the developer's server/data/thumbs: the retention job prunes files of unknown videos.
    THUMB_CACHE_DIR: THUMB_DIR,
    THUMB_CACHE_MB: "200",
    THUMB_UPSTREAM: "",
    APP_URL,
    CLIENT_ORIGIN: APP_URL,
    ADMIN_EMAILS: "",
    TRUST_PROXY: "1",
    RATE_LIMIT_MAX: "1000",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: "9",
    SMTP_SECURE: "false",
    SMTP_USER: "",
    SMTP_PASS: "",
    MAIL_FROM: "Crwn Animes <no-reply@crwn.example>",
    NODE_EXTRA_CA_CERTS: SMTP_CA_FILE, // trusts the fake SMTP server's certificate (only)
    // The server must never reach YouTube: its fetch() goes through a closed port.
    NODE_USE_ENV_PROXY: "1",
    HTTPS_PROXY: "http://127.0.0.1:9",
    https_proxy: "http://127.0.0.1:9",
    HTTP_PROXY: "http://127.0.0.1:9",
    http_proxy: "http://127.0.0.1:9",
    NO_PROXY: "localhost,127.0.0.1",
    no_proxy: "localhost,127.0.0.1",
    NODE_NO_WARNINGS: "1",
    ...overrides,
  };
}

/** A raw request (node:http): any Host / X-Forwarded-* header is sent as is, redirects are not followed. */
function request(base, { method = "GET", path: p = "/", headers = {}, body = null, cookie = null } = {}) {
  const url = new URL(base);
  const payload = body == null ? null : typeof body === "string" ? body : JSON.stringify(body);
  const h = { ...headers };
  if (payload != null) {
    h["content-type"] ??= "application/json";
    h["content-length"] = Buffer.byteLength(payload);
  }
  if (cookie) h.cookie = cookie;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, method, path: p, headers: h }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // not JSON
        }
        const setCookie = [].concat(res.headers["set-cookie"] ?? []);
        const sid = setCookie.map((c) => /^sid=([^;]*)/.exec(c)?.[1]).find((v) => v !== undefined);
        resolve({ status: res.statusCode, headers: res.headers, text, json, setCookie, sid });
      });
    });
    req.on("error", reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

/** Spawns `node src/index.js` with prodEnv(env); resolves once it answers. output() = stdout + stderr. */
async function startProd(env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ["src/index.js"], { cwd: SERVER_DIR, env: prodEnv({ PORT: String(port), ...env }) });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    if (child.exitCode != null) return { exited: child.exitCode, output: () => output, stop: async () => {} };
    try {
      if ((await request(base, { path: "/api/auth/me" })).status === 200) break;
    } catch {
      // not listening yet
    }
    if (i > 200) {
      child.kill("SIGKILL");
      throw new Error(`server did not start: ${output}`);
    }
    await sleep(50);
  }
  return {
    base,
    output: () => output,
    req: (opts) => request(base, opts),
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode != null) return resolve();
        child.once("exit", resolve);
        child.kill("SIGTERM");
      }),
  };
}

/** A fake client build: hashed assets, a non-hashed root script, a favicon and the index.html template. */
function makeDist() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crwn-prod-dist-"));
  fs.mkdirSync(path.join(dir, "assets"));
  fs.writeFileSync(
    path.join(dir, "index.html"),
    `<!doctype html><html lang="pt-BR"><head><meta charset="UTF-8" /><title>Crwn Animes</title>
<script src="/theme-init.js"></script><script type="module" crossorigin src="/assets/index-Ab12Cd34.js"></script>
<link rel="stylesheet" crossorigin href="/assets/index-Ef56Gh78.css"></head><body><div id="root"></div></body></html>`
  );
  fs.writeFileSync(path.join(dir, "assets", "index-Ab12Cd34.js"), "console.log('app')");
  fs.writeFileSync(path.join(dir, "assets", "index-Ef56Gh78.css"), "body{color:red}");
  fs.writeFileSync(path.join(dir, "theme-init.js"), "/* theme */");
  fs.writeFileSync(path.join(dir, "favicon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  // PWA (v1.5): service worker, web manifest, offline page.
  fs.writeFileSync(path.join(dir, "sw.js"), "self.addEventListener('fetch', () => {});");
  fs.writeFileSync(path.join(dir, "manifest.webmanifest"), '{"name":"Crwn Animes","start_url":"/"}');
  fs.writeFileSync(path.join(dir, "offline.html"), "<!doctype html><title>Você está offline</title>");
  // Files a sloppy deploy could leave next to the build: never served.
  fs.writeFileSync(path.join(dir, ".env"), "DIST_SECRET=1");
  fs.writeFileSync(path.join(dir, "assets", ".env"), "DIST_SECRET=2");
  return dir;
}

const DAY = 86_400_000;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString();

// Every line the production server may print: anything else is noise (and may carry personal data).
const ALLOWED_LINES = [
  /^Crwn Animes API listening on http:\/\/localhost:\d+ \(production\)$/,
  /^\[mail\] could not (?:send|build) an? "\w+" e-mail \((?:[A-Z][A-Z0-9_]*|unknown error)\)$/,
];

/** Lines of `output` that are not on the allow-list, and every secret that appears in it. */
function auditOutput(output, secrets) {
  const lines = output.split(/\r?\n/).filter((l) => l.trim() !== "");
  return {
    unexpected: lines.filter((l) => !ALLOWED_LINES.some((re) => re.test(l))),
    leaked: secrets.filter((s) => s && output.toLowerCase().includes(String(s).toLowerCase())),
  };
}

// ============================================================ start-up refusals
describe("production start-up", () => {
  const run = (env) =>
    spawnSync(process.execPath, ["src/index.js"], { cwd: SERVER_DIR, env: prodEnv(env), encoding: "utf8", timeout: 10_000 });

  test('refuses TRUST_PROXY="true", an unparsable https APP_URL, an http APP_URL and a THUMB_UPSTREAM, without echoing secrets', () => {
    for (const [env, reason] of [
      [{ TRUST_PROXY: "true", SMTP_PASS }, /TRUST_PROXY/],
      [{ APP_URL: "https://", SMTP_PASS }, /APP_URL/],
      [{ APP_URL: "http://crwn.example", SMTP_PASS }, /APP_URL/],
      [{ SMTP_HOST: "", SMTP_PASS }, /SMTP_HOST/],
      [{ THUMB_UPSTREAM: "http://127.0.0.1:9", SMTP_PASS }, /THUMB_UPSTREAM is for tests only/],
    ]) {
      const result = run(env);
      assert.equal(result.status, 1, JSON.stringify(env));
      assert.match(result.stderr, /^Refusing to start: /m);
      assert.match(result.stderr, reason);
      assert.doesNotMatch(result.stderr + result.stdout, new RegExp(SMTP_PASS), "the SMTP password is never printed");
      assert.doesNotMatch(result.stderr, /\n\s+at /, "no stack trace");
    }
  });

  test(
    "without CLIENT_ORIGIN, production trusts no development origin (CORS with credentials, CSRF Origin check)",
    async () => {
      const smtp = await startSmtp();
      const srv = await startProd({ CLIENT_ORIGIN: "", SMTP_PORT: String(smtp.port) });
      try {
        if (srv.exited != null) {
          assert.match(srv.output(), /CLIENT_ORIGIN/, "refusing to start is fine if it says why");
          return;
        }
        const dev = "http://localhost:5173";
        const cors = await srv.req({ path: "/api/auth/me", headers: { origin: dev } });
        assert.equal(cors.headers["access-control-allow-origin"], undefined, "no CORS grant for a dev origin");
        const write = await srv.req({ method: "POST", path: "/api/auth/logout", headers: { origin: dev, "sec-fetch-site": "cross-site" } });
        assert.equal(write.status, 403, "a write from a dev origin is cross-site in production");
        const own = await srv.req({ method: "POST", path: "/api/auth/logout", headers: { origin: APP_URL, "sec-fetch-site": "same-origin" } });
        assert.equal(own.status, 204, "writes from the site itself keep working");
      } finally {
        await srv.stop();
        await smtp.close();
      }
    }
  );
});

// ============================================================ one production server
describe("production server (NODE_ENV=production, https APP_URL, SMTP with STARTTLS, TRUST_PROXY=1, a client build)", () => {
  let smtp;
  let srv;
  let dist;
  let dataDir;
  let dbFile;
  const secrets = []; // everything that must never be printed
  const ip = (n) => `198.51.100.${n}`; // TEST-NET-2: the client address a proxy would append
  const viaProxy = (n, extra = {}) => ({ "x-forwarded-for": ip(n), "x-forwarded-proto": "https", ...extra });

  before(async () => {
    smtp = await startSmtp({ reject: (address) => address.startsWith("bounce-") });
    dist = makeDist();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "crwn-prod-data-"));
    dbFile = path.join(dataDir, "prod.db");
    // Data the retention job must purge at boot (it runs once at start-up, then hourly).
    const db = openDatabase(dbFile);
    const insertUser = db.prepare(
      "INSERT INTO users (email, display_name, password_hash, email_verified_at, privacy_accepted_at, created_at) VALUES (?, ?, 'x', ?, ?, ?)"
    );
    const stale = Number(insertUser.run("stale-unverified@prod.test", "Stale Pending Name", null, daysAgo(8), daysAgo(8)).lastInsertRowid);
    db.prepare("INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at) VALUES (?, ?, 'verify', ?)").run(sha256("stale"), stale, daysAgo(-1));
    const old = Number(insertUser.run("old-verified@prod.test", "Old Verified", daysAgo(40), daysAgo(40), daysAgo(40)).lastInsertRowid);
    db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256("expired-session"), old, daysAgo(1));
    db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(sha256("live-session"), old, daysAgo(-10));
    // A live video whose thumbnail the server will try (and fail) to fetch: outbound traffic goes to a closed port.
    db.prepare("INSERT INTO videos (youtube_video_id, source_title, section, status) VALUES ('prodThumb01', 'Prod upload', 'anime', 'pending')").run();
    db.close();
    secrets.push("stale-unverified@prod.test", "Stale Pending Name", "old-verified@prod.test", SMTP_PASS);

    srv = await startProd({
      DATABASE_FILE: dbFile,
      CLIENT_DIST: dist,
      SMTP_PORT: String(smtp.port),
      SMTP_USER: "crwn-mailer",
      SMTP_PASS,
      ADMIN_EMAILS: "admin-67@prod.test",
      RATE_LIMIT_MAX: "4",
    });
    assert.equal(srv.exited, undefined, srv.output());
  });

  after(async () => {
    await srv?.stop();
    await smtp?.close();
    fs.rmSync(dist, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  /** Registers + verifies through the captured e-mail; returns { sid, email, password, name }. */
  async function account(tag, n) {
    const email = `${tag}-${n}@prod.test`;
    const password = `pw-${tag}-${n}-Q9v`;
    const name = `Name ${tag} ${n}`;
    secrets.push(email, password, name);
    const before = smtp.messages.length;
    const reg = await srv.req({ method: "POST", path: "/api/auth/register", headers: viaProxy(n), body: { email, password, displayName: name, acceptPrivacy: true } });
    assert.equal(reg.status, 201, reg.text);
    const token = tokenIn(await smtp.waitFor(email, /verify-email/, before), "verify-email");
    secrets.push(token, sha256(token));
    const ver = await srv.req({ method: "POST", path: "/api/auth/verify-email", headers: viaProxy(n), body: { token, password } });
    assert.equal(ver.status, 200, ver.text);
    secrets.push(ver.sid, sha256(ver.sid));
    return { sid: ver.sid, email, password, name, id: ver.json.user.id };
  }

  test("the retention job ran at boot: 8-day-old unverified account and its token, expired sessions gone; live data kept", () => {
    const db = new Database(dbFile, { readonly: true, fileMustExist: true });
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'stale-unverified@prod.test'").get().n, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM email_tokens").get().n, 0);
      assert.deepEqual(db.prepare("SELECT token_hash FROM sessions").all().map((r) => r.token_hash), [sha256("live-session")]);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'old-verified@prod.test'").get().n, 1, "verified accounts stay");
    } finally {
      db.close();
    }
  });

  test("HSTS on every kind of response (page, 404 page, asset, 301, API JSON, API error, crawler files)", async () => {
    for (const p of ["/", "/nao-existe", "/assets/index-Ab12Cd34.js", "/assets/missing.js", "/index.html", "/api/sections", "/api/nope", "/robots.txt", "/sitemap.xml"]) {
      const res = await srv.req({ path: p });
      const hsts = res.headers["strict-transport-security"] ?? "";
      const maxAge = Number(/max-age=(\d+)/.exec(hsts)?.[1] ?? 0);
      assert.ok(maxAge >= 180 * 86_400, `${p}: HSTS max-age ${maxAge}`);
      assert.match(hsts, /includeSubDomains/i, p);
      assert.equal(res.headers["x-powered-by"], undefined, p);
    }
  });

  test("the session cookie is HttpOnly + Secure + SameSite=Lax whatever X-Forwarded-Proto says; logout clears it with the same flags", async () => {
    const user = await account("cookie", 11);
    for (const headers of [viaProxy(12), viaProxy(12, { "x-forwarded-proto": "http" }), {}]) {
      const login = await srv.req({ method: "POST", path: "/api/auth/login", headers, body: { email: user.email, password: user.password } });
      assert.equal(login.status, 200, login.text);
      const line = login.setCookie.find((c) => c.startsWith("sid="));
      secrets.push(login.sid, sha256(login.sid));
      for (const flag of [/;\s*HttpOnly/i, /;\s*Secure/i, /;\s*SameSite=Lax/i, /;\s*Path=\//i]) assert.match(line, flag, JSON.stringify(headers));
      const out = await srv.req({ method: "POST", path: "/api/auth/logout", headers, cookie: `sid=${login.sid}` });
      assert.equal(out.status, 204);
      assert.match(out.setCookie.find((c) => c.startsWith("sid=")), /;\s*Secure/i, "the clearing cookie is Secure too");
    }
  });

  test("no dev outbox, no debug routes: /api/dev/* is a JSON 404", async () => {
    for (const p of ["/api/dev/outbox", "/api/dev", "/api/dev/outbox?limit=1"]) {
      const res = await srv.req({ path: p });
      assert.equal(res.status, 404, p);
      assert.equal(res.json?.error?.code, "NOT_FOUND", p);
      assert.doesNotMatch(res.text, /@prod\.test|token=/, p);
    }
  });

  test("static files: hashed assets immutable, root files and pages revalidated, misses are 404 text, never the SPA shell", async () => {
    for (const [p, type] of [["/assets/index-Ab12Cd34.js", /javascript/], ["/assets/index-Ef56Gh78.css", /css/]]) {
      const res = await srv.req({ path: p });
      assert.equal(res.status, 200, p);
      assert.match(res.headers["content-type"], type, p);
      assert.equal(res.headers["cache-control"], "public, max-age=31536000, immutable", p);
      assert.equal(res.headers["x-content-type-options"], "nosniff", p);
    }
    for (const p of ["/theme-init.js", "/favicon.svg"]) {
      const res = await srv.req({ path: p });
      assert.equal(res.status, 200, p);
      assert.doesNotMatch(res.headers["cache-control"] ?? "", /immutable|max-age=[1-9]/, `${p} is not content-hashed: it must revalidate`);
    }
    for (const p of ["/", "/anime", "/login"]) {
      const res = await srv.req({ path: p });
      assert.equal(res.status, 200, p);
      assert.equal(res.headers["cache-control"], "no-cache", p);
    }
    for (const p of ["/assets/missing.js", "/assets/index-Ab12Cd34.js.map", "/missing.png", "/assets/%2e%2e/%2e%2e/package.json", "/node_modules/express/package.json"]) {
      const res = await srv.req({ path: p });
      assert.equal(res.status, 404, p);
      assert.match(res.headers["content-type"], /^text\/plain/, p);
      assert.doesNotMatch(res.headers["cache-control"] ?? "", /immutable/, p);
      assert.doesNotMatch(res.text, /<div id="root">|"dependencies"/, p);
    }
    // Dotfiles (no extension for path.extname) and traversal: a 404 (the SPA's not-found shell is fine), never the file.
    for (const p of ["/.env", "/.git/config", "/assets/.env", "/%2e%2e/server/.env", "/..%2f..%2fserver%2f.env", "/%2e%2e%2f%2e%2e%2fpackage.json"]) {
      const res = await srv.req({ path: p });
      assert.ok([400, 403, 404].includes(res.status), `${p}: ${res.status}`);
      assert.doesNotMatch(res.text, /DIST_SECRET|SMTP_|"dependencies"|\[core\]/, p);
    }
  });

  test("/index.html is a 301 to / (query kept, Location always same-origin and relative)", async () => {
    for (const [p, location] of [["/index.html", "/"], ["/index.html?ref=mail", "/?ref=mail"], ["/INDEX.HTML", "/"], ["/index.html/", "/"]]) {
      const res = await srv.req({ path: p, headers: { host: "evil.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "http" } });
      assert.equal(res.status, 301, p);
      assert.equal(res.headers.location, location, p);
    }
  });

  test(
    "the raw index.html template is never served: other spellings of /index.html redirect too (or 404)",
    async () => {
      for (const p of ["//index.html", "/%69ndex.html", "/./index.html", "/assets/../index.html"]) {
        const res = await srv.req({ path: p });
        assert.ok([301, 404].includes(res.status), `${p}: ${res.status}`);
        if (res.status === 301) assert.match(res.headers.location, /^\/(?!\/)/, p);
      }
    }
  );

  test("PWA files revalidate (sw.js may control /, the manifest has its media type); thumbnails fail closed: 404 / 502 JSON, never cached, never printed", async () => {
    const sw = await srv.req({ path: "/sw.js" });
    assert.equal(sw.status, 200);
    assert.equal(sw.headers["cache-control"], "no-cache");
    assert.equal(sw.headers["service-worker-allowed"], "/");
    assert.match(sw.headers["content-type"], /^text\/javascript/);
    assert.match(sw.headers["content-security-policy"], /;worker-src 'self';manifest-src 'self'$/);
    const manifest = await srv.req({ path: "/manifest.webmanifest" });
    assert.equal(manifest.status, 200);
    assert.equal(manifest.headers["cache-control"], "no-cache");
    assert.equal(manifest.headers["content-type"], "application/manifest+json");
    const offline = await srv.req({ path: "/offline.html" });
    assert.equal(offline.status, 200);
    assert.equal(offline.headers["cache-control"], "no-cache");

    secrets.push("prodThumb01", "nopeNopeNo1", "ytimg"); // the output audit below: never printed
    const unknown = await srv.req({ path: "/api/thumbs/nopeNopeNo1.jpg" });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json?.error?.code, "NOT_FOUND");
    const started = Date.now();
    const live = await srv.req({ path: "/api/thumbs/prodThumb01.jpg" });
    assert.equal(live.status, 502, "the real upstream fetch cannot get out of this sandbox");
    assert.equal(live.json?.error?.code, "UPSTREAM_ERROR");
    assert.equal(live.headers["cache-control"], "private, no-store");
    assert.ok(Date.now() - started < 6000, "within the 5 s upstream timeout");
    assert.deepEqual(fs.existsSync(THUMB_DIR) ? fs.readdirSync(THUMB_DIR) : [], [], "nothing cached");
  });

  test("error pages: HTML 404 shell (noindex), JSON API errors; no stack, path, module or SQL text in any of them", async () => {
    const page = await srv.req({ path: "/anime/nao-existe" });
    assert.equal(page.status, 404);
    assert.match(page.text, /<meta name="robots" content="noindex"/);
    const cases = [
      { path: "/api/videos/99999" },
      { path: "/api/videos/%FF" },
      { path: "/api/anime/series?limit=abc&q=" + "x".repeat(200) },
      { method: "POST", path: "/api/auth/login", body: '{"email": "a@b.c", "password": ' },
      { method: "POST", path: "/api/auth/login", body: "email=a@b.c", headers: { "content-type": "application/x-www-form-urlencoded" } },
      { method: "POST", path: "/api/auth/login", body: JSON.stringify({ email: "a@b.c", password: "x".repeat(30_000) }) },
      { method: "POST", path: "/api/auth/logout", headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" } },
      { method: "PUT", path: "/api/videos/1/rating", body: { score: 5 } },
      { method: "POST", path: "/anything" },
      { method: "DELETE", path: "/" },
    ];
    for (const c of cases) {
      const res = await srv.req({ ...c, headers: { ...viaProxy(30), ...c.headers } });
      const where = `${c.method ?? "GET"} ${c.path.slice(0, 40)} -> ${res.status}`;
      assert.ok(res.status >= 400 && res.status < 500, where);
      assert.doesNotMatch(res.text, /\n\s+at |node_modules|\/src\/|\.js:\d+|SQLITE|better-sqlite3|express/i, where);
      if (c.path.startsWith("/api/")) assert.equal(typeof res.json?.error?.code, "string", where);
    }
  });

  test("robots.txt, sitemap.xml, canonical/og:url and e-mail links use APP_URL whatever Host / X-Forwarded-Host / -Proto say", async () => {
    const spoof = { host: "evil.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "http", ...viaProxy(40) };
    const robots = await srv.req({ path: "/robots.txt", headers: spoof });
    assert.match(robots.text, /^Sitemap: https:\/\/crwn\.example\/sitemap\.xml$/m);
    const sitemap = await srv.req({ path: "/sitemap.xml", headers: spoof });
    const locs = [...sitemap.text.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
    assert.ok(locs.length >= 3, sitemap.text);
    assert.ok(locs.every((l) => l.startsWith(`${APP_URL}/`)), locs.join(" "));
    const home = await srv.req({ path: "/anime", headers: spoof });
    assert.match(home.text, /<link rel="canonical" href="https:\/\/crwn\.example\/anime"/);
    assert.doesNotMatch(home.text, /evil\.example/);

    const email = "links-41@prod.test";
    secrets.push(email);
    const before = smtp.messages.length;
    await srv.req({ method: "POST", path: "/api/auth/register", headers: spoof, body: { email, password: "links-password-41", displayName: "Links", acceptPrivacy: true } });
    const message = await smtp.waitFor(email, /verify-email/, before);
    secrets.push(tokenIn(message, "verify-email"));
    const links = [...message.text.matchAll(/https?:\/\/[^\s"<>]+/g)].map((m) => m[0]);
    assert.ok(links.length > 0);
    assert.ok(links.every((l) => l.startsWith(`${APP_URL}/`)), links.join(" "));
  });

  test("TRUST_PROXY=1: the rate limit keys on the address the proxy appended; a client-chosen X-Forwarded-For prefix does not reset it", async () => {
    const attempt = (spoofed, real) =>
      srv.req({ method: "POST", path: "/api/auth/forgot-password", headers: { "x-forwarded-for": `${spoofed}, ${real}` }, body: { email: "nobody-50@prod.test" } });
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await attempt(`10.9.8.${i}`, ip(50))).status);
    assert.deepEqual(statuses, [202, 202, 202, 202, 429, 429], "RATE_LIMIT_MAX=4 per real client");
    assert.equal((await attempt("10.9.8.1", ip(51))).status, 202, "another real client is not affected");
  });

  test("representative flows print nothing but the start-up line and coded mail errors: no address, name, password, token, cookie or IP", async () => {
    // Sign-up variants: new, again while unverified, again once verified, resend, a bounced address (550 echoes it).
    const user = await account("flow", 60);
    await srv.req({ method: "POST", path: "/api/auth/register", headers: viaProxy(61), body: { email: user.email, password: "other-password-61", displayName: "Other", acceptPrivacy: true } });
    const bounce = "bounce-62@prod.test";
    secrets.push(bounce, "bounce-password-62");
    await srv.req({ method: "POST", path: "/api/auth/register", headers: viaProxy(62), body: { email: bounce, password: "bounce-password-62", displayName: "Bounce", acceptPrivacy: true } });
    await srv.req({ method: "POST", path: "/api/auth/resend-verification", headers: viaProxy(62), body: { email: bounce } });
    const pending = "pending-63@prod.test";
    secrets.push(pending, "pending-password-63");
    await srv.req({ method: "POST", path: "/api/auth/register", headers: viaProxy(63), body: { email: pending, password: "pending-password-63", displayName: "Pending", acceptPrivacy: true } });
    const pendingToken = tokenIn(await smtp.waitFor(pending, /verify-email/), "verify-email");
    secrets.push(pendingToken);
    assert.equal((await srv.req({ method: "POST", path: "/api/auth/verify-email", headers: viaProxy(63), body: { token: pendingToken, password: "wrong-password-63" } })).status, 401);
    assert.equal((await srv.req({ method: "POST", path: "/api/auth/login", headers: viaProxy(63), body: { email: pending, password: "pending-password-63" } })).status, 403);

    // Logins: wrong password, unknown e-mail, success.
    assert.equal((await srv.req({ method: "POST", path: "/api/auth/login", headers: viaProxy(64), body: { email: user.email, password: "wrong-password-64" } })).status, 401);
    secrets.push("wrong-password-64", "ghost-64@prod.test");
    assert.equal((await srv.req({ method: "POST", path: "/api/auth/login", headers: viaProxy(64), body: { email: "ghost-64@prod.test", password: "wrong-password-64" } })).status, 401);
    const login = await srv.req({ method: "POST", path: "/api/auth/login", headers: viaProxy(65), body: { email: user.email, password: user.password } });
    assert.equal(login.status, 200);
    secrets.push(login.sid);

    // Admin actions (ADMIN_EMAILS promotes admin-67@prod.test on verify).
    const admin = await account("admin", 67);
    const as = (who, n) => ({ cookie: `sid=${who.sid}`, headers: viaProxy(n) });
    const series = await srv.req({ method: "POST", path: "/api/admin/series", ...as(admin, 68), body: { name: "Prod Log Saga", genres: ["Ação"] } });
    assert.equal(series.status, 201, series.text);
    const video = await srv.req({ method: "POST", path: "/api/admin/videos", ...as(admin, 68), body: { url: "prodLog0001", title: "Prod Log Saga Episode 1" } });
    assert.equal(video.status, 201, video.text);
    const videoId = video.json.video.id;
    assert.equal((await srv.req({ method: "PATCH", path: `/api/admin/videos/${videoId}`, ...as(admin, 68), body: { number: 2 } })).status, 200);
    assert.equal((await srv.req({ method: "POST", path: "/api/admin/series", ...as(admin, 68), body: { name: "" } })).status, 400);
    assert.equal((await srv.req({ path: "/api/admin/videos?status=bogus", ...as(admin, 68) })).status, 400);

    // A user's data: rate, rename, export, change password, reset password, sign out everywhere, delete.
    const me = { cookie: `sid=${login.sid}`, headers: viaProxy(69) };
    assert.equal((await srv.req({ method: "PUT", path: `/api/videos/${videoId}/rating`, ...me, body: { score: 4, reaction: "fire" } })).status, 200);
    assert.equal((await srv.req({ method: "PATCH", path: "/api/me", ...me, body: { displayName: "Renamed Flow 69" } })).status, 200);
    secrets.push("Renamed Flow 69");
    assert.equal((await srv.req({ path: "/api/me/export", ...me })).status, 200);
    const changed = await srv.req({ method: "POST", path: "/api/me/password", ...me, body: { currentPassword: user.password, newPassword: "changed-password-69" } });
    assert.equal(changed.status, 200);
    secrets.push("changed-password-69", changed.sid);
    let before = smtp.messages.length;
    await srv.req({ method: "POST", path: "/api/auth/forgot-password", headers: viaProxy(70), body: { email: user.email } });
    await srv.req({ method: "POST", path: "/api/auth/forgot-password", headers: viaProxy(70), body: { email: "ghost-70@prod.test" } });
    secrets.push("ghost-70@prod.test");
    const resetToken = tokenIn(await smtp.waitFor(user.email, /reset-password/, before), "reset-password");
    secrets.push(resetToken, sha256(resetToken));
    assert.equal((await srv.req({ method: "POST", path: "/api/auth/reset-password", headers: viaProxy(70), body: { token: "not-a-real-token-at-all-0000000000", password: "reset-password-70" } })).status, 400);
    const reset = await srv.req({ method: "POST", path: "/api/auth/reset-password", headers: viaProxy(70), body: { token: resetToken, password: "reset-password-70" } });
    assert.equal(reset.status, 200, reset.text);
    secrets.push("reset-password-70", reset.sid);
    assert.equal((await srv.req({ method: "POST", path: "/api/auth/logout-all", cookie: `sid=${reset.sid}`, headers: viaProxy(70) })).status, 204);
    const again = await srv.req({ method: "POST", path: "/api/auth/login", headers: viaProxy(71), body: { email: user.email, password: "reset-password-70" } });
    secrets.push(again.sid);
    assert.equal((await srv.req({ method: "DELETE", path: "/api/me", cookie: `sid=${again.sid}`, headers: viaProxy(71), body: { password: "not-my-password-71" } })).status, 401);
    secrets.push("not-my-password-71");
    assert.equal((await srv.req({ method: "DELETE", path: "/api/me", cookie: `sid=${again.sid}`, headers: viaProxy(71), body: { password: "reset-password-70" } })).status, 204);

    // Garbage that carries personal data in the body, cookie or URL.
    const garbage = [
      { method: "POST", path: "/api/auth/login", body: `{"email":"${user.email}","password":"${user.password}"`, headers: viaProxy(72) },
      { method: "POST", path: "/api/auth/register", body: `email=${user.email}&password=${user.password}`, headers: { ...viaProxy(72), "content-type": "text/plain" } },
      { method: "POST", path: "/api/auth/login", body: JSON.stringify({ email: user.email, password: "p".repeat(25_000) }), headers: viaProxy(72) },
      { path: `/api/auth/me`, cookie: `sid=${encodeURIComponent(user.email)}%ZZ`, headers: viaProxy(72) },
      { path: `/api/nope?email=${encodeURIComponent(user.email)}`, headers: viaProxy(72) },
      { path: `/genre/${encodeURIComponent(user.email)}%E0%A4%A`, headers: viaProxy(72) },
    ];
    for (const g of garbage) assert.ok((await srv.req(g)).status < 500, JSON.stringify(g).slice(0, 80));

    await sleep(300); // e-mails are fire-and-forget
    const sids = [user.sid, admin.sid, login.sid].filter(Boolean);
    const { unexpected, leaked } = auditOutput(srv.output(), [...secrets, ...sids, ...Array.from({ length: 80 }, (_, i) => ip(i)), "127.0.0.1", "crwn-mailer"]);
    assert.deepEqual(leaked, [], `printed:\n${srv.output()}`);
    assert.deepEqual(unexpected, [], "only the start-up line and coded mail errors");
    assert.match(srv.output(), /\[mail\] could not send a "verify" e-mail \(EENVELOPE\)/, "the bounce was reported by code");
  });

  test("when the SMTP server offers STARTTLS, AUTH and every message (with its tokenised link) travel encrypted", () => {
    const auth = smtp.lines.filter((l) => /^AUTH\b/i.test(l.line));
    assert.ok(auth.length > 0 && smtp.messages.length > 0, "the run did send mail");
    assert.deepEqual(auth.filter((l) => !l.tls), []);
    assert.deepEqual(smtp.messages.filter((m) => !m.tls).map((m) => m.to), []);
  });
});

// ============================================================ SMTP without STARTTLS
describe("production server whose SMTP connection offers no STARTTLS (misconfigured relay or stripped by an on-path attacker)", () => {
  test(
    "the SMTP password and tokenised links never travel in clear text: the mailer refuses to send",
    async () => {
      const plain = await startSmtp({ starttls: false });
      const srv = await startProd({ SMTP_PORT: String(plain.port), SMTP_USER: "crwn-mailer", SMTP_PASS });
      try {
        const email = "plaintext-90@prod.test";
        assert.equal((await srv.req({ method: "POST", path: "/api/auth/register", body: { email, password: "plaintext-password", displayName: "Plain", acceptPrivacy: true } })).status, 201);
        await srv.req({ method: "POST", path: "/api/auth/forgot-password", body: { email } });
        await sleep(1000);
        assert.deepEqual(plain.lines.filter((l) => /^AUTH\b/i.test(l.line)).map((l) => l.line.slice(0, 10)), [], "AUTH PLAIN (base64 of the SMTP password) was sent unencrypted");
        assert.deepEqual(plain.messages.map((m) => /token=/.test(m.text)), [], "verify/reset links were sent unencrypted");
        assert.doesNotMatch(srv.output(), new RegExp(`${email}|${SMTP_PASS}`));
      } finally {
        await srv.stop();
        await plain.close();
      }
    }
  );
});

// ============================================================ SMTP down
describe("production server with the SMTP server down (closed port)", () => {
  test("requests still answer at once; the failure is logged by code only (no address, port or host)", async () => {
    const closed = await freePort();
    const srv = await startProd({ SMTP_PORT: String(closed) });
    try {
      const email = "smtp-down-80@prod.test";
      const started = Date.now();
      const res = await srv.req({ method: "POST", path: "/api/auth/register", headers: { "x-forwarded-for": "198.51.100.80" }, body: { email, password: "smtp-down-password", displayName: "Down Name", acceptPrivacy: true } });
      assert.equal(res.status, 201);
      assert.ok(Date.now() - started < 3000, "never waits for SMTP");
      await srv.req({ method: "POST", path: "/api/auth/forgot-password", body: { email } });
      for (let i = 0; i < 100 && !/could not send/.test(srv.output()); i++) await sleep(50);
      const { unexpected, leaked } = auditOutput(srv.output(), [email, "smtp-down-password", "Down Name", "198.51.100.80", String(closed), "127.0.0.1"]);
      assert.match(srv.output(), /\[mail\] could not send a "verify" e-mail \([A-Z]+\)/);
      assert.deepEqual(leaked, [], srv.output());
      assert.deepEqual(unexpected, [], srv.output());
    } finally {
      await srv.stop();
    }
  });
});
