import { describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Layout } from "../Layout/Layout.jsx";
import { mockFetch, renderApp } from "../../test/utils.jsx";
import { SINGLE_KEY_SHORTCUTS_KEY } from "../../lib/prefs.js";

const item = (id, name, section = "anime") => ({
  id, slug: name.toLowerCase(), name, section, synopsis: null, aliases: [], genres: [], coverUrl: null,
  videoCount: 3, route: `/${section}/${name.toLowerCase()}`, rating: { average: null, count: 0 }, latestPublishedAt: null,
});

const routes = [
  {
    path: "/",
    Component: Layout,
    children: [
      { index: true, element: <h1>Home page</h1> },
      { path: "anime/:slug", element: <h1>Anime series page</h1> },
      { path: "manga/:slug", element: <h1>Manga series page</h1> },
      { path: "search", element: <h1>Search page</h1> },
    ],
  },
];

function setup() {
  const fetchFn = mockFetch((url) => {
    const u = new URL(url, "http://x");
    if (u.pathname === "/api/search") {
      const q = u.searchParams.get("q") ?? "";
      const all = [item(1, "Naruto"), item(1, "Naruto", "manga"), item(2, "Narutaru")];
      const items = all.filter((s) => s.name.toLowerCase().includes(q.toLowerCase()));
      return [200, { items, total: items.length }];
    }
    return [404, { error: { code: "NOT_FOUND" } }];
  });
  const utils = renderApp(null, { routes, path: "/" });
  return { ...utils, fetchFn, user: userEvent.setup() };
}

const palette = () => screen.getByRole("combobox", { name: "Search anime and manga", hidden: true });
const paletteOptions = () => within(screen.getByRole("listbox", { name: "Suggestions" })).getAllByRole("option");
const dialogOpen = () => palette().closest("dialog").hasAttribute("open");

async function typeAndWait(user, text) {
  await user.type(palette(), text);
  await waitFor(() => expect(paletteOptions()).toHaveLength(4));
}

