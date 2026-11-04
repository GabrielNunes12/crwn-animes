// v1.7 response compression (src/middleware/compression.js): pre-compressed built files,
// on-the-fly brotli/gzip for PUBLIC text responses only, and the never-compress list
// (private/no-store: auth, me, admin, ratings, errors), images and bodies under 1 KB.
// Requests go through node:http so the raw bytes and Content-Encoding are visible
// (fetch() would negotiate and decompress on its own).
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { after, before, describe, test } from "node:test";
import { COMPRESS_MIN_BYTES, chooseEncoding, compressPublic, parseAcceptEncoding } from "../src/middleware/compression.js";
import { addVideo, quickUser, startServer, vid } from "./helpers.js";

const BR_GZIP = "gzip, deflate, br";

/** Raw request (no URL normalisation, no decompression): { status, headers, body: Buffer }. */
function raw(srv, p, { headers = {}, method = "GET" } = {}) {
  const { hostname, port } = new URL(srv.base);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path: p, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

/** The body as the browser sees it, undoing Content-Encoding. */
function decoded(res) {
  const coding = res.headers["content-encoding"];
  if (coding === undefined) return res.body;
  if (coding === "br") return zlib.brotliDecompressSync(res.body);
  if (coding === "gzip") return zlib.gunzipSync(res.body);
  throw new Error(`unexpected Content-Encoding ${coding}`);
}

const varies = (res) => /(?:^|,)\s*accept-encoding\s*(?:,|$)/i.test(res.headers.vary ?? "");

/** Text of `bytes` bytes that compresses well but not trivially (a real bundle-ish body). */
const textOf = (bytes, seed = "x") => {
  let out = "";
  for (let i = 0; out.length < bytes; i++) out += `export const ${seed}${i} = ${JSON.stringify(`value number ${i} of ${seed}`)};\n`;
  return out.slice(0, bytes);
};

// =================================================================== negotiation
describe("Accept-Encoding negotiation (q-values; ties br > gzip > identity)", () => {
  test("chooseEncoding", () => {
    const cases = [
      [undefined, "identity", "no header: the original"],
      ["", "identity", "empty: identity only"],
      ["gzip", "gzip"],
      ["br", "br"],
      ["gzip, br", "br", "a tie goes to br"],
      [BR_GZIP, "br"],
      ["GZIP, BR", "br", "case-insensitive"],
      ["br;q=0.5, gzip;q=0.8", "gzip"],
      ["br;q=1.0, gzip;q=0.999", "br"],
      [" gzip ; q=0.5 , br ; Q=0.4 ", "gzip", "whitespace and Q"],
      ["gzip;q=0, br;q=0", "identity"],
      ["*", "br"],
      ["*;q=0.5, gzip", "gzip"],
      ["br;q=0, *", "gzip"],
      ["identity;q=0", "identity", "nothing acceptable: the original anyway"],
      ["*;q=0", "identity", "nothing acceptable: the original anyway"],
      ["identity;q=0, gzip;q=0.1", "gzip"],
      ["identity, gzip;q=0.5", "identity", "identity has the higher q"],
      ["identity;q=0.5, br;q=0.5", "br", "a tie with identity goes to br"],
      ["deflate", "identity", "unsupported codings are not acceptable"],
      ["deflate, *;q=0.2", "br"],
      ["x-gzip", "gzip"],
      ["br;q=2, gzip;q=0.3", "gzip", "a q above 1 is malformed: ignored"],
      ["br;q=abc, gzip;q=0.3", "gzip", "a q that is no number: ignored"],
      ["br;q=, gzip;q=0.3", "gzip"],
      ["br;q=-1", "identity"],
      ["br, br;q=0", "br", "the first listing counts"],
      ["b r, gzip", "gzip", "a malformed token is ignored"],
      [", ,;, gzip", "gzip"],
    ];
    for (const [header, expected, why = header] of cases) assert.equal(chooseEncoding(header), expected, `${JSON.stringify(header)}: ${why}`);
    // Only the variants that exist compete.
    assert.equal(chooseEncoding("br, gzip;q=0.1", ["gzip"]), "gzip");
    assert.equal(chooseEncoding("br", ["gzip"]), "identity");
    assert.equal(chooseEncoding("br, gzip", []), "identity");
    assert.equal(parseAcceptEncoding(undefined), null);
    assert.deepEqual([...parseAcceptEncoding("br;q=0.2;level=1, gzip")], [["br", 0.2], ["gzip", 1]]);
  });
});

// =================================================================== built files
describe("built files: pre-compressed siblings, else on-the-fly for public text", () => {
  let srv;
  let base; // a dot directory, like lighthouse/.client-dist
  let dist;
  const files = {};
  const write = (rel, body) => {
    const file = path.join(dist, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    files[rel] = Buffer.from(body);
    return file;
  };
  const siblings = (rel, { br = true, gz = true } = {}) => {
    const body = files[rel];
    if (br) fs.writeFileSync(path.join(dist, `${rel}.br`), zlib.brotliCompressSync(body));
    if (gz) fs.writeFileSync(path.join(dist, `${rel}.gz`), zlib.gzipSync(body, { level: 9 }));
  };
  const sibling = (rel, ext) => fs.readFileSync(path.join(dist, `${rel}.${ext}`));

  before(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "crwn-compress-"));
    dist = path.join(base, ".client-dist");
    write("index.html", `<!doctype html><html lang="en"><head><title>Crwn Animes</title><meta name="description" content="Static" /></head><body><div id="root"></div><!-- ${"p".repeat(1500)} --></body></html>`);
    // The build compresses index.html too: these must never be served (the shell goes through the SEO renderer).
    fs.writeFileSync(path.join(dist, "index.html.br"), zlib.brotliCompressSync("RAW-TEMPLATE-SIBLING"));
    fs.writeFileSync(path.join(dist, "index.html.gz"), zlib.gzipSync("RAW-TEMPLATE-SIBLING"));
    write("assets/app-abc123.js", textOf(40_000, "app"));
    siblings("assets/app-abc123.js");
    write("assets/style-abc123.css", `.a{color:red}\n`.repeat(400));
    siblings("assets/style-abc123.css", { br: false });
    write("assets/plain-abc123.js", textOf(20_000, "plain")); // no siblings (an older build)
    write("assets/big-abc123.js", textOf(3_000_000, "big")); // no siblings, streamed through zlib
    write("assets/tiny-abc123.js", "export const tiny = 1;\n");
    write("sw.js", textOf(6_000, "sw"));
    write("manifest.webmanifest", JSON.stringify({ name: "Crwn Animes", icons: Array.from({ length: 40 }, (_, i) => ({ src: `/icons/${i}.png`, sizes: "192x192" })) }));
    siblings("manifest.webmanifest");
    write("offline.html", `<!doctype html><title>Offline</title><p>${"offline ".repeat(300)}</p>`);
    write("favicon.svg", `<svg xmlns="http://www.w3.org/2000/svg">${'<rect width="1" height="1"/>'.repeat(100)}</svg>`);
    write("icons/icon-192.png", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4000, 7)]));
    write(".secret.js", textOf(4000, "secret"));
    siblings(".secret.js");
    srv = await startServer({ config: { clientDist: dist } });
  });
  after(async () => {
    await srv.close();
    fs.rmSync(base, { recursive: true, force: true });
  });

  test("a sibling per Accept-Encoding: Content-Encoding, the ORIGINAL's Content-Type and cache headers, Vary, an ETag per encoding", async () => {
    const p = "/assets/app-abc123.js";
    const identity = await raw(srv, p);
    assert.equal(identity.status, 200);
    assert.equal(identity.headers["content-encoding"], undefined);
    assert.deepEqual(identity.body, files["assets/app-abc123.js"]);
    assert.ok(varies(identity), "Vary even when the original is sent");
    assert.equal(identity.headers["accept-ranges"], "bytes");
    const type = identity.headers["content-type"];
    assert.match(type, /javascript/);

    const etags = new Set([identity.headers.etag]);
    for (const [header, coding] of [
      [BR_GZIP, "br"],
      ["br", "br"],
      ["gzip", "gzip"],
      ["gzip;q=1, br;q=0.5", "gzip"],
      ["*", "br"],
      ["br;q=0, *", "gzip"],
    ]) {
      const res = await raw(srv, p, { headers: { "accept-encoding": header } });
      assert.equal(res.status, 200, header);
      assert.equal(res.headers["content-encoding"], coding, header);
      assert.deepEqual(res.body, sibling("assets/app-abc123.js", coding === "br" ? "br" : "gz"), `${header}: the file on disk, as is`);
      assert.deepEqual(decoded(res), files["assets/app-abc123.js"], `${header}: decodes to the original`);
      assert.equal(res.headers["content-type"], type, `${header}: the original's type`);
      assert.equal(res.headers["content-length"], String(res.body.length), header);
      assert.equal(res.headers["cache-control"], "public, max-age=31536000, immutable", header);
      assert.ok(varies(res), header);
      assert.match(res.headers.etag, new RegExp(`^W/".+-${coding}"$`), header);
      assert.equal(res.headers["accept-ranges"], undefined, `${header}: no ranges on a variant`);
      assert.ok(res.headers["last-modified"], header);
      etags.add(res.headers.etag);
    }
    assert.equal(etags.size, 3, "identity, br and gzip have three different ETags");

    // Nothing acceptable, or only codings we have no sibling for: the original.
    for (const header of ["identity;q=0", "*;q=0", "deflate", "", "br;q=0, gzip;q=0"]) {
      const res = await raw(srv, p, { headers: { "accept-encoding": header } });
      assert.equal(res.status, 200, header);
      assert.equal(res.headers["content-encoding"], undefined, header);
      assert.deepEqual(res.body, files["assets/app-abc123.js"], header);
    }
  });

  test("conditional requests: 304 per encoding's ETag; Range is ignored on a variant (200) and still works on the original", async () => {
    const p = "/assets/app-abc123.js";
    const br = await raw(srv, p, { headers: { "accept-encoding": "br" } });
    const gz = await raw(srv, p, { headers: { "accept-encoding": "gzip" } });
    const plain = await raw(srv, p);

    const notModified = await raw(srv, p, { headers: { "accept-encoding": "br", "if-none-match": br.headers.etag } });
    assert.equal(notModified.status, 304);
    assert.equal(notModified.body.length, 0);
    assert.equal(notModified.headers.etag, br.headers.etag);
    assert.ok(varies(notModified), "Vary on the 304 too");
    // The browser switched encodings: its br ETag does not match the gzip variant.
    assert.equal((await raw(srv, p, { headers: { "accept-encoding": "gzip", "if-none-match": br.headers.etag } })).status, 200);
    assert.equal((await raw(srv, p, { headers: { "accept-encoding": "gzip", "if-none-match": gz.headers.etag } })).status, 304);
    assert.equal((await raw(srv, p, { headers: { "if-none-match": plain.headers.etag } })).status, 304);

    const ranged = await raw(srv, p, { headers: { "accept-encoding": "br", range: "bytes=0-9" } });
    assert.equal(ranged.status, 200, "Range ignored for a compressed variant");
    assert.equal(ranged.headers["content-range"], undefined);
    assert.deepEqual(decoded(ranged), files["assets/app-abc123.js"]);
    const partial = await raw(srv, p, { headers: { range: "bytes=0-9" } });
    assert.equal(partial.status, 206, "the original still serves ranges");
    assert.deepEqual(partial.body, files["assets/app-abc123.js"].subarray(0, 10));

    const head = await raw(srv, p, { method: "HEAD", headers: { "accept-encoding": "br" } });
    assert.equal(head.status, 200);
    assert.equal(head.headers["content-encoding"], "br");
    assert.equal(head.headers["content-length"], String(br.body.length));
    assert.equal(head.body.length, 0);
  });

  test("only the siblings that exist compete: .gz only -> gzip; br wanted -> compressed on the fly instead", async () => {
    const p = "/assets/style-abc123.css";
    const gz = await raw(srv, p, { headers: { "accept-encoding": BR_GZIP.replace("br", "br;q=0.9") } });
    assert.equal(gz.headers["content-encoding"], "gzip");
    assert.deepEqual(gz.body, sibling("assets/style-abc123.css", "gz"));
    assert.match(gz.headers["content-type"], /^text\/css/);
    const br = await raw(srv, p, { headers: { "accept-encoding": "br" } });
    assert.equal(br.headers["content-encoding"], "br", "no .br on disk: compressed per request");
    assert.deepEqual(decoded(br), files["assets/style-abc123.css"]);
    assert.equal(br.headers["cache-control"], "public, max-age=31536000, immutable");
  });

  // A backpressure bug (the zlib stream's "drain" not reaching the pipe) hangs: fail instead.
  test("files without siblings: public text compressed on the fly (also streamed MBs), small files and images as they are", { timeout: 30_000 }, async () => {
    for (const [p, rel, typePattern, cacheControl] of [
      ["/assets/plain-abc123.js", "assets/plain-abc123.js", /javascript/, "public, max-age=31536000, immutable"],
      ["/assets/big-abc123.js", "assets/big-abc123.js", /javascript/, "public, max-age=31536000, immutable"],
      ["/offline.html", "offline.html", /^text\/html/, "no-cache"],
      ["/favicon.svg", "favicon.svg", /^image\/svg\+xml/, "public, max-age=0"],
    ]) {
      for (const coding of ["br", "gzip"]) {
        const res = await raw(srv, p, { headers: { "accept-encoding": coding } });
        assert.equal(res.status, 200, p);
        assert.equal(res.headers["content-encoding"], coding, p);
        assert.deepEqual(decoded(res), files[rel], `${p} ${coding}: intact`);
        assert.ok(res.body.length < files[rel].length / 2, `${p} ${coding}: smaller`);
        assert.match(res.headers["content-type"], typePattern, p);
        assert.equal(res.headers["cache-control"], cacheControl, p);
        assert.ok(varies(res), p);
        assert.equal(res.headers["content-length"], undefined, `${p}: length unknown once compressed`);
        assert.equal(res.headers["accept-ranges"], undefined, p);
      }
    }
    // sw.js keeps its own headers.
    const sw = await raw(srv, "/sw.js", { headers: { "accept-encoding": "br" } });
    assert.equal(sw.headers["content-encoding"], "br");
    assert.equal(sw.headers["content-type"], "text/javascript; charset=utf-8");
    assert.equal(sw.headers["service-worker-allowed"], "/");
    assert.equal(sw.headers["cache-control"], "no-cache");
    assert.deepEqual(decoded(sw), files["sw.js"]);
    // The manifest from its sibling: its exact Content-Type, no-cache.
    const manifest = await raw(srv, "/manifest.webmanifest", { headers: { "accept-encoding": "br" } });
    assert.equal(manifest.headers["content-encoding"], "br");
    assert.deepEqual(manifest.body, sibling("manifest.webmanifest", "br"));
    assert.equal(manifest.headers["content-type"], "application/manifest+json");
    assert.equal(manifest.headers["cache-control"], "no-cache");

    const tiny = await raw(srv, "/assets/tiny-abc123.js", { headers: { "accept-encoding": "br" } });
    assert.equal(tiny.headers["content-encoding"], undefined, "under 1 KB");
    assert.deepEqual(tiny.body, files["assets/tiny-abc123.js"]);
    assert.ok(varies(tiny));
    const png = await raw(srv, "/icons/icon-192.png", { headers: { "accept-encoding": "br" } });
    assert.equal(png.headers["content-encoding"], undefined, "images are sent as they are");
    assert.equal(png.headers["content-type"], "image/png");
    assert.deepEqual(png.body, files["icons/icon-192.png"]);
    assert.ok(!varies(png));
    const pngEtag = png.headers.etag;
    const png304 = await raw(srv, "/icons/icon-192.png", { headers: { "accept-encoding": "br", "if-none-match": pngEtag } });
    assert.equal(png304.status, 304);
    assert.ok(!varies(png304));
  });

  test("the siblings are no URLs of their own; index.html's never replace the SEO shell; dotfiles stay hidden", async () => {
    for (const p of ["/index.html.br", "/index.html.gz", "/assets/app-abc123.js.br", "/assets/app-abc123.js.gz", "/assets/APP-abc123.js.BR"]) {
      const res = await raw(srv, p, { headers: { "accept-encoding": BR_GZIP } });
      assert.equal(res.status, 404, p);
      assert.equal(res.headers["content-encoding"], undefined, p);
    }
    for (const p of ["/.secret.js", "/assets/../.secret.js", "/assets/%2e%2e/.secret.js", "/%2esecret.js"]) {
      const res = await raw(srv, p, { headers: { "accept-encoding": "br" } });
      assert.notEqual(res.status, 200, p);
      assert.doesNotMatch(decoded(res).toString(), /secret0/, p);
    }
    assert.equal((await raw(srv, "/index.html", { headers: { "accept-encoding": "br" } })).status, 301);
    for (const p of ["/", "/anime/one-piece"]) {
      const res = await raw(srv, p, { headers: { "accept-encoding": "br" } });
      assert.equal(res.headers["content-encoding"], "br", p);
      const html = decoded(res).toString();
      assert.doesNotMatch(html, /RAW-TEMPLATE-SIBLING/, `${p}: never the build's index.html.br`);
      assert.match(html, /<title>[^<]+<\/title>/, p);
      assert.match(html, /<meta property="og:title"/, `${p}: the SEO renderer's page`);
    }
  });
});

