import { describe, expect, it } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Component as Series, loader, shouldRevalidate } from "./Series.jsx";
import { mockFetch, renderApp } from "../../test/utils.jsx";
import { buildSeriesIndex, getAllProgress, pruneSeriesProgress, saveProgress } from "../../lib/progress.js";
import { pickSeason, seasonsOf } from "../../lib/seasons.js";

const v = (n, season = 1) => ({
  id: season * 100 + n,
  youtubeVideoId: `yt${season * 100 + n}`.padEnd(11, "x"),
  title: `S${season}E${n}`,
  thumbnailUrl: "",
  section: "anime",
  seriesSlug: "op",
  seriesName: "OP",
  season,
  number: n,
  status: "published",
  availability: "ok",
  rating: { average: null, count: 0 },
  route: season > 1 ? `/anime/op/season/${season}/episode/${n}` : `/anime/op/episode/${n}`,
});
const VIDEOS = [v(1), v(2), v(1, 2), v(2, 2), v(3, 2)];
const SERIES = { id: 1, slug: "op", name: "OP", synopsis: null, aliases: [], genres: [], coverUrl: null };

const routes = [{ path: "/anime/:slug", Component: Series, loader: (args) => loader({ ...args, section: "anime" }), shouldRevalidate }];

function setup(path = "/anime/op", videos = VIDEOS) {
  const fetchFn = mockFetch((url) => (url.startsWith("/api/anime/series/op") ? [200, { series: SERIES, videos, seasons: [1, 2] }] : [404, {}]));
  const utils = renderApp(null, { routes: [...routes, { path: "/elsewhere", element: <p>Elsewhere</p> }], path });
  return { ...utils, fetchFn };
}

const episodeLinks = () =>
  within(screen.getByRole("region", { name: /^Season/ }))
    .getAllByRole("link")
    .map((a) => a.getAttribute("href"));

function watch(video, { done = true, at = Date.now() } = {}) {
  saveProgress(video.youtubeVideoId, { position: done ? 100 : 40, duration: 100, route: video.route, now: at });
}

describe("season helpers", () => {
  it("uses the API's seasons, or derives them from the videos", () => {
    expect(seasonsOf([2, 1], [])).toEqual([1, 2]);
    expect(seasonsOf(undefined, VIDEOS)).toEqual([1, 2]);
    expect(seasonsOf([], [])).toEqual([]);
  });

  it("?season= wins when valid; else the Continue target's season; else the first", () => {
    expect(pickSeason([1, 2, 3], "3", VIDEOS[2])).toBe(3);
    expect(pickSeason([1, 2, 3], "9", VIDEOS[2])).toBe(2);
    expect(pickSeason([1, 2, 3], "abc", null)).toBe(1);
    expect(pickSeason([1, 2, 3], null, null)).toBe(1);
  });
});

