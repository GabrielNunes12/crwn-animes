import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
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
// how many ran. Migration 1 is the original schema (IF NOT EXISTS, so a dev
// database created before migrations existed upgrades cleanly).
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
];

export const SCHEMA_VERSION = MIGRATIONS.length;

function migrate(db) {
  const current = db.pragma("user_version", { simple: true });
  if (current >= MIGRATIONS.length) return;
  // Table rebuilds need foreign keys off; they are checked again right after.
  db.pragma("foreign_keys = OFF");
  try {
    for (let version = current; version < MIGRATIONS.length; version++) {
      db.transaction(() => {
        db.exec(MIGRATIONS[version]);
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
    "INSERT INTO series (slug, name, synopsis, aliases, genres, cover_url) VALUES (?, ?, ?, ?, ?, ?)"
  );
  db.transaction(() => {
    for (const s of SEED_SERIES) {
      insert.run(s.slug, s.name, s.synopsis ?? null, JSON.stringify(s.aliases), JSON.stringify(s.genres), s.coverUrl);
    }
  })();
}

export function openDatabase(file = ":memory:", { seedCatalog = true } = {}) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  db.pragma("foreign_keys = ON");
  if (seedCatalog) seed(db);
  return db;
}
