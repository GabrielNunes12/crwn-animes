// Usage: node src/scripts/bench-admin-metrics.js [videoCount=50000] [ratingCount=1000000] [--analyze]
// Builds a throwaway database (temp file, WAL) at schema 13 (before v1.6) with
// `videoCount` videos over 1,000 series (5% pending: most with no series, some
// whose slot is taken; 1 in 97 unavailable; 1% of the videos and 10 series in
// the trash) and `ratingCount` ratings by 20,000 users spread over the last 90
// days (all kept by the retention job: the most rating_activity rows the daily
// chart could face), plus 1,000 cached thumbnails. Then it times the upgrade
// to the current schema (migration 14 rebuilds series/videos, 15 fills
// rating_days) and GET /api/admin/metrics over real HTTP (admin session), and
// the service call alone, printing p50/p95. Nothing touches the configured database.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../app.js";
import { hashToken } from "../crypto.js";
import { SCHEMA_VERSION, openDatabase } from "../db.js";
import { searchNormalize, searchText } from "../search.js";

const [videoArg, ratingArg] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const VIDEOS = Number(videoArg ?? 50_000);
const RATINGS = Number(ratingArg ?? 1_000_000);
const ANALYZE = process.argv.includes("--analyze");
const SERIES = 1_000;
const USERS = 20_000;
const PER_USER = Math.ceil(RATINGS / USERS);
const RUNS = 300;
const DAY = 86_400_000;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crwn-bench-metrics-"));
const file = path.join(dir, "bench.db");
const thumbDir = path.join(dir, "thumbs");
fs.mkdirSync(thumbDir);
for (let i = 1; i <= 1000; i++) fs.writeFileSync(path.join(thumbDir, `t${String(i).padStart(10, "0")}.jpg`), Buffer.alloc(8000, 1));

console.time(`seed (schema 13)`);
const old = openDatabase(file, { seedCatalog: false, migrateTo: 13 });
old.transaction(() => {
  const series = old.prepare("INSERT INTO series (id, slug, name, aliases, genres, search_text) VALUES (?, ?, ?, ?, '[\"Ação\"]', ?)");
  for (let i = 1; i <= SERIES; i++) {
    const name = `Series ${i}`;
    series.run(i, `series-${i}`, name, "[]", searchText(name, []));
  }
  const video = old.prepare(`
    INSERT INTO videos (id, youtube_video_id, source_title, title_search, channel, section, series_id, season, number,
      status, classification, overrides, created_at, updated_at, published_at)
    VALUES (?, ?, ?, ?, 'Channel', ?, ?, ?, ?, ?, '{"reasons":[]}', '{}', ?, ?, ?)`);
  const start = Date.now() - 400 * DAY;
  const slot = (i) => {
    const section = i % 5 === 0 ? "manga" : "anime";
    return { section, seriesId: (i % SERIES) + 1, season: section === "manga" ? 1 : (i % 3) + 1, number: Math.floor(i / SERIES) + 1 };
  };
  for (let i = 1; i <= VIDEOS; i++) {
    const pending = i % 20 === 0;
    const slotTaken = pending && i % 100 === 0; // the slot of the published video i + 2 (i + 1 goes to the trash)
    const s = slot(slotTaken ? i + 2 : i);
    const title = `Series ${s.seriesId} Episódio ${s.number}`;
    const created = new Date(start + i * 600_000).toISOString().replace("T", " ").slice(0, 19);
    video.run(
      i, `v${String(i).padStart(10, "0")}`, title, searchNormalize(title), pending && !slotTaken ? null : s.section,
      pending && !slotTaken ? null : s.seriesId, s.season, pending && !slotTaken ? null : s.number,
      pending ? "pending" : "published", created, created, pending ? null : new Date(start + i * 600_000).toISOString()
    );
  }
  old.exec("UPDATE videos SET availability = 'unavailable' WHERE id % 97 = 0");
  old.prepare(`INSERT INTO users (id, email, display_name, password_hash, role, email_verified_at, privacy_accepted_at, created_at)
    VALUES (1, 'admin@bench.test', 'Admin', 'x', 'admin', '2025-01-01', '2025-01-01', '2025-01-01')`).run();
  const user = old.prepare(`INSERT INTO users (id, email, display_name, password_hash, email_verified_at, privacy_accepted_at, created_at)
    VALUES (?, ?, 'U', 'x', '2025-01-01', '2025-01-01', '2025-01-01')`);
  const rating = old.prepare("INSERT INTO ratings (user_id, video_id, score, updated_at) VALUES (?, ?, ?, ?)");
  const now = Date.now();
  let made = 0;
  for (let u = 2; u < 2 + USERS && made < RATINGS; u++) {
    user.run(u, `u${u}@bench.test`);
    for (let k = 0; k < PER_USER && made < RATINGS; k++, made++) {
      const at = new Date(now - ((u * 7 + k) % 90) * DAY - (k % 24) * 3_600_000).toISOString();
      rating.run(u, ((u * 7919 + k * 104729) % VIDEOS) + 1, ((u + k) % 5) + 1, at);
    }
  }
  old.exec(`
    INSERT INTO rating_activity (video_id, day, count, score_sum)
    SELECT video_id, substr(updated_at, 1, 10), COUNT(*), SUM(score) FROM ratings GROUP BY 1, 2`);
  old.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, 1, '2999-01-01T00:00:00.000Z')").run(hashToken("bench"));
  // The trash, as trashService does it (the triggers keep the aggregates).
  const at = new Date().toISOString();
  old.prepare("UPDATE videos SET deleted_at = ?, trashed_with_series = 0 WHERE id % 100 = 1 AND status = 'published'").run(at);
  old.prepare("UPDATE series SET deleted_at = ? WHERE id BETWEEN 990 AND 999").run(at);
  old.prepare("UPDATE videos SET deleted_at = ?, trashed_with_series = 1 WHERE series_id BETWEEN 990 AND 999 AND deleted_at IS NULL").run(at);
})();
const counts = old.prepare(`
  SELECT (SELECT COUNT(*) FROM videos) AS videos, (SELECT COUNT(*) FROM ratings) AS ratings,
    (SELECT COUNT(*) FROM rating_activity) AS activity`).get();
