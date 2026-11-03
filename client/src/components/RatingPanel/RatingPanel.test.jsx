import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RatingPanel } from "./RatingPanel.jsx";
import { mockFetch, renderApp } from "../../test/utils.jsx";

const USER = { id: 7, email: "a@b.co", displayName: "Ana", role: "user", createdAt: "2026-01-01" };

function summary(overrides = {}) {
  return {
    average: 4,
    count: 2,
    distribution: { 1: 0, 2: 0, 3: 1, 4: 0, 5: 1 },
    reactions: { fire: 1, laugh: 0, cry: 0, wow: 0, love: 0 },
    mine: null,
    ...overrides,
  };
}

describe("RatingPanel", () => {
  it("shows a 'Log in to rate' link and the summary when logged out", async () => {
    mockFetch(() => [200, summary()]);
    renderApp(<RatingPanel videoId={42} />, { path: "/anime/x/episode/1" });
    const link = await screen.findByRole("link", { name: "Log in to rate" });
    expect(link).toHaveAttribute("href", "/login?next=%2Fanime%2Fx%2Fepisode%2F1");
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.getByText("2 ratings")).toBeInTheDocument();
  });

  it("PUTs the score, then the reaction, with credentials", async () => {
    const user = userEvent.setup();
    const fetch = mockFetch((url, init) => {
      if (init.method === "PUT") {
        const body = JSON.parse(init.body);
        return [200, summary({ average: 4, count: 3, mine: { score: body.score, reaction: body.reaction } })];
      }
      return [200, summary()];
    });
    renderApp(<RatingPanel videoId={42} />, { user: USER });

    await user.click(await screen.findByRole("radio", { name: "4 stars" }));
    await waitFor(() => expect(screen.getByRole("status", { name: "" })).toHaveTextContent("Rating saved."));

    const put = fetch.mock.calls.find(([, init]) => init.method === "PUT");
    expect(put[0]).toBe("/api/videos/42/rating");
    expect(put[1].credentials).toBe("include");
    expect(put[1].headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(put[1].body)).toEqual({ score: 4, reaction: null });
    expect(screen.getByRole("radio", { name: "4 stars" })).toBeChecked();

    const reactions = screen.getByRole("group", { name: "Reactions" });
    await user.click(within(reactions).getByRole("button", { name: /Fire/ }));
    await waitFor(() => {
      const puts = fetch.mock.calls.filter(([, init]) => init.method === "PUT");
      expect(JSON.parse(puts.at(-1)[1].body)).toEqual({ score: 4, reaction: "fire" });
    });
    await waitFor(() => expect(within(reactions).getByRole("button", { name: /Fire/ })).toHaveAttribute("aria-pressed", "true"));
  });

  it("updates optimistically and rolls back when the save fails", async () => {
    const user = userEvent.setup();
    let reject;
    mockFetch((url, init) => {
      if (init.method === "PUT") return new Promise((resolve) => (reject = () => resolve([500, { error: { code: "INTERNAL_ERROR", message: "Boom" } }])));
      return [200, summary()];
    });
    renderApp(<RatingPanel videoId={9} />, { user: USER });

    await user.click(await screen.findByRole("radio", { name: "1 star" }));
    // Optimistic: (3 + 5 + 1) / 3 = 3
    expect(screen.getByText("3 ratings")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "1 star" })).toBeChecked();

    reject();
    await waitFor(() => expect(screen.getByText(/Couldn't save your rating: Something went wrong on our side/)).toBeInTheDocument());
    expect(screen.queryByText(/Boom/)).not.toBeInTheDocument();
    expect(screen.getByText("2 ratings")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "1 star" })).not.toBeChecked();
  });

  it("keyboard: arrow keys update the stars at once but send a single PUT after a pause", async () => {
    const user = userEvent.setup();
    const fetch = mockFetch((url, init) => {
      if (init.method === "PUT") {
        const body = JSON.parse(init.body);
        return [200, summary({ count: 3, mine: { score: body.score, reaction: body.reaction } })];
      }
      return [200, summary()];
    });
    renderApp(<RatingPanel videoId={5} />, { user: USER });
    const first = await screen.findByRole("radio", { name: "1 star" });
    first.focus();
    await user.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}");
    // UI follows the keys immediately…
    expect(screen.getByRole("radio", { name: "5 stars" })).toBeChecked();
    const puts = () => fetch.mock.calls.filter(([, init]) => init.method === "PUT");
    expect(puts()).toHaveLength(0);
    // …and only the final choice is saved, once.
    await waitFor(() => expect(puts()).toHaveLength(1), { timeout: 2000 });
    expect(JSON.parse(puts()[0][1].body)).toEqual({ score: 5, reaction: null });
    await new Promise((r) => setTimeout(r, 700));
    expect(puts()).toHaveLength(1);
  });

  it("keyboard: Enter saves the pending choice right away", async () => {
    const user = userEvent.setup();
    const fetch = mockFetch((url, init) => (init.method === "PUT" ? [200, summary({ mine: { score: 2, reaction: null } })] : [200, summary()]));
    renderApp(<RatingPanel videoId={5} />, { user: USER });
    (await screen.findByRole("radio", { name: "1 star" })).focus();
    await user.keyboard("{ArrowRight}{Enter}");
    const puts = fetch.mock.calls.filter(([, init]) => init.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(JSON.parse(puts[0][1].body)).toEqual({ score: 2, reaction: null });
  });
});
