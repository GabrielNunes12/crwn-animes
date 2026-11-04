import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { canonicalGenres, genreSpellings } from "./genres.js";
import { searchNormalize, searchText } from "./search.js";
import { SEED_SERIES } from "./seed.js";

// series: one row per franchise (One Piece), shared by both sections.
// videos: one row per YouTube video. `section` + `series_id` + `season` +
//   `number` say where it is routed. Rows the classifier was not sure about are
//   stored with status 'pending' and stay hidden until an admin fixes them.
//   `overrides` keeps what an admin set by hand so re-classifying never loses it.
// users / sessions / email_tokens / ratings: accounts and the rating feature.
// rating_activity: anonymous per-day rating counts for "trending" and the admin
//   metrics (kept 90 days, src/retention.js).
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
  -- /api/trending; old rows are purged by the retention job (30 days; 90 since v1.6).
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

  // 9: admin lists are paginated and searchable (v1.3). title_search is the
  // source title through searchNormalize() (JS, like series.search_text; set
  // on insert, titles never change). Indexes give the admin video list
  // (newest created first, optionally per status) its order without a sort;
  // videos_created also holds every column the list filters on, so filtering,
  // counting and skipping OFFSET rows never read the (wide) table rows:
  // ~2x faster at 50k videos (src/scripts/bench-admin-lists.js).
  (db) => {
    db.exec("ALTER TABLE videos ADD COLUMN title_search TEXT NOT NULL DEFAULT ''");
    const update = db.prepare("UPDATE videos SET title_search = ? WHERE id = ?");
    for (const row of db.prepare("SELECT id, source_title FROM videos").all()) {
      update.run(searchNormalize(row.source_title), row.id);
    }
    db.exec(`
      CREATE INDEX videos_created ON videos (created_at, id, status, availability, series_id, title_search);
      CREATE INDEX videos_status_created ON videos (status, created_at, id);
      CREATE INDEX series_name ON series (name COLLATE NOCASE, id);
    `);
  },

  // 10: session epochs. Every session stores the epoch its user had when it
  // was created; a password change/reset and "sign out everywhere" bump the
  // user's epoch, so a session created by a login that was still in flight
  // (scrypt takes ~0.4 s) is born invalid. Existing sessions keep working (0 = 0).
  `
  ALTER TABLE users ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0;
  `,

  // 11: series_version is bumped by every series change; it keys the
  // classifier's pre-normalised catalog (video inserts do not invalidate it).
  `
  CREATE TABLE series_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
  INSERT INTO series_version VALUES (1, 0);
  CREATE TRIGGER series_sv_insert AFTER INSERT ON series BEGIN UPDATE series_version SET version = version + 1; END;
  CREATE TRIGGER series_sv_update AFTER UPDATE ON series BEGIN UPDATE series_version SET version = version + 1; END;
  CREATE TRIGGER series_sv_delete AFTER DELETE ON series BEGIN UPDATE series_version SET version = version + 1; END;
  `,

  // 12: per-video rating aggregates (count, sum), kept by triggers like
  // series_stats, so video lists and /api/top-rated never aggregate ratings
  // per request. Rows go with their video (FK cascade) and at n = 0.
  `
  CREATE TABLE video_rating_stats (
    video_id  INTEGER PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
    n         INTEGER NOT NULL,
    total     INTEGER NOT NULL
  );
  INSERT INTO video_rating_stats SELECT video_id, COUNT(*), SUM(score) FROM ratings GROUP BY video_id;

  CREATE TRIGGER ratings_vstats_insert AFTER INSERT ON ratings BEGIN
    INSERT INTO video_rating_stats (video_id, n, total) VALUES (NEW.video_id, 1, NEW.score)
      ON CONFLICT (video_id) DO UPDATE SET n = n + 1, total = total + excluded.total;
  END;
  CREATE TRIGGER ratings_vstats_update AFTER UPDATE OF score, video_id ON ratings BEGIN
    UPDATE video_rating_stats SET n = n - 1, total = total - OLD.score WHERE video_id = OLD.video_id;
    DELETE FROM video_rating_stats WHERE video_id = OLD.video_id AND n <= 0;
    INSERT INTO video_rating_stats (video_id, n, total) VALUES (NEW.video_id, 1, NEW.score)
      ON CONFLICT (video_id) DO UPDATE SET n = n + 1, total = total + excluded.total;
  END;
  CREATE TRIGGER ratings_vstats_delete AFTER DELETE ON ratings BEGIN
    UPDATE video_rating_stats SET n = n - 1, total = total - OLD.score WHERE video_id = OLD.video_id;
    DELETE FROM video_rating_stats WHERE video_id = OLD.video_id AND n <= 0;
  END;
  `,

  // 13: 7-day trash (v1.4). deleted_at (ISO 8601) marks a trashed series or
  // video; a trashed series takes its live videos with it (same deleted_at,
  // trashed_with_series = 1), so videos.deleted_at alone says whether a video
  // is visible. Trashed rows count as "not there" for every aggregate:
  //   - series_stats only covers live videos of live series; the stats
  //     triggers skip series that are not live (a series trash/restore
  //     recomputes its rows once instead of once per video);
  //   - rating_totals (site-wide mean) only counts ratings of live videos: the
  //     rating triggers skip trashed videos, trashing/restoring a video moves
  //     its ratings out of/into the totals, and a hard delete of a live video
  //     takes them out BEFORE the row goes (FK cascades run after the parent
  //     row is gone, when the rating triggers can no longer see it);
  //   - video_rating_stats and rating_activity stay per video (trashed videos
  //     are filtered out of every list that reads them).
  // The published-slot index ignores trashed videos (a new video may take the
  // slot; restoring then re-checks it). The indexes behind the live lists
  // become partial (WHERE deleted_at IS NULL): trashed rows are never in them.
  // The two admin-list indexes also carry deleted_at (always NULL there):
  // SQLite only treats `col = const` terms of a partial index's WHERE as
  // covered, so without the column the "deleted_at IS NULL" filter would
  // need the table row and the counts would fall back to a table scan.
  (db) => {
    db.exec(`
      ALTER TABLE series ADD COLUMN deleted_at TEXT;
      ALTER TABLE videos ADD COLUMN deleted_at TEXT;
      ALTER TABLE videos ADD COLUMN trashed_with_series INTEGER NOT NULL DEFAULT 0;

      DROP INDEX videos_published_slot;
      CREATE UNIQUE INDEX videos_published_slot
        ON videos (series_id, section, season, number) WHERE status = 'published' AND deleted_at IS NULL;
      DROP INDEX videos_status;
      CREATE INDEX videos_status ON videos (status, published_at) WHERE deleted_at IS NULL;
      DROP INDEX videos_created;
      CREATE INDEX videos_created ON videos (created_at, id, status, availability, series_id, title_search, deleted_at)
        WHERE deleted_at IS NULL;
      DROP INDEX videos_status_created;
      CREATE INDEX videos_status_created ON videos (status, created_at, id, deleted_at) WHERE deleted_at IS NULL;
      DROP INDEX series_name;
      CREATE INDEX series_name ON series (name COLLATE NOCASE, id) WHERE deleted_at IS NULL;
      CREATE INDEX videos_trashed ON videos (deleted_at, id) WHERE deleted_at IS NOT NULL;
      CREATE INDEX series_trashed ON series (deleted_at, id) WHERE deleted_at IS NOT NULL;

      DROP TRIGGER videos_stats_insert;
      DROP TRIGGER videos_stats_update;
      DROP TRIGGER videos_stats_delete;
      DROP TRIGGER ratings_stats_insert;
      DROP TRIGGER ratings_stats_update;
      DROP TRIGGER ratings_stats_delete;
      DROP TRIGGER videos_version_update;

      CREATE TRIGGER videos_stats_insert AFTER INSERT ON videos WHEN ${liveSeries("NEW")} BEGIN
        ${recomputeLiveStats("NEW.series_id", "NEW.section")}
      END;
      CREATE TRIGGER videos_stats_update_old AFTER UPDATE OF status, section, series_id, published_at, deleted_at ON videos
        WHEN ${liveSeries("OLD")} BEGIN
        ${recomputeLiveStats("OLD.series_id", "OLD.section")}
      END;
      CREATE TRIGGER videos_stats_update_new AFTER UPDATE OF status, section, series_id, published_at, deleted_at ON videos
        WHEN ${liveSeries("NEW")} BEGIN
        ${recomputeLiveStats("NEW.series_id", "NEW.section")}
      END;
      CREATE TRIGGER videos_stats_delete AFTER DELETE ON videos WHEN ${liveSeries("OLD")} BEGIN
        ${recomputeLiveStats("OLD.series_id", "OLD.section")}
      END;
      CREATE TRIGGER series_stats_trash AFTER UPDATE OF deleted_at ON series
        WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL BEGIN
        DELETE FROM series_stats WHERE series_id = NEW.id;
      END;
      CREATE TRIGGER series_stats_restore AFTER UPDATE OF deleted_at ON series
        WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL BEGIN
        ${recomputeLiveStats("NEW.id", "'anime'")}
        ${recomputeLiveStats("NEW.id", "'manga'")}
      END;

      CREATE TRIGGER ratings_stats_insert AFTER INSERT ON ratings BEGIN
        ${addLiveRating("NEW", "+")}
      END;
      CREATE TRIGGER ratings_stats_update AFTER UPDATE OF score, video_id ON ratings BEGIN
        ${addLiveRating("OLD", "-")}
        ${addLiveRating("NEW", "+")}
      END;
      CREATE TRIGGER ratings_stats_delete AFTER DELETE ON ratings BEGIN
        ${addLiveRating("OLD", "-")}
      END;
      CREATE TRIGGER videos_totals_trash AFTER UPDATE OF deleted_at ON videos
        WHEN (OLD.deleted_at IS NULL) <> (NEW.deleted_at IS NULL) BEGIN
        UPDATE rating_totals SET
          n = n + (CASE WHEN NEW.deleted_at IS NULL THEN 1 ELSE -1 END) * (SELECT COUNT(*) FROM ratings WHERE video_id = NEW.id),
          total = total + (CASE WHEN NEW.deleted_at IS NULL THEN 1 ELSE -1 END)
            * (SELECT COALESCE(SUM(score), 0) FROM ratings WHERE video_id = NEW.id);
      END;
      CREATE TRIGGER videos_totals_delete BEFORE DELETE ON videos WHEN OLD.deleted_at IS NULL BEGIN
        UPDATE rating_totals SET
          n = n - (SELECT COUNT(*) FROM ratings WHERE video_id = OLD.id),
          total = total - (SELECT COALESCE(SUM(score), 0) FROM ratings WHERE video_id = OLD.id);
      END;

      CREATE TRIGGER videos_version_update AFTER UPDATE ON videos
        WHEN OLD.status IS NOT NEW.status OR OLD.section IS NOT NEW.section OR OLD.series_id IS NOT NEW.series_id
          OR OLD.season IS NOT NEW.season OR OLD.number IS NOT NEW.number OR OLD.availability IS NOT NEW.availability
          OR OLD.published_at IS NOT NEW.published_at OR OLD.updated_at IS NOT NEW.updated_at
          OR OLD.youtube_video_id IS NOT NEW.youtube_video_id OR OLD.deleted_at IS NOT NEW.deleted_at
      BEGIN ${BUMP_VERSION} END;
    `);
  },

  // 14: ids are never reused (v1.6). Without AUTOINCREMENT SQLite hands out
  // max(id) + 1, so deleting the newest video/series for good (delete forever,
  // the 7-day purge) gave its id to the next one, and a cached
  // /api/videos/<id> could show another video. Rebuilds series and videos as
  // INTEGER PRIMARY KEY AUTOINCREMENT, keeping every row, id, index, trigger
  // and foreign key (see rebuildWithAutoincrement).
  (db) => rebuildWithAutoincrement(db),

  // 15: admin metrics (v1.6). rating_days = rating_activity summed per day
  // (anonymous, like its source; triggers keep it equal to
  // SELECT day, SUM(count), SUM(score_sum) FROM rating_activity GROUP BY day,
  // whoever writes, retention and FK cascades included), so the daily ratings
  // chart reads at most 90 rows instead of every (video, day) row. A partial
  // index counts unavailable live videos without scanning the table.
  `
  CREATE TABLE rating_days (
    day        TEXT PRIMARY KEY,
    count      INTEGER NOT NULL,
    score_sum  INTEGER NOT NULL
  ) WITHOUT ROWID;
  INSERT INTO rating_days (day, count, score_sum)
    SELECT day, SUM(count), SUM(score_sum) FROM rating_activity GROUP BY day
    HAVING SUM(count) <> 0 OR SUM(score_sum) <> 0;

  CREATE TRIGGER rating_days_insert AFTER INSERT ON rating_activity BEGIN
    ${addRatingDay("NEW", "+")}
    ${dropEmptyRatingDay("NEW")}
  END;
  CREATE TRIGGER rating_days_update AFTER UPDATE OF day, count, score_sum ON rating_activity BEGIN
    ${addRatingDay("OLD", "-")}
    ${addRatingDay("NEW", "+")}
    ${dropEmptyRatingDay("OLD")}
    ${dropEmptyRatingDay("NEW")}
  END;
  CREATE TRIGGER rating_days_delete AFTER DELETE ON rating_activity BEGIN
    ${addRatingDay("OLD", "-")}
    ${dropEmptyRatingDay("OLD")}
  END;

  CREATE INDEX videos_unavailable ON videos (availability, deleted_at)
    WHERE availability = 'unavailable' AND deleted_at IS NULL;
  `,
];

