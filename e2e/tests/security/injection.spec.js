// Security: injection and input abuse — SQL-ish payloads in every query /
// slug / id parameter, oversized and deeply nested bodies, unicode/NUL, and
// path traversal against the static file server.
import { expect, seedSeries, uniqueEmail, ADMIN, API_ORIGIN } from "../fixtures.js";
import { apiClient, newUserClient, rawRequest, test, withAdmin } from "./helpers.js";

const SERIES = { name: "Sec Inject Saga", slug: "sec-inject-saga", aliases: ["sqli"], genres: ["Injeção"] };
let video;

test.beforeAll(async () => {
  await withAdmin(async (admin) => {
    const seeded = await seedSeries(admin, SERIES, [{ youtubeId: "secInject01", title: "Sec Inject Saga Episode 1", section: "anime", number: 1 }]);
    video = seeded.videos[0];
  });
});

const SQLI = [
  "' OR '1'='1",
  "' OR 1=1 --",
  '" OR ""="',
  "1; DROP TABLE users; --",
  "') UNION SELECT email, password_hash, 1, 1 FROM users --",
  "%' OR 1=1 --",
  "%",
  "_",
  "\\",
  "' AND (SELECT 1 FROM sqlite_master) --",
  "1 AND randomblob(1000000000)",
  "admin'--",
  "$where: 1",
  "{\"$gt\": \"\"}",
];

