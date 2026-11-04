import { describe, expect, it, vi } from "vitest";
import {
  buildSeriesIndex,
  EXPORT_FILENAME,
  exportProgress,
  getAllProgress,
  importProgress,
  MAX_ENTRIES,
  MAX_IMPORT_BYTES,
  parseRoute,
  PROGRESS_KEY,
  pruneSeriesProgress,
  saveProgress,
  seriesProgress,
  subscribeProgress,
} from "./progress.js";

const id = (n) => `vid${String(n).padStart(8, "0")}`; // 11 chars, like a YouTube ID
const entry = (over = {}) => ({ t: 30, d: 100, at: 1000, route: "/anime/naruto/episode/1", title: "Naruto — Ep 1", thumb: "https://i.ytimg.com/vi/x/hqdefault.jpg", ...over });
const file = (entries, extra = {}) => JSON.stringify({ version: 1, exportedAt: "2026-11-01T00:00:00.000Z", entries, ...extra });

describe("progress export", () => {
  it("exports { version: 1, exportedAt, entries } with every stored entry", () => {
    saveProgress(id(1), { position: 61.24, duration: 600, route: "/anime/x/episode/1", title: "X", thumb: "t.jpg", now: 1000 });
    const out = exportProgress(new Date("2026-11-03T12:00:00Z"));
    expect(out).toEqual({
      version: 1,
      exportedAt: "2026-11-03T12:00:00.000Z",
      entries: { [id(1)]: { t: 61.2, d: 600, at: 1000, route: "/anime/x/episode/1", title: "X", thumb: "t.jpg" } },
    });
    expect(EXPORT_FILENAME).toBe("crwn-animes-progress.json");
  });

  it("round-trips: an exported file imports into an empty browser", () => {
    saveProgress(id(1), { position: 40, duration: 100, route: "/anime/x/episode/1", now: 5 });
    saveProgress(id(2), { position: 95, duration: 100, route: "/manga/y/chapter/3", now: 6 });
    const text = JSON.stringify(exportProgress());
    const before = getAllProgress();
    localStorage.clear();
    expect(importProgress(text)).toEqual({ ok: true, imported: 2, skipped: 0 });
    expect(getAllProgress()).toEqual(before);
  });
});

