// v1.5 same-origin series covers: GET /api/covers/<seriesId>.img (src/covers.js,
// src/netPolicy.js, src/routes/images.js). The source is an admin-typed URL fetched
// by the server, so most of this file is about SSRF: the resolver and the HTTPS
// transport are injected (no real network); one test runs the real https.request
// against a local TLS server to show the connection is pinned to the checked address.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import https from "node:https";
import { Readable } from "node:stream";
import { after, before, describe, test } from "node:test";
import { COVER_MAX_BYTES, COVER_TIMEOUT_MS, coverHash, coverTarget, fetchCover } from "../src/covers.js";
import { sniffImageType } from "../src/imageCache.js";
import { isPublicAddress } from "../src/netPolicy.js";
import { startRetention } from "../src/retention.js";
import { addVideo, fakeJpeg, fakePng, quickUser, startServer } from "./helpers.js";
import { TEST_TLS } from "./tls-fixture.js";

const PUBLIC_IP = "93.184.216.34";
const PNG = fakePng("x");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x20, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(16)]);
const AVIF = Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from("ftypmif1"), Buffer.from([0, 0, 0, 0]), Buffer.from("mif1avifmiaf"), Buffer.alloc(16)]);
const SEED_COVER = "https://beta.crunchyroll.com/imgsrv/display/thumbnail/1200x675/catalog/crunchyroll/236f44583009506b8d9d012c4d3119a5.jpeg";

/** A resolver: `answers(hostname, callNumber)` -> [{ address, family }] (or throws); calls are recorded. */
function fakeResolver(answers = () => [{ address: PUBLIC_IP, family: 4 }]) {
  const r = { calls: [] };
  r.lookup = async (hostname, options) => {
    r.calls.push({ hostname, options });
    return answers(hostname, r.calls.length);
  };
  return r;
}

/**
 * A fake https.request: on end() it "connects" the way net.connect would, through the
 * lookup it was given (recording the addresses it got), then answers with
 * respond(call) -> { status, headers, body: Buffer | Readable } or "hang".
 */
function fakeHttps(respond = () => ({ headers: { "content-type": "image/png" }, body: PNG })) {
  const t = { calls: [] };
  t.request = (options, onResponse) => {
    const req = new EventEmitter();
    let res = null;
    const call = { options, addresses: null, destroyed: false };
    req.destroy = () => {
      call.destroyed = true;
      res?.destroy();
    };
    req.end = () => {
      options.lookup(options.hostname, { all: true }, async (error, addresses) => {
        call.addresses = addresses.map((a) => a.address);
        t.calls.push(call);
        const answer = await respond(call);
        if (answer === "hang") return;
        res = answer.body instanceof Readable ? answer.body : Readable.from([answer.body]);
        res.statusCode = answer.status ?? 200;
        res.headers = answer.headers ?? {};
        onResponse(res);
      });
    };
    return req;
  };
  return t;
}

/** 64 KB chunks forever (a PNG start first); counts what was read. */
function endlessPng(counter) {
  return new Readable({
    read() {
      if (counter.pulled === 0) {
        counter.pulled += PNG.length;
        return this.push(PNG);
      }
      counter.pulled += 65536;
      this.push(Buffer.alloc(65536, 0x20));
    },
    destroy(error, callback) {
      counter.destroyed = true;
      callback(error);
    },
  });
}

const refused = (promise) => assert.rejects(promise, (error) => error.status === 502 && error.code === "UPSTREAM_ERROR");

