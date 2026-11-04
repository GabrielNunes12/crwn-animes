import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TrashTab } from "./TrashTab.jsx";
import { SeriesTab } from "./SeriesTab.jsx";
import { jsonResponse, mockFetch, renderApp } from "../../test/utils.jsx";

const DAY = 86_400_000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();
const inDays = (days) => new Date(Date.now() + days * DAY - 60_000).toISOString();

const trashedSeries = { id: 10, slug: "naruto", name: "Naruto", synopsis: null, aliases: [], genres: [], coverUrl: null, videoCount: 12, deletedAt: ago(3), purgeAt: inDays(4) };
const trashedVideo = (id, title, extra = {}) => ({
  id, youtubeVideoId: `yt${id}`.padEnd(11, "x"), title, channel: null, thumbnailUrl: "", section: "anime", seriesId: 20, seriesSlug: "bleach",
  seriesName: "Bleach", season: 1, number: id, status: "published", availability: "ok", route: null, rating: { average: null, count: 0 },
  deletedAt: ago(1), purgeAt: inDays(6), ...extra,
});

function server() {
  const db = {
    series: [trashedSeries],
    videos: [trashedVideo(5, "Bleach 5"), trashedVideo(6, "Naruto 6", { seriesId: 10, seriesSlug: "naruto", seriesName: "Naruto" })],
    calls: [],
  };
  const fetchFn = mockFetch((url, init) => {
    db.calls.push(`${init.method ?? "GET"} ${url}`);
    if (url === "/api/admin/trash") return [200, { series: db.series, videos: db.videos }];
    if (url === "/api/admin/trash/videos/6/restore") return [409, { error: { code: "CONFLICT", message: "Its series is in the trash." } }];
    if (url === "/api/admin/trash/videos/5/restore") {
      const video = { ...db.videos.find((v) => v.id === 5), deletedAt: undefined, purgeAt: undefined, route: "/anime/bleach/episode/5" };
      db.videos = db.videos.filter((v) => v.id !== 5);
      return [200, { video }];
    }
    if (url === "/api/admin/trash/series/10" && init.method === "DELETE") {
      db.series = [];
      db.videos = db.videos.filter((v) => v.seriesId !== 10);
      return new Response(null, { status: 204 });
    }
    return [404, { error: { code: "NOT_FOUND" } }];
  });
  return { db, fetchFn };
}

const rowOf = (text) => screen.getByText(text, { selector: "p" }).closest("li");
const seriesRow = () => document.getElementById("trash-series-10").closest("li");

