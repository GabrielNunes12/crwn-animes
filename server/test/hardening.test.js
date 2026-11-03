// Regression tests for the e2e security sweep (four Low findings):
//   1. cross-site forced logout (cookie cleared for cookie-less requests)
//   2. no Origin / Sec-Fetch-Site check on state-changing requests
//   3. malformed %-escapes in route params -> 500 + stack in the log
//   4. control characters accepted in e-mail addresses
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { toHttpError } from "../src/app.js";
import { EMAIL_RE } from "../src/validation.js";
import { addVideo, signUp, startServer } from "./helpers.js";

/** A raw node:http request: the path goes out byte for byte, any header can be set. */
function raw(srv, { method = "GET", path: p, headers = {}, body = null }) {
  const url = new URL(srv.base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: url.hostname, port: url.port, method, path: p, headers: { ...(body != null ? { "content-length": Buffer.byteLength(body) } : {}), ...headers } },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // not JSON
          }
          resolve({ status: res.statusCode, headers: res.headers, body: json, text });
        });
      }
    );
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

const ATTACKER = "http://localhost:9999"; // same site as localhost, another origin
const sidOf = (client) => client.cookie.slice("sid=".length);

describe("1. logout clears the cookie only when one was sent", () => {
  let srv;
  before(async () => {
    srv = await startServer();
  });
  after(() => srv.close());

  for (const route of ["/api/auth/logout", "/api/auth/logout-all"]) {
    test(`${route}: no cookie -> 204 without Set-Cookie`, async () => {
      const res = await raw(srv, { method: "POST", path: route });
      assert.equal(res.status, 204);
      assert.equal(res.headers["set-cookie"], undefined);
      // Other cookies do not count as a session cookie.
      const other = await raw(srv, { method: "POST", path: route, headers: { cookie: "theme=dark; sidx=1" } });
      assert.equal(other.status, 204);
      assert.equal(other.headers["set-cookie"], undefined);
    });

    test(`${route}: an invalid or undecodable sid is still cleared`, async () => {
      for (const sid of ["not-a-session", "%E0%A4%A"]) {
        const res = await raw(srv, { method: "POST", path: route, headers: { cookie: `sid=${sid}` } });
        assert.equal(res.status, 204);
        assert.match(String(res.headers["set-cookie"]), /^sid=;.*Expires=Thu, 01 Jan 1970/);
      }
    });

    test(`${route}: a valid session is ended and its cookie cleared`, async () => {
      const client = await signUp(srv, { email: `out${route.length}@example.com` });
      const res = await client.post(route);
      assert.equal(res.status, 204);
      assert.match(res.setCookie.join("\n"), /^sid=;/);
      assert.equal((await client.get("/api/auth/me")).body.user, null);
    });
  }
});