// ---- migration 14: AUTOINCREMENT rebuild of series and videos ----

// The current definitions (migrations 1, 2, 4, 9, 13), column for column, with
// AUTOINCREMENT. `{name}` is the temporary table name.
const AUTOINCREMENT_TABLES = [
  {
    table: "series",
    create: `
      CREATE TABLE {name} (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        slug         TEXT NOT NULL UNIQUE,
        name         TEXT NOT NULL,
        aliases      TEXT NOT NULL DEFAULT '[]',
        genres       TEXT NOT NULL DEFAULT '[]',
        cover_url    TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        synopsis     TEXT,
        search_text  TEXT NOT NULL DEFAULT '',
        deleted_at   TEXT
      )`,
    columns: ["id", "slug", "name", "aliases", "genres", "cover_url", "created_at", "synopsis", "search_text", "deleted_at"],
  },
  {
    table: "videos",
    create: `
      CREATE TABLE {name} (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        youtube_video_id     TEXT NOT NULL UNIQUE,
        source_title         TEXT NOT NULL,
        channel              TEXT,
        section              TEXT CHECK (section IN ('anime', 'manga')),
        series_id            INTEGER REFERENCES series(id) ON DELETE CASCADE,
        season               INTEGER NOT NULL DEFAULT 1,
        number               INTEGER,
        status               TEXT NOT NULL CHECK (status IN ('published', 'pending')),
        classification       TEXT NOT NULL DEFAULT '{}',
        overrides            TEXT NOT NULL DEFAULT '{}',
        created_at           TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
        published_at         TEXT,
        availability         TEXT NOT NULL DEFAULT 'ok' CHECK (availability IN ('ok', 'unavailable')),
        checked_at           TEXT,
        title_search         TEXT NOT NULL DEFAULT '',
        deleted_at           TEXT,
        trashed_with_series  INTEGER NOT NULL DEFAULT 0
      )`,
    columns: [
      "id", "youtube_video_id", "source_title", "channel", "section", "series_id", "season", "number", "status",
      "classification", "overrides", "created_at", "updated_at", "published_at", "availability", "checked_at",
      "title_search", "deleted_at", "trashed_with_series",
    ],
  },
];

