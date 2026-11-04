// v1.5 PWA files from the client build: the service worker and the web manifest
// always revalidate, sw.js may control the whole origin, the offline page is a
// plain static file, and the CSP lets the worker and the manifest load.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { startServer } from "./helpers.js";

const EXPECTED_CSP =
  "default-src 'self';script-src 'self' https://www.youtube.com https://s.ytimg.com;" +
  "frame-src https://www.youtube-nocookie.com https://www.youtube.com;img-src 'self' data:;" +
  "style-src 'self' 'unsafe-inline';font-src 'self';connect-src 'self';object-src 'none';base-uri 'self';" +
  "frame-ancestors 'none';form-action 'self';worker-src 'self';manifest-src 'self'";

const SW = "self.addEventListener('fetch', () => {});\n";
const MANIFEST = JSON.stringify({ name: "Crwn Animes", short_name: "Crwn", start_url: "/", display: "standalone", lang: "pt-BR" });
const OFFLINE = `<!doctype html><html lang="pt-BR"><head><meta charset="UTF-8" /><title>Você está offline</title></head><body>Offline</body></html>`;

describe("PWA files (sw.js, manifest.webmanifest, offline.html)", () => {
  let srv;
  let dir;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "crwn-pwa-"));
    fs.mkdirSync(path.join(dir, "assets"));
    fs.mkdirSync(path.join(dir, "icons"));
    fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html><html><head><title>Crwn Animes</title></head><body><div id="root"></div></body></html>`);
    fs.writeFileSync(path.join(dir, "assets", "index-abc123.js"), "console.log(1)");
    fs.writeFileSync(path.join(dir, "sw.js"), SW);
    fs.writeFileSync(path.join(dir, "manifest.webmanifest"), MANIFEST);
    fs.writeFileSync(path.join(dir, "offline.html"), OFFLINE);
    fs.writeFileSync(path.join(dir, "icons", "icon-192.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    srv = await startServer({ config: { nodeEnv: "production", isProduction: true, clientDist: dir } });
  });
  after(async () => {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const get = (p, init = {}) => fetch(srv.base + p, { redirect: "manual", ...init });

  test("sw.js: no-cache, Service-Worker-Allowed: /, a JavaScript type, the file itself (GET and HEAD)", async () => {
    for (const method of ["GET", "HEAD"]) {
      const res = await get("/sw.js", { method });
      assert.equal(res.status, 200, method);
      assert.equal(res.headers.get("cache-control"), "no-cache", method);
      assert.equal(res.headers.get("service-worker-allowed"), "/", method);
      assert.equal(res.headers.get("content-type"), "text/javascript; charset=utf-8", method);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff", method);
      assert.equal(res.headers.get("content-security-policy"), EXPECTED_CSP, method);
      if (method === "GET") assert.equal(await res.text(), SW);
    }
    // Revalidation works (ETag), and the query string a registration may add changes nothing.
    const etag = (await get("/sw.js")).headers.get("etag");
    assert.ok(etag);
    const again = await get("/sw.js?v=2", { headers: { "if-none-match": etag, "cache-control": "max-age=0" } });
    assert.equal(again.status, 304);
    assert.equal(again.headers.get("cache-control"), "no-cache");
  });

  test("manifest.webmanifest: no-cache, application/manifest+json, the file itself", async () => {
    const res = await get("/manifest.webmanifest");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-cache");
    assert.equal(res.headers.get("content-type"), "application/manifest+json");
    assert.equal(res.headers.get("service-worker-allowed"), null);
    assert.deepEqual(await res.json(), JSON.parse(MANIFEST));
  });

  test("offline.html is a plain static page (no-cache), not the SEO-rendered shell, never redirected", async () => {
    const res = await get("/offline.html");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-cache");
    assert.match(res.headers.get("content-type"), /^text\/html/);
    assert.equal(await res.text(), OFFLINE);
  });

  test("other build files keep their rules; only the root sw.js / manifest get the PWA headers", async () => {
    const asset = await get("/assets/index-abc123.js");
    assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(asset.headers.get("service-worker-allowed"), null);
    const icon = await get("/icons/icon-192.png");
    assert.equal(icon.status, 200);
    assert.equal(icon.headers.get("content-type"), "image/png");
    assert.equal(icon.headers.get("service-worker-allowed"), null);
    // Misses are still plain 404s (never the SPA shell), redirects for index.html still apply.
    for (const p of ["/assets/sw.js", "/sw.js.map", "/manifest.json", "/icons/sw.js", "/sw2.js"]) {
      const res = await get(p);
      assert.equal(res.status, 404, p);
      assert.match(res.headers.get("content-type"), /^text\/plain/, p);
      assert.equal(res.headers.get("service-worker-allowed"), null, p);
    }
    assert.equal((await get("/index.html")).status, 301);
    const page = await get("/anime");
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("content-security-policy"), EXPECTED_CSP);
  });
});
