import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Component as SeriesBoard } from "./SeriesBoard.jsx";
import { mockFetch, renderApp } from "../../test/utils.jsx";
import { routes as appRoutes } from "../../router.jsx";
import { RequireAdmin } from "../../auth/guards.jsx";

const SERIES = { id: 1, slug: "op", name: "One Piece", synopsis: null, aliases: [], genres: [], coverUrl: null, videoCounts: { anime: 8, manga: 0 } };

const ep = (id, number, season = 1) => ({
  id, youtubeVideoId: `yt${id}`.padEnd(11, "x"), title: `Title ${id}`, channel: null, thumbnailUrl: "", section: "anime",
  seriesId: 1, seriesSlug: "op", seriesName: "One Piece", season, number, status: "published", availability: "ok",
  route: season > 1 ? `/anime/op/season/${season}/episode/${number}` : `/anime/op/episode/${number}`, rating: { average: null, count: 0 },
});

/** In-memory admin API: one series; season 1 has episodes 1..6 (ids 1..6), season 2 has ids 7..8. */
function server({ empty = false } = {}) {
  const db = { videos: empty ? [] : [...[1, 2, 3, 4, 5, 6].map((n) => ep(n, n)), ep(7, 1, 2), ep(8, 2, 2)], puts: [], failNextPut: false };
  const fetchFn = mockFetch((url, init) => {
    if (url === "/api/admin/series/1" && (init.method ?? "GET") === "GET") {
      const seasons = [...new Set(db.videos.map((v) => v.season))].sort();
      return [
        200,
        {
          series: { ...SERIES, videoCounts: { anime: db.videos.length, manga: 0 } },
          sections: { anime: { seasons, videos: db.videos }, manga: { seasons: [], videos: [] } },
        },
      ];
    }
    if (url === "/api/admin/series/1/order" && init.method === "PUT") {
      const body = JSON.parse(init.body);
      db.puts.push(body);
      if (db.failNextPut) {
        db.failNextPut = false;
        return [400, { error: { code: "VALIDATION_ERROR", message: "videoIds must be exactly the published videos", details: {} } }];
      }
      const current = db.videos.filter((v) => v.season === body.season).map((v) => v.id);
      if (JSON.stringify(body.expected) !== JSON.stringify(current)) {
        return [409, { error: { code: "CONFLICT", message: "The order changed.", details: { current } } }];
      }
      const updated = body.videoIds.map((id, i) => {
        const v = db.videos.find((x) => x.id === id);
        return { ...v, number: i + 1, route: `/anime/op/episode/${i + 1}` };
      });
      db.videos = db.videos.map((v) => updated.find((u) => u.id === v.id) ?? v).sort((a, b) => a.season - b.season || a.number - b.number);
      return [200, { videos: updated }];
    }
    return [404, { error: { code: "NOT_FOUND" } }];
  });
  return { db, fetchFn };
}

const routes = [
  { path: "/admin/series/:id", Component: SeriesBoard },
  { path: "/admin/preview/:id", element: <p>preview page</p> },
  { path: "/admin", element: <p>admin page</p> },
];

/** Row ids in the order they are shown. */
const shownIds = () => [...document.querySelectorAll("li[data-id]")].map((li) => Number(li.dataset.id));
const rowOf = (label) => screen.getByRole("listitem", { name: new RegExp(`^${label}(?!\\d)`) });
const announcer = () => screen.getByTestId("board-announcer");

async function openBoard(opts = {}) {
  const user = userEvent.setup();
  const utils = renderApp(null, { routes, path: "/admin/series/1", ...opts });
  await waitFor(() => expect(shownIds()).toEqual([1, 2, 3, 4, 5, 6]));
  return { user, ...utils };
}