/** No SQL error text, no stack, no other users' data. */
function expectNoLeak(text, where) {
  expect(text, `${where}: SQL error`).not.toMatch(/SQLITE|syntax error|sqlite_master|no such (table|column)|unrecognized token/i);
  expect(text, `${where}: stack trace`).not.toMatch(/\bat [\w.<>]+ \(|node_modules|\/server\/src\//);
  expect(text, `${where}: user data`).not.toMatch(/password_hash|scrypt|@e2e\.test/);
}

test.describe("SQL / NoSQL-style injection", () => {
  test("payloads in every public q / slug / id / filter parameter: never 5xx, never an SQL error, no data leak", async () => {
    test.setTimeout(90_000);
    const anon = await apiClient();
    for (const p of SQLI) {
      const e = encodeURIComponent(p);
      const urls = [
        `/api/search?q=${e}`,
        `/api/search?genre=${e}`,
        `/api/search?section=${e}`,
        `/api/search?sort=${e}`,
        `/api/search?limit=${e}`,
        `/api/search?offset=${e}`,
        `/api/anime/series?q=${e}`,
        `/api/anime/series?genre=${e}`,
        `/api/anime/series/${e}`,
        `/api/anime/series/${SERIES.slug}?season=${e}`,
        `/api/${e}/series`,
        `/api/videos/${e}`,
        `/api/videos/${e}/rating`,
        `/api/latest?limit=${e}&offset=${e}&section=${e}`,
        `/api/top-rated?section=${e}&limit=${e}`,
        `/api/trending?section=${e}`,
        `/api/random?section=${e}`,
        `/api/genres?x=${e}`,
      ];
      for (const url of urls) {
        const res = await anon.get(url);
        expect(res.status(), `${url}`).toBeLessThan(500);
        expect([200, 400, 404], url).toContain(res.status());
        const text = await res.text();
        expectNoLeak(text, url);
        if (res.status() === 200 && url.startsWith("/api/search?q=")) {
          const body = JSON.parse(text);
          // A payload never turns into "match everything".
          const all = await (await anon.get("/api/search?limit=1")).json();
          expect(body.total, `${url} matched everything`).toBeLessThan(all.total);
        }
      }
    }
    // The database is intact.
    expect((await anon.get("/api/sections")).status()).toBe(200);
    expect((await anon.get(`/api/anime/series/${SERIES.slug}`)).status()).toBe(200);
    await anon.dispose();
  });

  test("payloads in admin list filters and admin route ids (as admin): no 5xx, no SQL error", async ({ admin }) => {
    for (const p of SQLI) {
      const e = encodeURIComponent(p);
      for (const url of [`/api/admin/series?q=${e}`, `/api/admin/series?limit=${e}`, `/api/admin/videos?q=${e}`, `/api/admin/videos?status=${e}`, `/api/admin/videos?availability=${e}&offset=${e}`]) {
        const res = await admin.get(url);
        expect([200, 400], url).toContain(res.status());
        expectNoLeak(await res.text(), url);
      }
      for (const [method, url] of [["PATCH", `/api/admin/series/${e}`], ["DELETE", `/api/admin/series/${e}`], ["PATCH", `/api/admin/videos/${e}`], ["DELETE", `/api/admin/videos/${e}`]]) {
        const res = await admin.fetch(url, { method, ...(method === "PATCH" ? { data: { name: "x" } } : {}) });
        expect([400, 404], `${method} ${url}`).toContain(res.status());
      }
      // Payloads in admin bodies are stored as data or refused, never executed.
      const res = await admin.post("/api/admin/videos", { data: { url: p, title: p } });
      expect([400, 422], `POST /api/admin/videos url=${p}`).toContain(res.status());
    }
    expect((await admin.get(`/api/videos/${video.id}`)).status()).toBe(200);
  });

  test("login / register / forgot with injection payloads: 400/401/202 only, admin is never logged in", async () => {
    const ctx = await apiClient();
    for (const p of SQLI) {
      for (const [email, password] of [[`${ADMIN.email}' --`, p], [ADMIN.email, p], [p, p], [`${ADMIN.email}\u0000`, p]]) {
        const res = await ctx.post("/api/auth/login", { data: { email, password } });
        expect([400, 401], `login ${email} / ${password}`).toContain(res.status());
      }
      // Operator objects instead of strings.
      const obj = await ctx.post("/api/auth/login", { data: { email: { $ne: null }, password: { $ne: null } } });
      expect(obj.status()).toBe(400);
      const fp = await ctx.post("/api/auth/forgot-password", { data: { email: p } });
      expect([400, 202]).toContain(fp.status());
    }
    expect((await (await ctx.get("/api/auth/me")).json()).user).toBeNull();
    await ctx.dispose();
  });
});

test.describe("body abuse", () => {
  test("oversized bodies → 413 JSON error (no crash); the server keeps answering", async () => {
    const { ctx } = await newUserClient();
    for (const [url, method] of [["/api/auth/login", "POST"], ["/api/me", "PATCH"], [`/api/videos/${video.id}/rating`, "PUT"], ["/api/auth/register", "POST"]]) {
      for (const size of [25 * 1024, 2 * 1024 * 1024]) {
        const body = JSON.stringify({ email: "a@b.co", password: "x".repeat(size), displayName: "x" });
        const res = await ctx.fetch(url, { method, headers: { "content-type": "application/json" }, data: body });
        expect(res.status(), `${method} ${url} ${size} bytes`).toBe(413);
        const json = await res.json();
        expect(json.error.code).toBe("PAYLOAD_TOO_LARGE");
        expectNoLeak(JSON.stringify(json), url);
      }
    }
    expect((await ctx.get("/api/auth/me")).status()).toBe(200);
    await ctx.dispose();
  });

  test("deeply nested JSON, arrays, wrong types, prototype keys and bad encodings → 4xx, never 5xx", async () => {
    const ctx = await apiClient();
    const deepObj = '{"a":'.repeat(3000) + "1" + "}".repeat(3000); // < 20 kB
    const deepArr = "[".repeat(9000) + "]".repeat(9000);
    const cases = [
      ["deep object", deepObj],
      ["deep array", deepArr],
      ["deep email", JSON.stringify({ email: JSON.parse('{"a":'.repeat(500) + "1" + "}".repeat(500)), password: "x" })],
      ["array body", "[1,2,3]"],
      ["string body", '"hello"'],
      ["number body", "42"],
      ["null body", "null"],
      ["invalid JSON", "{'email': 'x'}"],
      ["trailing garbage", '{"email":"a@b.co","password":"x"} trailing'],
      ["duplicate keys", '{"email":"a@b.co","email":"admin@e2e.test","password":"x"}'],
      ["__proto__", '{"__proto__":{"isAdmin":true},"email":"a@b.co","password":"x"}'],
      ["lone surrogate", '{"email":"\\ud800@b.co","password":"\\udfff"}'],
      ["NUL", '{"email":"a\\u0000@b.co","password":"x\\u0000"}'],
      ["BOM", "﻿{\"email\":\"a@b.co\",\"password\":\"x\"}"],
    ];
    for (const [name, body] of cases) {
      const res = await ctx.fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, data: body });
      expect(res.status(), name).toBeGreaterThanOrEqual(400);
      expect(res.status(), name).toBeLessThan(500);
      expectNoLeak(await res.text(), name);
    }
    for (const [name, headers] of [
      ["charset=utf-16", { "content-type": "application/json; charset=utf-16" }],
      ["gzip garbage", { "content-type": "application/json", "content-encoding": "gzip" }],
      ["unknown encoding", { "content-type": "application/json", "content-encoding": "br-x" }],
    ]) {
      const res = await rawRequest({ method: "POST", path: "/api/auth/login", headers, body: '{"email":"a@b.co","password":"x"}' });
      expect(res.status, name).toBeGreaterThanOrEqual(400);
      expect(res.status, name).toBeLessThan(500);
      expectNoLeak(res.body, name);
    }
    // Repeated query parameters (?q=a&q=b → array) are a 400, not a crash.
    for (const url of ["/api/search?q=a&q=b", "/api/search?limit=1&limit=2", "/api/latest?offset=1&offset=2"]) {
      const res = await ctx.get(url);
      expect(res.status(), url).toBe(400);
    }
    // Bracket syntax is not expanded into objects (Express 5 "simple" query parser): ignored or refused.
    for (const url of ["/api/search?q[$ne]=x", "/api/search?q[]=x", "/api/search?q[__proto__][x]=1"]) {
      const res = await ctx.get(url);
      expect([200, 400], url).toContain(res.status());
    }
    expect((await ctx.get("/api/auth/me")).status()).toBe(200);
    await ctx.dispose();
  });

  test("unicode / control characters: display names refuse control chars; search handles NUL, RTL and astral input", async () => {
    const { ctx, me } = await newUserClient();
    for (const displayName of ["a\u0000b", "ab\u0007", "line\nbreak\r\nx", "tab\tname\u001b[31m", "\u007fdelete"]) {
      const res = await ctx.patch("/api/me", { data: { displayName } });
      // "\n" and "\t" are whitespace and collapse to spaces; real control characters are refused.
      expect([200, 400], JSON.stringify(displayName)).toContain(res.status());
      if (res.status() === 200) expect((await res.json()).user.displayName).not.toMatch(/[\u0000-\u001f\u007f]/);
    }
    for (const q of ["\u0000", "%00", "‮", "😀".repeat(80), "鬼".repeat(81), "a\u0000' OR 1=1"]) {
      const res = await ctx.get(`/api/search?q=${encodeURIComponent(q)}`);
      expect([200, 400], JSON.stringify(q)).toContain(res.status());
    }
    // Lone surrogate / overlong UTF-8 / broken escapes in the query string (raw bytes).
    for (const raw of ["%ED%A0%80", "%C0%80", "%FF%FE", "%"]) {
      const res = await rawRequest({ path: `/api/search?q=${raw}` });
      expect([200, 400], raw).toContain(res.status);
    }
    // (Malformed %-escapes such as %FF are covered by the finding in headers.spec.js.)
    for (const slug of ["%00", "a%00b", "%E2%80%AE", "%C3%A9%00", "..%2F..%2Fetc%2Fpasswd"]) {
      const res = await rawRequest({ path: `/api/anime/series/${slug}` });
      expect([400, 404], slug).toContain(res.status);
      expectNoLeak(res.body, slug);
    }
    expect(me.role).toBe("user");
    await ctx.dispose();
  });

  // FINDING (low): the e-mail validator (server/src/validation.js:7 EMAIL_RE and
  // v.email() at :36-42) accepts C0 control characters such as NUL ("[^\s@]"
  // does not exclude them), unlike displayName, which refuses them. An account
  // "ad\u0000min@e2e.test" can be registered next to "admin@e2e.test" and is
  // shown identically in UIs/logs; mail is queued to an address containing NUL
  // (relayed as-is to the SMTP transport).
  test("e-mail addresses with control characters (NUL, ESC, DEL) are refused at sign-up", async () => {
    const ctx = await apiClient();
    const local = uniqueEmail("ctl").split("@")[0];
    for (const email of [`${local}\u0000x@e2e.test`, `${local}\u001bx@e2e.test`, `${local}\u007fx@e2e.test`]) {
      const res = await ctx.post("/api/auth/register", { data: { email, password: "correct-horse-battery", displayName: "Ctl", acceptPrivacy: true } });
      expect(res.status(), JSON.stringify(email)).toBe(400);
    }
    await ctx.dispose();
  });
});