describe("progress import", () => {
  it("merges per video: the newest `at` wins, older or equal entries are skipped", () => {
    saveProgress(id(1), { position: 10, duration: 100, route: "/anime/a/episode/1", now: 2000 });
    saveProgress(id(2), { position: 10, duration: 100, route: "/anime/a/episode/2", now: 2000 });
    const res = importProgress(
      file({
        [id(1)]: entry({ t: 50, at: 3000, route: "/anime/a/episode/1" }), // newer → wins
        [id(2)]: entry({ t: 80, at: 1000, route: "/anime/a/episode/2" }), // older → skipped
        [id(3)]: entry({ at: 1500, route: "/anime/a/season/2/episode/1" }), // new → imported
      }),
    );
    expect(res).toEqual({ ok: true, imported: 2, skipped: 1 });
    const all = getAllProgress();
    expect(all[id(1)]).toMatchObject({ t: 50, at: 3000 });
    expect(all[id(2)]).toMatchObject({ t: 10, at: 2000 });
    expect(all[id(3)]).toMatchObject({ route: "/anime/a/season/2/episode/1" });
  });

  it("notifies subscribers so the UI updates", () => {
    const fn = vi.fn();
    const off = subscribeProgress(fn);
    importProgress(file({ [id(1)]: entry() }));
    off();
    expect(fn).toHaveBeenCalled();
  });

  it("skips bad entries, drops unknown keys and never trusts routes or thumbnails", () => {
    const res = importProgress(
      file(
        {
          [id(1)]: { ...entry(), extra: "nope", __proto__x: 1 },
          "not-an-id": entry(),
          [id(2)]: entry({ t: "30" }),
          [id(3)]: entry({ at: -1 }),
          [id(4)]: entry({ route: "javascript:alert(1)" }),
          [id(5)]: entry({ route: "https://evil.example/anime/x/episode/1" }),
          [id(6)]: entry({ thumb: "https://tracker.example/pixel.gif" }),
          [id(7)]: null,
          [id(8)]: [1, 2],
          [id(9)]: entry({ t: 500, d: 100 }),
        },
        { somethingElse: true },
      ),
    );
    expect(res).toEqual({ ok: true, imported: 2, skipped: 8 });
    const all = getAllProgress();
    expect(Object.keys(all).sort()).toEqual([id(1), id(6)]);
    expect(all[id(1)]).toEqual(entry());
    // A third-party thumbnail would make the browser call that host: dropped, entry kept.
    expect(all[id(6)].thumb).toBeNull();
  });

  it("rejects files that aren't a watch history, without throwing or touching storage", () => {
    saveProgress(id(1), { position: 10, duration: 100, now: 1 });
    const before = localStorage.getItem(PROGRESS_KEY);
    for (const text of [
      "{not json",
      "",
      "null",
      "[]",
      JSON.stringify({ entries: {} }),
      JSON.stringify({ version: 2, entries: {} }),
      JSON.stringify({ version: 1, entries: [] }),
      JSON.stringify({ version: 1 }),
      undefined,
    ]) {
      expect(importProgress(text)).toEqual({ ok: false, error: "invalid" });
    }
    expect(localStorage.getItem(PROGRESS_KEY)).toBe(before);
  });

  it("rejects absurd numbers: far-future `at` (would pin the entry and evict real ones), huge t/d", () => {
    const now = Date.UTC(2026, 10, 3);
    const day = 24 * 60 * 60 * 1000;
    const res = importProgress(
      file({
        [id(1)]: entry({ at: 1e300 }),
        [id(2)]: entry({ at: now + day + 1 }),
        [id(3)]: entry({ t: 1e308, d: 1e308 }),
        [id(4)]: entry({ t: 10, d: 2e6 }),
        [id(5)]: entry({ at: now + day }), // clock skew of up to a day is fine
        [id(6)]: entry({ t: 3600, d: 7200, at: now }),
      }),
      { now },
    );
    expect(res).toEqual({ ok: true, imported: 2, skipped: 4 });
    expect(Object.keys(getAllProgress()).sort()).toEqual([id(5), id(6)]);
    // Nothing ends up as Infinity / null in storage.
    expect(localStorage.getItem(PROGRESS_KEY)).not.toMatch(/null,"d"|"t":null|"d":null/);
  });

  it("a far-future entry can no longer push real progress out of the 200-entry cap", () => {
    const now = Date.now();
    const evil = {};
    for (let i = 0; i < MAX_ENTRIES; i++) evil[id(i)] = entry({ at: 1e15 + i });
    expect(importProgress(file(evil))).toEqual({ ok: true, imported: 0, skipped: MAX_ENTRIES });
    saveProgress(id(9999), { position: 30, duration: 100, now });
    expect(getAllProgress()[id(9999)]).toBeDefined();
  });

  it("reports a storage failure (quota full) instead of claiming success", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    try {
      expect(importProgress(file({ [id(1)]: entry() }))).toEqual({ ok: false, error: "storage" });
    } finally {
      spy.mockRestore();
    }
    expect(getAllProgress()).toEqual({});
  });

  it("refuses files over 1 MB", () => {
    expect(importProgress("{}", { size: MAX_IMPORT_BYTES + 1 })).toEqual({ ok: false, error: "tooLarge" });
    const big = file({ [id(1)]: entry({ title: "x".repeat(MAX_IMPORT_BYTES) }) });
    expect(importProgress(big)).toEqual({ ok: false, error: "tooLarge" });
    expect(getAllProgress()).toEqual({});
  });

  it("keeps the 200-entry cap: the newest entries survive, evicted imports count as skipped", () => {
    for (let i = 0; i < MAX_ENTRIES; i++) saveProgress(id(i), { position: 30, duration: 100, now: 10_000 + i });
    const incoming = {};
    for (let i = 0; i < 10; i++) incoming[id(1000 + i)] = entry({ at: 50_000 + i }); // newer than everything
    for (let i = 0; i < 5; i++) incoming[id(2000 + i)] = entry({ at: 1 + i }); // older than everything
    const res = importProgress(file(incoming));
    expect(res).toEqual({ ok: true, imported: 10, skipped: 5 });
    const all = getAllProgress();
    expect(Object.keys(all)).toHaveLength(MAX_ENTRIES);
    expect(all[id(1009)]).toBeDefined();
    expect(all[id(2000)]).toBeUndefined();
    // The 10 oldest local entries made room.
    expect(all[id(9)]).toBeUndefined();
    expect(all[id(10)]).toBeDefined();
  });
});