/**
 * SQLite's 12-step table rebuild (https://sqlite.org/lang_altertable.html#otheralter),
 * for series then videos, inside the migration's transaction with foreign keys
 * off (migrate() checks them all afterwards):
 *   1. remember the SQL of every index on the two tables and of every trigger or
 *      view that is on them or mentions them (the rating triggers on `ratings`
 *      read `videos`), and drop those triggers/views: a rename re-parses the
 *      schema, and a trigger naming the dropped table would make it fail;
 *   2. per table: create it again with AUTOINCREMENT, copy every row (ids
 *      included, no trigger fires: the new table has none yet), drop the old one,
 *      rename. Other tables' foreign keys name the table (`REFERENCES videos(id)`),
 *      so they resolve to the new one; the copy is checked row for row (counts);
 *   3. re-create the indexes (partial and covering ones verbatim), then the
 *      triggers and views, from the remembered SQL;
 *   4. sqlite_sequence = the current max id (never lower than what it holds), so
 *      new ids start above every id still in use. Ids deleted before this
 *      migration above that max are unknowable; from here on none is reused.
 * Aggregates (series_stats, rating_totals, video_rating_stats, rating_activity,
 * catalog_version) are not touched: the rows they describe are the same.
 */
function rebuildWithAutoincrement(db) {
  const names = AUTOINCREMENT_TABLES.map((t) => t.table);
  const mentions = new RegExp(`\\b(${names.join("|")})\\b`, "i");
  const objects = db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('index', 'trigger', 'view') AND sql IS NOT NULL ORDER BY rowid")
    .all()
    .filter((o) => names.includes(o.tbl_name) || (o.type !== "index" && mentions.test(o.sql)));
  const hadStats = Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'").get() &&
      db.prepare(`SELECT 1 FROM sqlite_stat1 WHERE tbl IN (${names.map(() => "?").join(", ")})`).get(...names)
  );

  for (const o of objects) {
    if (o.type === "trigger") db.exec(`DROP TRIGGER "${o.name}"`);
    if (o.type === "view") db.exec(`DROP VIEW "${o.name}"`);
  }

  for (const { table, create, columns } of AUTOINCREMENT_TABLES) {
    const temp = `${table}_v14`;
    const list = columns.join(", ");
    const before = db.prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS max FROM "${table}"`).get();
    db.exec(create.replace("{name}", temp));
    db.exec(`INSERT INTO ${temp} (${list}) SELECT ${list} FROM "${table}" ORDER BY id`);
    const copied = db.prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS max FROM ${temp}`).get();
    if (copied.n !== before.n || copied.max !== before.max) throw new Error(`Rebuilding ${table} lost rows.`);
    db.exec(`DROP TABLE "${table}"`);
    db.exec(`ALTER TABLE ${temp} RENAME TO ${table}`);
  }

  // Indexes first (their tables exist again), then triggers and views, in their original order.
  for (const o of objects.filter((x) => x.type === "index")) db.exec(o.sql);
  for (const o of objects.filter((x) => x.type !== "index")) db.exec(o.sql);

  for (const table of names) {
    const max = db.prepare(`SELECT COALESCE(MAX(id), 0) AS max FROM ${table}`).get().max;
    const row = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(table);
    if (row) db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = ?").run(Math.max(row.seq, max), table);
    else db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(table, max);
  }
  if (hadStats) db.exec(names.map((t) => `ANALYZE ${t};`).join(" "));
}

