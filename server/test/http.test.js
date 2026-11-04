import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { addVideo, lastEmail, signUp, startServer, tokenFrom } from "./helpers.js";

const EXPECTED_CSP =
  "default-src 'self';script-src 'self' https://www.youtube.com https://s.ytimg.com;" +
  "frame-src https://www.youtube-nocookie.com https://www.youtube.com;img-src 'self' data:;" +
  "style-src 'self' 'unsafe-inline';font-src 'self';connect-src 'self';object-src 'none';base-uri 'self';" +
  "frame-ancestors 'none';form-action 'self';worker-src 'self';manifest-src 'self'";

describe("security & caching headers", () => {
  let srv;
  before(async () => {
    srv = await startServer();
    await addVideo(srv, 1, "One Piece Episode 1");
  });
  after(() => srv.close());

  test("CSP, Referrer-Policy, no COEP", async () => {
    const res = await srv.client().get("/api/sections");
    assert.equal(res.headers.get("content-security-policy"), EXPECTED_CSP);
    assert.equal(res.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
    assert.equal(res.headers.get("cross-origin-embedder-policy"), null);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-powered-by"), null);
  });

  test("public catalog GETs are cacheable with an ETag and answer 304", async () => {
    for (const p of ["/api/sections", "/api/genres", "/api/latest", "/api/anime/series", "/api/anime/series/one-piece", "/api/videos/1", "/api/top-rated", "/api/trending"]) {
      const res = await srv.client().get(p);
      assert.equal(res.status, 200, p);
      assert.equal(res.headers.get("cache-control"), "public, max-age=60, stale-while-revalidate=600", p);
      assert.ok(res.headers.get("etag"), p);
    }
    const first = await srv.client().get("/api/anime/series/one-piece");
    const again = await srv.client().get("/api/anime/series/one-piece", {
      // Node's fetch adds "Cache-Control: no-cache" to conditional requests (a forced reload); a browser revalidating sends max-age=0.
      headers: { "if-none-match": first.headers.get("etag"), "cache-control": "max-age=0" },
    });
    assert.equal(again.status, 304);
    assert.equal(again.text, "");
  });

  test("auth, me, admin and rating routes are private, no-store", async () => {
    const user = await signUp(srv, { email: "h@example.com" });
    for (const p of ["/api/auth/me", "/api/me/export", "/api/admin/series", "/api/videos/1/rating"]) {
      const res = await user.get(p);
      assert.equal(res.headers.get("cache-control"), "private, no-store", p);
    }
    const notFound = await srv.client().get("/api/anime/series/missing");
    assert.equal(notFound.headers.get("cache-control"), "private, no-store", "errors are never cached");
  });

  test("CORS only for CLIENT_ORIGIN, with credentials", async () => {
    const ok = await srv.client().request("OPTIONS", "/api/auth/login", {
      headers: { origin: "http://localhost:5173", "access-control-request-method": "POST" },
    });
    assert.equal(ok.headers.get("access-control-allow-origin"), "http://localhost:5173");
    assert.equal(ok.headers.get("access-control-allow-credentials"), "true");
    const evil = await srv.client().get("/api/sections", { headers: { origin: "https://evil.example" } });
    assert.equal(evil.headers.get("access-control-allow-origin"), null);
  });

  test("dev outbox exists outside production only", async () => {
    assert.equal((await srv.client().get("/api/dev/outbox")).status, 200);
    const prod = await startServer({ config: { nodeEnv: "production", isProduction: true } });
    try {
      assert.equal((await prod.client().get("/api/dev/outbox")).status, 404);
    } finally {
      await prod.close();
    }
  });
});

describe("production: built client", () => {
  let srv;
  let dir;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "crwn-dist-"));
    fs.mkdirSync(path.join(dir, "assets"));
    fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Crwn Animes</title>");
    fs.writeFileSync(path.join(dir, "assets", "app-1a2b3c.js"), "console.log('hi')");
    srv = await startServer({ config: { nodeEnv: "production", isProduction: true, clientDist: dir } });
  });
  after(async () => {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("serves assets immutable, index.html no-cache, SPA fallback, API 404 stays JSON", async () => {
    const asset = await srv.client().get("/assets/app-1a2b3c.js");
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");

    for (const p of ["/", "/anime", "/verify-email?token=abc"]) {
      const page = await srv.client().get(p);
      assert.equal(page.status, 200, p);
      assert.match(page.text, /Crwn Animes/);
      assert.equal(page.headers.get("cache-control"), "no-cache", p);
    }
    // v1.2: an episode that does not exist is a real 404, still with the SPA shell.
    const missing = await srv.client().get("/anime/one-piece/episode/5");
    assert.equal(missing.status, 404);
    assert.match(missing.text, /Página não encontrada · Crwn Animes/);
    assert.equal(missing.headers.get("cache-control"), "no-cache");
    const api = await srv.client().get("/api/nothing");
    assert.equal(api.status, 404);
    assert.equal(api.body.error.code, "NOT_FOUND");
  });

  test("session cookie is Secure in production", async () => {
    const client = srv.client();
    await client.post("/api/auth/register", { email: "prod@example.com", password: "a-long-password", displayName: "Prod", acceptPrivacy: true });
    const token = tokenFrom(lastEmail(srv.mailer, "prod@example.com"));
    const res = await client.post("/api/auth/verify-email", { token, password: "a-long-password" });
    assert.equal(res.status, 200);
    assert.match(res.setCookie.find((c) => c.startsWith("sid=")), /;\s*Secure/i);
  });
});