describe("per-series progress", () => {
  it("derives the series from the stored route", () => {
    expect(parseRoute("/anime/naruto/episode/3")).toEqual({ section: "anime", slug: "naruto", season: 1 });
    expect(parseRoute("/anime/naruto/season/2/episode/3")).toEqual({ section: "anime", slug: "naruto", season: 2 });
    expect(parseRoute("/manga/one-piece/chapter/1100")).toEqual({ section: "manga", slug: "one-piece", season: 1 });
    expect(parseRoute("/anime/naruto")).toBeNull();
    expect(parseRoute(null)).toBeNull();
  });

  it("counts watched and started episodes per series and section", () => {
    const index = buildSeriesIndex({
      a: entry({ t: 95, route: "/anime/naruto/episode/1" }),
      b: entry({ t: 10, route: "/anime/naruto/season/2/episode/1" }),
      c: entry({ t: 95, route: "/manga/naruto/chapter/1" }),
      d: entry({ route: null }),
    });
    expect(index).toEqual({ "anime/naruto": { watched: 1, started: 2 }, "manga/naruto": { watched: 1, started: 1 } });
  });

  it("counts distinct episodes (routes), not entries: a swapped YouTube link counts once", () => {
    const index = buildSeriesIndex({
      old: entry({ t: 95, route: "/anime/naruto/episode/1" }),
      new: entry({ t: 95, route: "/anime/naruto/episode/1" }),
      half: entry({ t: 10, route: "/anime/naruto/episode/1" }),
    });
    expect(index).toEqual({ "anime/naruto": { watched: 1, started: 1 } });
  });
});