// =================================================================== the address policy
describe("isPublicAddress: public unicast only", () => {
  test("IPv4 and IPv6, including mapped, CGNAT, ULA, link-local, multicast, reserved and documentation ranges", () => {
    const publicOnes = ["8.8.8.8", "1.1.1.1", PUBLIC_IP, "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e", "2001:4860:4860::8888"];
    const notPublic = [
      "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.255", "127.0.0.1", "127.255.0.1",
      "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.8", "192.0.2.1", "192.88.99.1", "192.168.1.1",
      "198.18.0.1", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
      "::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:8.8.8.8", "0:0:0:0:0:ffff:a00:1", "::127.0.0.1",
      "64:ff9b::7f00:1", "100::1", "fc00::1", "fd12:3456:789a::1", "fe80::1", "fe80::1%eth0", "febf::1", "fec0::1",
      "ff02::1", "2001:db8::1", "2001::1", "2002:7f00:1::1", "3fff::1",
      "localhost", "example.com", "", "1.2.3", "1.2.3.4.5", "::g", null, undefined, 2130706433,
    ];
    for (const ip of publicOnes) assert.equal(isPublicAddress(ip), true, ip);
    for (const ip of notPublic) assert.equal(isPublicAddress(ip), false, String(ip));
  });

  test("only https on port 443 without credentials is ever fetched (URL spellings normalised first)", () => {
    assert.deepEqual(coverTarget("https://img.example/a/b.jpg?w=300"), { hostname: "img.example", path: "/a/b.jpg?w=300" });
    assert.deepEqual(coverTarget("https://img.example:443/c.png"), { hostname: "img.example", path: "/c.png" });
    assert.deepEqual(coverTarget("https://[2606:4700::1]/c.png"), { hostname: "2606:4700::1", path: "/c.png" });
    assert.equal(coverTarget("https://0x7f.1/c.png").hostname, "127.0.0.1", "IPv4 spellings are normalised (then refused)");
    assert.equal(coverTarget("https://2130706433/c.png").hostname, "127.0.0.1");
    for (const url of ["http://img.example/c.png", "https://img.example:8443/c.png", "https://user:pw@img.example/c.png", "https://user@img.example/c.png",
      "ftp://img.example/c.png", "file:///etc/passwd", "data:image/png;base64,AAAA", "javascript:alert(1)", "not a url", "", null]) {
      assert.equal(coverTarget(url), null, String(url));
    }
  });

  test("sniffImageType: magic bytes, not the extension or the header", () => {
    assert.equal(sniffImageType(fakeJpeg("x")), "image/jpeg");
    assert.equal(sniffImageType(PNG), "image/png");
    assert.equal(sniffImageType(WEBP), "image/webp");
    assert.equal(sniffImageType(AVIF), "image/avif");
    for (const bytes of ["<svg onload=alert(1)>", "GIF89a......", "RIFF....WAVEfmt ", "\0\0\0\x1cftypisom\0\0\0\0isommp41", "<html>"]) {
      assert.equal(sniffImageType(Buffer.from(bytes, "latin1")), null, bytes);
    }
  });
});