// ---- migration 15: rating_days trigger bodies ----

// Function declarations: migration 15 is SQL built when MIGRATIONS is defined.

/** Adds (+) or removes (-) the rating_activity row `ref` (NEW/OLD) to/from its day. */
function addRatingDay(ref, sign) {
  return `
    INSERT INTO rating_days (day, count, score_sum) VALUES (${ref}.day, ${sign}${ref}.count, ${sign}${ref}.score_sum)
      ON CONFLICT (day) DO UPDATE SET count = count + excluded.count, score_sum = score_sum + excluded.score_sum;`;
}

/** Days back at zero leave the table (absent = no activity). */
function dropEmptyRatingDay(ref) {
  return `
    DELETE FROM rating_days WHERE day = ${ref}.day AND count = 0 AND score_sum = 0;`;
}

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

// Migration 13 (trash) versions of the two bodies above. Migrations 8's
// triggers are replaced by these; the functions above stay as migration 8 ran them.

/** Trigger WHEN condition: the series of the video row `ref` exists and is not in the trash. */
const liveSeries = (ref) => `EXISTS (SELECT 1 FROM series WHERE id = ${ref}.series_id AND deleted_at IS NULL)`;

/**
 * Rebuilds the series_stats row (series `sid`, section `sec`: SQL expressions)
 * from the live published videos there and their ratings. Callers only run it
 * for a live series (trigger WHEN), so a trashed series never has a row.
 * Served by the partial index videos_published_slot (series_id, section, ...).
 */
