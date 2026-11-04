// Usage: node src/scripts/bench-compression.js [episodes=120]
// What on-the-fly compression (src/middleware/compression.js, v1.7) costs per request:
// builds an in-memory catalog (one series with `episodes` videos), renders the real
// responses (catalog JSON and the server-rendered HTML shell, from the built client's
// index.html when there is one), then
//   1. CPU per response: brotli (the middleware's quality 5, text mode) and gzip (level 6)
//      on those exact bodies, measured with process.cpuUsage() over many runs;
//   2. end to end over HTTP: p50/p95 latency with Accept-Encoding br vs none.
// Nothing touches the configured database or the network.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createApp } from "../app.js";
import { SERVER_DIR } from "../config.js";
import { openDatabase } from "../db.js";

const EPISODES = Number(process.argv[2] ?? 120);
const CPU_RUNS = 500;
const HTTP_RUNS = 300;

const dist = fs.mkdtempSync(path.join(os.tmpdir(), "crwn-bench-compress-"));
const built = [path.join(SERVER_DIR, "../client/dist/index.html"), path.join(SERVER_DIR, "../lighthouse/.client-dist/index.html")].find((f) => fs.existsSync(f));
fs.writeFileSync(
  path.join(dist, "index.html"),
  built
    ? fs.readFileSync(built)
    : `<!doctype html><html lang="pt-BR"><head><meta charset="UTF-8" /><title>Crwn Animes</title>${'<link rel="modulepreload" href="/assets/chunk-0000000.js" />'.repeat(12)}</head><body><div id="root"></div></body></html>`
);

const db = openDatabase(":memory:");
const app = createApp({
  db,
  mailer: { send: async () => {}, outbox: [] },
  fetchVideoInfo: async () => ({ title: "x", channel: "Channel" }),
  fetchThumbnail: async () => {
    throw new Error("no thumbnails in this benchmark");
  },
  config: { nodeEnv: "test", isProduction: false, appUrl: "https://crwn.example", clientDist: dist, rateLimit: { max: 1e9, windowMs: 60_000 } },
});
const { videos } = app.locals.services;
for (let n = 1; n <= EPISODES; n++) {
  await videos.add({ url: `bench${String(n).padStart(6, "0")}`, title: `One Piece Episode ${n}`, overrides: {} });
}

const server = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
const { port } = server.address();

function get(p, headers = {}) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    http
      .get({ hostname: "127.0.0.1", port, path: p, headers }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ body: Buffer.concat(chunks), headers: res.headers, ms: Number(process.hrtime.bigint() - started) / 1e6 }));
      })
      .on("error", reject);
  });
}

const cpuMicros = (fn) => {
  for (let i = 0; i < 20; i++) fn(); // warm-up
  const start = process.cpuUsage();
  for (let i = 0; i < CPU_RUNS; i++) fn();
  const used = process.cpuUsage(start);
  return (used.user + used.system) / CPU_RUNS;
};
const pct = (values, p) => values.toSorted((a, b) => a - b)[Math.min(values.length - 1, Math.floor((values.length * p) / 100))];

const targets = [
  ["catalog JSON /api/latest", "/api/latest"],
  ["catalog JSON /api/anime/series/one-piece", "/api/anime/series/one-piece"],
  ["HTML shell /anime/one-piece", "/anime/one-piece"],
  ["HTML shell /anime/one-piece/episode/1", "/anime/one-piece/episode/1"],
];
console.log(`template: ${built ? path.relative(path.join(SERVER_DIR, ".."), built) : "synthetic"}; ${EPISODES} episodes; ${CPU_RUNS} CPU runs, ${HTTP_RUNS} HTTP runs\n`);
for (const [name, p] of targets) {
  const body = (await get(p)).body;
  const br = (input) =>
    zlib.brotliCompressSync(input, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
        [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: input.length,
      },
    });
  const gz = (input) => zlib.gzipSync(input, { level: 6 });
  const brCpu = cpuMicros(() => br(body));
  const gzCpu = cpuMicros(() => gz(body));
  const plain = [];
  const compressed = [];
  for (let i = 0; i < HTTP_RUNS; i++) {
    plain.push((await get(p)).ms);
    const res = await get(p, { "accept-encoding": "br" });
    if (res.headers["content-encoding"] !== "br") throw new Error(`${p} was not compressed`);
    compressed.push(res.ms);
  }
  console.log(
    `${name}: ${body.length} B -> br ${br(body).length} B (${brCpu.toFixed(0)} µs CPU), gzip ${gz(body).length} B (${gzCpu.toFixed(0)} µs CPU); ` +
      `HTTP p50/p95 ${pct(plain, 50).toFixed(2)}/${pct(plain, 95).toFixed(2)} ms plain vs ${pct(compressed, 50).toFixed(2)}/${pct(compressed, 95).toFixed(2)} ms br`
  );
}

server.close();
db.close();
fs.rmSync(dist, { recursive: true, force: true });
