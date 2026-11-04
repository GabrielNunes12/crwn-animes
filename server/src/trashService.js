import { HttpError, notFound } from "./errors.js";
import { checkpoint } from "./retention.js";

// The 7-day trash (docs/API.md v1.4). DELETE on a series or video moves it
// here; restoring brings it back, deleting forever (or the retention job,
// src/retention.js purgeTrash, after 7 days) removes it with its ratings.
//
// Trashed rows are invisible everywhere else: the repository's live queries
// filter on deleted_at, and the triggers of db.js migration 13 keep every
// aggregate (series_stats, rating_totals) to live videos. Everything below
// is synchronous and runs in one transaction per call. `onPurged(youtubeIds)`
// runs after a delete-forever commits (the app removes their cached thumbnails).
export function createTrashService({ db, repo, videos, now = () => new Date(), onPurged = () => {} }) {
  const transaction = (fn) => db.transaction(fn)();

  /**
   * Restores one trashed video as it was, except that a published video whose
   * slot was taken meanwhile comes back pending, with the reason.
   */
  function restoreOne(video) {
    let { status, classification } = video;
    if (status === "published" && repo.slotTaken(video, video.id)) {
      const what = video.section === "manga" ? "Chapter" : "Episode";
      status = "pending";
      const reasons = Array.isArray(classification?.reasons) ? classification.reasons : [];
      classification = {
        ...classification,
        reasons: [
          ...reasons,
          `Restored from the trash: ${what} ${video.number} (season ${video.season}) of ${video.seriesSlug} already has a published video`,
        ],
      };
    }
    repo.restoreVideo(video.id, { status, classification });
    return repo.getVideo(video.id);
  }

  return {
    /** DELETE /api/admin/series/:id — the series and every live video of it. */
    trashSeries(id) {
      if (!transaction(() => repo.trashSeries(id, now().toISOString()))) throw notFound("Series not found.");
    },

    /** DELETE /api/admin/videos/:id */
    trashVideo(id) {
      if (!transaction(() => repo.trashVideo(id, now().toISOString()))) throw notFound("Video not found.");
    },

    list: () => repo.listTrash(),

    /**
     * Restores the series and the videos trashed with it (a video trashed on
     * its own stays in the trash). The videos come back first, while the
     * series is still trashed, so the stats triggers rebuild the series' rows
     * once (on the series restore) rather than once per video. Then pending
     * videos are re-classified, as when a series is created: the classifier
     * can route into it again. Returns { series, published, pending }.
     */
    restoreSeries(id) {
      return transaction(() => {
        if (!repo.getTrashedSeries(id)) throw notFound("There is no series with this id in the trash.");
        const restored = repo.videosTrashedWithSeries(id).map(restoreOne);
        repo.restoreSeries(id);
        const series = repo.getSeriesById(id);
        const found = videos.reclassifyPending({ before: null, after: series });
        const current = restored.map((video) => repo.getVideo(video.id));
        const published = current.filter((video) => video.status === "published");
        const ids = new Set(published.map((video) => video.id));
        for (const video of found) if (!ids.has(video.id)) published.push(video);
        return { series, published, pending: current.filter((video) => video.status === "pending") };
      });
    },

    /** 409 while its series is in the trash (restore the series instead). */
    restoreVideo(id) {
      return transaction(() => {
        const video = repo.getTrashedVideo(id);
        if (!video) throw notFound("There is no video with this id in the trash.");
        const series = video.seriesId != null ? repo.getAnySeriesById(video.seriesId) : null;
        if (series?.deletedAt) {
          throw new HttpError(409, "Its series is in the trash: restore the series first.", { series });
        }
        return restoreOne(video);
      });
    },

    /** DELETE /api/admin/trash/series/:id — for good: its videos and their ratings go too. */
    deleteSeriesForever(id) {
      let youtubeIds = [];
      const purged = transaction(() => {
        youtubeIds = repo.youtubeIdsOfSeries(id); // its videos go with it (FK cascade)
        return repo.purgeTrashedSeries(id);
      });
      if (!purged) throw notFound("There is no series with this id in the trash.");
      checkpoint(db); // ratings are personal data: no copy left in the WAL
      onPurged(youtubeIds);
    },

    /** DELETE /api/admin/trash/videos/:id */
    deleteVideoForever(id) {
      const video = transaction(() => {
        const trashed = repo.getTrashedVideo(id);
        return trashed && repo.purgeTrashedVideo(id) ? trashed : null;
      });
      if (!video) throw notFound("There is no video with this id in the trash.");
      checkpoint(db);
      onPurged([video.youtubeVideoId]);
    },
  };
}
