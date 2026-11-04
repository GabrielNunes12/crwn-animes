import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AddVideoTab } from "./AddVideoTab.jsx";
import { BulkResults } from "./BulkTab.jsx";
import { mockFetch, renderApp } from "../../test/utils.jsx";

const trashed = {
  id: 13, youtubeVideoId: "B9498740005", title: "Bleach 5", channel: null, thumbnailUrl: "", section: "anime", seriesId: 2, seriesSlug: "bleach",
  seriesName: "Bleach", season: 1, number: 5, status: "published", availability: "ok", route: null, rating: { average: null, count: 0 },
  deletedAt: "2026-11-03T10:00:00Z", purgeAt: "2026-11-10T10:00:00Z",
};

async function add(locale) {
  mockFetch(() => [409, { error: { code: "CONFLICT", message: "This video is in the trash; restore it instead.", details: { video: trashed } } }]);
  renderApp(<AddVideoTab series={[]} />, { locale });
  const user = userEvent.setup();
  await user.type(screen.getByRole("textbox", { name: locale === "en" ? "YouTube link or ID" : "Link ou ID do YouTube" }), "B9498740005");
  await user.click(screen.getByRole("button", { name: locale === "en" ? "Add video" : "Adicionar vídeo" }));
  return screen.findByRole("alert");
}

describe("adding a video that is in the trash (409)", () => {
  it("says it is in the trash with a link to the Trash tab — never 'Published — it found its home'", async () => {
    const alert = await add("en");
    expect(alert).toHaveTextContent("In the trash — restore it instead of adding it again.");
    expect(alert).toHaveTextContent("This video is in the trash; restore it instead."); // the server's message (English UI only)
    expect(within(alert).getByRole("link", { name: "Open the Trash" })).toHaveAttribute("href", "/admin?tab=trash");
    expect(screen.queryByText("Published — it found its home.")).not.toBeInTheDocument();
    expect(screen.queryByText("This video was already added. Here it is:")).not.toBeInTheDocument();
    expect(screen.getByText("In the trash", { selector: ".badge" })).toBeInTheDocument();
  });

  it("pt-BR: 'Na lixeira — restaure-o', without the server's English text", async () => {
    const alert = await add("pt-BR");
    expect(alert).toHaveTextContent("Na lixeira — restaure-o em vez de adicionar de novo.");
    expect(alert).not.toHaveTextContent("restore it instead");
    expect(within(alert).getByRole("link", { name: "Abrir a Lixeira" })).toHaveAttribute("href", "/admin?tab=trash");
    expect(screen.queryByText("Publicado — encontrou seu lugar.")).not.toBeInTheDocument();
  });

  it("a live duplicate still shows the usual 'already added' result", async () => {
    mockFetch(() => [409, { error: { code: "CONFLICT", details: { video: { ...trashed, deletedAt: undefined, purgeAt: undefined, route: "/anime/bleach/episode/5" } } } }]);
    renderApp(<AddVideoTab series={[]} />);
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "YouTube link or ID" }), "B9498740005");
    await user.click(screen.getByRole("button", { name: "Add video" }));
    expect(await screen.findByText("This video was already added. Here it is:")).toBeInTheDocument();
    expect(screen.getByText("Published — it found its home.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("bulk: an 'Already added' row whose video is in the trash says so and links to the Trash tab", () => {
    const results = [
      { input: "B9498740005", youtubeVideoId: "B9498740005", outcome: "duplicate", video: trashed },
      { input: "B9498740006", youtubeVideoId: "B9498740006", outcome: "duplicate", video: { ...trashed, id: 14, title: "Live one", deletedAt: undefined, route: "/anime/bleach/episode/6" } },
    ];
    renderApp(<BulkResults results={results} preview />);
    const [, row, live] = screen.getAllByRole("row");
    expect(within(row).getByText("Already added")).toBeInTheDocument();
    expect(within(row).getByText("In the trash")).toBeInTheDocument();
    expect(within(row).queryByText("(Published)")).not.toBeInTheDocument();
    expect(within(row).getByRole("link", { name: "Open the Trash" })).toHaveAttribute("href", "/admin?tab=trash");
    expect(within(live).queryByText("In the trash")).not.toBeInTheDocument();
    expect(within(live).queryByRole("link", { name: "Open the Trash" })).not.toBeInTheDocument();
  });
});