function recomputeLiveStats(sid, sec) {
  const live = (v) => `${v}series_id = ${sid} AND ${v}section = ${sec} AND ${v}status = 'published' AND ${v}deleted_at IS NULL`;
  return `
        DELETE FROM series_stats WHERE series_id = ${sid} AND section = ${sec};
        INSERT INTO series_stats (series_id, section, video_count, latest_published_at, rating_n, rating_sum)
        SELECT ${sid}, ${sec}, agg.c, agg.latest, rt.n, rt.total
        FROM (SELECT COUNT(*) AS c, MAX(published_at) AS latest FROM videos WHERE ${live("")}) AS agg,
             (SELECT COUNT(r.score) AS n, COALESCE(SUM(r.score), 0) AS total
              FROM videos v JOIN ratings r ON r.video_id = v.id WHERE ${live("v.")}) AS rt
        WHERE agg.c > 0;`;
}

/**
 * Adds (+) or removes (-) the rating row `ref`: series stats when its video is
 * live and published, the site-wide totals when its video is live. A rating
 * removed by an FK cascade (its video is already gone) changes neither: the
 * video's own triggers have accounted for it.
 */
function addLiveRating(ref, sign) {
  return `
        UPDATE series_stats SET rating_n = rating_n ${sign} 1, rating_sum = rating_sum ${sign} ${ref}.score
        WHERE (series_id, section) = (SELECT series_id, section FROM videos
          WHERE id = ${ref}.video_id AND status = 'published' AND deleted_at IS NULL);
        UPDATE rating_totals SET n = n ${sign} 1, total = total ${sign} ${ref}.score
        WHERE EXISTS (SELECT 1 FROM videos WHERE id = ${ref}.video_id AND deleted_at IS NULL);`;
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
  // RGPD erasure: overwrite deleted content instead of leaving it readable in free pages.
  db.pragma("secure_delete = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db, migrateTo);
  db.pragma("foreign_keys = ON");
  // The seed matches the latest schema, so a partly migrated database is never seeded.
  if (seedCatalog && migrateTo >= MIGRATIONS.length) seed(db);
  return db;
}