// =================================================================== dynamic responses
describe("on-the-fly compression of public responses", () => {
  let srv;
  let dir;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "crwn-compress-dyn-"));
    fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html><html lang="en"><head><title>Crwn Animes</title></head><body><div id="root"></div><!-- ${"p".repeat(1200)} --></body></html>`);
    srv = await startServer({ config: { clientDist: dir } });
    for (let n = 1; n <= 30; n++) await addVideo(srv, n, `One Piece Episode ${n}`);
  });
  after(async () => {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("HTML shell, sitemap and catalog JSON: br/gzip by Accept-Encoding, the same bytes once decoded, headers otherwise unchanged", async () => {
    const ignored = new Set(["date", "content-length", "content-encoding", "transfer-encoding"]);
    const comparable = (headers) => Object.fromEntries(Object.entries(headers).filter(([k]) => !ignored.has(k)));
    for (const p of ["/", "/anime/one-piece", "/anime/one-piece/episode/3", "/no-such-page", "/sitemap.xml", "/api/latest", "/api/anime/series/one-piece", `/api/videos/1`]) {
      const identity = await raw(srv, p);
      assert.ok(identity.body.length >= COMPRESS_MIN_BYTES, `${p}: big enough to matter (${identity.body.length} B)`);
      assert.equal(identity.headers["content-encoding"], undefined, p);
      assert.ok(varies(identity), `${p}: Vary also on the uncompressed answer`);
      for (const [header, coding] of [
        [BR_GZIP, "br"],
        ["gzip", "gzip"],
        ["br;q=0.1, gzip;q=0.9", "gzip"],
        ["identity;q=0", undefined],
        ["deflate", undefined],
      ]) {
        const res = await raw(srv, p, { headers: { "accept-encoding": header } });
        assert.equal(res.status, identity.status, `${p} ${header}`);
        assert.equal(res.headers["content-encoding"], coding, `${p} ${header}`);
        assert.deepEqual(decoded(res), identity.body, `${p} ${header}: same body`);
        if (coding) assert.ok(res.body.length < identity.body.length, `${p} ${header}: smaller`);
        // CSP, HSTS, nosniff, CORP, Cache-Control, Content-Type, the weak ETag of the uncompressed body...
        assert.deepEqual(comparable(res.headers), comparable(identity.headers), `${p} ${header}: other headers unchanged`);
      }
    }
    const page = await raw(srv, "/", { headers: { "accept-encoding": "br" } });
    assert.equal(page.headers["cache-control"], "no-cache");
    assert.match(page.headers["content-security-policy"], /img-src 'self' data:/);
    assert.equal((await raw(srv, "/no-such-page", { headers: { "accept-encoding": "br" } })).status, 404, "a 404 shell is compressed too");
    const json = await raw(srv, "/api/latest", { headers: { "accept-encoding": "br" } });
    assert.match(json.headers["cache-control"], /^public/);
    assert.ok(JSON.parse(decoded(json)).items?.length ?? JSON.parse(decoded(json)), "valid JSON");
  });

  test("ETag/304 still work: the weak ETag is the uncompressed body's, the 304 carries Vary", async () => {
    for (const p of ["/api/latest", "/sitemap.xml", "/"]) {
      const br = await raw(srv, p, { headers: { "accept-encoding": "br" } });
      const etag = br.headers.etag;
      assert.match(etag ?? "", /^W\//, p);
      assert.equal((await raw(srv, p)).headers.etag, etag, `${p}: same ETag uncompressed`);
      for (const header of ["br", "gzip", undefined]) {
        const res = await raw(srv, p, { headers: { ...(header ? { "accept-encoding": header } : {}), "if-none-match": etag } });
        assert.equal(res.status, 304, `${p} ${header}`);
        assert.equal(res.body.length, 0);
        assert.equal(res.headers["content-encoding"], undefined);
        assert.ok(varies(res), `${p}: Vary on the 304`);
      }
    }
  });

  test("small public responses (robots.txt, /api/sections) are sent as they are; images are never compressed", async () => {
    for (const p of ["/robots.txt", "/api/sections"]) {
      const res = await raw(srv, p, { headers: { "accept-encoding": "br" } });
      assert.equal(res.status, 200, p);
      assert.ok(res.body.length < COMPRESS_MIN_BYTES, p);
      assert.equal(res.headers["content-encoding"], undefined, p);
      assert.ok(varies(res), p);
    }
    const onePiece = srv.services.repo.getSeries("one-piece");
    for (const p of [`/api/thumbs/${vid(1)}.jpg`, `/api/thumbs/${vid(1)}-m.jpg`, `/api/covers/${onePiece.id}.img`]) {
      const res = await raw(srv, p, { headers: { "accept-encoding": BR_GZIP } });
      assert.equal(res.status, 200, p);
      assert.equal(res.headers["content-encoding"], undefined, p);
      assert.ok(!varies(res), `${p}: no Vary`);
      assert.match(res.headers["content-type"], /^image\//, p);
      assert.equal(res.headers["content-length"], String(res.body.length), p);
      const again = await raw(srv, p, { headers: { "accept-encoding": BR_GZIP, "if-none-match": res.headers.etag } });
      assert.equal(again.status, 304, p);
      assert.ok(!varies(again), `${p}: no Vary on the 304 either`);
    }
  });
});

// =================================================================== never compressed
describe("never compressed: private/no-store responses (BREACH), whatever their size", () => {
  test("auth, me, admin, ratings, dev outbox, no-store and errors stay uncompressed even with a 0-byte threshold", async () => {
    // compressMinBytes 0: size is no excuse, only the never-compress rules keep these plain.
    const srv = await startServer({ config: { compressMinBytes: 0 } });
    try {
      const admin = quickUser(srv, "admin@example.com", "admin").client;
      const user = quickUser(srv, "user@example.com").client;
      const video = await addVideo(srv, 1, "One Piece Episode 1");
      for (let n = 2; n <= 20; n++) await addVideo(srv, n, `One Piece Episode ${n}`);
      const plain = [
        [admin, "/api/auth/me"],
        [user, "/api/auth/me"],
        [user, "/api/me/export"],
        [admin, "/api/admin/videos"],
        [admin, "/api/admin/series"],
        [admin, "/api/admin/metrics"],
        [admin, "/api/admin/trash"],
        [user, `/api/videos/${video.id}/rating`],
        [srv.client(), `/api/videos/${video.id}/rating`],
        [srv.client(), "/api/dev/outbox"],
        [srv.client(), "/api/random"], // no-store
        [srv.client(), "/api/nope"], // 404 error
        [srv.client(), "/api/videos/999999"], // 404 error
        [srv.client(), "/api/me/export"], // 401 error
        [user, "/api/admin/videos"], // 403 error
        [srv.client(), "/api/search?limit=nope"], // 400 error
        [srv.client(), "/api/thumbs/nope.jpg"], // 404 error
      ];
      for (const [client, p] of plain) {
        const res = await raw(srv, p, { headers: { "accept-encoding": BR_GZIP, ...(client.cookie ? { cookie: client.cookie } : {}) } });
        assert.equal(res.headers["content-encoding"], undefined, `${p} (${res.status})`);
        assert.ok(!varies(res), `${p}: no Vary: Accept-Encoding`);
        assert.match(res.headers["cache-control"], /no-store/, p);
        assert.doesNotThrow(() => JSON.parse(res.body.toString()), p);
      }
      const big = await raw(srv, "/api/admin/videos", { headers: { "accept-encoding": "br", cookie: admin.cookie } });
      assert.ok(big.body.length > 4 * COMPRESS_MIN_BYTES, `a big private body (${big.body.length} B) still goes out plain`);

      // The same server does compress public answers of any size (the threshold really is 0 here).
      for (const p of ["/api/sections", "/robots.txt"]) {
        const res = await raw(srv, p, { headers: { "accept-encoding": "br" } });
        assert.equal(res.headers["content-encoding"], "br", p);
      }
    } finally {
      await srv.close();
    }
  });

  test("the route list wins even if a private route said 'public'; Cache-Control private/no-store/no-transform always wins", async () => {
    const app = express();
    app.use(compressPublic({ minBytes: 0 }));
    const body = { text: "secret-ish ".repeat(500) };
    const send = (cacheControl) => (req, res) => {
      if (cacheControl) res.set("Cache-Control", cacheControl);
      res.json(body);
    };
    for (const p of ["/api/auth/x", "/api/me", "/api/me/export", "/api/admin/videos", "/API/Admin/videos", "/api/dev/outbox", "/api/videos/1/rating"]) app.get(p, send("public, max-age=60"));
    app.get("/api/private", send("private, max-age=60"));
    app.get("/api/nostore", send("public, no-store"));
    app.get("/api/notransform", send("public, max-age=60, no-transform"));
    app.get("/api/nocache", send("no-cache"));
    app.get("/api/none", send(null));
    app.get("/api/public", send("public, max-age=60"));
    app.get("/page", send("no-cache"));
    app.get("/page-private", send("private"));
    const server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const srv = { base: `http://127.0.0.1:${server.address().port}` };
    try {
      for (const p of ["/api/auth/x", "/api/me", "/api/me/export", "/api/admin/videos", "/API/Admin/videos", "/api/dev/outbox", "/api/videos/1/rating", "/api/private", "/api/nostore", "/api/notransform", "/api/nocache", "/api/none", "/page-private"]) {
        const res = await raw(srv, p, { headers: { "accept-encoding": "br" } });
        assert.equal(res.status, 200, p);
        assert.equal(res.headers["content-encoding"], undefined, p);
        assert.deepEqual(JSON.parse(res.body), body, p);
      }
      for (const p of ["/api/public", "/page"]) {
        const res = await raw(srv, p, { headers: { "accept-encoding": "br" } });
        assert.equal(res.headers["content-encoding"], "br", p);
        assert.deepEqual(JSON.parse(decoded(res)), body, p);
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