describe("watched N of M + Continue target", () => {
  const v = (n, season = 1, over = {}) => ({
    id: n + season * 100,
    youtubeVideoId: id(n + season * 100),
    season,
    number: n,
    availability: "ok",
    route: season > 1 ? `/anime/s/season/${season}/episode/${n}` : `/anime/s/episode/${n}`,
    ...over,
  });
  const videos = [v(1), v(2), v(3), v(1, 2), v(2, 2)];
  const done = (at = 1) => ({ t: 100, d: 100, at });
  const mid = (at = 1) => ({ t: 40, d: 100, at });

  it("no progress: target is the first episode, nothing watched", () => {
    expect(seriesProgress(videos, {})).toMatchObject({ watched: 0, total: 5, target: videos[0], resume: false, touched: false, allWatched: false });
  });

  it("resumes the in-progress episode (the most recent one) over the first unwatched", () => {
    const map = { [videos[0].youtubeVideoId]: done(), [videos[3].youtubeVideoId]: mid(5), [videos[2].youtubeVideoId]: mid(3) };
    expect(seriesProgress(videos, map)).toMatchObject({ watched: 1, target: videos[3], resume: true, touched: true });
  });

  it("otherwise opens the first unwatched episode, skipping unavailable ones", () => {
    const list = [v(1), v(2, 1, { availability: "unavailable" }), v(3)];
    const map = { [list[0].youtubeVideoId]: done() };
    expect(seriesProgress(list, map)).toMatchObject({ watched: 1, total: 3, target: list[2], resume: false });
  });

  it("a barely started episode (< 5 s) is not 'in progress'", () => {
    const map = { [videos[0].youtubeVideoId]: done(), [videos[4].youtubeVideoId]: { t: 2, d: 100, at: 9 } };
    expect(seriesProgress(videos, map)).toMatchObject({ target: videos[1], resume: false });
  });

  it("N and M count every published episode; unavailable ones block 'everything' and Continue", () => {
    const list = [v(1), v(2), v(3, 1, { availability: "unavailable" })];
    const map = { [list[0].youtubeVideoId]: done(), [list[1].youtubeVideoId]: done() };
    expect(seriesProgress(list, map)).toMatchObject({ watched: 2, total: 3, target: null, allWatched: false, unavailableLeft: 1 });
    // A watched episode that later became unavailable still counts and doesn't block.
    const map2 = { ...map, [list[2].youtubeVideoId]: done() };
    expect(seriesProgress(list, map2)).toMatchObject({ watched: 3, total: 3, allWatched: true, unavailableLeft: 0 });
  });

  it("uses the same route-based derivation as the cards: a swapped link keeps the episode watched", () => {
    const list = [v(1), v(2)];
    // Progress was saved under the old YouTube ID; the admin swapped the link (same route).
    const map = { oldYoutubeId: { ...done(), route: list[0].route } };
    const sp = seriesProgress(list, map);
    expect(sp).toMatchObject({ watched: 1, total: 2, target: list[1], touched: true });
    expect(sp.isWatched(list[0])).toBe(true);
    expect(buildSeriesIndex(map)["anime/s"]).toEqual({ watched: 1, started: 1 });
  });

  it("an entry of a video in the list counts for that video only, whatever route it stored (reorder)", () => {
    // [A, B] was reordered to [B, A]: A's entry still says episode 1, B's says episode 2.
    const A = v(1);
    const B = v(2);
    const list = [{ ...B, number: 1, route: A.route }, { ...A, number: 2, route: B.route }];
    const map = { [A.youtubeVideoId]: { ...done(1), route: A.route }, [B.youtubeVideoId]: { ...mid(2), route: B.route } };
    const sp = seriesProgress(list, map);
    expect(sp).toMatchObject({ watched: 1, total: 2, resume: true });
    expect(sp.target.youtubeVideoId).toBe(B.youtubeVideoId);
    expect(sp.isWatched(list[0])).toBe(false); // B
    expect(sp.isWatched(list[1])).toBe(true); // A
  });

  it("pruneSeriesProgress moves known videos to their current routes and keeps swapped links", () => {
    const A = v(1);
    const B = v(2);
    const list = [{ ...B, number: 1, route: A.route }, { ...A, number: 2, route: B.route }];
    localStorage.setItem(
      PROGRESS_KEY,
      JSON.stringify({
        [A.youtubeVideoId]: { ...done(1), route: A.route },
        [B.youtubeVideoId]: { ...mid(2), route: B.route },
        swapped0001: { ...done(3), route: B.route }, // unknown ID at a live route: kept
        deleted0001: { ...done(4), route: "/anime/s/episode/9" }, // unknown ID, dead route: removed
        other000001: { ...done(5), route: "/anime/other/episode/1" }, // other series: untouched
      }),
    );
    expect(pruneSeriesProgress("anime", "s", list)).toBe(3);
    const all = getAllProgress();
    expect(all[A.youtubeVideoId].route).toBe("/anime/s/episode/2");
    expect(all[B.youtubeVideoId].route).toBe("/anime/s/episode/1");
    expect(all.swapped0001.route).toBe("/anime/s/episode/2");
    expect(all.deleted0001).toBeUndefined();
    expect(all.other000001.route).toBe("/anime/other/episode/1");
    expect(pruneSeriesProgress("anime", "s", list)).toBe(0); // idempotent
  });

  it("everything watched: no target", () => {
    const map = Object.fromEntries(videos.map((x) => [x.youtubeVideoId, done()]));
    expect(seriesProgress(videos, map)).toMatchObject({ watched: 5, total: 5, target: null, allWatched: true });
  });
});
