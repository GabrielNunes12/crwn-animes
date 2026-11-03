import { classify, parseYouTubeId } from "./classifier.js";
import { HttpError, validationError } from "./errors.js";
import { videoRoute } from "./routing.js";

const slotKey = (p) => `${p.seriesId}|${p.section}|${p.season}|${p.number}`;

/** Runs `worker` over `items`, at most `limit` at a time, keeping the order of results. */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

/** oEmbed answers that mean "this video will never play on our site". */
const isGone = (error) => error instanceof HttpError && (error.status === 404 || error.status === 422);

// Adds, re-classifies and corrects videos. The classifier decides where a
// video goes; this layer also makes sure two published videos never claim the
// same episode/chapter.
export function createVideoService({ repo, fetchVideoInfo }) {
  /** `claimed`: extra slots taken by videos not stored yet (bulk dry runs). */
  function place(title, overrides, excludeId = null, claimed = null) {
    const result = classify({ title }, repo.listSeries(), overrides);
    if (overrides.seriesSlug && !result.seriesId) {
      throw validationError(
        { seriesSlug: `There is no series with slug "${overrides.seriesSlug}".` },
        `There is no series with slug "${overrides.seriesSlug}".`
      );
    }
    if (
      result.status === "published" &&
      (repo.slotTaken(result, excludeId) || claimed?.has(slotKey(result)))
    ) {
      const what = result.section === "manga" ? "Chapter" : "Episode";
      result.status = "pending";
      result.classification.reasons.push(
        `${what} ${result.number} (season ${result.season}) of ${result.seriesSlug} already has a published video`
      );
    }
    return { ...result, overrides };
  }

  async function add({ url, title, channel = null, overrides = {} }) {
    const youtubeVideoId = parseYouTubeId(url);
    if (!youtubeVideoId) throw validationError({ url: "That is not a YouTube link or video ID." }, "That is not a YouTube link or video ID.");

    const existing = repo.getVideoByYoutubeId(youtubeVideoId);
    if (existing) throw new HttpError(409, "This video was already added.", { video: existing });

    // A title sent by hand skips the YouTube lookup (useful offline and in tests).
    const info = title ? { title, channel } : await fetchVideoInfo(youtubeVideoId);
    return repo.insertVideo({ youtubeVideoId, ...info, ...place(info.title, overrides) });
  }

  return {
    add,

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

    /**
     * Points an existing video at another YouTube upload (the old one was taken
     * down). Route, title, overrides and ratings stay; availability resets to "ok".
     */
    async swapUrl(id, url) {
      const video = repo.getVideo(id);
      if (!video) throw new HttpError(404, "Video not found.");
      const youtubeVideoId = parseYouTubeId(url);
      if (!youtubeVideoId) throw validationError({ url: "That is not a YouTube link or video ID." }, "That is not a YouTube link or video ID.");
      const owner = repo.getVideoByYoutubeId(youtubeVideoId);
      if (owner && owner.id !== id) throw new HttpError(409, "Another video already uses this YouTube ID.", { video: owner });
      await fetchVideoInfo(youtubeVideoId); // throws 404/422/502 if it cannot play here
      return repo.swapYoutubeId(id, youtubeVideoId);
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

    /**
     * Adds many videos at once. `inputs` are [{ input, youtubeVideoId }] (already
     * de-duplicated); YouTube lookups run 3 at a time. With dryRun nothing is
     * stored and each row gets a `preview` of where it would go.
     */
    async bulk(inputs, { overrides = {}, dryRun = false } = {}) {
      const looked = await mapLimit(inputs, 3, async (row) => {
        if (!row.youtubeVideoId) return { ...row, outcome: "invalid", message: "Not a YouTube link or video ID." };
        if (repo.getVideoByYoutubeId(row.youtubeVideoId)) return { ...row, outcome: "duplicate" };
        try {
          return { ...row, info: await fetchVideoInfo(row.youtubeVideoId) };
        } catch (error) {
          if (isGone(error)) return { ...row, outcome: "unavailable", message: error.message };
          return { ...row, outcome: "error", message: error.message };
        }
      });

      const claimed = new Set();
      const results = [];
      for (const { info, ...row } of looked) {
        const base = { input: row.input, youtubeVideoId: row.youtubeVideoId };
        if (row.outcome === "duplicate") {
          results.push({ ...base, outcome: "duplicate", video: repo.getVideoByYoutubeId(row.youtubeVideoId) });
          continue;
        }
        if (row.outcome) {
          results.push({ ...base, outcome: row.outcome, message: row.message });
          continue;
        }
        if (dryRun) {
          const p = place(info.title, overrides, null, claimed);
          if (p.status === "published") claimed.add(slotKey(p));
          results.push({
            ...base,
            outcome: "would-create",
            preview: {
              title: info.title,
              section: p.section,
              seriesSlug: p.seriesSlug,
              season: p.season,
              number: p.number,
              status: p.status,
              route: p.status === "published" ? videoRoute(p) : null,
              reasons: p.classification.reasons,
            },
          });
          continue;
        }
        try {
          const video = await add({ url: row.youtubeVideoId, title: info.title, channel: info.channel, overrides });
          results.push({ ...base, outcome: "created", video });
        } catch (error) {
          if (error instanceof HttpError && error.status === 409) {
            results.push({ ...base, outcome: "duplicate", video: error.details.video });
          } else {
            results.push({ ...base, outcome: "error", message: error.message });
          }
        }
      }
      return results;
    },

    /**
     * Asks oEmbed about each video again. 401/403/404 mark it "unavailable";
     * network/5xx problems leave it as it was (and unchecked, so it is retried).
     * `olderThan` (ISO) limits the run to videos not checked since then.
     */
    async healthCheck({ olderThan = null } = {}) {
      const rows = repo.videoIdsToCheck(olderThan);
      let checked = 0;
      await mapLimit(rows, 3, async ({ id, youtube_video_id: youtubeVideoId }) => {
        try {
          await fetchVideoInfo(youtubeVideoId);
          repo.setAvailability(id, "ok");
          checked++;
        } catch (error) {
          if (isGone(error)) {
            repo.setAvailability(id, "unavailable");
            checked++;
          }
        }
      });
      return { checked, unavailable: repo.listVideos(null, "unavailable") };
    },
  };
}
