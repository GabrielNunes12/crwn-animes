import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VideoListTab } from "./VideoListTab.jsx";
import { SeriesTab } from "./SeriesTab.jsx";
import { jsonResponse, mockFetch, renderApp } from "../../test/utils.jsx";
import { adminApi, toPage } from "../../api/client.js";

const video = (n, title = `Video ${n}`) => ({
  id: n, youtubeVideoId: `yt${n}`.padEnd(11, "x"), title, channel: null, thumbnailUrl: "", section: "anime", seriesId: 1,
  seriesSlug: "op", seriesName: "OP", season: 1, number: n, status: "published", availability: "ok", route: `/anime/op/episode/${n}`,
  rating: { average: null, count: 0 }, classification: null, overrides: {},
});
const ALL = Array.from({ length: 45 }, (_, i) => video(i + 1));

const params = (url) => new URL(url, "http://x").searchParams;
const titles = () => screen.queryAllByText(/^Video \d+$|^Naruto/).map((el) => el.textContent);

describe("admin API shapes", () => {
  it("normalises { items, total } and tolerates an older array response", () => {
    expect(toPage({ items: [1], total: 9 })).toEqual({ items: [1], total: 9 });
    expect(toPage([1, 2])).toEqual({ items: [1, 2], total: 2 });
    expect(toPage(null)).toEqual({ items: [], total: 0 });
  });

  it("allSeries pages through every series (100 at a time) for the pickers", async () => {
    const series = Array.from({ length: 230 }, (_, i) => ({ id: i, slug: `s${i}`, name: `S${i}` }));
    const fetchFn = mockFetch((url) => {
      const p = params(url);
      const offset = Number(p.get("offset") ?? 0);
      return [200, { items: series.slice(offset, offset + Number(p.get("limit"))), total: series.length }];
    });
    expect(await adminApi.allSeries()).toHaveLength(230);
    expect(fetchFn.mock.calls.map(([u]) => u)).toEqual(["/api/admin/series?limit=100", "/api/admin/series?limit=100&offset=100", "/api/admin/series?limit=100&offset=200"]);
  });
});

describe("admin lists — pagination", () => {
  it("pages with Previous / Next, shows 'Page x of y' and 'N results', and moves focus to the list heading", async () => {
    const fetchFn = mockFetch((url) => {
      const p = params(url);
      expect(p.get("status")).toBe("published");
      const offset = Number(p.get("offset") ?? 0);
      return [200, { items: ALL.slice(offset, offset + Number(p.get("limit"))), total: ALL.length }];
    });
    renderApp(<VideoListTab status="published" series={[]} />);
    const user = userEvent.setup();

    const heading = await screen.findByRole("heading", { level: 2, name: "45 published videos" });
    await waitFor(() => expect(titles()).toHaveLength(20));
    expect(titles()[0]).toBe("Video 1");
    expect(screen.getByText("45 results")).toBeInTheDocument();
    const pager = screen.getByRole("navigation", { name: "Pages" });
    expect(within(pager).getByText("Page 1 of 3")).toBeInTheDocument();
    const prev = within(pager).getByRole("button", { name: "Previous page" });
    const next = within(pager).getByRole("button", { name: "Next page" });
    expect(prev).toHaveAttribute("aria-disabled", "true");

    await user.click(next);
    await waitFor(() => expect(titles()[0]).toBe("Video 21"));
    expect(within(pager).getByText("Page 2 of 3")).toBeInTheDocument();
    await waitFor(() => expect(heading).toHaveFocus());
    expect(params(fetchFn.mock.calls.at(-1)[0]).get("offset")).toBe("20");

    await user.click(next);
    await waitFor(() => expect(titles()).toEqual(["Video 41", "Video 42", "Video 43", "Video 44", "Video 45"]));
    expect(next).toHaveAttribute("aria-disabled", "true");
    const calls = fetchFn.mock.calls.length;
    await user.click(next); // at the end: no request
    expect(fetchFn.mock.calls.length).toBe(calls);

    await user.click(prev);
    await waitFor(() => expect(titles()[0]).toBe("Video 21"));
  });

  it("hides the pager when everything fits on one page", async () => {
    mockFetch(() => [200, { items: ALL.slice(0, 3), total: 3 }]);
    renderApp(<VideoListTab status="pending" series={[]} />);
    await screen.findByText("3 results");
    expect(screen.queryByRole("navigation", { name: "Pages" })).not.toBeInTheDocument();
  });
});

describe("admin lists — search", () => {
  it("debounces, starts again from page 1, and ignores a stale response that arrives late", async () => {
    const pending = {};
    const fetchFn = mockFetch((url) => {
      const p = params(url);
      const q = p.get("q") ?? "";
      if (q === "nar") {
        // Slow server: this one resolves only when the test says so.
        return new Promise((resolve) => {
          pending.nar = () => resolve(jsonResponse(200, { items: [video(900, "Naruto STALE")], total: 1 }));
        });
      }
      if (q === "naruto") return [200, { items: [video(901, "Naruto Shippuden 1"), video(902, "Naruto Shippuden 2")], total: 2 }];
      const offset = Number(p.get("offset") ?? 0);
      return [200, { items: ALL.slice(offset, offset + 20), total: ALL.length }];
    });
    renderApp(<VideoListTab status="published" series={[]} />);
    const user = userEvent.setup();
    await screen.findByText("45 results");
    await user.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByText("Page 2 of 3");

    const box = screen.getByRole("searchbox", { name: "Search videos by title or series" });
    await user.type(box, "nar");
    await waitFor(() => expect(pending.nar).toBeTypeOf("function"));
    // Typing is debounced: one request for "nar", not one per key.
    expect(fetchFn.mock.calls.filter(([u]) => params(u).has("q")).map(([u]) => params(u).get("q"))).toEqual(["nar"]);
    // A new query goes back to the first page.
    expect(params(fetchFn.mock.calls.at(-1)[0]).has("offset")).toBe(false);

    await user.type(box, "uto");
    await screen.findByText("2 results for “naruto”");
    expect(titles()).toEqual(["Naruto Shippuden 1", "Naruto Shippuden 2"]);

    // The "nar" response finally arrives: it must not replace the newer results.
    pending.nar();
    await new Promise((r) => setTimeout(r, 30));
    expect(titles()).toEqual(["Naruto Shippuden 1", "Naruto Shippuden 2"]);
    expect(screen.queryByText("Naruto STALE")).not.toBeInTheDocument();
    expect(screen.getByText("2 results for “naruto”")).toBeInTheDocument();
  });

  it("shows an empty state for a search with no match (series tab)", async () => {
    mockFetch((url) => {
      const q = params(url).get("q");
      return [200, q ? { items: [], total: 0 } : { items: [{ id: 1, slug: "naruto", name: "Naruto", genres: [], aliases: [] }], total: 1 }];
    });
    renderApp(<SeriesTab genres={[]} reloadSeries={() => {}} reloadKey={0} />);
    expect(await screen.findByRole("heading", { level: 2, name: "1 series" })).toBeInTheDocument();
    await userEvent.setup().type(screen.getByRole("searchbox", { name: "Search series" }), "zzz");
    expect(await screen.findByText("Nothing matches “zzz”.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "0 series" })).toBeInTheDocument();
  });
});