old.close();
console.timeEnd(`seed (schema 13)`);
console.log(counts);

let t = process.hrtime.bigint();
const db = openDatabase(file, { seedCatalog: false });
const migrationMs = Number(process.hrtime.bigint() - t) / 1e6;
console.log(`migrations 14..${SCHEMA_VERSION} on that database: ${migrationMs.toFixed(0)} ms`);
if (ANALYZE) db.exec("ANALYZE");

const app = createApp({
  db,
  config: { nodeEnv: "test", isProduction: false, rateLimit: { max: 1e9, windowMs: 60_000 }, thumbCacheDir: thumbDir },
});
const server = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
const time = async (fn) => {
  await fn();
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    t = process.hrtime.bigint();
    await fn();
    times.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  times.sort((a, b) => a - b);
  return { p50: pct(times, 50).toFixed(2), p95: pct(times, 95).toFixed(2), max: times.at(-1).toFixed(2) };
};

const results = [];
for (const days of [7, 30, 90]) {
  const url = `/api/admin/metrics?days=${days}`;
  const first = await fetch(base + url, { headers: { cookie: "sid=bench" } });
  if (first.status !== 200) throw new Error(`${url} -> ${first.status} ${await first.text()}`);
  const body = await first.json();
  results.push({
    what: `GET ${url}`,
    ...(await time(async () => (await fetch(base + url, { headers: { cookie: "sid=bench" } })).arrayBuffer())),
  });
  results.push({ what: `metrics.get({ days: ${days} }) only`, ...(await time(() => app.locals.services.metrics.get({ days }))) });
  if (days === 30) {
    console.log(JSON.stringify({ ...body, ratings: { ...body.ratings, daily: `${body.ratings.daily.length} days` } }));
  }
}
console.log(`${counts.videos} videos, ${counts.ratings} ratings (${counts.activity} rating_activity rows), ${SERIES} series${ANALYZE ? ", ANALYZE" : ""}; ${RUNS} sequential runs each (ms):`);
console.table(results);

server.close();
db.close();
fs.rmSync(dir, { recursive: true, force: true });
