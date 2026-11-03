import { describe, expect, it } from "vitest";
import {
  clearProgress,
  continueWatching,
  formatTime,
  getAllProgress,
  getProgress,
  isCompleted,
  MAX_ENTRIES,
  PROGRESS_KEY,
  pruneLRU,
  resumePosition,
  saveProgress,
} from "./progress.js";

describe("progress helper", () => {
  it("marks completion at 90% of the duration", () => {
    expect(isCompleted(89, 100)).toBe(false);
    expect(isCompleted(90, 100)).toBe(true);
    expect(isCompleted(10, 0)).toBe(false);
  });

  it("stores { t, d, at, route, title, thumb } under crwn:progress:v1", () => {
    saveProgress("abc12345678", { position: 61.24, duration: 600, route: "/anime/x/episode/1", title: "X — Ep 1", thumb: "t.jpg", now: 1000 });
    const raw = JSON.parse(localStorage.getItem(PROGRESS_KEY));
    expect(raw.abc12345678).toEqual({ t: 61.2, d: 600, at: 1000, route: "/anime/x/episode/1", title: "X — Ep 1", thumb: "t.jpg" });
  });

  it("ENDED sets the position to the end, which counts as completed", () => {
    const e = saveProgress("v", { position: 12, duration: 300, ended: true });
    expect(e.t).toBe(300);
    expect(resumePosition(e)).toBe(0);
  });

  it("resumes from the saved position, but not from the very start or when finished", () => {
    saveProgress("a", { position: 754.9, duration: 1400 });
    expect(resumePosition(getProgress("a"))).toBe(754);
    expect(formatTime(754)).toBe("12:34");
    saveProgress("b", { position: 3, duration: 1400 });
    expect(resumePosition(getProgress("b"))).toBe(0);
    saveProgress("c", { position: 1300, duration: 1400 });
    expect(resumePosition(getProgress("c"))).toBe(0);
    expect(resumePosition(null)).toBe(0);
  });

  it("keeps at most 200 entries, evicting the least recently updated", () => {
    for (let i = 0; i < MAX_ENTRIES + 5; i++) {
      saveProgress(`vid${i}`, { position: 30, duration: 100, now: 1000 + i });
    }
    const all = getAllProgress();
    expect(Object.keys(all)).toHaveLength(MAX_ENTRIES);
    expect(all.vid0).toBeUndefined();
    expect(all.vid4).toBeUndefined();
    expect(all.vid5).toBeDefined();
    // Touching an old entry makes it recent again.
    saveProgress("vid5", { position: 40, duration: 100, now: 99999 });
    saveProgress("new", { position: 40, duration: 100, now: 100000 });
    expect(getProgress("vid5")).not.toBeNull();
    expect(getProgress("vid6")).toBeNull();
  });

  it("pruneLRU is pure and sorts by `at`", () => {
    const out = pruneLRU({ a: { at: 1 }, b: { at: 3 }, c: { at: 2 } }, 2);
    expect(Object.keys(out).sort()).toEqual(["b", "c"]);
  });

  it("continueWatching lists unfinished videos, newest first; clear empties it", () => {
    saveProgress("old", { position: 50, duration: 100, route: "/a", now: 1 });
    saveProgress("done", { position: 95, duration: 100, route: "/b", now: 2 });
    saveProgress("recent", { position: 20, duration: 100, route: "/c", now: 3 });
    expect(continueWatching().map((e) => e.youtubeVideoId)).toEqual(["recent", "old"]);
    clearProgress();
    expect(getAllProgress()).toEqual({});
  });

  it("survives corrupted storage", () => {
    localStorage.setItem(PROGRESS_KEY, "{not json");
    expect(getAllProgress()).toEqual({});
    expect(saveProgress("x", { position: 10, duration: 20 })).not.toBeNull();
  });
});