describe("2. state-changing requests must come from the app's origin", () => {
  let srv;
  let admin;
  before(async () => {
    // APP_URL http://app.test (helpers) + CLIENT_ORIGIN.
    srv = await startServer({ config: { clientOrigins: ["http://client.test:5173"] } });
    admin = await signUp(srv, { email: "admin@example.com" });
    await addVideo(srv, 1, "One Piece Episode 1");
  });
  after(() => srv.close());

  const post = (p, headers, client = null) =>
    raw(srv, { method: "POST", path: p, headers: { ...(client ? { cookie: client.cookie } : {}), ...headers } });
  const assertRefused = (res, label) => {
    assert.equal(res.status, 403, label);
    assert.equal(res.body.error.code, "CROSS_SITE_REQUEST", label);
    assert.equal(res.headers["set-cookie"], undefined, label);
    assert.equal(res.headers["cache-control"], "private, no-store", label);
  };

  test("same-site (another port/subdomain) or cross-site body-less POSTs are refused and change nothing", async () => {
    const user = await signUp(srv, { email: "victim@example.com" });
    const otherDevice = await signUp(srv, { email: "victim2@example.com" });
    await otherDevice.post("/api/auth/login", { email: "victim@example.com", password: "correct-horse-battery" });
    for (const route of ["/api/auth/logout-all", "/api/auth/logout"]) {
      for (const site of ["same-site", "cross-site"]) {
        assertRefused(await post(route, { "sec-fetch-site": site, origin: ATTACKER }, user), `${site} ${route}`);
      }
      // Older browsers: no Sec-Fetch-Site, only Origin.
      assertRefused(await post(route, { origin: ATTACKER }, user), `Origin only ${route}`);
      assertRefused(await post(route, { origin: "null" }, user), `Origin null ${route}`);
      assertRefused(await post(route, { "sec-fetch-site": "same-site" }, user), `no Origin ${route}`);
    }
    assert.equal((await user.get("/api/auth/me")).body.user.email, "victim@example.com");
    assert.equal((await otherDevice.get("/api/auth/me")).body.user.email, "victim@example.com");
  });

  test("admin health check cannot be triggered from another origin", async () => {
    const calls = srv.fake.calls.length;
    assertRefused(await post("/api/admin/videos/health-check", { "sec-fetch-site": "same-site", origin: ATTACKER }, admin));
    assertRefused(await post("/api/admin/videos/health-check", { origin: "https://evil.example" }, admin));
    assert.equal(srv.fake.calls.length, calls, "no oEmbed lookups ran");
    const ok = await post("/api/admin/videos/health-check", { "sec-fetch-site": "same-origin", origin: "http://app.test" }, admin);
    assert.equal(ok.status, 200);
  });

  test("PUT / PATCH / DELETE are checked too (before auth); GET is not", async () => {
    const headers = { "sec-fetch-site": "cross-site", origin: ATTACKER, "content-type": "application/json" };
    for (const [method, p, body] of [
      ["PUT", "/api/videos/1/rating", '{"score":5}'],
      ["DELETE", "/api/videos/1/rating", null],
      ["PATCH", "/api/me", '{"displayName":"Pwned"}'],
      ["DELETE", "/api/me", '{"password":"x"}'],
    ]) {
      assertRefused(await raw(srv, { method, path: p, headers, body }), `${method} ${p}`);
    }
    const get = await raw(srv, { path: "/api/auth/me", headers: { "sec-fetch-site": "cross-site", origin: ATTACKER } });
    assert.equal(get.status, 200);
  });

  test("a non-JSON body is still 415 (checked first)", async () => {
    const res = await raw(srv, {
      method: "POST",
      path: "/api/auth/logout-all",
      headers: { "sec-fetch-site": "cross-site", origin: ATTACKER, "content-type": "application/x-www-form-urlencoded" },
      body: "a=b",
    });
    assert.equal(res.status, 415);
  });

  test("allowed: same-origin / none, a trusted Origin (APP_URL or CLIENT_ORIGIN), or neither header", async () => {
    const login = (headers) =>
      raw(srv, {
        method: "POST",
        path: "/api/auth/login",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ email: "admin@example.com", password: "correct-horse-battery" }),
      });
    for (const headers of [
      { "sec-fetch-site": "same-origin", origin: "http://app.test" },
      { "sec-fetch-site": "same-origin" },
      { "sec-fetch-site": "none" },
      { origin: "http://app.test" },
      { origin: "http://client.test:5173" },
      { "sec-fetch-site": "same-site", origin: "http://client.test:5173" }, // CORS client on a sibling origin
      {},
    ]) {
      const res = await login(headers);
      assert.equal(res.status, 200, JSON.stringify(headers));
    }
    // Look-alikes of trusted origins are not trusted.
    for (const origin of ["http://app.test.evil.example", "https://app.test", "http://app.test:8080", "http://client.test"]) {
      assertRefused(await login({ origin }), origin);
    }
  });

  test("a logged-in same-origin request still works end to end", async () => {
    const client = await signUp(srv, { email: "fine@example.com" });
    const res = await raw(srv, {
      method: "POST",
      path: "/api/auth/logout",
      headers: { cookie: client.cookie, "sec-fetch-site": "same-origin", origin: "http://app.test" },
    });
    assert.equal(res.status, 204);
    assert.match(String(res.headers["set-cookie"]), /^sid=;/);
    assert.equal((await raw(srv, { path: "/api/auth/me", headers: { cookie: `sid=${sidOf(client)}` } })).body.user, null);
  });
});