describe("admin Trash tab", () => {
  it("trashed videos have thumbnailUrl null (v1.5): the gradient placeholder, never a broken <img>", async () => {
    const { db } = server();
    db.videos = [trashedVideo(5, "Bleach 5", { thumbnailUrl: null }), trashedVideo(7, "Bleach 7", { thumbnailUrl: "/api/thumbs/yt7xxxxxxxx.jpg" })];
    const { container } = renderApp(<TrashTab reloadSeries={() => {}} />);
    await screen.findByText("Bleach 5", { selector: "p" });
    const missing = rowOf("Bleach 5");
    expect(missing.querySelector("img")).toBeNull();
    expect(missing.querySelector('[data-state="error"]')).toHaveTextContent("BL");
    const present = rowOf("Bleach 7").querySelector("img");
    expect(present).toHaveAttribute("src", "/api/thumbs/yt7xxxxxxxx.jpg");
    // A thumbnail that fails to load (502 from the proxy) gets the same placeholder.
    fireEvent.error(present);
    expect(rowOf("Bleach 7").querySelector("img")).toBeNull();
    expect(container.querySelectorAll("img")).toHaveLength(0);
  });

  it("lists trashed series and videos with when they were removed and when they will be deleted (pt-BR)", async () => {
    server();
    renderApp(<TrashTab reloadSeries={() => {}} />, { locale: "pt-BR" });
    expect(await screen.findByRole("heading", { level: 3, name: "1 série" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "2 vídeos" })).toBeInTheDocument();
    const series = seriesRow();
    expect(series).toHaveTextContent("12 vídeos");
    expect(series).toHaveTextContent("Removido há 3 dias");
    expect(series).toHaveTextContent("Apagado em 4 dias");
    const video = rowOf("Bleach 5");
    expect(video).toHaveTextContent("Removido ontem");
    expect(video).toHaveTextContent("Apagado em 6 dias");
    expect(within(video).getByRole("link", { name: "Pré-visualizar" })).toHaveAttribute("href", "/admin/preview/5");
    expect(within(video).getByRole("button", { name: "Restaurar" })).toBeInTheDocument();
    expect(within(video).getByRole("button", { name: "Apagar para sempre" })).toBeInTheDocument();
  });

  it("restores a video, and explains a 409 (its series is still in the trash)", async () => {
    const { db } = server();
    renderApp(<TrashTab reloadSeries={() => {}} />);
    const user = userEvent.setup();
    await screen.findByRole("heading", { level: 3, name: "2 videos" });

    const blocked = rowOf("Naruto 6");
    await user.click(within(blocked).getByRole("button", { name: "Restore" }));
    expect(await within(blocked).findByRole("alert")).toHaveTextContent("This video can’t be restored while its series “Naruto” is in the trash. Restore the series first.");
    expect(rowOf("Naruto 6")).toBeInTheDocument();

    await user.click(within(rowOf("Bleach 5")).getByRole("button", { name: "Restore" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Restored “Bleach 5”.");
    expect(screen.queryByText("Bleach 5")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "1 video" })).toHaveFocus();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(db.calls).toContain("POST /api/admin/trash/videos/5/restore");
  });

  it("says when a restored video came back as pending", async () => {
    mockFetch((url) => {
      if (url === "/api/admin/trash") return [200, { series: [], videos: [trashedVideo(5, "Bleach 5")] }];
      return [200, { video: { ...trashedVideo(5, "Bleach 5"), status: "pending" } }];
    });
    renderApp(<TrashTab reloadSeries={() => {}} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Restore" }));
    expect(await screen.findByRole("status")).toHaveTextContent("“Bleach 5” came back as pending: its slot was taken while it was in the trash.");
  });

  it("deletes a series forever only after a confirm dialog that says it can't be undone", async () => {
    const { db } = server();
    const reloadSeries = vi.fn();
    renderApp(<TrashTab reloadSeries={reloadSeries} />);
    const user = userEvent.setup();
    await screen.findByRole("heading", { level: 3, name: "1 series" });

    await user.click(within(seriesRow()).getByRole("button", { name: "Delete forever" }));
    const dialog = screen.getByRole("dialog", { name: "Delete “Naruto” forever?" });
    expect(dialog).toHaveTextContent("The series, its 12 videos in the trash and every rating will be deleted now. This can’t be undone.");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(db.calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);

    await user.click(within(seriesRow()).getByRole("button", { name: "Delete forever" }));
    await user.click(within(screen.getByRole("dialog", { name: "Delete “Naruto” forever?" })).getByRole("button", { name: "Delete forever" }));
    expect(await screen.findByText("Deleted “Naruto” forever.")).toBeInTheDocument();
    expect(db.calls).toContain("DELETE /api/admin/trash/series/10");
    // The list is read again: the video of that series went with it.
    await waitFor(() => expect(screen.queryByText("Naruto 6")).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { level: 3, name: "0 series" })).toBeInTheDocument();
  });

  it("restores a series and refreshes the series pickers", async () => {
    const reloadSeries = vi.fn();
    mockFetch((url) => {
      if (url === "/api/admin/trash") return [200, { series: [trashedSeries], videos: [] }];
      if (url === "/api/admin/trash/series/10/restore") return [200, { series: trashedSeries, published: [trashedVideo(1, "a")], pending: [trashedVideo(2, "b")] }];
      return jsonResponse(404, { error: { code: "NOT_FOUND" } });
    });
    renderApp(<TrashTab reloadSeries={reloadSeries} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Restore" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Restored the series Naruto. 1 video came back as pending — check the Pending tab.");
    expect(reloadSeries).toHaveBeenCalled();
  });
});

describe("Series tab — board link and trash copy", () => {
  it("links each series to its board and moves series to the trash (7-day copy)", async () => {
    const calls = [];
    mockFetch((url, init) => {
      calls.push(`${init.method ?? "GET"} ${url}`);
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      return [200, { items: [{ id: 3, slug: "naruto", name: "Naruto", genres: [], aliases: [], videoCounts: { anime: 2, manga: 0 } }], total: 1 }];
    });
    renderApp(<SeriesTab genres={[]} reloadSeries={() => {}} reloadKey={0} />);
    const user = userEvent.setup();
    const row = (await screen.findByText("Naruto", { selector: "p" })).closest("li");
    expect(within(row).getByRole("link", { name: "Open board" })).toHaveAttribute("href", "/admin/series/3");

    await user.click(within(row).getByRole("button", { name: "Move to trash" }));
    const dialog = screen.getByRole("dialog", { name: "Move Naruto to the trash?" });
    expect(dialog).toHaveTextContent("stay in the trash for 7 days");
    await user.click(within(dialog).getByRole("button", { name: "Move to trash" }));
    expect(await screen.findByText("Moved Naruto to the trash.")).toBeInTheDocument();
    expect(calls).toContain("DELETE /api/admin/series/3");
  });
});
