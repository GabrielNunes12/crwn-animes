import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { Component as DraftPreview } from "./DraftPreview.jsx";
import { mockFetch, renderApp } from "../../test/utils.jsx";

const series = { id: 1, slug: "op", name: "One Piece", synopsis: null, aliases: [], genres: [], coverUrl: null };
const pendingVideo = {
  id: 7, youtubeVideoId: "abcdefghijk", title: "One Piece 1100 legendado", channel: "Canal X", thumbnailUrl: "", section: "anime",
  seriesId: 1, seriesSlug: "op", seriesName: "One Piece", season: 2, number: 3, status: "pending", availability: "ok", route: null,
  rating: { average: null, count: 0 },
  classification: { scores: { anime: 2, manga: 1 }, reasons: ["Episode slot 3 is already taken"], suggestedNumber: 3 },
  overrides: {}, createdAt: "2026-11-01T10:00:00Z", updatedAt: "2026-11-02T10:00:00Z",
};

const routes = [{ path: "/admin/preview/:id", Component: DraftPreview }];

function serve(video) {
  return mockFetch((url) => {
    if (url === `/api/admin/videos/${video.id}/preview`) return [200, { video, series }];
    return [404, { error: { code: "NOT_FOUND" } }];
  });
}

describe("admin draft preview", () => {
  it("shows the draft banner with the pending reasons, the player and metadata — and no rating panel", async () => {
    const fetchFn = serve(pendingVideo);
    renderApp(null, { routes, path: "/admin/preview/7" });
    const banner = await screen.findByRole("region", { name: "Draft preview" });
    expect(within(banner).getByText("Pending")).toBeInTheDocument();
    expect(within(banner).getByText("Why it is pending")).toBeInTheDocument();
    expect(within(banner).getByText("Episode slot 3 is already taken")).toBeInTheDocument();
    expect(within(banner).getByRole("link", { name: /Back to the board/ })).toHaveAttribute("href", "/admin/series/1?section=anime&season=2");
    expect(within(banner).queryByText("In the trash")).not.toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Play: One Piece 1100 legendado" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Season 2 · Episode 3" })).toBeInTheDocument();
    expect(screen.getByText("abcdefghijk")).toBeInTheDocument();
    expect(screen.getByText("No route — not published")).toBeInTheDocument();

    expect(screen.queryByRole("heading", { name: "Ratings & reactions" })).not.toBeInTheDocument();
    expect(fetchFn.mock.calls.some(([u]) => String(u).includes("/rating"))).toBe(false);
    expect(document.head.querySelector('meta[name="robots"]')).toHaveAttribute("content", "noindex");
    await waitFor(() => expect(document.title).toBe("Preview: One Piece 1100 legendado · Crwn Animes"));
  });

  it("says when the video is in the trash (pt-BR)", async () => {
    serve({ ...pendingVideo, status: "published", route: "/anime/op/season/2/episode/3", deletedAt: "2026-11-03T10:00:00Z", purgeAt: "2026-11-10T10:00:00Z" });
    renderApp(null, { routes, path: "/admin/preview/7", locale: "pt-BR" });
    const banner = await screen.findByRole("region", { name: "Pré-visualização de rascunho" });
    expect(within(banner).getByText("Na lixeira")).toBeInTheDocument();
    expect(within(banner).getByRole("link", { name: "Ver na Lixeira" })).toHaveAttribute("href", "/admin?tab=trash");
    expect(within(banner).queryByText("Por que está pendente")).not.toBeInTheDocument();
    // A trashed video has no live public page.
    expect(screen.getByText("Sem rota — não está publicado")).toBeInTheDocument();
  });

  it("shows a not-found card for an unknown or purged video", async () => {
    mockFetch(() => [404, { error: { code: "NOT_FOUND" } }]);
    renderApp(null, { routes, path: "/admin/preview/999" });
    expect(await screen.findByRole("heading", { level: 1, name: "Page not found" })).toBeInTheDocument();
  });
});
