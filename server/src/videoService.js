import { classify, normalize, parseYouTubeId, prepareCatalog } from "./classifier.js";
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
/** Normalised names + aliases of a series (what the classifier matches titles against). */
const needlesOf = (series) =>
  series ? [...new Set([series.name, ...(series.aliases ?? [])].map(normalize).filter((n) => n.trim() !== ""))].sort() : [];

export function createVideoService({ repo, fetchVideoInfo }) {
  // Series with pre-normalised names, rebuilt only when a series changes.
  const catalog = repo.untilSeriesChange(() => prepareCatalog(repo.listSeries()));

  /**
   * `claimed`: extra slots taken by videos not stored yet (bulk dry runs).
   * `strict`: an unknown overrides.seriesSlug is a 400 (false while
   * re-classifying: the video just stays pending, with the reason).
   */
  function place(title, overrides, excludeId = null, claimed = null, { strict = true } = {}) {
    const result = classify({ title }, catalog(), overrides);
    if (strict && overrides.seriesSlug && !result.seriesId) {
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

    // Check again after the lookup: the same link may have been added meanwhile.
    // From here to the insert everything is synchronous, so nothing else interleaves.
    const added = repo.getVideoByYoutubeId(youtubeVideoId);
    if (added) throw new HttpError(409, "This video was already added.", { video: added });
    try {
      return repo.insertVideo({ youtubeVideoId, ...info, ...place(info.title, overrides) });
    } catch (error) {
      const owner = error.code === "SQLITE_CONSTRAINT_UNIQUE" && repo.getVideoByYoutubeId(youtubeVideoId);
      if (owner) throw new HttpError(409, "This video was already added.", { video: owner });
      throw error;
    }
  }

  let healthRun = null;

  /** One health-check run (see healthCheck()). */
  async function runHealthCheck({ olderThan = null } = {}) {
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
  }

  const mergeOverrides = (current, changes) => {
    const overrides = { ...current };
    for (const [key, value] of Object.entries(changes)) {
      if (value == null) delete overrides[key];
      else overrides[key] = value;
    }
    return overrides;
  };

  return {
    add,

    /**
     * Admin correction of one video. `url` points it at another YouTube upload
     * (the old one was taken down): route, title and ratings stay, availability
     * resets to "ok". `changes` are override corrections ({ section, seriesSlug,
     * season, number }, null clears one). Everything is checked first; then
     * both are written in one transaction, so a bad field changes nothing.
     */
    async patch(id, { url, changes = {} }) {
      if (!repo.getVideo(id)) throw new HttpError(404, "Video not found.");
      let youtubeVideoId = null;
      if (url) {
        youtubeVideoId = parseYouTubeId(url);
        if (!youtubeVideoId) throw validationError({ url: "That is not a YouTube link or video ID." }, "That is not a YouTube link or video ID.");
        const owner = repo.getVideoByYoutubeId(youtubeVideoId);
        if (owner && owner.id !== id) throw new HttpError(409, "Another video already uses this YouTube ID.", { video: owner });
        await fetchVideoInfo(youtubeVideoId); // throws 404/422/502 if it cannot play here
      }
      return repo.transaction(() => {
        // Re-read after the await: the video may have changed or gone meanwhile.
        const video = repo.getVideo(id);
        if (!video) throw new HttpError(404, "Video not found.");
        const placement = Object.keys(changes).length
          ? place(video.title, mergeOverrides(video.overrides, changes), id)
          : null; // throws 400 on an unknown seriesSlug before anything is written
        if (youtubeVideoId && youtubeVideoId !== video.youtubeVideoId) {
          const owner = repo.getVideoByYoutubeId(youtubeVideoId);
          if (owner) throw new HttpError(409, "Another video already uses this YouTube ID.", { video: owner });
        }
        let result = youtubeVideoId ? repo.swapYoutubeId(id, youtubeVideoId) : video;
        if (placement) result = repo.updateVideo(id, placement);
        return result;
      });
    },

    /**
     * Runs the classifier again on pending videos after a series was created
     * ({ after }) or edited ({ before, after }); returns the ones now published.
     * Only a change of name, aliases (as the classifier normalises them) or slug
     * can move a video, and only one whose title contains an old or new
     * name/alias, or whose admin override names the old or new slug: the
     * others are skipped. A synopsis/genre/cover edit does nothing. Without an
     * argument every pending video is re-classified. One transaction; rows
     * whose placement did not change are not rewritten.
     */
    reclassifyPending(change = null) {
      let needles = null;
      let slugs = null;
      if (change) {
        const before = needlesOf(change.before);
        const after = needlesOf(change.after);
        if (change.before && change.before.slug === change.after?.slug && before.join("|") === after.join("|")) return [];
        needles = [...new Set([...before, ...after])];
        slugs = new Set([change.before?.slug, change.after?.slug].filter(Boolean));
      }
      return repo.transaction(() => {
        const changed = [];
        for (const video of repo.pendingForReclassify()) {
          if (needles && !slugs.has(video.overrides.seriesSlug)) {
            const text = normalize(video.title);
            if (!needles.some((needle) => text.includes(needle))) continue;
          }
          const p = place(video.title, video.overrides, video.id, null, { strict: false });
          const same =
            p.status === video.status && p.section === video.section && p.seriesId === video.seriesId &&
            p.season === video.season && p.number === video.number &&
            JSON.stringify(p.classification) === video.classification;
          if (same) continue;
          const updated = repo.updateVideo(video.id, p);
          if (updated.status === "published") changed.push(updated);
        }
        return changed;
      });
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
    healthCheck(options = {}) {
      // Single flight: while a run is going (admin or the daily job), callers share it.
      healthRun ??= runHealthCheck(options).finally(() => {
        healthRun = null;
      });
      return healthRun;
    },
  };
}
