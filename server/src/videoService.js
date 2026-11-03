import { classify, parseYouTubeId } from "./classifier.js";
import { HttpError } from "./errors.js";

// Adds, re-classifies and corrects videos. The classifier decides where a
// video goes; this layer also makes sure two published videos never claim the
// same episode/chapter.
export function createVideoService({ repo, fetchVideoInfo }) {
  function place(title, overrides, excludeId = null) {
    const result = classify({ title }, repo.listSeries(), overrides);
    if (overrides.seriesSlug && !result.seriesId) {
      throw new HttpError(400, `There is no series with slug "${overrides.seriesSlug}".`);
    }
    if (result.status === "published" && repo.slotTaken(result, excludeId)) {
      const what = result.section === "manga" ? "Chapter" : "Episode";
      result.status = "pending";
      result.classification.reasons.push(
        `${what} ${result.number} (season ${result.season}) of ${result.seriesSlug} already has a published video`
      );
    }
    return { ...result, overrides };
  }

  return {
    async add({ url, title, overrides = {} }) {
      const youtubeVideoId = parseYouTubeId(url);
      if (!youtubeVideoId) throw new HttpError(400, "That is not a YouTube link or video ID.");

      const existing = repo.getVideoByYoutubeId(youtubeVideoId);
      if (existing) throw new HttpError(409, "This video was already added.", { video: existing });

      // A title sent by hand skips the YouTube lookup (useful offline and in tests).
      const info = title ? { title, channel: null } : await fetchVideoInfo(youtubeVideoId);
      return repo.insertVideo({ youtubeVideoId, ...info, ...place(info.title, overrides) });
    },

    /** Merges admin corrections into the video's overrides and places it again. */
    update(id, changes) {
      const video = repo.getVideo(id);
      if (!video) throw new HttpError(404, "Video not found.");
      const overrides = { ...video.overrides };
      for (const [key, value] of Object.entries(changes)) {
        if (value == null) delete overrides[key];
        else overrides[key] = value;
      }
      return repo.updateVideo(id, place(video.title, overrides, id));
    },

    /** Runs the classifier again on every pending video, e.g. after a new series is added. */
    reclassifyPending() {
      const changed = [];
      for (const video of repo.listVideos("pending")) {
        const updated = repo.updateVideo(video.id, place(video.title, video.overrides, video.id));
        if (updated.status === "published") changed.push(updated);
      }
      return changed;
    },

    remove(id) {
      if (!repo.deleteVideo(id)) throw new HttpError(404, "Video not found.");
    },
  };
}
