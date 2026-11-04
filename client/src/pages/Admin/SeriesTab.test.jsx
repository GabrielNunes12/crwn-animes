import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SeriesTab } from "./SeriesTab.jsx";
import { mockFetch, renderApp } from "../../test/utils.jsx";

const SOURCE = "https://img.example/naruto.jpg";
const NEW_SOURCE = "https://covers.example/naruto-v2.png";
const NARUTO = {
  id: 3, slug: "naruto", name: "Naruto", synopsis: null, genres: [], aliases: [], videoCounts: { anime: 1, manga: 0 },
  coverUrl: "/api/covers/3.img?v=aaaa1111", coverSourceUrl: SOURCE,
};

function server() {
  const calls = [];
  mockFetch((url, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method ?? "GET", url, body });
    if (url.startsWith("/api/admin/series?") || url === "/api/admin/series") {
      if (init.method === "POST") return [201, { series: { ...body, id: 9, slug: "bleach", coverUrl: null, coverSourceUrl: null }, published: [] }];
      return [200, { items: [NARUTO], total: 1 }];
    }
    if (url === "/api/admin/series/3" && init.method === "PATCH") {
      return [200, { series: { ...NARUTO, ...body, coverUrl: "/api/covers/3.img?v=bbbb2222", coverSourceUrl: body.coverUrl }, published: [] }];
    }
    return [404, { error: { code: "NOT_FOUND" } }];
  });
  return calls;
}

/** No element anywhere may point the browser at the typed external address. */
const externalImages = () => [...document.querySelectorAll("img")].filter((img) => !img.getAttribute("src")?.startsWith("/"));

describe("admin series form — covers through our own server (v1.5)", () => {
  // "Edit" scrolls the form into view; jsdom has no layout.
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => {
    delete Element.prototype.scrollIntoView;
  });

  it("edits the source address (coverSourceUrl) and previews the proxied cover, never the typed URL", async () => {
    server();
    renderApp(<SeriesTab genres={[]} reloadSeries={() => {}} reloadKey={0} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const field = screen.getByRole("textbox", { name: "Cover image address" });
    expect(field).toHaveValue(SOURCE);
    expect(field).toHaveAccessibleDescription(/the browser never opens this address/);
    expect(screen.getByRole("img", { name: "Cover preview" })).toHaveAttribute("src", "/api/covers/3.img?v=aaaa1111");

    await user.clear(field);
    await user.type(field, NEW_SOURCE);
    expect(screen.queryByRole("img", { name: "Cover preview" })).toBeNull();
    expect(screen.getByText("The preview appears after you save.")).toBeInTheDocument();
    expect(externalImages()).toEqual([]);

    // Typing the saved address back shows the saved (proxied) cover again.
    await user.clear(field);
    await user.type(field, SOURCE);
    expect(screen.getByRole("img", { name: "Cover preview" })).toHaveAttribute("src", "/api/covers/3.img?v=aaaa1111");
  });

  it("sends the typed address as coverUrl and, once saved, shows the proxied cover from the response", async () => {
    const calls = server();
    renderApp(<SeriesTab genres={[]} reloadSeries={() => {}} reloadKey={0} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const field = screen.getByRole("textbox", { name: "Cover image address" });
    await user.clear(field);
    await user.type(field, NEW_SOURCE);
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByText("Saved Naruto.")).toBeInTheDocument());
    expect(calls.find((c) => c.method === "PATCH").body.coverUrl).toBe(NEW_SOURCE);
    expect(screen.getByRole("img", { name: "Saved cover of Naruto" })).toHaveAttribute("src", "/api/covers/3.img?v=bbbb2222");
    expect(externalImages()).toEqual([]);
  });

  it("a new series: no preview before saving, and the address is sent as coverUrl", async () => {
    const calls = server();
    renderApp(<SeriesTab genres={[]} reloadSeries={() => {}} reloadKey={0} />);
    const user = userEvent.setup();
    await screen.findByRole("button", { name: "Edit" });
    expect(screen.getByText("Preview appears here")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Bleach");
    await user.type(screen.getByRole("textbox", { name: "Cover image address" }), NEW_SOURCE);
    expect(screen.getByText("The preview appears after you save.")).toBeInTheDocument();
    expect(externalImages()).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Create series" }));
    await waitFor(() => expect(screen.getByText("Created Bleach.")).toBeInTheDocument());
    expect(calls.find((c) => c.method === "POST").body.coverUrl).toBe(NEW_SOURCE);
    // The server had no cover to show yet (coverUrl null): nothing to preview.
    expect(screen.queryByRole("img", { name: /Saved cover/ })).toBeNull();
  });
});
