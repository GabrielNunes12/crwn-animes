import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { Component as Watch, loader } from "./Watch.jsx";
import { mockFetch, renderApp } from "../../test/utils.jsx";
import { getAllProgress, saveProgress } from "../../lib/progress.js";

const rating = { average: null, count: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, reactions: { fire: 0, laugh: 0, cry: 0, wow: 0, love: 0 }, mine: null };
const v = (id, number, season = 1) => ({
  id, youtubeVideoId: `yt${id}`.padEnd(11, "x"), title: `Ep ${number}`, thumbnailUrl: "", section: "anime", seriesSlug: "op", seriesName: "OP",
  season, number, status: "published", availability: "ok", rating: { average: null, count: 0 },
  route: season > 1 ? `/anime/op/season/${season}/episode/${number}` : `/anime/op/episode/${number}`,
});
const videos = [v(1, 1), v(2, 2), v(3, 1, 2)];

function api(url) {
  if (url === "/api/anime/series/op") return [200, { series: { id: 1, slug: "op", name: "OP" }, videos }];
  const m = url.match(/^\/api\/videos\/(\d+)$/);
  if (m) {
    const i = videos.findIndex((x) => x.id === Number(m[1]));
    return [200, { video: videos[i], series: { id: 1, slug: "op", name: "OP" }, prev: videos[i - 1] ?? null, next: videos[i + 1] ?? null }];
  }
  if (url.endsWith("/rating")) return [200, rating];
  return [404, { error: { code: "NOT_FOUND" } }];
}

const routes = ["anime/:slug/episode/:number", "anime/:slug/season/:season/episode/:number"].map((path) => ({
  path: `/${path}`,
  Component: Watch,
  loader: (args) => loader({ ...args, section: "anime" }),
}));

describe("Watch page canonical URLs", () => {
  for (const [from, to] of [
    ["/anime/op/season/1/episode/2", "/anime/op/episode/2"],
    ["/anime/op/episode/02", "/anime/op/episode/2"],
    ["/anime/op/episode/2.0", "/anime/op/episode/2"],
    ["/anime/op/season/02/episode/1", "/anime/op/season/2/episode/1"],
  ]) {
    it(`replaces ${from} with ${to}`, async () => {
      mockFetch(api);
      const { router } = renderApp(null, { routes, path: from });
      await waitFor(() => expect(router.state.location.pathname).toBe(to));
      expect(router.state.historyAction).toBe("REPLACE");
      expect(await screen.findByRole("heading", { level: 1, name: /Episode/ })).toBeInTheDocument();
    });
  }

  it("leaves canonical URLs alone", async () => {
    mockFetch(api);
    const { router } = renderApp(null, { routes, path: "/anime/op/episode/2" });
    expect(await screen.findByRole("heading", { level: 1, name: "Episode 2" })).toBeInTheDocument();
    expect(router.state.historyAction).toBe("POP");
  });
});

describe("Watch page after a reorder", () => {
  // [A, B] was saved as [B, A]: B is episode 1 now, A is episode 2. Local progress still has the old routes.
  const A = { ...v(1, 2), title: "A" };
  const B = { ...v(2, 1), title: "B" };
  const order = [B, A];
  const reorderApi = (url) => {
    if (url === "/api/anime/series/op") return [200, { series: { id: 1, slug: "op", name: "OP" }, videos: order }];
    const m = url.match(/^\/api\/videos\/(\d+)$/);
    if (m) {
      const i = order.findIndex((x) => x.id === Number(m[1]));
      return [200, { video: order[i], series: { id: 1, slug: "op", name: "OP" }, prev: order[i - 1] ?? null, next: order[i + 1] ?? null }];
    }
    if (url.endsWith("/rating")) return [200, rating];
    return [404, { error: { code: "NOT_FOUND" } }];
  };

  it("resumes and marks by YouTube ID, never from another video's entry at the same route", async () => {
    saveProgress(A.youtubeVideoId, { position: 1400, duration: 1400, route: "/anime/op/episode/1", now: 1 }); // finished
    saveProgress(B.youtubeVideoId, { position: 300, duration: 1400, route: "/anime/op/episode/2", now: 2 }); // in progress
    mockFetch(reorderApi);
    renderApp(null, { routes, path: "/anime/op/episode/2" }); // now A
    expect(await screen.findByRole("heading", { level: 1, name: "Episode 2" })).toBeInTheDocument();
    // A is finished: no "Resume at 5:00" (that is B's position, B used to be episode 2).
    expect(screen.getByRole("button", { name: "Play: A" })).not.toHaveTextContent(/Resume at/);
    const side = screen.getByRole("complementary");
    // The episode list renders in the page's second (deferred) pass, right after the player.
    await within(side).findAllByRole("listitem");
    const item = (title) => within(side).getAllByRole("listitem").find((li) => li.textContent.includes(title));
    expect(within(item("A")).getByText("Watched")).toBeInTheDocument();
    expect(within(item("B")).queryByText("Watched")).not.toBeInTheDocument();
    // Stored routes now follow the videos.
    await waitFor(() => expect(getAllProgress()[A.youtubeVideoId].route).toBe("/anime/op/episode/2"));
    expect(getAllProgress()[B.youtubeVideoId].route).toBe("/anime/op/episode/1");
  });

  it("resumes B at its own position on its new route", async () => {
    saveProgress(B.youtubeVideoId, { position: 300, duration: 1400, route: "/anime/op/episode/2", now: 2 });
    mockFetch(reorderApi);
    renderApp(null, { routes, path: "/anime/op/episode/1" });
    expect(await screen.findByRole("button", { name: "Play: B" })).toHaveTextContent("Resume at 5:00");
  });
});