describe("Series page — seasons, watched N of M and Continue", () => {
  it("shows season 1 by default and switches seasons through ?season= without refetching", async () => {
    const { router, fetchFn } = setup();
    expect(await screen.findByRole("heading", { level: 1, name: "OP" })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Seasons" });
    expect(within(nav).getByRole("link", { name: "Season 1" })).toHaveAttribute("aria-current", "true");
    expect(episodeLinks()).toEqual(["/anime/op/episode/1", "/anime/op/episode/2"]);
    expect(screen.getByRole("link", { name: "Start watching" })).toHaveAttribute("href", "/anime/op/episode/1");
    expect(screen.queryByText(/Watched \d+ of/)).not.toBeInTheDocument();

    await userEvent.setup().click(within(nav).getByRole("link", { name: "Season 2" }));
    await waitFor(() => expect(router.state.location.search).toBe("?season=2"));
    // router.state is updated before React commits it (a transition): wait for the DOM, not the router.
    await waitFor(() => expect(within(nav).getByRole("link", { name: "Season 2" })).toHaveAttribute("aria-current", "true"));
    expect(within(nav).getByRole("link", { name: "Season 1" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("heading", { level: 3, name: "Season 2" })).toBeInTheDocument();
    expect(episodeLinks()).toEqual(["/anime/op/season/2/episode/1", "/anime/op/season/2/episode/2", "/anime/op/season/2/episode/3"]);
    // Only the season filter changed: the loaded series is reused.
    expect(fetchFn.mock.calls.filter(([u]) => u.startsWith("/api/anime/series/op"))).toHaveLength(1);
    expect(fetchFn.mock.calls[0][0]).toBe("/api/anime/series/op");
  });

  it("season links push history entries: Back returns to the previous season, not off the page", async () => {
    const { router } = setup("/elsewhere");
    await act(() => router.navigate("/anime/op"));
    await screen.findByRole("heading", { level: 1, name: "OP" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("link", { name: "Season 2" }));
    await waitFor(() => expect(router.state.location.search).toBe("?season=2"));
    expect(router.state.historyAction).toBe("PUSH");
    await act(() => router.navigate(-1));
    await waitFor(() => expect(router.state.location.search).toBe(""));
    expect(router.state.location.pathname).toBe("/anime/op");
    expect(screen.getByRole("link", { name: "Season 1" })).toHaveAttribute("aria-current", "true");
  });

  it("opens the season from the URL", async () => {
    setup("/anime/op?season=2");
    await screen.findByRole("heading", { level: 1, name: "OP" });
    expect(screen.getByRole("link", { name: "Season 2" })).toHaveAttribute("aria-current", "true");
    expect(episodeLinks()).toHaveLength(3);
  });

  it("defaults to the season of the in-progress episode and resumes it", async () => {
    watch(VIDEOS[0], { at: 1 });
    watch(VIDEOS[3], { done: false, at: 2 }); // S2E2 in progress
    setup();
    await screen.findByRole("heading", { level: 1, name: "OP" });
    expect(screen.getByRole("link", { name: "Season 2" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByText("Watched 1 of 5")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Continue: Season 2 · Episode 2" })).toHaveAttribute("href", "/anime/op/season/2/episode/2");
  });

  it("continues with the first unwatched episode, and its season", async () => {
    watch(VIDEOS[0]);
    watch(VIDEOS[1]);
    setup();
    await screen.findByRole("heading", { level: 1, name: "OP" });
    expect(screen.getByText("Watched 2 of 5")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Continue: Season 2 · Episode 1" })).toHaveAttribute("href", "/anime/op/season/2/episode/1");
    expect(screen.getByRole("link", { name: "Season 2" })).toHaveAttribute("aria-current", "true");
  });

  it("everything watched: no Continue button, 'Watched everything ✓' instead", async () => {
    VIDEOS.forEach((x, i) => watch(x, { at: i + 1 }));
    setup();
    await screen.findByRole("heading", { level: 1, name: "OP" });
    expect(screen.getByText("Watched 5 of 5")).toBeInTheDocument();
    expect(screen.getByText("Watched everything")).toHaveTextContent("Watched everything ✓");
    expect(screen.queryByRole("link", { name: /^(Continue|Start watching)/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/unavailable right now/)).not.toBeInTheDocument();
    // Back to the first season when there is nothing left to continue.
    expect(screen.getByRole("link", { name: "Season 1" })).toHaveAttribute("aria-current", "true");
  });

  it("everything playable watched but some episodes unavailable: no badge, no Continue, a short note", async () => {
    const videos = VIDEOS.map((x, i) => (i === 4 ? { ...x, availability: "unavailable" } : x));
    videos.slice(0, 4).forEach((x, i) => watch(x, { at: i + 1 }));
    setup("/anime/op", videos);
    await screen.findByRole("heading", { level: 1, name: "OP" });
    expect(screen.getByText("Watched 4 of 5")).toBeInTheDocument();
    expect(screen.getByText("1 episode is unavailable right now.")).toBeInTheDocument();
    expect(screen.queryByText("Watched everything")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^(Continue|Start watching)/ })).not.toBeInTheDocument();
  });

  it("prunes local entries for episodes that no longer exist, so cards agree with the page", async () => {
    const save = (yt, route, now) => saveProgress(yt, { position: 100, duration: 100, route, now });
    save(VIDEOS[0].youtubeVideoId, VIDEOS[0].route, 1); // S1E1: real, watched
    save("ghost000099", "/anime/op/episode/99", 2); // deleted episode
    save(VIDEOS[1].youtubeVideoId, "/anime/op/episode/7", 3); // renumbered: E7 is now E2
    save("other000001", "/anime/bleach/episode/99", 4); // another series: untouched
    save("manga000099", "/manga/op/chapter/99", 5); // same slug, other section: untouched
    expect(buildSeriesIndex(getAllProgress())["anime/op"]).toEqual({ watched: 3, started: 3 }); // stale card count

    setup();
    await screen.findByRole("heading", { level: 1, name: "OP" });
    await waitFor(() => expect(buildSeriesIndex(getAllProgress())["anime/op"]).toEqual({ watched: 2, started: 2 }));
    expect(screen.getByText("Watched 2 of 5")).toBeInTheDocument();
    const all = getAllProgress();
    expect(all.ghost000099).toBeUndefined();
    expect(all[VIDEOS[1].youtubeVideoId].route).toBe("/anime/op/episode/2");
    expect(all.other000001.route).toBe("/anime/bleach/episode/99");
    expect(all.manga000099.route).toBe("/manga/op/chapter/99");
  });

  it("after a reorder (every old route still exists), progress follows the video, not the route", async () => {
    // Before: A = episode 1 (finished), B = episode 2 (in progress). The admin saved the order [B, A].
    const [A, B] = [VIDEOS[0].youtubeVideoId, VIDEOS[1].youtubeVideoId];
    saveProgress(A, { position: 1400, duration: 1400, route: "/anime/op/episode/1", now: 1 });
    saveProgress(B, { position: 300, duration: 1400, route: "/anime/op/episode/2", now: 2 });
    const reordered = [
      { ...VIDEOS[1], number: 1, route: "/anime/op/episode/1" },
      { ...VIDEOS[0], number: 2, route: "/anime/op/episode/2" },
      ...VIDEOS.slice(2),
    ];
    setup("/anime/op", reordered);
    await screen.findByRole("heading", { level: 1, name: "OP" });
    expect(screen.getByText("Watched 1 of 5")).toBeInTheDocument();
    // B (now episode 1) is the one in progress — not "watched" because A used to live at /episode/1.
    expect(screen.getByRole("link", { name: /Continue: Episode 1/ })).toHaveAttribute("href", "/anime/op/episode/1");
    const row = (n) => screen.getAllByRole("listitem").find((li) => li.textContent.startsWith(`Episode ${n}`));
    expect(row(1)).not.toHaveAttribute("data-done");
    expect(row(2)).toHaveAttribute("data-done", "true");
    // Stored routes are rewritten, so the cards and "Continue watching" agree.
    await waitFor(() => expect(getAllProgress()[A].route).toBe("/anime/op/episode/2"));
    expect(getAllProgress()[B].route).toBe("/anime/op/episode/1");
  });

  it("pruneSeriesProgress never clears anything without a published list", () => {
    saveProgress("ghost000099", { position: 100, duration: 100, route: "/anime/op/episode/99" });
    expect(pruneSeriesProgress("anime", "op", [])).toBe(0);
    expect(pruneSeriesProgress("anime", "op", undefined)).toBe(0);
    expect(getAllProgress().ghost000099).toBeDefined();
  });
});

describe("Series page — images (docs/API.md v1.7)", () => {
  it("episode thumbnails use the API's srcset with the row's sizes; the cover is the one high-priority image", async () => {
    const thumbs = VIDEOS.map((x) => ({
      ...x,
      thumbnailUrl: `/api/thumbs/${x.youtubeVideoId}.jpg`,
      thumbnailSrcSet: `/api/thumbs/${x.youtubeVideoId}-m.jpg 320w, /api/thumbs/${x.youtubeVideoId}.jpg 480w`,
    }));
    mockFetch((url) =>
      url.startsWith("/api/anime/series/op") ? [200, { series: { ...SERIES, coverUrl: "/api/covers/1.img?v=1" }, videos: thumbs, seasons: [1, 2] }] : [404, {}],
    );
    renderApp(null, { routes, path: "/anime/op" });
    const cover = await screen.findByRole("img", { name: /OP/ });
    expect(cover).toHaveAttribute("fetchpriority", "high");
    expect(cover).toHaveAttribute("loading", "eager");
    const rows = [...document.querySelectorAll("ol img")];
    expect(rows.map((img) => img.getAttribute("srcset"))).toEqual(thumbs.filter((x) => x.season === 1).map((x) => x.thumbnailSrcSet));
    for (const img of rows) {
      expect(img).toHaveAttribute("sizes", "7.5rem");
      expect(img).toHaveAttribute("loading", "lazy");
      expect(img).not.toHaveAttribute("fetchpriority");
    }
    expect(document.querySelectorAll('img[fetchpriority="high"]')).toHaveLength(1);
  });
});
