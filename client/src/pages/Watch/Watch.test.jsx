import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { Component as Watch, loader } from "./Watch.jsx";
import { mockFetch, renderApp } from "../../test/utils.jsx";

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
