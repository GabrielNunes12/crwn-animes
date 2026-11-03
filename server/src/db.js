import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { SEED_SERIES } from "./seed.js";

// series: one row per franchise (One Piece), shared by both sections.
// videos: one row per YouTube video. `section` + `series_id` + `season` +
//   `number` say where it is routed. Rows the classifier was not sure about are
//   stored with status 'pending' and stay hidden until an admin fixes them.
//   `overrides` keeps what an admin set by hand so re-classifying never loses it.
const SCHEMA = `
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

-- Only one published video per episode/chapter slot.
CREATE UNIQUE INDEX IF NOT EXISTS videos_published_slot
  ON videos (series_id, section, season, number) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS videos_status ON videos (status);
`;

export function openDatabase(file = ":memory:") {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);

  const { n } = db.prepare("SELECT COUNT(*) AS n FROM series").get();
  if (n === 0) {
    const insert = db.prepare(
      "INSERT INTO series (slug, name, aliases, genres, cover_url) VALUES (?, ?, ?, ?, ?)"
    );
    db.transaction(() => {
      for (const s of SEED_SERIES) {
        insert.run(s.slug, s.name, JSON.stringify(s.aliases), JSON.stringify(s.genres), s.coverUrl);
      }
    })();
  }
  return db;
}