// =================================================================== fetchCover (injected resolver + transport)
describe("fetchCover: the SSRF-guarded fetch", () => {
  const fetchWith = (url, resolver, transport, extra = {}) => fetchCover(url, { lookup: resolver.lookup, request: transport.request, ...extra });

  test("a public host: one lookup, a GET pinned to that address on port 443, the validated type back", async () => {
    const resolver = fakeResolver();
    const transport = fakeHttps((call) => ({ headers: { "content-type": "image/webp", "content-length": String(WEBP.length) }, body: WEBP }));
    const image = await fetchWith("https://img.example/covers/frieren.webp?w=600", resolver, transport);
    assert.deepEqual(image, { body: WEBP, type: "image/webp" });
    assert.deepEqual(resolver.calls.map((c) => c.hostname), ["img.example"]);
    assert.equal(resolver.calls[0].options.all, true, "every address is checked, not just the first");
    const [{ options, addresses }] = transport.calls;
    assert.deepEqual(addresses, [PUBLIC_IP], "connected to the checked address");
    assert.equal(options.hostname, "img.example", "TLS (SNI + certificate) still checks the host name");
    assert.equal(options.port, 443);
    assert.equal(options.path, "/covers/frieren.webp?w=600");
    assert.equal(options.method, "GET");
    assert.equal(options.agent, false, "no pooled connection pinned for another host");
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers.cookie, undefined);
    assert.equal(options.headers.authorization, undefined);
    assert.match(options.headers.accept, /image\/avif/);
    for (const [type, body] of [["image/jpeg", fakeJpeg("c")], ["image/png", PNG], ["image/avif", AVIF]]) {
      const t = fakeHttps(() => ({ headers: { "content-type": `${type}; charset=binary` }, body }));
      assert.deepEqual(await fetchWith("https://img.example/c", fakeResolver(), t), { body, type });
    }
  });

  test("private, loopback, link-local, CGNAT, mapped and unique-local answers are refused before any connection", async () => {
    for (const address of ["127.0.0.1", "10.0.0.5", "172.20.1.1", "192.168.0.10", "169.254.169.254", "100.64.1.1", "0.0.0.0",
      "::1", "::ffff:127.0.0.1", "::ffff:10.0.0.5", "fd00::5", "fe80::1", "ff02::1", "2001:db8::1"]) {
      const transport = fakeHttps();
      await refused(fetchWith("https://evil.example/c.png", fakeResolver(() => [{ address, family: address.includes(":") ? 6 : 4 }]), transport));
      assert.equal(transport.calls.length, 0, address);
    }
    // One bad address among good ones is enough to refuse (no lucky pick).
    const mixed = fakeHttps();
    await refused(fetchWith("https://mixed.example/c.png", fakeResolver(() => [{ address: PUBLIC_IP, family: 4 }, { address: "10.0.0.1", family: 4 }]), mixed));
    assert.equal(mixed.calls.length, 0);
    // No answer, or a failing resolver.
    await refused(fetchWith("https://none.example/c.png", fakeResolver(() => []), fakeHttps()));
    await refused(fetchWith("https://nx.example/c.png", fakeResolver(() => { throw Object.assign(new Error("ENOTFOUND nx.example"), { code: "ENOTFOUND" }); }), fakeHttps()));
  });

  test("IP-literal URLs are checked too (no DNS), whatever their spelling", async () => {
    for (const url of ["https://127.0.0.1/c.png", "https://0x7f.1/c.png", "https://2130706433/c.png", "https://169.254.169.254/latest/meta-data/",
      "https://[::1]/c.png", "https://[::ffff:127.0.0.1]/c.png", "https://[fd00::1]/c.png", "https://10.1.2.3/c.png"]) {
      const resolver = fakeResolver();
      const transport = fakeHttps();
      await refused(fetchWith(url, resolver, transport));
      assert.equal(resolver.calls.length + transport.calls.length, 0, url);
    }
    const resolver = fakeResolver();
    const transport = fakeHttps();
    await fetchWith(`https://${PUBLIC_IP}/c.png`, resolver, transport);
    assert.equal(resolver.calls.length, 0, "a public literal needs no lookup");
    assert.deepEqual(transport.calls[0].addresses, [PUBLIC_IP]);
  });

  test("DNS rebinding: the host is resolved ONCE; the connection uses that checked address, not a later answer", async () => {
    const resolver = fakeResolver((hostname, n) => [{ address: n === 1 ? PUBLIC_IP : "127.0.0.1", family: 4 }]);
    const transport = fakeHttps((call) => {
      // The transport may ask the lookup it was given again (as net.connect does per attempt): still the pinned address.
      call.options.lookup(call.options.hostname, {}, (error, address) => (call.again = address));
      return { headers: { "content-type": "image/png" }, body: PNG };
    });
    await fetchWith("https://rebind.example/c.png", resolver, transport);
    assert.equal(resolver.calls.length, 1);
    assert.deepEqual(transport.calls[0].addresses, [PUBLIC_IP]);
    assert.equal(transport.calls[0].again, PUBLIC_IP);
  });

  test("not https, another port, credentials: refused without a lookup", async () => {
    for (const url of ["http://img.example/c.png", "https://img.example:8443/c.png", "https://u:p@img.example/c.png", "ftp://img.example/c.png", "file:///etc/passwd"]) {
      const resolver = fakeResolver();
      const transport = fakeHttps();
      await refused(fetchWith(url, resolver, transport));
      assert.equal(resolver.calls.length + transport.calls.length, 0, url);
    }
  });

  test("redirects, non-200, non-images, type/bytes mismatch, oversize, timeouts: refused", async () => {
    const cases = [
      ["302 redirect", () => ({ status: 302, headers: { location: "https://127.0.0.1/c.png" }, body: Buffer.alloc(0) })],
      ["301 to http", () => ({ status: 301, headers: { location: "http://img.example/c.png" }, body: Buffer.alloc(0) })],
      ["404", () => ({ status: 404, headers: { "content-type": "image/png" }, body: PNG })],
      ["text/html", () => ({ headers: { "content-type": "text/html" }, body: Buffer.from("<script>alert(1)</script>") })],
      ["image/svg+xml", () => ({ headers: { "content-type": "image/svg+xml" }, body: Buffer.from("<svg onload=alert(1)/>") })],
      ["image/gif", () => ({ headers: { "content-type": "image/gif" }, body: Buffer.from("GIF89a") })],
      ["no content-type", () => ({ headers: {}, body: PNG })],
      ["image/png with JPEG bytes", () => ({ headers: { "content-type": "image/png" }, body: fakeJpeg("x") })],
      ["image/jpeg with HTML bytes", () => ({ headers: { "content-type": "image/jpeg" }, body: Buffer.from("<html>") })],
      ["declared over 2 MB", () => ({ headers: { "content-type": "image/png", "content-length": String(COVER_MAX_BYTES + 1) }, body: PNG })],
      ["2 MB + 1 byte", () => ({ headers: { "content-type": "image/png" }, body: fakePng("x", COVER_MAX_BYTES - PNG.length + 1) })],
    ];
    for (const [name, respond] of cases) await refused(fetchWith("https://img.example/c", fakeResolver(), fakeHttps(respond)), name);

    const exact = fakePng("x", COVER_MAX_BYTES - PNG.length);
    assert.equal((await fetchWith("https://img.example/c", fakeResolver(), fakeHttps(() => ({ headers: { "content-type": "image/png" }, body: exact })))).body.length, COVER_MAX_BYTES, "exactly 2 MB is fine");

    const counter = { pulled: 0, destroyed: false };
    await refused(fetchWith("https://img.example/c", fakeResolver(), fakeHttps(() => ({ headers: { "content-type": "image/png" }, body: endlessPng(counter) }))));
    assert.equal(counter.destroyed, true, "the endless download was cut off");
    assert.ok(counter.pulled <= COVER_MAX_BYTES + 4 * 65536, `read ${counter.pulled} bytes`);

    for (const [name, resolver, transport] of [
      ["the lookup never answers", { lookup: () => new Promise(() => {}) }, fakeHttps()],
      ["the server never answers", fakeResolver(), fakeHttps(() => "hang")],
      ["the body stalls", fakeResolver(), fakeHttps(() => ({ headers: { "content-type": "image/png" }, body: new Readable({ read() {} }) }))],
    ]) {
      const started = Date.now();
      await refused(fetchWith("https://slow.example/c.png", resolver, transport, { timeoutMs: 150 }), name);
      assert.ok(Date.now() - started < 1500, `${name}: ${Date.now() - started} ms`);
    }
    assert.equal(COVER_TIMEOUT_MS, 5000);
    assert.equal(COVER_MAX_BYTES, 2 * 1024 * 1024);
  });

  describe("the real https.request against a local TLS server", () => {
    let server;
    let port;
    const served = [];
    before(async () => {
      server = https.createServer({ key: TEST_TLS.key, cert: TEST_TLS.cert }, (req, res) => {
        served.push({ url: req.url, host: req.headers.host, cookie: req.headers.cookie });
        if (req.url === "/c.png") return res.writeHead(200, { "content-type": "image/png" }).end(PNG);
        if (req.url === "/redirect") return res.writeHead(302, { location: "/c.png" }).end();
        res.writeHead(200, { "content-type": "text/html" }).end("<html>");
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      port = server.address().port;
    });
    after(() => new Promise((resolve) => server.close(resolve)));

    /**
     * The real https.request, with two test-only changes: the local server's port, and
     * "NAT" from the pinned public address to 127.0.0.1 (recording what was pinned).
     * Everything else (TLS, SNI, certificate check, the pinned lookup) is real.
     */
    const viaLocalServer = (pinned) => (options, onResponse) =>
      https.request(
        {
          ...options,
          port,
          ca: TEST_TLS.cert,
          lookup: (hostname, opts, callback) =>
            options.lookup(hostname, opts, (error, address, family) => {
              const list = Array.isArray(address) ? address : [{ address, family }];
              pinned.push(...list.map((a) => a.address));
              if (Array.isArray(address)) callback(error, list.map(() => ({ address: "127.0.0.1", family: 4 })));
              else callback(error, "127.0.0.1", 4);
            }),
        },
        onResponse
      );

    test("pinned to the first (checked) answer although DNS now says 127.0.0.1; TLS verifies the host name; redirects are not followed", async () => {
      const pinned = [];
      const resolver = fakeResolver((hostname, n) => [{ address: n === 1 ? PUBLIC_IP : "127.0.0.1", family: 4 }]);
      const image = await fetchCover("https://localhost/c.png", { lookup: resolver.lookup, request: viaLocalServer(pinned) });
      assert.deepEqual(image, { body: PNG, type: "image/png" });
      assert.equal(resolver.calls.length, 1);
      assert.ok(pinned.length >= 1 && pinned.every((a) => a === PUBLIC_IP), `connected via ${pinned}`);
      assert.equal(served.at(-1).url, "/c.png");
      assert.match(served.at(-1).host, /^localhost(:\d+)?$/, "Host is the name (the port is the test server's)");
      assert.equal(served.at(-1).cookie, undefined);

      const count = served.length;
      await refused(fetchCover("https://localhost/redirect", { lookup: fakeResolver().lookup, request: viaLocalServer([]) }));
      assert.equal(served.length, count + 1, "the 302 was not followed");
      await refused(fetchCover("https://localhost/page", { lookup: fakeResolver().lookup, request: viaLocalServer([]) }));
      // A certificate that is not for the host name: the TLS check is still on.
      await refused(fetchCover("https://wrong-host.example/c.png", { lookup: fakeResolver().lookup, request: viaLocalServer([]) }));
    });
  });
});

// =================================================================== HTTP
describe("GET /api/covers/:seriesId.img and Series.coverUrl", () => {
  let srv;
  let resolver;
  let transport;
  let respond;
  let admin;
  before(async () => {
    resolver = fakeResolver();
    respond = () => ({ headers: { "content-type": "image/png" }, body: PNG });
    transport = fakeHttps((call) => respond(call));
    srv = await startServer({
      fetchCover: (url) => fetchCover(url, { lookup: resolver.lookup, request: transport.request }),
      config: { imageMissRateLimit: { max: 1000, windowMs: 60_000 } },
    });
    admin = quickUser(srv, "admin@example.com", "admin").client;
    await addVideo(srv, 1, "One Piece Episode 1"); // the seeded series (crunchyroll cover) gets a published video
  });
  after(() => srv.close());

  const get = async (p) => {
    const res = await fetch(srv.base + p, { redirect: "manual" });
    const body = Buffer.from(await res.arrayBuffer());
    let json = null;
    try {
      json = JSON.parse(body.toString("utf8"));
    } catch {
      // an image
    }
    return { status: res.status, headers: res.headers, body, json };
  };
  const coverFiles = () => (fs.existsSync(srv.thumbDir) ? fs.readdirSync(srv.thumbDir).filter((f) => f.startsWith("cover-")).sort() : []);
  const newSeries = async (name, coverUrl) => (await admin.post("/api/admin/series", { name, coverUrl })).body.series;

  test("public coverUrl is /api/covers/<id>.img?v=<hash>, never the source; admin responses add coverSourceUrl", async () => {
    const onePiece = srv.services.repo.getSeries("one-piece");
    const expected = `/api/covers/${onePiece.id}.img?v=${coverHash(SEED_COVER)}`;
    for (const p of ["/api/anime/series", "/api/anime/series/one-piece", "/api/search?q=one", `/api/videos/${(await srv.client().get("/api/latest")).body[0].id}`]) {
      const res = await srv.client().get(p);
      assert.equal(res.status, 200, p);
      assert.doesNotMatch(res.text, /crunchyroll|coverSourceUrl/, `${p}: the source URL never reaches the public`);
      assert.ok(res.text.includes(JSON.stringify(expected)), `${p}: ${expected}`);
    }
    const page = await admin.get(`/api/admin/series?q=one`);
    const item = page.body.items.find((s) => s.slug === "one-piece");
    assert.equal(item.coverUrl, expected);
    assert.equal(item.coverSourceUrl, SEED_COVER);
    assert.equal((await admin.get(`/api/admin/series/${onePiece.id}`)).body.series.coverSourceUrl, SEED_COVER);
  });

  test("admin create/patch take coverUrl as the source (https, port 443, no credentials); ?v= follows the source", async () => {
    const created = await admin.post("/api/admin/series", { name: "Frieren", coverUrl: "https://img.example/frieren.png" });
    assert.equal(created.status, 201);
    const { series } = created.body;
    assert.equal(series.coverSourceUrl, "https://img.example/frieren.png");
    assert.equal(series.coverUrl, `/api/covers/${series.id}.img?v=${coverHash("https://img.example/frieren.png")}`);
    const patched = (await admin.patch(`/api/admin/series/${series.id}`, { coverUrl: "https://img.example/frieren-2.png" })).body.series;
    assert.notEqual(patched.coverUrl, series.coverUrl, "a new source URL, a new ?v=");
    assert.match(patched.coverUrl, new RegExp(`^/api/covers/${series.id}\\.img\\?v=[0-9a-f]{8}$`));
    const renamed = (await admin.patch(`/api/admin/series/${series.id}`, { synopsis: "An elf mage." })).body.series;
    assert.equal(renamed.coverSourceUrl, "https://img.example/frieren-2.png", "other edits keep the source (never the proxy path)");
    assert.equal(srv.db.prepare("SELECT cover_url FROM series WHERE id = ?").pluck().get(series.id), "https://img.example/frieren-2.png");
    assert.equal((await admin.patch(`/api/admin/series/${series.id}`, { coverUrl: null })).body.series.coverUrl, null);
    for (const coverUrl of ["http://img.example/c.png", "https://img.example:8443/c.png", "https://u:p@img.example/c.png", "javascript:alert(1)", "/api/covers/1.img"]) {
      const res = await admin.post("/api/admin/series", { name: `Bad ${coverUrl.length}`, coverUrl });
      assert.equal(res.status, 400, coverUrl);
      assert.ok(res.body.error.details.coverUrl, coverUrl);
    }
  });

  test("the seeded crunchyroll cover through the proxy: headers, then from disk; concurrent requests share one fetch", async () => {
    const onePiece = srv.services.repo.getSeries("one-piece");
    respond = () => ({ headers: { "content-type": "image/jpeg" }, body: fakeJpeg("onepiece") });
    const before = transport.calls.length;
    const results = await Promise.all(Array.from({ length: 6 }, () => get(`/api/covers/${onePiece.id}.img?v=${coverHash(SEED_COVER)}`)));
    for (const res of results) {
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, fakeJpeg("onepiece"));
      assert.equal(res.headers.get("content-type"), "image/jpeg", "the validated type");
      assert.equal(res.headers.get("cache-control"), "public, max-age=604800");
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.equal(res.headers.get("cross-origin-resource-policy"), "same-origin");
      assert.equal(res.headers.get("set-cookie"), null);
    }
    assert.equal(transport.calls.length, before + 1, "6 requests, 1 upstream fetch");
    const { options } = transport.calls.at(-1);
    assert.equal(options.hostname, "beta.crunchyroll.com");
    assert.equal(options.path, new URL(SEED_COVER).pathname);
    assert.deepEqual(coverFiles(), [`cover-${onePiece.id}-${coverHash(SEED_COVER)}.jpg`]);
    assert.equal((await get(`/api/covers/${onePiece.id}.img`)).status, 200, "?v= is optional");
    assert.equal(transport.calls.length, before + 1, "served from disk");
  });

  test("unknown, trashed, cover-less and malformed: 404 with ZERO upstream calls; trashed series have coverUrl null for admins", async () => {
    const trashed = await newSeries("Trashed Show", "https://img.example/trashed.png");
    const bare = await newSeries("No Cover Show");
    assert.equal((await admin.del(`/api/admin/series/${trashed.id}`)).status, 204);
    const before = resolver.calls.length + transport.calls.length;
    for (const p of [`/api/covers/${trashed.id}.img`, `/api/covers/${bare.id}.img`, "/api/covers/999999.img", "/api/covers/0.img", "/api/covers/-1.img",
      "/api/covers/01.img", "/api/covers/1.jpg", "/api/covers/1", "/api/covers/abc.img", "/api/covers/1.img.img", "/api/covers/99999999999999999999.img",
      "/api/covers/..%2F..%2Fpackage.json", "/api/covers/"]) {
      const res = await get(p);
      assert.equal(res.status, 404, p);
      assert.equal(res.json?.error?.code, "NOT_FOUND", p);
      assert.equal(res.headers.get("cache-control"), "private, no-store", p);
    }
    assert.equal(resolver.calls.length + transport.calls.length, before, "nothing went upstream");
    const inTrash = (await admin.get("/api/admin/trash")).body.series.find((s) => s.id === trashed.id);
    assert.equal(inTrash.coverUrl, null);
    assert.equal(inTrash.coverSourceUrl, "https://img.example/trashed.png");
  });

  test("failures: 502 once upstream, then remembered for 10 minutes (no upstream); a new source URL is a fresh attempt", async () => {
    const series = await newSeries("Fragile Show", "https://img.example/fragile.png");
    respond = () => ({ headers: { "content-type": "text/html" }, body: Buffer.from("<html>") });
    const before = transport.calls.length;
    const first = await get(`/api/covers/${series.id}.img`);
    assert.equal(first.status, 502);
    assert.equal(first.json.error.code, "UPSTREAM_ERROR");
    assert.doesNotMatch(first.json.error.message, /img\.example|93\.184|html/);
    for (let i = 0; i < 3; i++) assert.equal((await get(`/api/covers/${series.id}.img`)).status, 502);
    assert.equal(transport.calls.length, before + 1, "remembered: one upstream attempt");

    respond = () => ({ headers: { "content-type": "image/png" }, body: PNG });
    const moved = (await admin.patch(`/api/admin/series/${series.id}`, { coverUrl: "https://img.example/fragile-fixed.png" })).body.series;
    const fixed = await get(moved.coverUrl);
    assert.equal(fixed.status, 200, "another source URL is another key: tried at once");
    assert.equal(transport.calls.length, before + 2);
    // A private address is a failure like any other (and remembered).
    const sneaky = (await admin.post("/api/admin/series", { name: "Sneaky Show", coverUrl: "https://127.0.0.1/admin.png" })).body.series;
    assert.equal(sneaky.coverSourceUrl, "https://127.0.0.1/admin.png", "accepted as a URL...");
    const count = transport.calls.length;
    assert.equal((await get(`/api/covers/${sneaky.id}.img`)).status, 502, "...never fetched");
    assert.equal(transport.calls.length, count);
  });

  test("covers of series deleted for good are removed; a replaced cover's file goes with the hourly prune", async () => {
    respond = () => ({ headers: { "content-type": "image/png" }, body: PNG });
    const doomed = await newSeries("Doomed Show", "https://img.example/doomed.png");
    const changing = await newSeries("Changing Show", "https://img.example/v1.png");
    for (const s of [doomed, changing]) assert.equal((await get(s.coverUrl)).status, 200);
    const fileOf = (s, url) => `cover-${s.id}-${coverHash(url)}.png`;
    assert.ok(coverFiles().includes(fileOf(doomed, "https://img.example/doomed.png")));

    assert.equal((await admin.del(`/api/admin/series/${doomed.id}`)).status, 204);
    assert.ok(coverFiles().includes(fileOf(doomed, "https://img.example/doomed.png")), "the trash keeps it (restore)");
    assert.equal((await admin.del(`/api/admin/trash/series/${doomed.id}`)).status, 204);
    assert.equal(coverFiles().some((f) => f.startsWith(`cover-${doomed.id}-`)), false, "delete forever removes it");

    await admin.patch(`/api/admin/series/${changing.id}`, { coverUrl: "https://img.example/v2.png" });
    assert.ok(coverFiles().includes(fileOf(changing, "https://img.example/v1.png")));
    startRetention(srv.db, { intervalMs: 3_600_000, images: srv.services.images })();
    assert.equal(coverFiles().includes(fileOf(changing, "https://img.example/v1.png")), false, "the old cover no series uses is pruned");
    assert.ok(coverFiles().length > 0, "current covers stay");
  });
});

