import { describe, expect, it } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Component as Search } from "./Search.jsx";
import { jsonResponse, mockFetch, renderApp } from "../../test/utils.jsx";
import { resetGenresCache } from "../../hooks/useGenres.js";

const routes = [{ path: "/search", Component: Search }];

const item = (id, name, section = "anime") => ({
  id, slug: name.toLowerCase().replace(/\W+/g, "-"), name, section, synopsis: null, aliases: [], genres: [], coverUrl: null,
  videoCount: 1, route: `/${section}/${id}`, rating: { average: null, count: 0 }, latestPublishedAt: null,
});

function searchCalls(fetchFn) {
  return fetchFn.mock.calls.map(([u]) => new URL(String(u), "http://x")).filter((u) => u.pathname === "/api/search");
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

describe("Search page", () => {
  it("reads its state from the URL and writes filter changes back (back/forward works)", async () => {
    resetGenresCache();
    const fetchFn = mockFetch((url) => {
      if (url.startsWith("/api/genres")) return [200, ["Action", "Shonen"]];
      if (url.startsWith("/api/search")) return [200, { items: [item(1, "Naruto", "manga")], total: 1 }];
      return [404, {}];
    });
    const { router } = renderApp(null, { routes, path: "/search?q=naruto&section=manga&genre=Shonen&sort=top" });

    expect(await screen.findByRole("heading", { level: 1, name: "Results for “naruto”" })).toBeInTheDocument();
    expect(screen.getByLabelText("Name or alternative title")).toHaveValue("naruto");
    expect(within(screen.getByRole("group", { name: "Section" })).getByRole("radio", { name: "Manga" })).toBeChecked();
    await waitFor(() => expect(screen.getByLabelText("Genre")).toHaveValue("Shonen"));
    expect(screen.getByLabelText("Sort by")).toHaveValue("top");
    expect(await screen.findByText("1 result")).toBeInTheDocument();

    const first = searchCalls(fetchFn)[0];
    expect(Object.fromEntries(first.searchParams)).toEqual({ q: "naruto", section: "manga", genre: "Shonen", sort: "top", limit: "20", offset: "0" });

    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "Anime" }));
    await waitFor(() => expect(router.state.location.search).toContain("section=anime"));
    await waitFor(() => expect(searchCalls(fetchFn).at(-1).searchParams.get("section")).toBe("anime"));

    await user.selectOptions(screen.getByLabelText("Sort by"), "az");
    await waitFor(() => expect(new URLSearchParams(router.state.location.search).get("sort")).toBe("az"));

    // Back twice: sort, then section return to their earlier values.
    await act(() => router.navigate(-1));
    expect(screen.getByLabelText("Sort by")).toHaveValue("top");
    await act(() => router.navigate(-1));
    expect(screen.getByRole("radio", { name: "Manga" })).toBeChecked();
    await waitFor(() => expect(searchCalls(fetchFn).at(-1).searchParams.get("section")).toBe("manga"));
  });

  it("debounces typing into ?q= and syncs the box on back/forward", async () => {
    resetGenresCache();
    mockFetch((url) => (url.startsWith("/api/genres") ? [200, []] : [200, { items: [], total: 0 }]));
    const { router } = renderApp(null, { routes, path: "/search" });
    const user = userEvent.setup();
    const box = screen.getByLabelText("Name or alternative title");
    await user.type(box, "one piece");
    // Nothing is committed while typing…
    expect(router.state.location.search).toBe("");
    // …then once, after the pause.
    await waitFor(() => expect(new URLSearchParams(router.state.location.search).get("q")).toBe("one piece"));
    expect(screen.getByLabelText("Sort by")).toHaveValue("relevance");

    await act(() => router.navigate(-1));
    expect(router.state.location.search).toBe("");
    expect(box).toHaveValue("");
    expect(screen.getByLabelText("Sort by")).toHaveValue("az");
    expect(screen.queryByRole("option", { name: "Relevance" })).not.toBeInTheDocument();
  });

  it("never lets an older, slower response overwrite newer results", async () => {
    resetGenresCache();
    const slow = deferred();
    const fetchFn = mockFetch((url) => {
      if (url.startsWith("/api/genres")) return [200, []];
      const q = new URL(url, "http://x").searchParams.get("q");
      if (q === "a") return slow.promise;
      if (q === "ab") return [200, { items: [item(2, "AB Newer")], total: 1 }];
      return [200, { items: [], total: 0 }];
    });
    const { router } = renderApp(null, { routes, path: "/search" });
    await act(() => router.navigate("/search?q=a"));
    await waitFor(() => expect(searchCalls(fetchFn).some((u) => u.searchParams.get("q") === "a")).toBe(true));
    const aborted = fetchFn.mock.calls.find(([u]) => String(u).includes("q=a&"))[1].signal;

    await act(() => router.navigate("/search?q=ab"));
    expect(await screen.findByRole("heading", { level: 3, name: "AB Newer" })).toBeInTheDocument();
    expect(aborted.aborted).toBe(true);

    await act(async () => slow.resolve(jsonResponse(200, { items: [item(1, "A Older")], total: 1 })));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("A Older")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "AB Newer" })).toBeInTheDocument();
  });

  it("“Load more” appends the next page, announces it and moves focus when done", async () => {
    resetGenresCache();
    const all = Array.from({ length: 25 }, (_, i) => item(i + 1, `Show ${String(i + 1).padStart(2, "0")}`));
    const fetchFn = mockFetch((url) => {
      if (url.startsWith("/api/genres")) return [200, []];
      const p = new URL(url, "http://x").searchParams;
      const offset = Number(p.get("offset"));
      return [200, { items: all.slice(offset, offset + Number(p.get("limit"))), total: all.length }];
    });
    renderApp(null, { routes, path: "/search" });

    expect(await screen.findByText("25 results")).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(20);
    expect(screen.getByText("Showing 20 of 25")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(25));
    expect(screen.getByText("5 more results loaded. Showing 25 of 25.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
    expect(searchCalls(fetchFn).at(-1).searchParams.get("offset")).toBe("20");
    // Order is kept: the first page, then the second.
    const names = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(names[19]).toBe("Show 20");
    expect(names[20]).toBe("Show 21");
    expect(document.activeElement).toBe(screen.getByRole("link", { name: /Show 21/ }));
  });

  it("shows an empty state with a way to clear the filters", async () => {
    resetGenresCache();
    mockFetch((url) => (url.startsWith("/api/genres") ? [200, []] : [200, { items: [], total: 0 }]));
    renderApp(null, { routes, path: "/search?q=zzz&section=anime" });
    expect(await screen.findByText(/Nothing found/)).toBeInTheDocument();
    expect(screen.getByText("0 results")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Clear filters" })).toHaveAttribute("href", "/search");
  });
});
