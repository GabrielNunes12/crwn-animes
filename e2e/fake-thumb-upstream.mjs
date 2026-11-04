// A stand-in for https://i.ytimg.com during e2e runs (THUMB_UPSTREAM, docs/API.md v1.5).
// Started by playwright.config.js (webServer "thumbs"); the e2e API fetches
// `${THUMB_UPSTREAM}/vi/<id>/hqdefault.jpg` from here instead of YouTube.
//
//   GET /vi/<11-char id>/hqdefault.jpg  → 200 image/jpeg (a 160×90 JPEG)
//   GET /vi/<11-char id>/mqdefault.jpg  → 200 image/jpeg (same JPEG; hits counted under `<id>-m`)
//       ids starting with "upFail"      → 404 (the API must answer 502)
//   GET /__hits?id=<id>                 → { id, hits }: how many times the API asked for that id
//                                         (lets tests prove a 404 happened before any upstream call)
//   GET /healthz                        → 200 (Playwright's readiness probe)
//   anything else                       → 404
import http from "node:http";

const PORT = Number(process.env.E2E_THUMB_PORT || 4617);

// 160×90, two colour bands, baseline JPEG (509 bytes): small, valid, decodable by Chromium.
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAA0JCgsKCA0LCgsODg0PEyAVExISEyccHhcgLikxMC4pLSwzOko+MzZGNywtQFdBRkxOUlNSMj5aYVpQYEpRUk//2wBDAQ4ODhMREyYVFSZPNS01T09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0//wAARCABaAKADASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAAAAMC/8QAFxABAAMAAAAAAAAAAAAAAAAAABRiof/EABgBAQADAQAAAAAAAAAAAAAAAAADBAUG/8QAGhEBAAMAAwAAAAAAAAAAAAAAAAMUUgGhsf/aAAwDAQACEQMRAD8AyA6dMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC8a+Ea+K1yHXXK1Tmz4gLxr4Rr4XIddclObPiAvGvhGvhch11yU5s+IC8a+Ea+FyHXXJTmz4gLxr4Rr4XIddclObPiAvGvhGvhch11yU5s+IC8a+Ea+FyHXXJTmz4gLxr4Rr4XIddclObPiAvGvhGvhch11yU5s+IC8a+Ea+FyHXXJTmz4uAw22AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/9k=",
  "base64"
);
// hqdefault (480w, `<id>.jpg`) and mqdefault (320w, `<id>-m.jpg`); counted separately: the hit key
// is `<id>` for hqdefault and `<id>-m` for mqdefault (so existing `?id=<id>` callers are unchanged).
const THUMB_PATH = /^\/vi\/([A-Za-z0-9_-]{11})\/(hq|mq)default\.jpg$/;
const hits = new Map(); // id -> number of upstream requests

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://upstream");
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("ok");
  }
  if (url.pathname === "/__hits") {
    const id = url.searchParams.get("id") ?? "";
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify({ id, hits: hits.get(id) ?? 0 }));
  }
  const m = THUMB_PATH.exec(url.pathname);
  const id = m?.[1];
  const key = m ? (m[2] === "mq" ? `${id}-m` : id) : null;
  if (key) hits.set(key, (hits.get(key) ?? 0) + 1);
  if (req.method !== "GET" || !id || id.startsWith("upFail")) {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("not found");
  }
  res.writeHead(200, { "content-type": "image/jpeg", "content-length": JPEG.length, "cache-control": "public, max-age=7200" });
  res.end(JPEG);
});

server.listen(PORT, "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
