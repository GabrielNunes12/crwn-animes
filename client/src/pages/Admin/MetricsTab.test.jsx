import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MetricsTab } from "./MetricsTab.jsx";
import { Component as Admin } from "./Admin.jsx";
import { mockFetch, renderApp } from "../../test/utils.jsx";

const DAY = 86_400_000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();

// The last 7 UTC days ending 2026-11-04. 10-31 is missing on purpose (the client fills it);
// 10-30 and 11-03 are sent as zero-activity days.
const DAILY = [
  { day: "2026-10-29", count: 3, average: 4 },
  { day: "2026-10-30", count: 0, average: null },
  { day: "2026-11-01", count: 6, average: 4.5 },
  { day: "2026-11-02", count: 2, average: 3.5 },
  { day: "2026-11-03", count: 0, average: null },
  { day: "2026-11-04", count: 4, average: 5 },
];

function metrics({ generatedAt = "2026-11-04T14:32:00Z", daily = DAILY } = {}) {
  return {
    generatedAt,
    catalog: {
      series: 48,
      anime: { series: 30, videos: 1234 },
      manga: { series: 20, videos: 410 },
      pending: 12,
      unavailable: 3,
      trashed: { series: 1, videos: 5 },
    },
    pendingQueue: {
      count: 12,
      oldestAt: ago(9),
      medianAgeHours: 50,
      byReason: [
        { reason: "no series", count: 7 },
        { reason: "A reason this client doesn't know yet", count: 3 },
      ],
    },
    ratings: { total: 15320, average: 4.236, daily },
    topSeries: [
      { id: 10, name: "Naruto", slug: "naruto", section: "anime", ratingCount: 120, average: 4.71 },
      { id: 22, name: "Berserk", slug: "berserk", section: "manga", ratingCount: 3, average: 4.4 },
    ],
    thumbnails: { cachedFiles: 640, cachedBytes: 3_355_443, failuresRemembered: 2 },
  };
}

const daysOf = (url) => new URL(url, "http://x").searchParams.get("days");

function server(respond = () => [200, metrics()]) {
  const calls = [];
  const fetchFn = mockFetch((url, init) => {
    if (url.startsWith("/api/admin/metrics")) {
      calls.push(url);
      return respond(url, calls.length, init);
    }
    if (url.startsWith("/api/admin/series")) return [200, { items: [], total: 0 }];
    if (url === "/api/genres") return [200, []];
    return [404, { error: { code: "NOT_FOUND" } }];
  });
  return { calls, fetchFn };
}

const tile = (label) => screen.getByText(label, { selector: "dt" }).parentElement;
const longDay = (locale, day) =>
  new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));
const hhmm = (locale, iso) => new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(new Date(iso));