describe("thumbnails and covers share one per-IP limit on cache misses", () => {
  test("beyond it a 429 (Retry-After) without upstream; cache hits and remembered failures do not count", async () => {
    const srv = await startServer({ config: { imageMissRateLimit: { max: 3, windowMs: 60_000 } } });
    try {
      for (let n = 1; n <= 4; n++) await addVideo(srv, n, `One Piece Episode ${n}`);
      const onePiece = srv.services.repo.getSeries("one-piece");
      const status = async (p) => (await fetch(srv.base + p)).status;
      assert.equal(await status("/api/thumbs/vid00000001.jpg"), 200);
      assert.equal(await status("/api/thumbs/vid00000002.jpg"), 200);
      assert.equal(await status(`/api/covers/${onePiece.id}.img`), 200);
      const limited = await fetch(srv.base + "/api/thumbs/vid00000003.jpg");
      assert.equal(limited.status, 429);
      assert.equal((await limited.json()).error.code, "RATE_LIMITED");
      assert.ok(Number(limited.headers.get("retry-after")) > 0);
      assert.equal(limited.headers.get("cache-control"), "private, no-store");
      assert.deepEqual(srv.fake.thumbCalls, ["vid00000001", "vid00000002"], "no upstream call for the limited one");
      for (let i = 0; i < 5; i++) {
        assert.equal(await status("/api/thumbs/vid00000001.jpg"), 200, "cache hits are never limited");
        assert.equal(await status(`/api/covers/${onePiece.id}.img`), 200);
      }
    } finally {
      await srv.close();
    }
  });
});
