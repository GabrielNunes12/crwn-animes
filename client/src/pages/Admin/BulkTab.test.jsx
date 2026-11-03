import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BulkTab } from "./BulkTab.jsx";
import { mockFetch, renderApp } from "../../test/utils.jsx";

const SERIES = [{ id: 1, slug: "one-piece", name: "One Piece" }];

const PREVIEW = {
  results: [
    {
      input: "https://youtu.be/aaaaaaaaaaa",
      youtubeVideoId: "aaaaaaaaaaa",
      outcome: "would-create",
      preview: { section: "anime", seriesSlug: "one-piece", season: 1, number: 5, status: "published", route: "/anime/one-piece/episode/5", reasons: ['title says "anime"'] },
    },
    { input: "https://youtu.be/bbbbbbbbbbb", youtubeVideoId: "bbbbbbbbbbb", outcome: "duplicate", video: { title: "Old one", section: "anime", seriesSlug: "one-piece", number: 4, route: "/anime/one-piece/episode/4" } },
    { input: "nope", youtubeVideoId: null, outcome: "invalid", message: "Not a YouTube link" },
  ],
};

describe("Bulk add", () => {
  it("previews with dryRun and renders a results table, then confirms", async () => {
    const user = userEvent.setup();
    const fetch = mockFetch((url, init) => {
      const body = JSON.parse(init.body);
      if (body.dryRun) return [200, PREVIEW];
      return [200, { results: [{ ...PREVIEW.results[0], outcome: "created", video: { route: "/anime/one-piece/episode/5", title: "Ep 5" } }] }];
    });
    renderApp(<BulkTab series={SERIES} />);

    await user.type(screen.getByLabelText("Links"), "https://youtu.be/aaaaaaaaaaa https://youtu.be/bbbbbbbbbbb nope");
    await user.selectOptions(screen.getByLabelText("Series"), "one-piece");
    await user.click(screen.getByRole("button", { name: "Preview" }));

    const table = await screen.findByRole("table", { name: "Preview of the bulk import" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(4); // header + 3
    expect(within(rows[1]).getByText("Will be created")).toBeInTheDocument();
    expect(within(rows[1]).getByRole("link", { name: "/anime/one-piece/episode/5" })).toBeInTheDocument();
    expect(within(rows[1]).getByText(/title says "anime"/)).toBeInTheDocument();
    expect(within(rows[2]).getByText("Already added")).toBeInTheDocument();
    expect(within(rows[3]).getByText("Invalid")).toBeInTheDocument();
    expect(within(rows[3]).getByText("Not a YouTube link")).toBeInTheDocument();

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("/api/admin/videos/bulk");
    expect(JSON.parse(init.body)).toEqual({
      text: "https://youtu.be/aaaaaaaaaaa https://youtu.be/bbbbbbbbbbb nope",
      defaults: { seriesSlug: "one-piece" },
      dryRun: true,
    });

    await user.click(screen.getByRole("button", { name: "Confirm and add 1 video" }));
    await waitFor(() => expect(screen.getByRole("table", { name: "Result of the bulk import" })).toBeInTheDocument());
    expect(JSON.parse(fetch.mock.calls[1][1].body).dryRun).toBe(false);
    expect(screen.getByText("Created")).toBeInTheDocument();
  });
});