describe("admin Métricas tab", () => {
  it("renders the KPI tiles from the API, numbers formatted for the locale (pt-BR)", async () => {
    const { calls } = server();
    renderApp(<MetricsTab />, { locale: "pt-BR", path: "/admin?tab=metrics" });
    expect(await screen.findByRole("heading", { level: 2, name: "Métricas" })).toBeInTheDocument();
    await screen.findByText("Vídeos de anime", { selector: "dt" });
    expect(daysOf(calls[0])).toBe("30");

    expect(tile("Séries")).toHaveTextContent("48");
    expect(tile("Séries")).toHaveTextContent("30 com anime · 20 com mangá");
    expect(tile("Vídeos de anime")).toHaveTextContent("1.234");
    expect(tile("Vídeos de anime")).toHaveTextContent("em 30 séries");
    expect(tile("Vídeos de mangá")).toHaveTextContent("410");
    expect(tile("Pendentes")).toHaveTextContent("12");
    expect(tile("Pendentes")).toHaveTextContent("o mais antigo há 9 dias");
    expect(tile("Indisponíveis")).toHaveTextContent("3");
    expect(tile("Vídeos na lixeira")).toHaveTextContent("5");
    expect(tile("Vídeos na lixeira")).toHaveTextContent("e 1 série");
    expect(tile("Avaliações")).toHaveTextContent("15.320");
    expect(tile("Avaliações")).toHaveTextContent("média 4,2 de 5");
    expect(tile("Miniaturas em cache")).toHaveTextContent("640");
    expect(tile("Miniaturas em cache")).toHaveTextContent(/3,2\sMB · 2 falhas lembradas/);
    expect(screen.getByRole("list", { name: "Motivos mais comuns" }).firstElementChild).toHaveTextContent("Sem série7 vídeos");
    expect(screen.getByText(`Atualizado às ${hhmm("pt-BR", "2026-11-04T14:32:00Z")}`)).toBeInTheDocument();
  });

  it("draws the daily chart with a summary and the same data in a table, zero-activity days included", async () => {
    server(() => [200, metrics({ daily: DAILY })]);
    const { container } = renderApp(<MetricsTab />, { path: "/admin?tab=metrics&days=7" });
    const chart = await screen.findByRole("img", { name: /^Ratings per day over the last 7 days/ });
    expect(chart).toHaveAccessibleName(
      `Ratings per day over the last 7 days: 15 ratings in total; peak of 6 on ${longDay("en", "2026-11-01")}; 3 days without ratings.`,
    );

    // Seven columns, one per day (the missing 10-31 filled in); bars only where count > 0.
    const columns = container.querySelectorAll("svg [data-day]");
    expect([...columns].map((g) => g.dataset.day)).toEqual(["2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"]);
    expect(container.querySelectorAll('svg [data-count="0"]')).toHaveLength(3);
    expect(container.querySelectorAll("svg [data-day] path")).toHaveLength(4);

    const table = screen.getByRole("table", { name: "Ratings per day, last 7 days" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(7);
    const cells = (row) => within(row).getAllByRole("cell").map((c) => c.textContent);
    expect(within(rows[0]).getByRole("rowheader")).toHaveTextContent(longDay("en", "2026-10-29"));
    expect(cells(rows[0])).toEqual(["3", "4.0"]);
    expect(cells(rows[1])).toEqual(["0", "—no average"]);
    expect(cells(rows[2])).toEqual(["0", "—no average"]);
    expect(cells(rows[3])).toEqual(["6", "4.5"]);
    expect(cells(rows[5])).toEqual(["0", "—no average"]);
  });

  it("the summary leaves out the empty-days clause when every day had ratings (pt-BR)", async () => {
    const busy = Array.from({ length: 7 }, (_, i) => ({ day: `2026-11-0${i + 1}`, count: i + 1, average: 4 }));
    server(() => [200, metrics({ daily: busy })]);
    renderApp(<MetricsTab />, { locale: "pt-BR", path: "/?days=7" });
    expect(await screen.findByRole("img", { name: /^Avaliações por dia/ })).toHaveAccessibleName(
      `Avaliações por dia nos últimos 7 dias: 28 avaliações no total; pico de 7 em ${longDay("pt-BR", "2026-11-07")}.`,
    );
  });

  it("“Show table” reveals the table as a keyboard-scrollable region", async () => {
    server();
    renderApp(<MetricsTab />);
    const user = userEvent.setup();
    const toggle = await screen.findByRole("button", { name: "Show table" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("table").parentElement).toHaveClass("visually-hidden");
    expect(screen.queryByRole("region", { name: "Ratings per day, last 30 days" })).toBeNull();
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    const region = screen.getByRole("region", { name: "Ratings per day, last 30 days" });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region).not.toHaveClass("visually-hidden");
  });

  it("a period with no ratings at all still draws every day on a 0–1 axis", async () => {
    const empty = Array.from({ length: 7 }, (_, i) => ({ day: `2026-11-0${i + 1}`, count: 0, average: null }));
    server(() => [200, metrics({ daily: empty })]);
    const { container } = renderApp(<MetricsTab />, { path: "/?days=7" });
    expect(await screen.findByRole("img", { name: "Ratings per day over the last 7 days: no ratings." })).toBeInTheDocument();
    expect(screen.getByText("No ratings in this period.")).toBeInTheDocument();
    expect(container.querySelectorAll("svg [data-day]")).toHaveLength(7);
    expect(container.querySelectorAll("svg path")).toHaveLength(0);
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(8);
  });

  it("switching the period refetches with days= and keeps it in the URL", async () => {
    const { calls } = server((url) => [200, metrics({ daily: DAILY.slice(-Number(daysOf(url))) })]);
    const { router } = renderApp(<MetricsTab />, { path: "/admin?tab=metrics" });
    const user = userEvent.setup();
    await screen.findByRole("img", { name: /last 30 days/ });
    expect(screen.getByRole("radio", { name: "30 days" })).toBeChecked();

    await user.click(screen.getByRole("radio", { name: "7 days" }));
    await screen.findByRole("img", { name: /last 7 days/ });
    expect(calls.map(daysOf)).toEqual(["30", "7"]);
    expect(router.state.location.search).toBe("?tab=metrics&days=7");
    expect(screen.getByRole("radio", { name: "7 days" })).toBeChecked();

    await user.click(screen.getByRole("radio", { name: "90 days" }));
    await screen.findByRole("img", { name: /last 90 days/ });
    expect(calls.map(daysOf)).toEqual(["30", "7", "90"]);
    expect(screen.getByRole("table", { name: "Ratings per day, last 90 days" }).querySelectorAll("tbody tr")).toHaveLength(90);
  });

  it("refresh refetches and announces the update in a polite status region", async () => {
    const times = ["2026-11-04T14:32:00Z", "2026-11-04T15:07:00Z"];
    const { calls } = server((url, n) => [200, metrics({ generatedAt: times[Math.min(n, 2) - 1] })]);
    renderApp(<MetricsTab />);
    const user = userEvent.setup();
    await screen.findByText(`Updated at ${hhmm("en", times[0])}`);
    // Nothing is announced for the first load.
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("");

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText(`Updated at ${hhmm("en", times[1])}`);
    expect(calls).toHaveLength(2);
    expect(daysOf(calls[1])).toBe("30");
    expect(status).toHaveTextContent(`Metrics updated at ${hhmm("en", times[1])} — last 30 days.`);

    // A second refresh at the same minute is announced again (the message node is replaced).
    const first = status.firstElementChild;
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(calls).toHaveLength(3));
    await waitFor(() => expect(status.firstElementChild).not.toBe(first));
    expect(status).toHaveTextContent(`Metrics updated at ${hhmm("en", times[1])} — last 30 days.`);
  });

  it("shows skeletons while loading, then an error with a retry", async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { calls } = server(async (url, n) => {
      if (n === 1) {
        await gate;
        return [500, { error: { code: "INTERNAL_ERROR", message: "boom" } }];
      }
      return [200, metrics()];
    });
    const user = userEvent.setup();
    renderApp(<MetricsTab />);
    expect(screen.getByRole("status", { name: "Loading…" })).toBeInTheDocument();
    release();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Loading…" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Anime videos", { selector: "dt" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("a failed refresh keeps the last numbers on screen and says why", async () => {
    server((url, n) => (n === 1 ? [200, metrics()] : [503, { error: { code: "INTERNAL_ERROR" } }]));
    const user = userEvent.setup();
    renderApp(<MetricsTab />);
    await screen.findByText("Anime videos", { selector: "dt" });
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(tile("Anime videos")).toHaveTextContent("1,234");
  });

  it("lists the pending queue (median age, top reasons) and top series linking to their boards", async () => {
    server();
    renderApp(<MetricsTab />);
    const queue = (await screen.findByRole("heading", { name: "Pending queue" })).closest("section");
    expect(queue).toHaveTextContent("Median age2 days");
    expect(queue).toHaveTextContent("Oldest9 days ago");
    const reasons = within(queue).getByRole("list", { name: "Most common reasons" });
    // Known server reasons are translated; an unknown one is shown as sent.
    expect(within(reasons).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["No series7 videos", "A reason this client doesn't know yet3 videos"]);

    const top = screen.getByRole("list", { name: "Top-rated series" });
    expect(within(top).getByRole("link", { name: "Naruto" })).toHaveAttribute("href", "/admin/series/10");
    expect(within(top).getByRole("link", { name: "Berserk" })).toHaveAttribute("href", "/admin/series/22");
    expect(within(top).getAllByRole("listitem")[0]).toHaveTextContent("average 4.7 · 120 ratings");
  });

  it("the chart's tooltip follows the keyboard (focus → newest day, arrows move, Esc hides)", async () => {
    server(() => [200, metrics()]);
    const { container } = renderApp(<MetricsTab />, { path: "/?days=7" });
    const chart = await screen.findByRole("img", { name: /last 7 days/ });
    const tip = () => container.querySelector("[data-align]");
    fireEvent.focus(chart);
    expect(tip()).toHaveTextContent(`4 ratings${longDay("en", "2026-11-04")}average 5.0`);
    expect(tip()).toHaveAttribute("aria-hidden", "true");
    fireEvent.keyDown(chart, { key: "ArrowLeft" });
    expect(tip()).toHaveTextContent(`No ratings${longDay("en", "2026-11-03")}`);
    fireEvent.keyDown(chart, { key: "Home" });
    expect(tip()).toHaveTextContent(longDay("en", "2026-10-29"));
    fireEvent.keyDown(chart, { key: "Escape" });
    expect(tip()).toBeNull();
  });

  it("is the Metrics tab of the admin page", async () => {
    server();
    renderApp(<Admin />, { path: "/admin?tab=metrics&days=90" });
    expect(await screen.findByRole("tab", { name: "Metrics" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("img", { name: /last 90 days/ })).toBeInTheDocument();
  });
});
