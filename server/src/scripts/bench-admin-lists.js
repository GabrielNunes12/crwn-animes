// Usage: node src/scripts/bench-admin-lists.js [videoCount=50000]
// Builds a throwaway database (temp file, WAL) with `videoCount` videos over
// 1,000 series and some ratings, then times the paginated list endpoints and
// /api/search over real HTTP (admin session) and prints p50/p95 per request.
// When the schema has the v1.4 trash (videos.deleted_at), 1% of the videos and
// 10 series (with their videos) are moved to the trash first, so the lists
// also have to skip trashed rows. Nothing touches the configured database.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../app.js";
import { hashToken } from "../crypto.js";
import { openDatabase } from "../db.js";
import { searchNormalize, searchText } from "../search.js";

const VIDEOS = Number(process.argv[2] ?? 50_000);
const SERIES = 1_000;
const RUNS = 200;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crwn-bench-"));
const db = openDatabase(path.join(dir, "bench.db"), { seedCatalog: false });

const words = ["Pokémon", "Shingeki", "Kyojin", "Café", "Naruto", "Bleach", "Frieren", "Mágica", "Dragão", "Sakamoto"];
console.time("seed");
db.transaction(() => {
  const series = db.prepare("INSERT INTO series (id, slug, name, aliases, genres, search_text) VALUES (?, ?, ?, ?, '[\"Ação\"]', ?)");
  for (let i = 1; i <= SERIES; i++) {
    const name = `${words[i % words.length]} ${words[(i * 7) % words.length]} ${i}`;
    const aliases = [`Alias ${i}`];
    series.run(i, `series-${i}`, name, JSON.stringify(aliases), searchText(name, aliases));
  }
  const video = db.prepare(`
    INSERT INTO videos (id, youtube_video_id, source_title, title_search, channel, section, series_id, season, number,
      status, classification, overrides, created_at, updated_at, published_at)
    VALUES (?, ?, ?, ?, 'Channel', ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`);
  const classification = JSON.stringify({ scores: { anime: 3, manga: 0 }, reasons: ["matched the series name", "found an episode number"], suggestedNumber: 1 });
  const start = Date.UTC(2025, 0, 1);
  for (let i = 1; i <= VIDEOS; i++) {
    const seriesId = (i % SERIES) + 1;
    const section = i % 5 === 0 ? "manga" : "anime";
    const season = section === "manga" ? 1 : (i % 3) + 1;
    const number = Math.floor(i / SERIES) + 1;
    const pending = i % 20 === 0;
    const title = `${words[seriesId % words.length]} ${words[(seriesId * 7) % words.length]} ${seriesId} Episódio ${number} legendado`;
    // 25 videos share every created_at second: plenty of ties for the id tiebreak.
    const created = new Date(start + Math.floor(i / 25) * 1000).toISOString().replace("T", " ").slice(0, 19);
    video.run(
      i, `v${String(i).padStart(10, "0")}`, title, searchNormalize(title), section,
      pending ? null : seriesId, season, number, pending ? "pending" : "published", classification,
      created, created, pending ? null : new Date(start + i * 1000).toISOString()
    );
  }
  db.exec("UPDATE videos SET availability = 'unavailable' WHERE id % 97 = 0");
  db.prepare(`INSERT INTO users (id, email, display_name, password_hash, role, email_verified_at, privacy_accepted_at, created_at)
    VALUES (1, 'admin@bench.test', 'Admin', 'x', 'admin', '2025-01-01', '2025-01-01', '2025-01-01')`).run();
  const user = db.prepare(`INSERT INTO users (id, email, display_name, password_hash, email_verified_at, privacy_accepted_at, created_at)
    VALUES (?, ?, 'U', 'x', '2025-01-01', '2025-01-01', '2025-01-01')`);
  const rating = db.prepare("INSERT INTO ratings (user_id, video_id, score, updated_at) VALUES (?, ?, ?, '2025-01-01')");
  for (let u = 2; u <= 101; u++) {
    user.run(u, `u${u}@bench.test`);
    for (let k = 0; k < 200; k++) rating.run(u, ((u * 7919 + k * 104729) % VIDEOS) + 1, (k % 5) + 1);
  }
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, 1, '2999-01-01T00:00:00.000Z')").run(hashToken("bench"));
})();
const app = createApp({ db, config: { nodeEnv: "test", isProduction: false, rateLimit: { max: 1e9, windowMs: 60_000 } } });
const hasTrash = db.prepare("SELECT 1 FROM pragma_table_info('videos') WHERE name = 'deleted_at'").get();
if (hasTrash) {
  const { trash } = app.locals.services;
  for (let id = 101; id <= VIDEOS; id += 100) trash.trashVideo(id);
  for (let id = 990; id < 1000; id++) trash.trashSeries(id);
}
db.exec("ANALYZE");
console.timeEnd("seed");

const server = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

const cases = [
  "/api/admin/videos",
  "/api/admin/videos?offset=25000",
  `/api/admin/videos?offset=${VIDEOS - 50}`,
  "/api/admin/videos?limit=100&offset=40000",
  "/api/admin/videos?q=pokemon", // series name + titles, many matches
  "/api/admin/videos?q=pokemon&offset=5000",
  "/api/admin/videos?q=episodio%201", // title words
  "/api/admin/videos?q=sakamoto%20cafe%20999", // few matches
  "/api/admin/videos?q=zzzz", // nothing matches: full scan
  "/api/admin/videos?status=pending",
  "/api/admin/videos?status=pending&q=magica",
  "/api/admin/videos?availability=unavailable",
  "/api/admin/videos?availability=unavailable&status=published&q=naruto",
  "/api/admin/series?q=magica&offset=50",
  "/api/latest?section=manga&offset=5000",
  "/api/search", // browse everything, A-Z
  "/api/search?q=pokemon",
  "/api/search?q=pokemon&sort=top",
  "/api/search?sort=new&offset=500",
  "/api/search?q=alias%2099&section=manga",
  "/api/search?genre=a%C3%A7%C3%A3o&sort=top&offset=100",
];

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
const results = [];
for (const url of cases) {
  const get = () => fetch(base + url, { headers: { cookie: "sid=bench" } });
  const first = await get();
  if (first.status !== 200) throw new Error(`${url} -> ${first.status} ${await first.text()}`);
  const body = await first.json();
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    const t = process.hrtime.bigint();
    await (await get()).arrayBuffer();
    times.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  times.sort((a, b) => a - b);
  results.push({
    url,
    total: Array.isArray(body) ? body.length : body.total,
    p50: pct(times, 50).toFixed(1),
    p95: pct(times, 95).toFixed(1),
  });
}
console.log(`${VIDEOS} videos, ${SERIES} series${hasTrash ? " (1% of videos + 10 series in the trash)" : ""}, ${RUNS} sequential requests each (ms):`);
console.table(results);

server.close();
db.close();
fs.rmSync(dir, { recursive: true, force: true });