test.describe("path traversal on the static file server (API origin)", () => {
  const MARKERS = [/"name":\s*"crwn-animes/, /SMTP_HOST|RATE_LIMIT_MAX|DATABASE_FILE/, /root:x:0:0/, /CREATE TABLE/i, /SQLite format/];
  const TARGETS = ["server/.env", "server/.env.example", "server/package.json", "package.json", "etc/passwd"];
  const PREFIXES = [
    "/assets/../../../",
    "/assets/..%2f..%2f..%2f",
    "/assets/%2e%2e/%2e%2e/%2e%2e/",
    "/assets/%2e%2e%2f%2e%2e%2f%2e%2e%2f",
    "/assets/..%5c..%5c..%5c",
    "/assets/%252e%252e/%252e%252e/%252e%252e/",
    "/assets/....//....//....//",
    "/assets/..;/..;/..;/",
    "/assets/%c0%ae%c0%ae/%c0%ae%c0%ae/%c0%ae%c0%ae/",
    "/../../../",
    "/%2e%2e/%2e%2e/%2e%2e/",
    "/..%2f..%2f..%2f",
    "/genre/..%2f..%2f..%2f..%2f",
    "/anime/..%2f..%2f..%2f..%2f",
    "/api/..%2f..%2f..%2f",
    "//",
    "/assets/../../../../../../../../../../",
  ];

  test("traversal variants never return a file's contents", async () => {
    test.setTimeout(60_000);
    for (const prefix of PREFIXES) {
      for (const target of TARGETS) {
        const variants = [prefix + target, prefix + target.replace(/\//g, "%2f"), prefix + target + "%00.js", prefix + target + "?.js"];
        for (const path of variants) {
          const res = await rawRequest({ path });
          const leaked = MARKERS.find((m) => m.test(res.body));
          expect(leaked, `${path} → ${res.status} leaked ${leaked}`).toBeUndefined();
          expect(res.status, path).not.toBe(500);
          if (res.status === 200) expect(res.headers["content-type"], `${path} served as a file`).toMatch(/text\/html/);
        }
      }
    }
    // Dotfiles and source maps / server files directly under the dist root.
    for (const path of ["/.env", "/.git/config", "/.gitignore", "/server/.env", "/src/main.jsx", "/node_modules/react/package.json", "/package.json", "/../.client-dist/index.html"]) {
      const res = await rawRequest({ path });
      expect(MARKERS.find((m) => m.test(res.body)), path).toBeUndefined();
      expect(res.body, path).not.toMatch(/\[core\]|repositoryformatversion|import React/);
    }
    expect(API_ORIGIN).toMatch(/^http:\/\/localhost:/);
  });
});