describe("3. malformed %-escapes are 400 (API) or 404 (pages), never 500", () => {
  let srv;
  let dist;
  before(async () => {
    dist = fs.mkdtempSync(path.join(os.tmpdir(), "crwn-dist-"));
    fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html><html><head><title>x</title></head><body><div id=root></div></body></html>");
    fs.mkdirSync(path.join(dist, "assets"));
    srv = await startServer({ config: { clientDist: dist } });
  });
  after(async () => {
    await srv.close();
    fs.rmSync(dist, { recursive: true, force: true });
  });

  test("API route params", async (t) => {
    const logged = t.mock.method(console, "error", () => {});
    const admin = await signUp(srv, { email: "admin@example.com" });
    const cases = [
      ["GET", "/api/videos/%E0%A4%A/rating"],
      ["GET", "/api/videos/%FF"],
      ["GET", "/api/anime/series/%FF"],
      ["GET", "/api/anime/series/%C0%AE%C0%AE"],
      ["GET", "/api/%E0%A4%A/series/x"],
      ["DELETE", "/api/admin/videos/%FF"],
      ["PATCH", "/api/admin/series/%E0%A4%A"],
    ];
    for (const [method, p] of cases) {
      const res = await raw(srv, { method, path: p, headers: { cookie: admin.cookie } });
      assert.equal(res.status, 400, `${method} ${p}`);
      assert.deepEqual(Object.keys(res.body), ["error"]);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
      assert.ok(res.body.error.details.url);
      assert.doesNotMatch(res.text, /URIError|at .*\(|node_modules/);
      assert.equal(res.headers["cache-control"], "private, no-store");
    }
    assert.equal(logged.mock.callCount(), 0, "nothing logged");
  });

  test("pages and static files", async (t) => {
    const logged = t.mock.method(console, "error", () => {});
    for (const p of ["/%FF", "/anime/%FF", "/anime/x%E0%A4%A/episode/1", "/genre/%FF", "/assets/%FF.js", "/x%FF.png"]) {
      const res = await raw(srv, { path: p });
      assert.ok([400, 404].includes(res.status), `${p} -> ${res.status}`);
    }
    assert.equal(logged.mock.callCount(), 0);
  });

  test("toHttpError: any 4xx status/statusCode keeps its status without logging; other errors are 500", (t) => {
    const logged = t.mock.method(console, "error", () => {});
    const notFound = toHttpError(Object.assign(new Error("internal detail"), { status: 404 }));
    assert.equal(notFound.status, 404);
    assert.equal(notFound.code, "NOT_FOUND");
    assert.equal(notFound.message, "Not Found", "unexposed messages are replaced");
    const tooBig = toHttpError(Object.assign(new Error("x"), { statusCode: 413, expose: true }));
    assert.equal(tooBig.status, 413);
    assert.equal(tooBig.message, "x");
    const uri = toHttpError(new URIError("URI malformed"));
    assert.equal(uri.status, 400);
    assert.equal(uri.code, "VALIDATION_ERROR");
    assert.equal(logged.mock.callCount(), 0);
    assert.equal(toHttpError(Object.assign(new Error("boom"), { status: 503 })).status, 500);
    assert.equal(toHttpError(new Error("boom")).status, 500);
    assert.equal(logged.mock.callCount(), 2, "real server errors are still logged");
  });
});

describe("4. e-mail addresses with control characters are refused", () => {
  let srv;
  before(async () => {
    srv = await startServer();
  });
  after(() => srv.close());

  test("EMAIL_RE", () => {
    for (const bad of ["a\u0000b@x.com", "a\u001bb@x.com", "a\u007fb@x.com", "a\u0085b@x.com", "a@x\u0000.com", "a@x.c\u009fom"]) {
      assert.equal(EMAIL_RE.test(bad), false, JSON.stringify(bad));
    }
    for (const good of ["a@x.com", "josé@exemplo.com.br", "名前@例え.jp"]) assert.equal(EMAIL_RE.test(good), true, good);
  });

  test("register, login, resend and forgot-password answer 400 with details.email", async () => {
    const client = srv.client();
    for (const email of ["ctl\u0000x@example.com", "ctl\u001bx@example.com", "ctl\u007fx@example.com", "ctl\u0085x@example.com", "ad\u0000min@example.com"]) {
      const reg = await client.post("/api/auth/register", { email, password: "correct-horse-battery", displayName: "Ctl", acceptPrivacy: true });
      assert.equal(reg.status, 400, JSON.stringify(email));
      assert.equal(reg.body.error.code, "VALIDATION_ERROR");
      assert.ok(reg.body.error.details.email);
      for (const [route, body] of [
        ["/api/auth/login", { email, password: "whatever-password" }],
        ["/api/auth/resend-verification", { email }],
        ["/api/auth/forgot-password", { email }],
      ]) {
        const res = await client.post(route, body);
        assert.equal(res.status, 400, `${route} ${JSON.stringify(email)}`);
        assert.ok(res.body.error.details.email);
      }
    }
    assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM users").get().n, 0);
    assert.equal(srv.mailer.outbox.length, 0);
    const ok = await client.post("/api/auth/register", { email: "josé@example.com", password: "correct-horse-battery", displayName: "José", acceptPrivacy: true });
    assert.equal(ok.status, 201);
  });
});