describe("admin series board — layout", () => {
  it("shows the series, a link to its public page, the sections that have videos and the season tabs", async () => {
    server();
    await openBoard();
    expect(screen.getByRole("heading", { level: 1, name: "One Piece" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /View public page/ })).toHaveAttribute("href", "/anime/op");
    expect(screen.getByRole("button", { name: "Anime" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Manga" })).toBeDisabled();
    expect(screen.getByRole("tab", { name: "Season 1" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { level: 2, name: "Season 1 · 6 episodes" })).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole("tab", { name: "Season 2" }));
    await waitFor(() => expect(shownIds()).toEqual([7, 8]));
    const row = rowOf("Episode 1");
    expect(within(row).getByRole("link", { name: "Preview" })).toHaveAttribute("href", "/admin/preview/7");
  });

  it("disables both sections with a hint when the series has no published videos", async () => {
    server({ empty: true });
    renderApp(null, { routes, path: "/admin/series/1" });
    expect(await screen.findByText(/This series has no published episodes or chapters yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Anime" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Manga" })).toBeDisabled();
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("loads everything from GET /api/admin/series/:id (no public catalog request)", async () => {
    const { fetchFn } = server();
    await openBoard();
    expect(fetchFn.mock.calls.map(([u]) => u)).toEqual(["/api/admin/series/1"]);
  });

  it("shows a 'not found or in the trash' state with a link back to the Series tab", async () => {
    mockFetch(() => [404, { error: { code: "NOT_FOUND" } }]);
    renderApp(null, { routes, path: "/admin/series/42", locale: "pt-BR" });
    expect(await screen.findByRole("heading", { level: 1, name: "Série não encontrada ou na lixeira" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Voltar para Séries" })).toHaveAttribute("href", "/admin?tab=series");
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("is admin-only, lazy, and marked noindex", async () => {
    const admin = appRoutes[0].children[0].children.find((r) => r.path === "admin");
    expect(admin.Component).toBe(RequireAdmin);
    expect(admin.children.map((r) => r.path)).toEqual(expect.arrayContaining(["series/:id", "preview/:id"]));
    expect(admin.children.filter((r) => r.path).every((r) => typeof r.lazy === "function")).toBe(true);

    server();
    await openBoard();
    expect(document.head.querySelector('meta[name="robots"]')).toHaveAttribute("content", "noindex");
  });
});

describe("admin series board — keyboard reordering", () => {
  it("moves with the Move up / Move down buttons, keeps focus on the button and announces (pt-BR copy)", async () => {
    server();
    const { user } = await openBoard({ locale: "pt-BR" });
    const up = within(rowOf("Episódio 3")).getByRole("button", { name: "Mover para cima" });
    await user.click(up);
    expect(shownIds()).toEqual([1, 3, 2, 4, 5, 6]);
    expect(announcer()).toHaveTextContent("Episódio 3 movido para a posição 2 de 6");
    await waitFor(() => expect(within(rowOf("Episódio 3")).getByRole("button", { name: "Mover para cima" })).toHaveFocus());

    await user.click(within(rowOf("Episódio 1")).getByRole("button", { name: "Mover para baixo" }));
    expect(shownIds()).toEqual([3, 1, 2, 4, 5, 6]);
    expect(announcer()).toHaveTextContent("Episódio 1 movido para a posição 2 de 6");

    // At the edges the buttons are aria-disabled and do nothing.
    const top = within(rowOf("Episódio 3")).getByRole("button", { name: "Mover para cima" });
    expect(top).toHaveAttribute("aria-disabled", "true");
    await user.click(top);
    expect(shownIds()).toEqual([3, 1, 2, 4, 5, 6]);
    expect(screen.getByText("Ordem alterada e ainda não salva.")).toBeInTheDocument();
  });

  it("moves the focused row with Alt+ArrowUp / Alt+ArrowDown and keeps focus on it", async () => {
    server();
    const { user } = await openBoard();
    rowOf("Episode 5").focus();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(shownIds()).toEqual([1, 2, 3, 4, 6, 5]);
    expect(announcer()).toHaveTextContent("Episode 5 moved to position 6 of 6");
    await waitFor(() => expect(rowOf("Episode 5")).toHaveFocus());

    await user.keyboard("{Alt>}{ArrowUp}{ArrowUp}{ArrowUp}{/Alt}");
    expect(shownIds()).toEqual([1, 2, 5, 3, 4, 6]);
    expect(announcer()).toHaveTextContent("Episode 5 moved to position 3 of 6");
    expect(rowOf("Episode 5")).toHaveFocus();

    // Plain arrows (no Alt) don't reorder.
    await user.keyboard("{ArrowUp}");
    expect(shownIds()).toEqual([1, 2, 5, 3, 4, 6]);
  });

  it("Save order sends exactly the shown video ids, then shows the new numbers", async () => {
    const { db } = server();
    const { user } = await openBoard();
    const save = screen.getByRole("button", { name: "Save order" });
    expect(save).toHaveAttribute("aria-disabled", "true");

    await user.click(within(rowOf("Episode 6")).getByRole("button", { name: "Move up" }));
    rowOf("Episode 1").focus();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(shownIds()).toEqual([2, 1, 3, 4, 6, 5]);
    expect(save).not.toHaveAttribute("aria-disabled");

    await user.click(save);
    expect(await screen.findByText("Order saved: numbered 1 to 6.")).toBeInTheDocument();
    expect(db.puts).toEqual([{ section: "anime", season: 1, videoIds: [2, 1, 3, 4, 6, 5], expected: [1, 2, 3, 4, 5, 6] }]);
    // Renumbered from the server's answer; the order stays and nothing is dirty any more.
    expect(shownIds()).toEqual([2, 1, 3, 4, 6, 5]);
    expect(rowOf("Episode 1")).toHaveAttribute("data-id", "2");
    expect(screen.getByRole("button", { name: "Save order" })).toHaveAttribute("aria-disabled", "true");
  });

  it("a 400 on save reloads the board, keeps the local order (new videos at the end) and lets you save again", async () => {
    const { db, fetchFn } = server();
    const { user } = await openBoard();
    await user.click(within(rowOf("Episode 3")).getByRole("button", { name: "Move up" }));
    expect(shownIds()).toEqual([1, 3, 2, 4, 5, 6]);
    // Meanwhile another admin published episode 7 of season 1 and our save is rejected.
    db.videos = [...db.videos.filter((v) => v.season === 1), ep(9, 7), ...db.videos.filter((v) => v.season === 2)];
    db.failNextPut = true;
    await user.click(screen.getByRole("button", { name: "Save order" }));
    expect(await screen.findByText(/The list changed since you opened it/)).toBeInTheDocument();
    await waitFor(() => expect(shownIds()).toEqual([1, 3, 2, 4, 5, 6, 9]));
    expect(fetchFn.mock.calls.filter(([u, i]) => u === "/api/admin/series/1" && i.method === "GET")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Save order" })).not.toHaveAttribute("aria-disabled");

    await user.click(screen.getByRole("button", { name: "Save order" }));
    expect(await screen.findByText("Order saved: numbered 1 to 7.")).toBeInTheDocument();
    expect(db.puts.map((b) => b.videoIds)).toEqual([
      [1, 3, 2, 4, 5, 6],
      [1, 3, 2, 4, 5, 6, 9],
    ]);
  });

  it("a 409 (another admin saved a different order) reloads, keeps the local order and says why", async () => {
    const { db } = server();
    const { user } = await openBoard({ locale: "pt-BR" });
    await user.click(within(rowOf("Episódio 1")).getByRole("button", { name: "Mover para baixo" }));
    expect(shownIds()).toEqual([2, 1, 3, 4, 5, 6]);
    // Another admin saved [6, 5, 4, 3, 2, 1] in the meantime.
    db.videos = [...[6, 5, 4, 3, 2, 1].map((id, i) => ({ ...ep(id, i + 1) })), ...db.videos.filter((v) => v.season === 2)];
    await user.click(screen.getByRole("button", { name: "Salvar ordem" }));
    expect(await screen.findByText("Outro administrador salvou uma ordem diferente — confira e salve de novo.")).toBeInTheDocument();
    expect(db.puts[0].expected).toEqual([1, 2, 3, 4, 5, 6]);
    // Reloaded: still our order (it differs from the new server order), so it stays unsaved.
    await waitFor(() => expect(screen.getByRole("button", { name: "Salvar ordem" })).not.toHaveAttribute("aria-disabled"));
    expect(shownIds()).toEqual([2, 1, 3, 4, 5, 6]);
    await user.click(screen.getByRole("button", { name: "Salvar ordem" }));
    expect(await screen.findByText("Ordem salva: numerados de 1 a 6.")).toBeInTheDocument();
    expect(db.puts[1]).toEqual({ section: "anime", season: 1, videoIds: [2, 1, 3, 4, 5, 6], expected: [6, 5, 4, 3, 2, 1] });
  });

  it("Discard puts the saved order back", async () => {
    const { fetchFn } = server();
    const { user } = await openBoard();
    await user.click(within(rowOf("Episode 2")).getByRole("button", { name: "Move down" }));
    await user.click(within(rowOf("Episode 5")).getByRole("button", { name: "Move up" }));
    expect(shownIds()).toEqual([1, 3, 2, 5, 4, 6]);

    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(shownIds()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(screen.getByRole("status")).toHaveTextContent("Changes discarded.");
    expect(screen.getByRole("button", { name: "Save order" })).toHaveAttribute("aria-disabled", "true");
    expect(fetchFn.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  });

  it("keeps an unsaved order per season and marks the season tab", async () => {
    server();
    const { user } = await openBoard();
    await user.click(within(rowOf("Episode 2")).getByRole("button", { name: "Move up" }));
    expect(screen.getByRole("tab", { name: /^Season 1\s?\(unsaved changes\)$/ })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Season 2" }));
    await waitFor(() => expect(shownIds()).toEqual([7, 8]));
    expect(screen.getByRole("button", { name: "Save order" })).toHaveAttribute("aria-disabled", "true");
    await user.click(screen.getByRole("tab", { name: /Season 1/ }));
    expect(shownIds()).toEqual([2, 1, 3, 4, 5, 6]);
  });

  it("asks before leaving the board with an unsaved order", async () => {
    server();
    const { user, router } = await openBoard();
    await user.click(within(rowOf("Episode 2")).getByRole("button", { name: "Move up" }));
    await user.click(within(rowOf("Episode 4")).getByRole("link", { name: "Preview" }));
    const dialog = await screen.findByRole("dialog", { name: "Leave without saving the order?" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(router.state.location.pathname).toBe("/admin/series/1");
    expect(shownIds()).toEqual([2, 1, 3, 4, 5, 6]);

    await user.click(within(rowOf("Episode 4")).getByRole("link", { name: "Preview" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Leave without saving the order?" })).getByRole("button", { name: "Leave without saving" }));
    expect(await screen.findByText("preview page")).toBeInTheDocument();
  });
});

describe("admin series board — pointer drag-and-drop", () => {
  /** Rows are 60px tall, stacked from y=200, in DOM order. */
  function layoutRows() {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
      const i = this.matches("li[data-id]") ? [...this.parentElement.children].indexOf(this) : -1;
      const top = i < 0 ? 0 : 200 + i * 60;
      const height = i < 0 ? 0 : 60;
      return { top, bottom: top + height, height, left: 0, right: 600, width: 600, x: 0, y: top, toJSON() {} };
    });
  }
  const handleOf = (label) => rowOf(label).querySelector(".handle");

  it("drags a row by its handle to a new position and announces it on drop", async () => {
    server();
    await openBoard();
    layoutRows();
    fireEvent.pointerDown(handleOf("Episode 1"), { pointerId: 1, button: 0, clientY: 230 });
    expect(rowOf("Episode 1")).toHaveAttribute("data-dragging", "true");
    // Past the middles of rows 2, 3 and 4 (290, 350, 410).
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 420 });
    expect(shownIds()).toEqual([2, 3, 4, 1, 5, 6]);
    // Back up past row 4's new middle (350): one step back.
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 340 });
    expect(shownIds()).toEqual([2, 3, 1, 4, 5, 6]);
    expect(announcer().textContent).toBe(""); // nothing announced mid-drag
    fireEvent.pointerUp(window, { pointerId: 1, clientY: 340 });
    expect(announcer()).toHaveTextContent("Episode 1 moved to position 3 of 6");
    expect(rowOf("Episode 1")).not.toHaveAttribute("data-dragging");
    await waitFor(() => expect(rowOf("Episode 1")).toHaveFocus());
    expect(screen.getByRole("button", { name: "Save order" })).not.toHaveAttribute("aria-disabled");
  });

  it("Escape (or a cancelled pointer) puts the row back", async () => {
    server();
    await openBoard();
    layoutRows();
    fireEvent.pointerDown(handleOf("Episode 2"), { pointerId: 7, button: 0, clientY: 290 });
    fireEvent.pointerMove(window, { pointerId: 7, clientY: 540 });
    expect(shownIds()).toEqual([1, 3, 4, 5, 6, 2]);
    // Another pointer is ignored.
    fireEvent.pointerUp(window, { pointerId: 8, clientY: 540 });
    expect(rowOf("Episode 2")).toHaveAttribute("data-dragging", "true");
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(shownIds()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(announcer()).toHaveTextContent("Move cancelled. Episode 2 is back at position 2 of 6");

    fireEvent.pointerDown(handleOf("Episode 6"), { pointerId: 9, button: 0, clientY: 530 });
    fireEvent.pointerMove(window, { pointerId: 9, clientY: 210 });
    expect(shownIds()).toEqual([6, 1, 2, 3, 4, 5]);
    fireEvent.pointerCancel(window, { pointerId: 9 });
    expect(shownIds()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(screen.getByRole("button", { name: "Save order" })).toHaveAttribute("aria-disabled", "true");
  });

  it("only the primary button starts a drag", async () => {
    server();
    await openBoard();
    layoutRows();
    fireEvent.pointerDown(handleOf("Episode 1"), { pointerId: 1, button: 2, clientY: 230 });
    fireEvent.pointerMove(window, { pointerId: 1, clientY: 420 });
    expect(shownIds()).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
