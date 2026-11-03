import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Component as Genre } from "./Genre.jsx";
import { mockFetch, renderApp } from "../../test/utils.jsx";
import { resetGenresCache } from "../../hooks/useGenres.js";

const item = (id, name, section, rating) => ({
  id, slug: name.toLowerCase(), name, section, synopsis: null, aliases: [], genres: ["Shonen"], coverUrl: null,
  videoCount: 2, route: `/${section}/${name.toLowerCase()}`, rating: { average: rating, count: 3 }, latestPublishedAt: null,
});
const SERIES = [item(1, "Bleach", "anime", 3.1), item(2, "Naruto", "manga", 4.8), item(3, "Zatch", "anime", 4.2)];

describe("Genre page", () => {
  it("lists both sections for the genre, sorts via the URL and sets title + description", async () => {
    resetGenresCache();
    const fetchFn = mockFetch((url) => {
      if (url.startsWith("/api/genres")) return [200, ["Drama", "Shonen"]];
      const p = new URL(url, "http://x").searchParams;
      const items = [...SERIES];
      if (p.get("sort") === "top") items.sort((a, b) => b.rating.average - a.rating.average);
      return [200, { items, total: items.length }];
    });
    const { router } = renderApp(null, { routes: [{ path: "/genre/:genre", Component: Genre }], path: "/genre/shonen" });

    // The catalogue's spelling wins over the URL's.
    expect(await screen.findByRole("heading", { level: 1, name: "Shonen" })).toBeInTheDocument();
    const names = () => screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    await waitFor(() => expect(names()).toEqual(["Bleach", "Naruto", "Zatch"]));
    expect(screen.getByText("3 results")).toBeInTheDocument();
    // Both sections are shown, each card labelled with its section.
    expect(screen.getByRole("link", { name: /Naruto/ })).toHaveTextContent("Manga");
    expect(screen.getByRole("link", { name: /Bleach/ })).toHaveTextContent("Anime");

    const first = fetchFn.mock.calls.map(([u]) => new URL(u, "http://x")).find((u) => u.pathname === "/api/search");
    expect(first.pathname).toBe("/api/search");
    expect(first.searchParams.get("genre")).toBe("shonen");
    expect(first.searchParams.get("sort")).toBe("az");
    expect(first.searchParams.has("section")).toBe(false);

    await waitFor(() => expect(document.title).toBe("Shonen · Anime & manga · Crwn Animes"));
    expect(document.querySelector('meta[name="description"]').getAttribute("content")).toBe(
      "Shonen anime and manga series on Crwn Animes. Sort by rating, newest or A–Z.",
    );

    await userEvent.setup().selectOptions(screen.getByLabelText("Sort by"), "top");
    await waitFor(() => expect(router.state.location.search).toBe("?sort=top"));
    await waitFor(() => expect(names()).toEqual(["Naruto", "Zatch", "Bleach"]));
    expect(new URL(fetchFn.mock.calls.at(-1)[0], "http://x").searchParams.get("sort")).toBe("top");
  });

  it("has an empty state for a genre without series", async () => {
    resetGenresCache();
    mockFetch((url) => (url.startsWith("/api/genres") ? [200, []] : [200, { items: [], total: 0 }]));
    renderApp(null, { routes: [{ path: "/genre/:genre", Component: Genre }], path: "/genre/Isekai" });
    expect(await screen.findByText("No Isekai series yet.")).toBeInTheDocument();
  });
});
