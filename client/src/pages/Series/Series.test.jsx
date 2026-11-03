import { describe, expect, it } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Component as Series, loader, shouldRevalidate } from "./Series.jsx";
import { mockFetch, renderApp } from "../../test/utils.jsx";
import { saveProgress } from "../../lib/progress.js";
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
    expect(within(nav).getByRole("link", { name: "Season 2" })).toHaveAttribute("aria-current", "true");
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
});
