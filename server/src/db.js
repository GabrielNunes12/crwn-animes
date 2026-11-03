import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { canonicalGenres, genreSpellings } from "./genres.js";
import { searchText } from "./search.js";
import { SEED_SERIES } from "./seed.js";

// series: one row per franchise (One Piece), shared by both sections.
// videos: one row per YouTube video. `section` + `series_id` + `season` +
//   `number` say where it is routed. Rows the classifier was not sure about are
//   stored with status 'pending' and stay hidden until an admin fixes them.
//   `overrides` keeps what an admin set by hand so re-classifying never loses it.
// users / sessions / email_tokens / ratings: accounts and the rating feature.
// rating_activity: anonymous per-day rating counts for "trending".
//   Only what docs/API.md lists under "Personal data we keep" is stored.
//   Tokens are stored as SHA-256 hashes, never in clear.
//
// Each entry in MIGRATIONS runs once, in order; PRAGMA user_version remembers
// how many ran (openDatabase's `migrateTo` stops earlier, for upgrade tests). Migration 1 is the original schema (IF NOT EXISTS, so a dev
// database created before migrations existed upgrades cleanly). An entry is
// SQL, or a function (db) => void for steps SQL cannot do alone.
const MIGRATIONS = [
  // 1: catalog
  `
  CREATE TABLE IF NOT EXISTS series (
    id          INTEGER PRIMARY KEY,
    slug        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    aliases     TEXT NOT NULL DEFAULT '[]',
    genres      TEXT NOT NULL DEFAULT '[]',
    cover_url   TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS videos (
    id                INTEGER PRIMARY KEY,
    youtube_video_id  TEXT NOT NULL UNIQUE,
    source_title      TEXT NOT NULL,
    channel           TEXT,
    section           TEXT CHECK (section IN ('anime', 'manga')),
    series_id         INTEGER REFERENCES series(id) ON DELETE SET NULL,
    season            INTEGER NOT NULL DEFAULT 1,
    number            INTEGER,
    status            TEXT NOT NULL CHECK (status IN ('published', 'pending')),
    classification    TEXT NOT NULL DEFAULT '{}',
    overrides         TEXT NOT NULL DEFAULT '{}',
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,

  // 2: synopsis, videos follow their series on delete, accounts and ratings
  `
  ALTER TABLE series ADD COLUMN synopsis TEXT;

  CREATE TABLE videos_new (
    id                INTEGER PRIMARY KEY,
    youtube_video_id  TEXT NOT NULL UNIQUE,
    source_title      TEXT NOT NULL,
    channel           TEXT,
    section           TEXT CHECK (section IN ('anime', 'manga')),
    series_id         INTEGER REFERENCES series(id) ON DELETE CASCADE,
    season            INTEGER NOT NULL DEFAULT 1,
    number            INTEGER,
    status            TEXT NOT NULL CHECK (status IN ('published', 'pending')),
    classification    TEXT NOT NULL DEFAULT '{}',
    overrides         TEXT NOT NULL DEFAULT '{}',
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    published_at      TEXT,
    availability      TEXT NOT NULL DEFAULT 'ok' CHECK (availability IN ('ok', 'unavailable')),
    checked_at        TEXT
  );
  INSERT INTO videos_new SELECT
    id, youtube_video_id, source_title, channel, section, series_id, season, number,
    status, classification, overrides, created_at, updated_at,
    CASE WHEN status = 'published' THEN replace(created_at, ' ', 'T') || '.000Z' END,
    'ok', NULL
  FROM videos;
  DROP TABLE videos;
  ALTER TABLE videos_new RENAME TO videos;

  -- Only one published video per episode/chapter slot.
  CREATE UNIQUE INDEX videos_published_slot
    ON videos (series_id, section, season, number) WHERE status = 'published';
  CREATE INDEX videos_status ON videos (status, published_at);
  CREATE INDEX videos_checked ON videos (checked_at);
  CREATE INDEX videos_series ON videos (series_id, section, status);

  CREATE TABLE users (
    id                   INTEGER PRIMARY KEY,
    email                TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
    display_name         TEXT NOT NULL,
    password_hash        TEXT NOT NULL,
    role                 TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    email_verified_at    TEXT,
    privacy_accepted_at  TEXT NOT NULL,
    created_at           TEXT NOT NULL
  );

  CREATE TABLE sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  TEXT NOT NULL
  );
  CREATE INDEX sessions_user ON sessions (user_id);
  CREATE INDEX sessions_expiry ON sessions (expires_at);

  CREATE TABLE email_tokens (
    token_hash  TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose     TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
    expires_at  TEXT NOT NULL
  );
  CREATE INDEX email_tokens_user ON email_tokens (user_id, purpose);
  CREATE INDEX email_tokens_expiry ON email_tokens (expires_at);

  CREATE TABLE ratings (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    video_id    INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    score       INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
    reaction    TEXT CHECK (reaction IN ('fire', 'laugh', 'cry', 'wow', 'love')),
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (user_id, video_id)
  );
  CREATE INDEX ratings_video ON ratings (video_id, score);

  -- Anonymous: how many ratings each video got per day (no user id). Feeds
  -- /api/trending; rows older than 30 days are purged by the retention job.
  CREATE TABLE rating_activity (
    video_id   INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    day        TEXT NOT NULL,
    count      INTEGER NOT NULL DEFAULT 0,
    score_sum  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (video_id, day)
  );
  CREATE INDEX rating_activity_day ON rating_activity (day);
  `,

  // 3: before migration 2, deleting a series set its videos' series_id to NULL
  // and left them "published" with no route. Send them back to the admin queue.
  `
  UPDATE videos SET status = 'pending', series_id = NULL,
    classification = json_set(
      CASE WHEN json_valid(classification) THEN classification ELSE '{}' END,
      '$.reasons',
      json_insert(
        CASE WHEN json_valid(classification) AND json_type(classification, '$.reasons') = 'array'
          THEN json_extract(classification, '$.reasons') ELSE '[]' END,
        '$[#]', 'its series was deleted; pick a new one'))
  WHERE status = 'published' AND (series_id IS NULL OR series_id NOT IN (SELECT id FROM series));
  `,

  // 4: accent/case-insensitive search. search_text = normalised name + aliases
  // (see src/search.js); stripping accents needs JS, so rows are filled from JS.
  (db) => {
    db.exec("ALTER TABLE series ADD COLUMN search_text TEXT NOT NULL DEFAULT ''");
    refreshSearchText(db);
  },

  // 5: search_text keeps letters of every script (Japanese names were dropped).
  (db) => refreshSearchText(db),

  // 6: one spelling per genre ("Ação" / "AÇÃO" / " ação"): the first one used
  // (series id order) wins, duplicates inside a series go away.
  (db) => {
    const rows = db.prepare("SELECT id, genres FROM series ORDER BY id").all().map((r) => ({ id: r.id, genres: parseList(r.genres) }));
    const spellings = genreSpellings(rows);
    const update = db.prepare("UPDATE series SET genres = ? WHERE id = ?");
    for (const row of rows) update.run(JSON.stringify(canonicalGenres(row.genres, spellings)), row.id);
  },

  // 7: manga chapters have no seasons (their route is /manga/:slug/chapter/:n).
  // Published chapters sharing a number: the oldest stays, the others go back
  // to the admin queue. Then every manga video gets season 1.
  (db) => {
    const rows = db
      .prepare(`
        SELECT id, series_id, number, classification FROM videos
        WHERE section = 'manga' AND status = 'published' AND number IS NOT NULL
        ORDER BY series_id, number, published_at IS NULL, published_at, id`)
      .all();
    const demote = db.prepare("UPDATE videos SET status = 'pending', classification = ? WHERE id = ?");
    let previous = null;
    for (const row of rows) {
      const slot = `${row.series_id}|${row.number}`;
      if (slot === previous) {
        let classification = {};
        try {
          classification = JSON.parse(row.classification) ?? {};
        } catch {
          // start over from {}
        }
        if (typeof classification !== "object" || Array.isArray(classification)) classification = {};
        const reasons = Array.isArray(classification.reasons) ? classification.reasons : [];
        reasons.push(`Chapter ${row.number} already has an older published video (manga chapters have no seasons)`);
        demote.run(JSON.stringify({ ...classification, reasons }), row.id);
      }
      previous = slot;
    }
    db.exec("UPDATE videos SET season = 1 WHERE section = 'manga' AND season <> 1");
  },

  // 8: precomputed per-(series, section) stats for search and section lists,
  // site-wide rating totals, and a catalog version for in-memory caches
  // (genres, sitemap). Triggers keep all three current, whoever writes.
  (db) => {
    db.exec(`
      CREATE TABLE series_stats (
        series_id            INTEGER NOT NULL,
        section              TEXT NOT NULL,
        video_count          INTEGER NOT NULL,
        latest_published_at  TEXT,
        rating_n             INTEGER NOT NULL DEFAULT 0,
        rating_sum           INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (series_id, section)
      ) WITHOUT ROWID;
      CREATE INDEX series_stats_section ON series_stats (section, series_id);

      CREATE TABLE rating_totals (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL, total INTEGER NOT NULL);
      INSERT INTO rating_totals SELECT 1, COUNT(*), COALESCE(SUM(score), 0) FROM ratings;

      CREATE TABLE catalog_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
      INSERT INTO catalog_version VALUES (1, 0);

      INSERT INTO series_stats (series_id, section, video_count, latest_published_at, rating_n, rating_sum)
      SELECT v.series_id, v.section, COUNT(*), MAX(v.published_at),
        (SELECT COUNT(*) FROM ratings r JOIN videos v2 ON v2.id = r.video_id
          WHERE v2.series_id = v.series_id AND v2.section = v.section AND v2.status = 'published'),
        (SELECT COALESCE(SUM(r.score), 0) FROM ratings r JOIN videos v2 ON v2.id = r.video_id
          WHERE v2.series_id = v.series_id AND v2.section = v.section AND v2.status = 'published')
      FROM videos v
      WHERE v.status = 'published' AND v.section IS NOT NULL AND v.series_id IN (SELECT id FROM series)
      GROUP BY v.series_id, v.section;

      CREATE TRIGGER videos_stats_insert AFTER INSERT ON videos BEGIN
        ${recomputeStats("NEW")}
      END;
      CREATE TRIGGER videos_stats_update AFTER UPDATE OF status, section, series_id, published_at ON videos BEGIN
        ${recomputeStats("OLD")}
        ${recomputeStats("NEW")}
      END;
      CREATE TRIGGER videos_stats_delete AFTER DELETE ON videos BEGIN
        ${recomputeStats("OLD")}
      END;
      CREATE TRIGGER series_stats_delete AFTER DELETE ON series BEGIN
        DELETE FROM series_stats WHERE series_id = OLD.id;
      END;

      CREATE TRIGGER ratings_stats_insert AFTER INSERT ON ratings BEGIN
        ${addRating("NEW", "+")}
      END;
      CREATE TRIGGER ratings_stats_update AFTER UPDATE OF score, video_id ON ratings BEGIN
        ${addRating("OLD", "-")}
        ${addRating("NEW", "+")}
      END;
      CREATE TRIGGER ratings_stats_delete AFTER DELETE ON ratings BEGIN
        ${addRating("OLD", "-")}
      END;

      CREATE TRIGGER series_version_insert AFTER INSERT ON series BEGIN ${BUMP_VERSION} END;
      CREATE TRIGGER series_version_update AFTER UPDATE ON series BEGIN ${BUMP_VERSION} END;
      CREATE TRIGGER series_version_delete AFTER DELETE ON series BEGIN ${BUMP_VERSION} END;
      CREATE TRIGGER videos_version_insert AFTER INSERT ON videos BEGIN ${BUMP_VERSION} END;
      CREATE TRIGGER videos_version_delete AFTER DELETE ON videos BEGIN ${BUMP_VERSION} END;
      CREATE TRIGGER videos_version_update AFTER UPDATE ON videos
        WHEN OLD.status IS NOT NEW.status OR OLD.section IS NOT NEW.section OR OLD.series_id IS NOT NEW.series_id
          OR OLD.season IS NOT NEW.season OR OLD.number IS NOT NEW.number OR OLD.availability IS NOT NEW.availability
          OR OLD.published_at IS NOT NEW.published_at OR OLD.updated_at IS NOT NEW.updated_at
          OR OLD.youtube_video_id IS NOT NEW.youtube_video_id
      BEGIN ${BUMP_VERSION} END;
    `);
  },
];

function parseList(text) {
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function refreshSearchText(db) {
  const update = db.prepare("UPDATE series SET search_text = ? WHERE id = ?");
  for (const row of db.prepare("SELECT id, name, aliases FROM series").all()) {
    update.run(searchText(row.name, parseList(row.aliases)), row.id);
  }
}

const BUMP_VERSION = "UPDATE catalog_version SET version = version + 1;";

/**
 * Trigger body that rebuilds the series_stats row of the video row `ref`
 * (NEW or OLD) from scratch: count and newest publishedAt of the published
 * videos of that series in that section, and their ratings. Index-backed
 * (videos_series, ratings_video), so it touches only that series' videos.
 */
function recomputeStats(ref) {
  const sid = `${ref}.series_id`;
  const sec = `${ref}.section`;
  return `
        DELETE FROM series_stats WHERE series_id = ${sid} AND section = ${sec};
        INSERT INTO series_stats (series_id, section, video_count, latest_published_at, rating_n, rating_sum)
        SELECT ${sid}, ${sec}, agg.c, agg.latest, rt.n, rt.total
        FROM (SELECT COUNT(*) AS c, MAX(published_at) AS latest FROM videos
              WHERE series_id = ${sid} AND section = ${sec} AND status = 'published') AS agg,
             (SELECT COUNT(r.score) AS n, COALESCE(SUM(r.score), 0) AS total
              FROM videos v JOIN ratings r ON r.video_id = v.id
              WHERE v.series_id = ${sid} AND v.section = ${sec} AND v.status = 'published') AS rt
        WHERE agg.c > 0 AND EXISTS (SELECT 1 FROM series WHERE id = ${sid});`;
}

/** Trigger body that adds (+) or removes (-) the rating row `ref` from the stats. */
function addRating(ref, sign) {
  return `
        UPDATE series_stats SET rating_n = rating_n ${sign} 1, rating_sum = rating_sum ${sign} ${ref}.score
        WHERE (series_id, section) = (SELECT series_id, section FROM videos WHERE id = ${ref}.video_id AND status = 'published');
        UPDATE rating_totals SET n = n ${sign} 1, total = total ${sign} ${ref}.score;`;
}

export const SCHEMA_VERSION = MIGRATIONS.length;

function migrate(db, target = MIGRATIONS.length) {
  const current = db.pragma("user_version", { simple: true });
  if (current >= target) return;
  // Table rebuilds need foreign keys off; they are checked again right after.
  db.pragma("foreign_keys = OFF");
  try {
    for (let version = current; version < target; version++) {
      db.transaction(() => {
        const step = MIGRATIONS[version];
        if (typeof step === "function") step(db);
        else db.exec(step);
        db.pragma(`user_version = ${version + 1}`);
      })();
    }
    const broken = db.pragma("foreign_key_check");
    if (broken.length) throw new Error(`Migration left ${broken.length} broken foreign keys.`);
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

function seed(db) {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM series").get();
  if (n > 0) return;
  const insert = db.prepare(
    "INSERT INTO series (slug, name, synopsis, aliases, genres, cover_url, search_text) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  db.transaction(() => {
    for (const s of SEED_SERIES) {
      insert.run(
        s.slug,
        s.name,
        s.synopsis ?? null,
        JSON.stringify(s.aliases),
        JSON.stringify(s.genres),
        s.coverUrl,
        searchText(s.name, s.aliases)
      );
    }
  })();
}

/**
 * Opens (creating if needed) and migrates the database.
 * @param migrateTo  stop after this migration (tests that build an old database)
 */
export function openDatabase(file = ":memory:", { seedCatalog = true, migrateTo = MIGRATIONS.length } = {}) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  migrate(db, migrateTo);
  db.pragma("foreign_keys = ON");
  if (seedCatalog) seed(db);
  return db;
}
