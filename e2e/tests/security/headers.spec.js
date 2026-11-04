// Security: response headers of the production-shaped server (the API origin,
// which serves both /api and the client build): CSP, Referrer-Policy, nosniff,
// framing, no X-Powered-By, no stack traces, and no-store on private data.
// v1.5: same-origin thumbnails (/api/thumbs) and the PWA files (sw.js, manifest, offline page).
import { expect, seedSeries } from "../fixtures.js";
import { apiClient, closeAdmin, newAdminClient, newUserClient, rawRequest, test, withAdmin } from "./helpers.js";

// docs/API.md v1.1 + v1.5. Thumbnails are same-origin now, so no i.ytimg.com anywhere: script-src
// keeps s.ytimg.com only for the IFrame API loaded on Play, and img-src keeps `https:` only for
// admin-chosen series covers.
const CSP = {
  "default-src": ["'self'"],
  "script-src": ["'self'", "https://www.youtube.com", "https://s.ytimg.com"],
  "frame-src": ["https://www.youtube-nocookie.com", "https://www.youtube.com"],
  "img-src": ["'self'", "data:", "https:"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "font-src": ["'self'"],
  "connect-src": ["'self'"],
  "object-src": ["'none'"],
  "base-uri": ["'self'"],
  "frame-ancestors": ["'none'"],
  "form-action": ["'self'"],
  "worker-src": ["'self'"],
  "manifest-src": ["'self'"],
};

function parseCsp(header) {
  const out = {};
  for (const part of String(header ?? "").split(";").map((s) => s.trim()).filter(Boolean)) {
    const [name, ...values] = part.split(/\s+/);
    out[name.toLowerCase()] = values;
  }
  return out;
}

const SERIES = { name: "Sec Headers Saga", slug: "sec-headers-saga", aliases: [], genres: ["Cabeçalhos"] };
let video;
test.beforeAll(async () => {
  await withAdmin(async (admin) => {
    video = (await seedSeries(admin, SERIES, [{ youtubeId: "secHeader01", title: "Sec Headers Saga Episode 1", section: "anime", number: 1 }])).videos[0];
  });
});

function expectBaseline(headers, where) {
  expect(headers["x-powered-by"], `${where}: X-Powered-By`).toBeUndefined();
  expect(headers["x-content-type-options"], where).toBe("nosniff");
  expect(headers["referrer-policy"], where).toBe("strict-origin-when-cross-origin");
  expect(headers["server"], `${where}: Server header`).toBeUndefined();
  expect(headers["cross-origin-embedder-policy"], `${where}: no COEP (breaks YouTube embeds)`).toBeUndefined();
  const csp = parseCsp(headers["content-security-policy"]);
  expect(csp, `${where}: CSP matches docs/API.md`).toEqual(CSP);
  expect(headers["content-security-policy"], `${where}: CSP ends with the v1.5 directives`).toMatch(/worker-src 'self';\s*manifest-src 'self'$/);
  expect(headers["content-security-policy"], `${where}: no i.ytimg.com in the CSP`).not.toMatch(/i\.ytimg\.com/);
  expect(headers["content-security-policy-report-only"], where).toBeUndefined();
}

test.describe("security headers", () => {
  test("HTML pages (home, series, episode, 404, admin, account) carry the documented CSP and hardening headers", async () => {
    for (const path of ["/", "/anime", `/anime/${SERIES.slug}`, video.route, "/admin", "/account", "/login", "/nao-existe", "/anime/nao-existe", "/privacy", "/search?q=x"]) {
      const res = await rawRequest({ path });
      expect([200, 404], path).toContain(res.status);
      expect(res.headers["content-type"], path).toMatch(/^text\/html/);
      expectBaseline(res.headers, path);
      expect(res.headers["cache-control"], path).toBe("no-cache");
      expect(res.headers["set-cookie"], `${path}: no cookie on page loads`).toBeUndefined();
    }
  });

  test("static assets, robots and sitemap: nosniff + CSP + correct types, immutable caching only for hashed assets", async () => {
    const html = (await rawRequest({ path: "/" })).body;
    const asset = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
    expect(asset).toBeTruthy();
    const js = await rawRequest({ path: asset });
    expect(js.status).toBe(200);
    expect(js.headers["content-type"]).toMatch(/javascript/);
    expect(js.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expectBaseline(js.headers, asset);
    for (const path of ["/robots.txt", "/sitemap.xml", "/favicon.svg", "/assets/missing-file.js"]) {
      const res = await rawRequest({ path });
      expectBaseline(res.headers, path);
    }
    const missing = await rawRequest({ path: "/assets/missing-file.js" });
    expect(missing.status).toBe(404);
    expect(missing.headers["content-type"]).toMatch(/^text\/plain/);
    expect(missing.headers["cache-control"]).not.toMatch(/immutable/);
  });

  test("PWA files (v1.5): sw.js and the manifest always revalidated, sw.js scoped to /, offline page under the CSP", async () => {
    const sw = await rawRequest({ path: "/sw.js" });
    expect(sw.status).toBe(200);
    expect(sw.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(sw.headers["cache-control"]).toBe("no-cache");
    expect(sw.headers["service-worker-allowed"]).toBe("/");
    expectBaseline(sw.headers, "/sw.js");

    const manifest = await rawRequest({ path: "/manifest.webmanifest" });
    expect(manifest.status).toBe(200);
    expect(manifest.headers["content-type"]).toBe("application/manifest+json");
    expect(manifest.headers["cache-control"]).toBe("no-cache");
    expect(JSON.parse(manifest.body).name).toBe("Crwn Animes");
    expectBaseline(manifest.headers, "/manifest.webmanifest");

    const offline = await rawRequest({ path: "/offline.html" });
    expect(offline.status).toBe(200);
    expect(offline.headers["content-type"]).toMatch(/^text\/html/);
    expect(offline.headers["cache-control"]).toBe("no-cache");
    expect(offline.body).toContain("Você está offline");
    // The CSP forbids inline scripts: the offline page's only script is a same-origin file.
    expect(offline.body).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expectBaseline(offline.headers, "/offline.html");

    for (const [path, type] of [["/offline.js", /javascript/], ["/icons/icon-192.png", /^image\/png$/], ["/icons/icon.svg", /^image\/svg\+xml/]]) {
      const res = await rawRequest({ path });
      expect(res.status, path).toBe(200);
      expect(res.headers["content-type"], path).toMatch(type);
      expect(res.headers["cache-control"], `${path}: not a hashed asset, so not immutable`).not.toMatch(/immutable/);
      expectBaseline(res.headers, path);
    }
  });

  test("thumbnails (v1.5): same-origin JPEG, immutable, nosniff, CORP same-origin, no cookie; unknown ids are a no-store 404", async () => {
    const res = await rawRequest({ path: `/api/thumbs/${video.youtubeVideoId}.jpg`, headers: { cookie: "sid=whatever" } });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(res.headers["cache-control"]).toBe("public, max-age=604800, immutable");
    expect(res.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(res.headers["set-cookie"], "thumbnails never set a cookie").toBeUndefined();
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expectBaseline(res.headers, "thumbnail");

    const unknown = await rawRequest({ path: "/api/thumbs/secHdrNope1.jpg" });
    expect(unknown.status).toBe(404);
    expect(unknown.headers["cache-control"]).toBe("private, no-store");
    expect(JSON.parse(unknown.body).error.code).toBe("NOT_FOUND");
    expectBaseline(unknown.headers, "unknown thumbnail");
  });

  test("API JSON responses: hardening headers everywhere, Cache-Control private, no-store on auth/me/admin/rating routes", async () => {
    const anon = await apiClient();
    const { ctx: user } = await newUserClient();
    const admin = await newAdminClient();
    const rating = `/api/videos/${video.id}/rating`;
    const privateRoutes = [
      [anon, "GET", "/api/auth/me"],
      [user, "GET", "/api/auth/me"],
      [anon, "POST", "/api/auth/login", { email: "x@e2e.test", password: "wrong-password" }],
      [anon, "POST", "/api/auth/forgot-password", { email: "x@e2e.test" }],
      [user, "GET", "/api/me/export"],
      [anon, "GET", "/api/me/export"],
      [user, "PATCH", "/api/me", { displayName: "Header Tester" }],
      [admin, "GET", "/api/admin/series"],
      [admin, "GET", "/api/admin/videos"],
      [anon, "GET", "/api/admin/series"],
      [user, "GET", "/api/admin/videos"],
      [anon, "GET", rating],
      [user, "GET", rating],
      [user, "PUT", rating, { score: 4 }],
      [user, "DELETE", rating],
      [anon, "PUT", rating],
      [anon, "GET", "/api/random"],
    ];
    for (const [ctx, method, path, data] of privateRoutes) {
      const res = await ctx.fetch(path, { method, ...(data ? { data } : {}) });
      const h = res.headers();
      expectBaseline(h, `${method} ${path}`);
      expect(h["cache-control"], `${method} ${path} (${res.status()})`).toMatch(path === "/api/random" ? /no-store/ : /^private, no-store$/);
      expect(h["access-control-allow-origin"], `${method} ${path}`).toBeUndefined();
    }
    // Public catalog GETs are cacheable but must never carry user-specific data.
    for (const path of ["/api/latest", "/api/sections", "/api/genres", `/api/videos/${video.id}`, "/api/search?q=sec"]) {
      const res = await user.get(path);
      expect(res.headers()["cache-control"], path).toBe("public, max-age=60, stale-while-revalidate=600");
      expect(res.headers()["set-cookie"], path).toBeUndefined();
      expect(await res.text(), `${path} must not contain "mine"`).not.toMatch(/"mine"|"email"/);
    }
    await Promise.all([anon.dispose(), user.dispose(), closeAdmin(admin)]);
  });

  test("errors never expose stack traces, file paths or framework banners", async () => {
    const probes = [
      ["GET", "/api/nope"],
      ["GET", "/api/videos/999999999"],
      ["GET", "/api/anime/series/does-not-exist"],
      ["GET", "/api/unknown-section/series"],
      ["POST", "/api/auth/login", '{"email":', { "content-type": "application/json" }],
      ["POST", "/api/auth/login", "a=b", { "content-type": "application/x-www-form-urlencoded" }],
      ["POST", "/api/auth/login", "{}", { "content-type": "application/json; charset=koi8-r" }],
      ["POST", "/anime", "x", { "content-type": "text/plain" }],
      ["PUT", "/", "x", { "content-type": "text/plain" }],
      ["DELETE", "/api/auth/me"],
      ["TRACE", "/api/auth/me"],
      ["OPTIONS", "/api/auth/me"],
      ["GET", "/%"],
      ["GET", "/api/%"],
      ["GET", "/assets/%"],
    ];
    for (const [method, path, body, headers = {}] of probes) {
      const res = await rawRequest({ method, path, body: body ?? null, headers });
      expect(res.status, `${method} ${path}`).toBeLessThan(500);
      expect(res.body, `${method} ${path}`).not.toMatch(/\bat [\w.<>]+ \(|\bat (?:async )?[\w.]+ \(?\/|node_modules|\/home\/|\/server\/src\/|Error: |express|body-parser/i);
      expect(res.headers["x-powered-by"], `${method} ${path}`).toBeUndefined();
      if (path.startsWith("/api/") && res.status >= 400 && res.status !== 405 && method !== "TRACE") {
        const json = JSON.parse(res.body);
        expect(Object.keys(json), `${method} ${path}`).toEqual(["error"]);
        expect(Object.keys(json.error).sort()).toEqual(["code", "details", "message"]);
        expect(json.error).not.toHaveProperty("stack");
        expect(res.headers["cache-control"], `${method} ${path}`).toBe("private, no-store");
      }
    }
  });

  // FINDING (low): a malformed %-escape in any Express route parameter
  // (/api/videos/:id, /api/:section/series/:slug, /api/admin/*/:id) makes the
  // router throw a URIError with status 400 but no `expose` flag, so
  // toHttpError() (server/src/app.js:41-57, the `default:` branch) turns it into
  // 500 INTERNAL_ERROR and console.error()s the full stack on every request.
  // Any anonymous client can produce unlimited 500s + stack traces in the logs
  // (log flooding / alert noise). The response body itself leaks nothing.
  test("malformed percent-encoding in route params → 400, not 500", async () => {
    for (const path of ["/api/videos/%E0%A4%A/rating", "/api/videos/%FF", "/api/anime/series/%FF", "/api/anime/series/%C0%AE%C0%AE", "/api/%E0%A4%A/series/x"]) {
      const res = await rawRequest({ path });
      expect(JSON.parse(res.body).error).not.toHaveProperty("stack");
      expect(res.status, path).toBe(400);
    }
  });
});
