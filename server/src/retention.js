// Deletes personal data we no longer need (see docs/API.md, "Personal data we keep"):
// expired sessions and e-mail tokens, accounts never verified within 7 days,
// anonymous rating activity older than 90 days, and series/videos that have
// been in the trash for 7 days (with their ratings, cached thumbnails and covers).

const DAY = 24 * 60 * 60 * 1000;
const UNVERIFIED_TTL_MS = 7 * DAY;
/** How long a trashed series/video (and its ratings) is kept before the purge. */
export const TRASH_TTL_MS = 7 * DAY;
/**
 * Days of anonymous rating activity kept (no user id: not personal data). 90 since v1.6 (was 30),
 * for the admin metrics' 90-day chart; /api/trending only reads the last 7.
 */
export const RATING_ACTIVITY_DAYS = 90;
const HOUR = 60 * 60 * 1000;

/** Moves the WAL into the main file and truncates it, so erased rows leave no copy behind. */
export function checkpoint(db) {
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    // In-memory databases have no WAL; a busy checkpoint is retried by the next one.
  }
}

export function purgeExpired(db, now = new Date()) {
  const at = now.toISOString();
  const unverifiedBefore = new Date(now.getTime() - UNVERIFIED_TTL_MS).toISOString();
  const activityBefore = new Date(now.getTime() - RATING_ACTIVITY_DAYS * DAY).toISOString().slice(0, 10);
  const result = db.transaction(() => ({
    sessions: db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(at).changes,
    emailTokens: db.prepare("DELETE FROM email_tokens WHERE expires_at <= ?").run(at).changes,
    unverifiedUsers: db
      .prepare("DELETE FROM users WHERE email_verified_at IS NULL AND created_at < ?")
      .run(unverifiedBefore).changes,
    ratingActivity: db.prepare("DELETE FROM rating_activity WHERE day < ?").run(activityBefore).changes,
  }))();
  // Purged accounts must not survive in the WAL either (secure_delete covers the main file).
  if (result.unverifiedUsers) checkpoint(db);
  return result;
}

/**
 * Deletes series and videos trashed at least 7 days before `now`, for good:
 * their ratings, rating activity and per-video stats go with them (FK
 * cascades; the aggregates already left them out while they were in the
 * trash). A series takes every video it still has. Checkpoints the WAL when
 * anything went, like an account deletion (ratings are personal data).
 * `onPurged({ youtubeIds, seriesIds })` gets the YouTube IDs of every video and the
 * ids of every series that went (their cached images are deleted) once the
 * transaction has committed.
 */
export function purgeTrash(db, now = new Date(), { onPurged = null } = {}) {
  const before = new Date(now.getTime() - TRASH_TTL_MS).toISOString();
  let youtubeIds = [];
  let seriesIds = [];
  const result = db.transaction(() => {
    seriesIds = db.prepare("SELECT id FROM series WHERE deleted_at IS NOT NULL AND deleted_at <= ?").pluck().all(before);
    youtubeIds = db
      .prepare(`
        SELECT youtube_video_id FROM videos
        WHERE (deleted_at IS NOT NULL AND deleted_at <= @before)
          OR series_id IN (SELECT id FROM series WHERE deleted_at IS NOT NULL AND deleted_at <= @before)`)
      .pluck()
      .all({ before });
    return {
      series: db.prepare("DELETE FROM series WHERE deleted_at IS NOT NULL AND deleted_at <= ?").run(before).changes,
      videos: db.prepare("DELETE FROM videos WHERE deleted_at IS NOT NULL AND deleted_at <= ?").run(before).changes,
    };
  })();
  if (result.series || result.videos) checkpoint(db);
  if (youtubeIds.length > 0 || seriesIds.length > 0) onPurged?.({ youtubeIds, seriesIds });
  return result;
}

/**
 * Runs now and then every hour. The timer is unref'd so it never keeps the process alive.
 * `images` (the app's image service, app.locals.services.images): purged videos' and
 * series' cached files are deleted, then any cached file that belongs to nothing any more
 * (an admin swapped an upload or replaced a cover, a crash mid-purge).
 */
export function startRetention(db, { intervalMs = HOUR, images = null } = {}) {
  const run = () => {
    try {
      purgeExpired(db);
      purgeTrash(db, new Date(), { onPurged: (gone) => images?.purge(gone) });
      images?.prune();
    } catch (error) {
      console.error(`[retention] ${error.message}`);
    }
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Re-checks every video with YouTube once a day: hourly ticks pick the videos
 * not checked in the last 24 h. Unref'd; the first tick runs after a minute.
 * videos.healthCheck() is single-flight: a tick that finds a run going (its
 * own or an admin's POST /api/admin/videos/health-check) joins it.
 */
export function startHealthChecks(videos, { intervalMs = HOUR, maxAgeMs = DAY, firstDelayMs = 60_000 } = {}) {
  const run = async () => {
    try {
      await videos.healthCheck({ olderThan: new Date(Date.now() - maxAgeMs).toISOString() });
    } catch (error) {
      console.error(`[health-check] ${error.message}`);
    }
  };
  const first = setTimeout(run, firstDelayMs);
  first.unref();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