describe("Command palette (⌘K / Ctrl+K)", () => {
  it("opens with Ctrl+K and ⌘K — even while typing in a field — but not over another dialog", async () => {
    setup();
    await screen.findByRole("heading", { name: "Home page" });
    expect(dialogOpen()).toBe(false);

    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    expect(dialogOpen()).toBe(true);
    expect(palette()).toHaveFocus();
    fireEvent.keyDown(palette(), { key: "Escape" });
    expect(dialogOpen()).toBe(false);

    // ⌘K from inside the header search box (a text field) still works.
    const headerSearch = screen.getByLabelText("Search series");
    headerSearch.focus();
    fireEvent.keyDown(headerSearch, { key: "K", metaKey: true });
    expect(dialogOpen()).toBe(true);
    fireEvent.keyDown(palette(), { key: "Escape" });
    expect(headerSearch).toHaveFocus();
  });

  it("is a modifier shortcut: the single-key switch does not turn it off", async () => {
    localStorage.setItem(SINGLE_KEY_SHORTCUTS_KEY, "0");
    setup();
    await screen.findByRole("heading", { name: "Home page" });
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    expect(dialogOpen()).toBe(true);
  });

  it("supports ArrowUp/Down, Home/End with aria-activedescendant, and Enter navigates to the series", async () => {
    const { user, router, fetchFn } = setup();
    await user.click(await screen.findByRole("button", { name: "Quick search" }));
    const input = palette();
    expect(input).toHaveAttribute("aria-expanded", "false");
    await typeAndWait(user, "naru");

    expect(input).toHaveAttribute("aria-expanded", "true");
    const listbox = screen.getByRole("listbox", { name: "Suggestions" });
    expect(input).toHaveAttribute("aria-controls", listbox.id);
    const options = paletteOptions();
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining("Naruto"),
      expect.stringContaining("Naruto"),
      expect.stringContaining("Narutaru"),
      "↵See all results for “naru”",
    ]);
    const active = () => document.getElementById(input.getAttribute("aria-activedescendant"));
    expect(active()).toBe(options[0]);
    expect(options[0]).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{ArrowDown}");
    expect(active()).toBe(options[1]);
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    expect(options[0]).toHaveAttribute("aria-selected", "false");
    await user.keyboard("{End}");
    expect(active()).toBe(options[3]);
    await user.keyboard("{ArrowDown}");
    expect(active()).toBe(options[0]);
    await user.keyboard("{ArrowUp}");
    expect(active()).toBe(options[3]);
    await user.keyboard("{Home}{ArrowDown}");
    expect(active()).toBe(options[1]);

    const call = fetchFn.mock.calls.map(([u]) => new URL(u, "http://x")).find((u) => u.pathname === "/api/search");
    expect(call.searchParams.get("limit")).toBe("8");

    await user.keyboard("{Enter}");
    expect(await screen.findByRole("heading", { name: "Manga series page" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/manga/naruto");
    expect(dialogOpen()).toBe(false);
  });

  it("the last option goes to /search with the query", async () => {
    const { user, router } = setup();
    await user.click(await screen.findByRole("button", { name: "Quick search" }));
    await typeAndWait(user, "naru");
    await user.keyboard("{End}{Enter}");
    expect(await screen.findByRole("heading", { name: "Search page" })).toBeInTheDocument();
    expect(router.state.location.search).toBe("?q=naru");
  });

  it("Escape closes it and returns focus to the trigger", async () => {
    const { user } = setup();
    const trigger = await screen.findByRole("button", { name: "Quick search" });
    await user.click(trigger);
    expect(dialogOpen()).toBe(true);
    expect(palette()).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(dialogOpen()).toBe(false);
    expect(trigger).toHaveFocus();
  });

  it("is listed in the keyboard shortcuts dialog", async () => {
    setup();
    await screen.findByRole("heading", { name: "Home page" });
    act(() => {
      fireEvent.keyDown(window, { key: "?" });
    });
    expect(screen.getByText("Quick search (works even while typing)")).toBeInTheDocument();
    expect(screen.getByText("Ctrl + K")).toBeInTheDocument();
  });
});

describe("Command palette — a late native `close` event (Esc, then Ctrl+K at once)", () => {
  /**
   * jsdom's <dialog> has no behaviour (the component falls back to the `open` attribute), so this
   * gives it the browser's: showModal() opens it, and close() fires `close` in a LATER task.
   */
  function browserLikeDialog() {
    const proto = HTMLDialogElement.prototype;
    const saved = { showModal: Object.getOwnPropertyDescriptor(proto, "showModal"), close: Object.getOwnPropertyDescriptor(proto, "close") };
    const queued = [];
    proto.showModal = function showModal() {
      this.setAttribute("open", "");
    };
    proto.close = function close() {
      if (!this.hasAttribute("open")) return;
      this.removeAttribute("open");
      queued.push(this); // the browser's "queue an element task … fire close"
    };
    const restore = () => {
      for (const [name, d] of Object.entries(saved)) {
        if (d) Object.defineProperty(proto, name, d);
        else delete proto[name];
      }
    };
    // Runs the queued task(s): what the browser does once the current task is over.
    const runQueuedCloseEvents = () => act(() => queued.splice(0).forEach((d) => d.dispatchEvent(new Event("close"))));
    return { restore, runQueuedCloseEvents };
  }

  it("the reopened palette stays open, and focus still returns to the trigger when it finally closes", async () => {
    const dialog = browserLikeDialog();
    try {
      const { user } = setup();
      await screen.findByRole("heading", { name: "Home page" });
      const trigger = screen.getByRole("button", { name: /Quick search/ });
      trigger.focus();

      fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
      expect(dialogOpen()).toBe(true);
      expect(palette()).toHaveFocus();

      // Esc and Ctrl+K in the same task: the `close` event queued by Esc's close() has not run yet.
      fireEvent.keyDown(palette(), { key: "Escape" });
      expect(dialogOpen()).toBe(false);
      fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
      expect(dialogOpen()).toBe(true);

      // Now the late `close` event from the first Esc arrives: it must not close the new palette.
      dialog.runQueuedCloseEvents();
      expect(dialogOpen()).toBe(true);
      expect(palette()).toHaveFocus();
      // …and the palette still works.
      await typeAndWait(user, "naru");

      // A normal close afterwards: its own late event changes nothing, and focus goes back.
      fireEvent.keyDown(palette(), { key: "Escape" });
      dialog.runQueuedCloseEvents();
      expect(dialogOpen()).toBe(false);
      expect(trigger).toHaveFocus();
      expect(palette()).toHaveValue("");
    } finally {
      dialog.restore();
    }
  });

  it("a close the browser starts on its own (no Esc key from us) still closes it and returns focus", async () => {
    const dialog = browserLikeDialog();
    try {
      setup();
      await screen.findByRole("heading", { name: "Home page" });
      const trigger = screen.getByRole("button", { name: /Quick search/ });
      trigger.focus();
      fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
      expect(dialogOpen()).toBe(true);
      // e.g. a close request handled natively: the dialog closes, then `close` fires.
      act(() => palette().closest("dialog").close());
      dialog.runQueuedCloseEvents();
      expect(dialogOpen()).toBe(false);
      expect(trigger).toHaveFocus();
      // It can be opened again.
      fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
      expect(dialogOpen()).toBe(true);
    } finally {
      dialog.restore();
    }
  });
});
