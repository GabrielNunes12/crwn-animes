import { describe, expect, it } from "vitest";
import { act, screen } from "@testing-library/react";
import { SeriesCard } from "./SeriesCard.jsx";
import { renderApp } from "../../test/utils.jsx";
import { saveProgress } from "../../lib/progress.js";

const series = { id: 1, slug: "naruto", name: "Naruto", genres: [], videoCount: 12, route: "/anime/naruto", rating: { average: null, count: 0 } };
const save = (n, route, done = true) => saveProgress(`yt${n}`.padEnd(11, "x"), { position: done ? 100 : 30, duration: 100, route });

describe("SeriesCard — watched indicator", () => {
  it("is hidden without local progress for that series", () => {
    save(1, "/anime/bleach/episode/1");
    save(2, "/manga/naruto/chapter/1"); // same slug, other section
    renderApp(<SeriesCard series={series} section="anime" />);
    expect(screen.queryByText(/watched/)).not.toBeInTheDocument();
  });

  it("shows N/M watched from progress stored under the series' routes, and updates live", () => {
    save(1, "/anime/naruto/episode/1");
    save(2, "/anime/naruto/season/2/episode/4");
    save(3, "/anime/naruto/episode/2", false); // started, not finished
    renderApp(<SeriesCard series={series} section="anime" />);
    expect(screen.getByText("2/12 watched")).toBeInTheDocument();
    act(() => save(4, "/anime/naruto/episode/3"));
    expect(screen.getByText("3/12 watched")).toBeInTheDocument();
  });

  it("only started: 0/M; manga says 'read'", () => {
    save(1, "/manga/naruto/chapter/1", false);
    renderApp(<SeriesCard series={{ ...series, route: "/manga/naruto" }} section="manga" />);
    expect(screen.getByText("0/12 read")).toBeInTheDocument();
  });

  it("counts distinct episodes and never exceeds the episode count", () => {
    save(1, "/anime/naruto/episode/1");
    save(2, "/anime/naruto/episode/1"); // same episode after a link swap
    renderApp(<SeriesCard series={series} section="anime" />);
    expect(screen.getByText("1/12 watched")).toBeInTheDocument();
  });

  it("caps N at M (watched episodes that were later deleted)", () => {
    [1, 2, 3].forEach((n) => save(n, `/anime/naruto/episode/${n}`));
    renderApp(<SeriesCard series={{ ...series, videoCount: 2 }} section="anime" />);
    expect(screen.getByText("2/2 watched")).toBeInTheDocument();
  });
});
