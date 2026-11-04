// Deletes personal data we no longer need (see docs/API.md, "Personal data we keep"):
// expired sessions and e-mail tokens, accounts never verified within 7 days,
// and anonymous rating activity older than 30 days.

const DAY = 24 * 60 * 60 * 1000;
const UNVERIFIED_TTL_MS = 7 * DAY;
const ACTIVITY_DAYS = 30;
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
  const activityBefore = new Date(now.getTime() - ACTIVITY_DAYS * DAY).toISOString().slice(0, 10);
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

/** Runs now and then every hour. The timer is unref'd so it never keeps the process alive. */
export function startRetention(db, { intervalMs = HOUR } = {}) {
  const run = () => {
    try {
      purgeExpired(db);
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
