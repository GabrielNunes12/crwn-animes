import { ratingAverage } from "./repository.js";
import { REACTIONS } from "./validation.js";

const day = (isoTime) => isoTime.slice(0, 10);

// One rating (score 1..5 + optional reaction) per user per video.
// rating_activity keeps an anonymous per-day count of current ratings (by the
// day they were last set) so /api/trending never needs user ids.
export function createRatingService({ db, now = () => new Date() }) {
  const q = {
    distribution: db.prepare("SELECT score, COUNT(*) AS n FROM ratings WHERE video_id = ? GROUP BY score"),
    reactions: db.prepare(
      "SELECT reaction, COUNT(*) AS n FROM ratings WHERE video_id = ? AND reaction IS NOT NULL GROUP BY reaction"
    ),
    mine: db.prepare("SELECT score, reaction, updated_at FROM ratings WHERE user_id = ? AND video_id = ?"),
    upsert: db.prepare(`
      INSERT INTO ratings (user_id, video_id, score, reaction, updated_at) VALUES (@userId, @videoId, @score, @reaction, @now)
      ON CONFLICT (user_id, video_id) DO UPDATE SET score = excluded.score, reaction = excluded.reaction, updated_at = excluded.updated_at`),
    remove: db.prepare("DELETE FROM ratings WHERE user_id = ? AND video_id = ?"),
    allOfUser: db.prepare("SELECT video_id, score, updated_at FROM ratings WHERE user_id = ?"),
    removeAllOfUser: db.prepare("DELETE FROM ratings WHERE user_id = ?"),
    activityAdd: db.prepare(`
      INSERT INTO rating_activity (video_id, day, count, score_sum) VALUES (@videoId, @day, 1, @score)
      ON CONFLICT (video_id, day) DO UPDATE SET count = count + 1, score_sum = score_sum + excluded.score_sum`),
    activityRemove: db.prepare(`
      UPDATE rating_activity SET count = MAX(count - 1, 0), score_sum = MAX(score_sum - @score, 0)
      WHERE video_id = @videoId AND day = @day`),
    byUser: db.prepare(`
      SELECT r.score, r.reaction, r.updated_at, v.id AS video_id, v.youtube_video_id, v.source_title,
        v.section, v.season, v.number, v.status, s.slug AS series_slug
      FROM ratings r JOIN videos v ON v.id = r.video_id LEFT JOIN series s ON s.id = v.series_id
      WHERE r.user_id = ? ORDER BY r.updated_at DESC`),
  };

  function summary(videoId, userId = null) {
    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let count = 0;
    let total = 0;
    for (const { score, n } of q.distribution.all(videoId)) {
      distribution[score] = n;
      count += n;
      total += score * n;
    }
    const reactions = Object.fromEntries(REACTIONS.map((key) => [key, 0]));
    for (const { reaction, n } of q.reactions.all(videoId)) reactions[reaction] = n;
    const mine = userId ? q.mine.get(userId, videoId) : null;
    return {
      ...ratingAverage(count ? total / count : null, count),
      distribution,
      reactions,
      mine: mine ? { score: mine.score, reaction: mine.reaction } : null,
    };
  }

  const forget = (old, videoId) => {
    if (old) q.activityRemove.run({ videoId, day: day(old.updated_at), score: old.score });
  };

  return {
    summary,

    set: db.transaction((userId, videoId, { score, reaction }) => {
      const at = now().toISOString();
      forget(q.mine.get(userId, videoId), videoId);
      q.upsert.run({ userId, videoId, score, reaction: reaction ?? null, now: at });
      q.activityAdd.run({ videoId, day: day(at), score });
    }),

    remove: db.transaction((userId, videoId) => {
      forget(q.mine.get(userId, videoId), videoId);
      q.remove.run(userId, videoId);
    }),

    /** Account deletion: drops every rating of the user and takes them out of the trending counts. */
    removeAllForUser: db.transaction((userId) => {
      for (const row of q.allOfUser.all(userId)) forget(row, row.video_id);
      q.removeAllOfUser.run(userId);
    }),

    /** Raw rows for the GDPR export. */
    listByUser: (userId) => q.byUser.all(userId),
  };
}
