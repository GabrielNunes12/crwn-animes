// Journey 9 (API v1.6): the admin "Métricas" tab, built only from anonymous aggregates.
//
//   - GET /api/admin/metrics?days=7–90 (admin only, private no-store): catalog counts, the pending
//     queue with stable reason keys, ratings per UTC day (from the anonymous rating_activity), the
//     top series (Bayesian, n ≥ 3) and the image cache.
//   - /admin?tab=metrics: the period lives in ?days= (7/30/90 radios in a "Período" fieldset; any
//     other value falls back to 30); KPI tiles; a column chart (svg role="img" whose aria-label
//     summarises the period) backed by a visually hidden table that "Ver tabela" shows; "Fila de
//     pendentes" with Portuguese labels from the reason keys; "Séries mais bem avaliadas" linking to
//     the series board; "Atualizado às HH:MM" + "Atualizar", announced once in a polite live region.
//
// Other specs write to the same server in parallel, so the absolute numbers move while a test
// runs. The UI is checked against the exact response it rendered (page.waitForResponse), and the
// data a test seeded with lower bounds (today's ratings ≥ what it added, …). Expected strings are
// formatted by the page's own Intl (pt-BR), like the app does, so ICU differences between Node and
// Chromium cannot make a test fail.
import { request as playwrightRequest } from "@playwright/test";
import { test, expect, ADMIN_STATE, createUser, expectNoSeriousViolations, fakeYouTubeId, newGuardedContext, seedSeries, uniqueEmail } from "./fixtures.js";

test.use({ storageState: ADMIN_STATE });

const tagOf = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
/** Letters only: a title without any digit has no (guessed) episode number. */
const lettersOf = (n = 10) => Array.from({ length: n }, () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)]).join("");
const EMPTY_STATE = { cookies: [], origins: [] };

/** docs/API.md v1.6: the stable reason keys and the Portuguese label the tab shows for each. */
const REASON_PT = {
  "no-section": "Não deu para saber se é anime ou mangá",
  "no-series": "Sem série",
  "series-trashed": "A série está na lixeira",
  "no-number": "Sem número de episódio ou capítulo",
  "guessed-number": "Número de episódio ou capítulo deduzido — confira",
  "slot-taken": "O lugar do episódio/capítulo já tem um vídeo publicado",
  ready: "Completo e com o lugar livre: pronto para publicar",
};

/**
 * Seeds what the tab should count: a series with 3 published anime episodes, each rated 5★ by
 * `fans` new users today (so the series has 3 × fans ratings: top-series material from 1 fan on),
 * a 4th episode moved to the trash, and a pending video in that series whose title has no number
 * (reason key "no-number").
 */
async function seedMetrics(admin, baseURL, { fans = 1 } = {}) {
  const tag = tagOf();
  const series = { name: `Métricas ${tag}`, slug: `metricas-${tag}`, aliases: [], genres: [] };
  const { series: created, videos } = await seedSeries(
    admin,
    series,
    [1, 2, 3, 4].map((number) => ({ youtubeId: fakeYouTubeId("mt"), title: `${series.name} episódio ${number}`, section: "anime", number }))
  );
  const trashed = videos.pop();
  expect((await admin.delete(`/api/admin/videos/${trashed.id}`)).status()).toBe(204);

  const res = await admin.post("/api/admin/videos", {
    data: { url: `https://youtu.be/${fakeYouTubeId("mtp")}`, title: `Especial sem numero ${lettersOf()}`, section: "anime", seriesSlug: series.slug },
  });
  expect(res.status(), await res.text()).toBe(201);
  const pending = (await res.json()).video;
  expect(pending, "no number, no guessed number: pending for “no-number”").toMatchObject({ status: "pending", number: null, classification: { suggestedNumber: null } });

  await Promise.all(
    Array.from({ length: fans }, async (_, i) => {
      const ctx = await playwrightRequest.newContext({ baseURL, storageState: EMPTY_STATE });
      try {
        await createUser(ctx, { email: uniqueEmail("metricfan"), displayName: `Fã das Métricas ${i + 1}` });
        for (const video of videos) {
          const rated = await ctx.put(`/api/videos/${video.id}/rating`, { data: { score: 5 } });
          expect(rated.status(), `rate ${video.title}`).toBe(200);
        }
      } finally {
        await ctx.dispose();
      }
    })
  );
  return { ...series, id: created.id, videos, trashed, pending, ratings: fans * videos.length };
}

const isMetrics = (url) => new URL(url).pathname === "/api/admin/metrics";
const daysOf = (url) => new URL(url).searchParams.get("days");

/** Every GET /api/admin/metrics the page sends, as its ?days= value. */
function trackMetricsRequests(page) {
  const sent = [];
  page.on("request", (req) => {
    if (isMetrics(req.url())) sent.push(daysOf(req.url()));
  });
  return sent;
}

/** The JSON of the next metrics response for `days` (call before the action that triggers it). */
async function nextMetrics(page, days) {
  const res = await page.waitForResponse((r) => isMetrics(r.url()) && daysOf(r.url()) === String(days));
  expect(res.status()).toBe(200);
  expect(res.headers()["cache-control"]).toBe("private, no-store");
  return res.json();
}

/** Lets React commit and run its effects (so a fetch an interaction would start has started). */
const settle = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50))));

function ui(page) {
  const panel = page.getByRole("tabpanel");
  return {
    panel,
    heading: panel.getByRole("heading", { level: 2, name: "Métricas" }),
    period: panel.getByRole("group", { name: "Período" }),
    radio: (days) => panel.getByRole("group", { name: "Período" }).getByRole("radio", { name: `${days} dias`, exact: true }),
    tiles: panel.locator("dl").first(),
    chartRegion: panel.getByRole("region", { name: "Avaliações por dia", exact: true }),
    chart: panel.getByRole("img", { name: /^Avaliações por dia nos últimos \d+ dias: / }),
    table: (days) => panel.getByRole("table", { name: `Avaliações por dia, últimos ${days} dias` }),
    tableRegion: (days) => panel.getByRole("region", { name: `Avaliações por dia, últimos ${days} dias` }),
    showTable: panel.getByRole("button", { name: "Ver tabela" }),
    updated: panel.locator("time").filter({ hasText: /^Atualizado às / }),
    refresh: panel.getByRole("button", { name: /^(Atualizar|Atualizando…)$/ }),
    live: panel.locator('p.visually-hidden[role="status"]'),
    pending: panel.getByRole("region", { name: "Fila de pendentes" }),
    top: panel.getByRole("region", { name: "Séries mais bem avaliadas" }),
  };
}

/** The <dd>s of the <dt> labelled `label` inside `scope`: [value, detail?]. */
const definitions = (scope, label) => scope.getByRole("term").filter({ hasText: new RegExp(`^${label}$`) }).locator("xpath=following-sibling::dd");

/** Opens `path` and returns the metrics response the tab rendered (and its ?days=). */
async function openMetrics(page, path = "/admin?tab=metrics", days = 30) {
  const response = nextMetrics(page, days);
  await page.goto(path);
  const data = await response;
  const u = ui(page);
  await expect(u.heading).toBeVisible();
  await expect(u.chart).toBeVisible();
  return data;
}

/**
 * What the tab should print for `data` (the response it rendered) and period `days`, formatted
 * in the page with pt-BR Intl rules (numbers, plurals, UTC days, local HH:MM).
 */
function expectedTexts(page, data, days) {
  return page.evaluate(
    ({ data, days }) => {
      const L = "pt-BR";
      const nf = new Intl.NumberFormat(L);
      const num = (n) => nf.format(n);
      const rules = new Intl.PluralRules(L);
      const plural = (n, one, other) => (rules.select(n) === "one" ? one : other).replace("#", num(n));
      const avg = (n) => new Intl.NumberFormat(L, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n);
      const longDay = (d) =>
        new Intl.DateTimeFormat(L, { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`));
      const time = (iso) => new Intl.DateTimeFormat(L, { timeStyle: "short" }).format(new Date(iso));

      const { catalog: c, ratings: r, thumbnails: th, pendingQueue: q } = data;
      const total = r.daily.reduce((sum, d) => sum + d.count, 0);
      const empty = r.daily.filter((d) => d.count === 0).length;
      let peak = null;
      for (const d of r.daily) if (d.count > 0 && (!peak || d.count >= peak.count)) peak = d;
      const lead = `Avaliações por dia nos últimos ${num(days)} dias`;
      const facts = [
        plural(total, "# avaliação no total", "# avaliações no total"),
        peak && `pico de ${num(peak.count)} em ${longDay(peak.day)}`,
        empty > 0 && plural(empty, "# dia sem avaliações", "# dias sem avaliações"),
      ];
      return {
        // [label, value, detail]: the detail is exact, or "prefix:…"/"suffix:…" when part of it is relative/variable.
        tiles: [
          ["Séries", num(c.series), `${num(c.anime.series)} com anime · ${num(c.manga.series)} com mangá`],
          ["Vídeos de anime", num(c.anime.videos), plural(c.anime.series, "em # série", "em # séries")],
          ["Vídeos de mangá", num(c.manga.videos), plural(c.manga.series, "em # série", "em # séries")],
          ["Pendentes", num(c.pending), q.oldestAt ? "prefix:o mais antigo " : "Fila vazia"],
          ["Indisponíveis", num(c.unavailable), "Veja a aba Quebrados"],
          ["Vídeos na lixeira", num(c.trashed.videos), plural(c.trashed.series, "e # série", "e # séries")],
          ["Avaliações", num(r.total), r.average != null ? `média ${avg(r.average)} de 5` : "Sem avaliações ainda"],
          ["Miniaturas em cache", num(th.cachedFiles), `suffix: · ${plural(th.failuresRemembered, "# falha lembrada", "# falhas lembradas")}`],
        ],
        summary: total > 0 ? `${lead}: ${facts.filter(Boolean).join("; ")}.` : `${lead}: nenhuma avaliação.`,
        updated: `Atualizado às ${time(data.generatedAt)}`,
        live: `Métricas atualizadas às ${time(data.generatedAt)} — últimos ${num(days)} dias.`,
        rows: r.daily.map((d) => ({ day: longDay(d.day), count: num(d.count), average: d.average != null ? avg(d.average) : "—sem média" })),
        queue: { count: num(q.count), reasons: q.byReason.map((x) => plural(x.count, "# vídeo", "# vídeos")) },
        top: data.topSeries.map((s) => ({ avg: s.average != null ? `média ${avg(s.average)}` : null, count: plural(s.ratingCount, "# avaliação", "# avaliações") })),
        today: { day: longDay(r.daily.at(-1).day), count: num(r.daily.at(-1).count) },
      };
    },
    { data, days }
  );
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Checks every KPI tile (label, value, detail) against the rendered response. */
async function expectTiles(page, exp) {
  const u = ui(page);
  await expect(u.tiles.getByRole("term")).toHaveText(exp.tiles.map(([label]) => label));
  for (const [label, value, detail] of exp.tiles) {
    const dd = definitions(u.tiles, label);
    await expect(dd.first(), `${label}: value`).toHaveText(value);
    if (detail.startsWith("prefix:")) await expect(dd.nth(1), `${label}: detail`).toHaveText(new RegExp(`^${escapeRe(detail.slice(7))}\\S`));
    else if (detail.startsWith("suffix:")) await expect(dd.nth(1), `${label}: detail`).toHaveText(new RegExp(`\\S${escapeRe(detail.slice(7))}$`));
    else await expect(dd.nth(1), `${label}: detail`).toHaveText(detail);
  }
}

/** The hidden table: caption, one row per day (day, count, average), in order. */
async function expectTable(page, exp, days) {
  const table = ui(page).table(days);
  await expect(table).toHaveCount(1);
  await expect(table.locator("tbody > tr")).toHaveCount(days);
  await expect(table.locator("tbody > tr > th")).toHaveText(exp.rows.map((r) => r.day));
  await expect(table.locator("tbody > tr > td:nth-of-type(1)")).toHaveText(exp.rows.map((r) => r.count));
  await expect(table.locator("tbody > tr > td:nth-of-type(2)")).toHaveText(exp.rows.map((r) => r.average));
}

/** The width of the box that clips the table: 1px while visually hidden, the table's width once shown. */
const tableBoxWidth = async (table) => (await table.locator("xpath=..").boundingBox())?.width ?? 0;

const noHorizontalScroll = async (page, where) => {
  const sizes = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
  expect(sizes.scrollWidth, `${where}: ${JSON.stringify(sizes)}`).toBeLessThanOrEqual(sizes.clientWidth);
  expect(sizes.bodyScrollWidth, `${where}: ${JSON.stringify(sizes)}`).toBeLessThanOrEqual(sizes.clientWidth);
};

test.describe("admin metrics (Métricas)", () => {
  test("API: the documented anonymous shape; days 7–90 (default 30, else 400); the seeded series, pending reason, trash and today's ratings are counted", async ({
    admin,
    baseURL,
  }) => {
    const seed = await seedMetrics(admin, baseURL, { fans: 3 });
    const res = await admin.get("/api/admin/metrics");
    expect(res.status()).toBe(200);
    expect(res.headers()["cache-control"]).toBe("private, no-store");
    const data = await res.json();
    const n = expect.any(Number);
    expect(data).toEqual({
      generatedAt: expect.any(String),
      catalog: { series: n, anime: { series: n, videos: n }, manga: { series: n, videos: n }, pending: n, unavailable: n, trashed: { series: n, videos: n } },
      pendingQueue: { count: n, oldestAt: expect.any(String), medianAgeHours: n, byReason: expect.any(Array) },
      ratings: { total: n, average: n, daily: expect.any(Array) },
      topSeries: expect.any(Array),
      thumbnails: { cachedFiles: n, cachedBytes: n, failuresRemembered: n },
    });

    await test.step("catalog and pending queue include the seed (lower bounds: other specs write in parallel)", async () => {
      expect(data.catalog.series).toBeGreaterThanOrEqual(1);
      expect(data.catalog.anime.series).toBeGreaterThanOrEqual(1);
      expect(data.catalog.anime.videos).toBeGreaterThanOrEqual(seed.videos.length);
      expect(data.catalog.trashed.videos, "the trashed 4th episode").toBeGreaterThanOrEqual(1);
      expect(data.catalog.pending).toBe(data.pendingQueue.count);
      expect(data.pendingQueue.count).toBeGreaterThanOrEqual(1);
      expect(Date.parse(data.pendingQueue.oldestAt)).toBeLessThanOrEqual(Date.parse(seed.pending.createdAt));
      expect(data.pendingQueue.medianAgeHours).toBeGreaterThanOrEqual(0);
      const { byReason } = data.pendingQueue;
      expect(byReason.length).toBeLessThanOrEqual(10);
      for (const r of byReason) {
        expect(Object.keys(REASON_PT), `documented key: ${JSON.stringify(r)}`).toContain(r.key);
        expect(r).toEqual({ key: r.key, reason: expect.any(String), count: expect.any(Number) });
        expect(r.count).toBeGreaterThan(0);
      }
      expect(byReason.map((r) => r.count), "most frequent first").toEqual([...byReason.map((r) => r.count)].sort((a, b) => b - a));
      expect(byReason.find((r) => r.key === "no-number"), "the seeded pending video's reason").toMatchObject({ reason: "no episode or chapter number", count: expect.any(Number) });
    });

    await test.step("ratings.daily: 30 consecutive UTC days ending today, zero days included; today counts the seeded ratings", async () => {
      const { daily } = data.ratings;
      expect(daily).toHaveLength(30);
      const today = data.generatedAt.slice(0, 10);
      const expectedDays = Array.from({ length: 30 }, (_, i) => new Date(Date.parse(`${today}T00:00:00Z`) - (29 - i) * 86_400_000).toISOString().slice(0, 10));
      expect(daily.map((d) => d.day)).toEqual(expectedDays);
      for (const d of daily) {
        expect(d).toEqual({ day: d.day, count: expect.any(Number), average: d.count > 0 ? expect.any(Number) : null });
      }
      expect(daily.at(-1).count, "today ≥ the ratings this test added").toBeGreaterThanOrEqual(seed.ratings);
      expect(data.ratings.total).toBeGreaterThanOrEqual(seed.ratings);
    });

    await test.step("topSeries: ≤ 10 rows, each with ≥ 3 ratings; the seeded series (9 × 5★) is among them", async () => {
      expect(data.topSeries.length).toBeLessThanOrEqual(10);
      for (const s of data.topSeries) {
        expect(Object.keys(s).sort()).toEqual(["average", "id", "name", "ratingCount", "section", "slug"]);
        expect(s.ratingCount).toBeGreaterThanOrEqual(3);
      }
      expect(data.topSeries).toContainEqual({ id: seed.id, name: seed.name, slug: seed.slug, section: "anime", ratingCount: seed.ratings, average: 5 });
    });

    await test.step("days: 7, 8, 30 and 90 → that many days; out of range, not an integer or repeated → 400", async () => {
      for (const days of [7, 8, 30, 90]) {
        const r = await admin.get(`/api/admin/metrics?days=${days}`);
        expect(r.status(), `days=${days}`).toBe(200);
        const body = await r.json();
        expect(body.ratings.daily, `days=${days}`).toHaveLength(days);
        expect(body.ratings.daily.at(-1).count).toBeGreaterThanOrEqual(seed.ratings);
      }
      for (const bad of ["6", "91", "0", "-7", "abc", "7.5", "1e1", "30&days=7"]) {
        const r = await admin.get(`/api/admin/metrics?days=${bad}`);
        expect(r.status(), `days=${bad}`).toBe(400);
        const body = await r.json();
        expect(body.error.code, `days=${bad}`).toBe("VALIDATION_ERROR");
        expect(Object.keys(body.error.details ?? {}), `days=${bad}`).toEqual(["days"]);
        expect(r.headers()["cache-control"]).toBe("private, no-store");
      }
    });
  });

  test("Admin → Métricas: KPI tiles match the API response; the chart's summary and the hidden table carry the seeded day; “Ver tabela”", async ({
    page,
    admin,
    baseURL,
  }) => {
    const seed = await seedMetrics(admin, baseURL);
    const sent = trackMetricsRequests(page);
    const u = ui(page);
    let data;

    await test.step("the “Métricas” tab: ?tab=metrics, 30 days by default, one request", async () => {
      await page.goto("/admin");
      await expect(page.getByRole("heading", { level: 1, name: "Admin" })).toBeVisible();
      const response = nextMetrics(page, 30);
      await page.getByRole("tab", { name: "Métricas", exact: true }).click();
      data = await response;
      await expect(page).toHaveURL(/\/admin\?tab=metrics$/);
      await expect(page.getByRole("tab", { name: "Métricas", exact: true })).toHaveAttribute("aria-selected", "true");
      await expect(u.heading).toBeVisible();
      await expect(u.radio(30)).toBeChecked();
      await expect(u.period.getByRole("radio")).toHaveCount(3);
      await expect(u.chart).toBeVisible();
      await settle(page);
      expect(sent, "one request for the first load").toEqual(["30"]);
    });

    const exp = await expectedTexts(page, data, 30);
    const today = data.ratings.daily.at(-1);
    expect(today.day).toBe(data.generatedAt.slice(0, 10));
    expect(today.count, "today ≥ the ratings this test added").toBeGreaterThanOrEqual(seed.ratings);

    await test.step("KPI tiles = the response the tab rendered (labels, values, details)", async () => {
      await expectTiles(page, exp);
      await expect(u.updated).toHaveText(exp.updated);
      await expect(u.updated).toHaveAttribute("datetime", data.generatedAt);
      expect(exp.updated).toMatch(/^Atualizado às \d{2}:\d{2}$/);
    });

    await test.step("chart: role=img with a one-sentence summary that has today's count as its peak", async () => {
      await expect(u.chart).toHaveAttribute("aria-label", exp.summary);
      expect(exp.summary).toContain(`pico de ${exp.today.count} em ${exp.today.day}`);
      // One column group per day, today's carrying its count.
      await expect(u.chart.locator("g[data-day]")).toHaveCount(30);
      await expect(u.chart.locator(`g[data-day="${today.day}"]`)).toHaveAttribute("data-count", String(today.count));
    });

    await test.step("keyboard tooltip: focusing the chart shows today, ← the day before (aria-hidden, repeats the table)", async () => {
      const tooltip = u.chartRegion.locator('div[aria-hidden="true"]');
      await u.chart.focus();
      await expect(tooltip).toContainText(exp.rows.at(-1).day);
      await expect(tooltip).toContainText(`${exp.today.count} avaliaç`);
      await page.keyboard.press("ArrowLeft");
      await expect(tooltip).toContainText(exp.rows.at(-2).day);
      await page.keyboard.press("Escape");
      await expect(tooltip).toHaveCount(0);
    });

    await test.step("hidden table: caption, 30 rows, today's row has the seeded count and average", async () => {
      await expectTable(page, exp, 30);
      const last = u.table(30).locator("tbody > tr").last();
      await expect(last.getByRole("rowheader")).toHaveText(exp.rows.at(-1).day);
      await expect(last.getByRole("cell").first()).toHaveText(exp.today.count);
      await expect(last.locator("time")).toHaveAttribute("datetime", today.day);
      expect(await tableBoxWidth(u.table(30)), "visually hidden until “Ver tabela”").toBeLessThanOrEqual(1);
      await expect(u.tableRegion(30)).toHaveCount(0);
    });

    await test.step("“Ver tabela” (aria-pressed) shows the table as a focusable region, and hides it again", async () => {
      await expect(u.showTable).toHaveAttribute("aria-pressed", "false");
      await expect(u.showTable).toHaveAttribute("aria-controls", /.+/);
      await u.showTable.click();
      await expect(u.showTable).toHaveAttribute("aria-pressed", "true");
      await expect(u.tableRegion(30)).toBeVisible();
      await expect(u.tableRegion(30)).toHaveAttribute("tabindex", "0");
      expect(await tableBoxWidth(u.table(30))).toBeGreaterThan(100);
      await u.showTable.click();
      await expect(u.showTable).toHaveAttribute("aria-pressed", "false");
      await expect(u.tableRegion(30)).toHaveCount(0);
      expect(await tableBoxWidth(u.table(30))).toBeLessThanOrEqual(1);
    });
  });

  test("period: the radios set ?days= (7, 90, 30 by arrow key) and refetch; caption, rows and summary follow; a reload keeps it; an unknown value falls back to 30", async ({
    page,
    admin,
    baseURL,
  }) => {
    await seedMetrics(admin, baseURL);
    const sent = trackMetricsRequests(page);
    const u = ui(page);
    await openMetrics(page);
    await settle(page);
    expect(sent).toEqual(["30"]);

    // click(), not check(): the radios are controlled by ?days=, which the router updates in a
    // transition, so `checked` can lag a moment behind the click (toBeChecked() below waits).
    for (const [days, choose] of [
      [7, () => u.radio(7).click()],
      [90, () => u.radio(90).click()],
      // Native radios: ← from 90 selects 30 (the group is one tab stop).
      [30, () => page.keyboard.press("ArrowLeft")],
    ]) {
      await test.step(`${days} dias`, async () => {
        const response = nextMetrics(page, days);
        await choose();
        const data = await response;
        const url = new URL(page.url());
        expect(Object.fromEntries(url.searchParams), "the period is in the URL").toEqual({ tab: "metrics", days: String(days) });
        await expect(u.radio(days)).toBeChecked();
        await expect(u.radio(days)).toBeFocused();
        const exp = await expectedTexts(page, data, days);
        await expect(u.chart).toHaveAttribute("aria-label", exp.summary);
        await expect(u.chart.locator("g[data-day]")).toHaveCount(days);
        await expectTable(page, exp, days);
        await expect(u.live, "a period change is announced (polite)").toHaveText(exp.live);
        await expectTiles(page, exp);
      });
    }
    await settle(page);
    expect(sent, "one request per period change, nothing else").toEqual(["30", "7", "90", "30"]);

    await test.step("a reload of ?days=90 opens on 90 dias", async () => {
      const response = nextMetrics(page, 90);
      await page.goto("/admin?tab=metrics&days=90");
      const data = await response;
      await expect(u.radio(90)).toBeChecked();
      await expectTable(page, await expectedTexts(page, data, 90), 90);
      await expect(u.live, "the first load is not announced").toHaveText("");
    });

    await test.step("?days=12 (not offered) → 30 dias, request days=30", async () => {
      const response = nextMetrics(page, 30);
      await page.goto("/admin?tab=metrics&days=12");
      await response;
      await expect(u.radio(30)).toBeChecked();
      await expect(u.table(30)).toHaveCount(1);
      expect(sent.at(-1)).toBe("30");
    });
  });

  test("“Fila de pendentes” shows the reasons in Portuguese (from the keys, never the server's English); “Séries mais bem avaliadas” links to the series board", async ({
    page,
    admin,
    baseURL,
  }) => {
    const seed = await seedMetrics(admin, baseURL, { fans: 3 });
    const data = await openMetrics(page);
    const exp = await expectedTexts(page, data, 30);
    const u = ui(page);

    await test.step("pending queue: count, median age, oldest; one row per reason key with its Portuguese label and count", async () => {
      await expect(u.pending.getByRole("heading", { level: 3, name: "Fila de pendentes" })).toBeVisible();
      await expect(definitions(u.pending, "Na fila").first()).toHaveText(exp.queue.count);
      await expect(definitions(u.pending, "Idade mediana").first()).toHaveText(/^\d+ (minutos?|horas?|dias?)$/);
      await expect(u.pending.getByRole("term")).toHaveText(["Na fila", "Idade mediana", "Mais antigo"]);
      await expect(definitions(u.pending, "Mais antigo").locator("time")).toHaveAttribute("datetime", data.pendingQueue.oldestAt);

      const keys = data.pendingQueue.byReason.map((r) => r.key);
      expect(keys, "the seeded video's key").toContain("no-number");
      const reasons = u.pending.getByRole("list", { name: "Motivos mais comuns" }).getByRole("listitem");
      await expect(reasons).toHaveText(data.pendingQueue.byReason.map((r, i) => `${REASON_PT[r.key]}${exp.queue.reasons[i]}`));
      await expect(reasons.filter({ hasText: REASON_PT["no-number"] })).toHaveCount(1);
      for (const r of data.pendingQueue.byReason) {
        await expect(u.pending, `no English text: “${r.reason}”`).not.toContainText(r.reason);
      }
      await expect(u.panel).not.toContainText("no episode or chapter number");
    });

    await test.step("top series: the response's list in order, each name a link to /admin/series/:id; the seed is 9 × 5★", async () => {
      expect(data.topSeries.map((s) => s.id), "the seeded series is in the top 10").toContain(seed.id);
      const links = u.top.getByRole("list", { name: "Séries mais bem avaliadas" }).getByRole("listitem").getByRole("link");
      await expect(links).toHaveText(data.topSeries.map((s) => s.name));
      for (const [i, s] of data.topSeries.entries()) {
        await expect(links.nth(i)).toHaveAttribute("href", `/admin/series/${s.id}`);
      }
      const row = u.top.getByRole("listitem").filter({ has: page.getByRole("link", { name: seed.name, exact: true }) });
      const i = data.topSeries.findIndex((s) => s.id === seed.id);
      await expect(row).toContainText("Anime");
      await expect(row).toContainText(`${exp.top[i].avg} · ${exp.top[i].count}`);
      expect(exp.top[i]).toEqual({ avg: "média 5,0", count: `${seed.ratings} avaliações` });

      await row.getByRole("link", { name: seed.name, exact: true }).click();
      await expect(page).toHaveURL(`/admin/series/${seed.id}`);
      await expect(page.getByRole("heading", { level: 1, name: seed.name })).toBeVisible();
    });
  });

  test("“Atualizar”: refetches, keeps focus, “Atualizando…” + aria-busy while waiting, ignores clicks meanwhile, announces the new time once per refresh (polite)", async ({
    page,
    admin,
    baseURL,
  }) => {
    await seedMetrics(admin, baseURL);
    const sent = trackMetricsRequests(page);
    const u = ui(page);
    const data = await openMetrics(page);
    await expect(u.updated).toHaveText((await expectedTexts(page, data, 30)).updated);
    await expect(u.live, "the first load is not announced").toHaveText("");
    await expect(u.live).toHaveAttribute("role", "status");
    expect(await u.live.getAttribute("aria-live"), "status is polite (never assertive)").not.toBe("assertive");
    // Everything the live region ever says from now on.
    await u.live.evaluate((el) => {
      window.__announced = [];
      new MutationObserver(() => window.__announced.push(el.textContent)).observe(el, { childList: true, subtree: true, characterData: true });
    });
    const announced = async () => (await page.evaluate(() => window.__announced)).filter((t) => t.trim() !== "");

    let release;
    const held = new Promise((resolve) => (release = resolve));
    await page.route((url) => isMetrics(url.href), async (route) => {
      await held;
      await route.continue();
    });

    await test.step("while the request is held: “Atualizando…”, aria-disabled, focus kept, old numbers dimmed (aria-busy), no skeleton", async () => {
      const response = nextMetrics(page, 30);
      await u.refresh.click();
      await expect(u.refresh).toHaveAccessibleName("Atualizando…");
      await expect(u.refresh).toHaveAttribute("aria-disabled", "true");
      await expect(u.refresh).toBeFocused();
      await expect(u.panel.locator('[aria-busy="true"]')).toHaveCount(1);
      await expect(u.chart).toBeVisible();
      await expect(u.panel.getByRole("status", { name: "Carregando" })).toHaveCount(0);

      // More clicks and Enter while busy start nothing.
      await u.refresh.click({ force: true });
      await u.refresh.press("Enter");
      await settle(page);
      expect(sent).toEqual(["30", "30"]);
      expect(await announced(), "nothing announced while loading").toEqual([]);

      release();
      const fresh = await response;
      const exp = await expectedTexts(page, fresh, 30);
      await expect(u.live).toHaveText(exp.live);
      await expect(u.updated).toHaveText(exp.updated);
      await expect(u.refresh).toHaveAccessibleName("Atualizar");
      await expect(u.refresh).not.toHaveAttribute("aria-disabled", /.*/);
      await expect(u.refresh).toBeFocused();
      await expect(u.panel.locator("[aria-busy]")).toHaveCount(0);
      await settle(page);
      expect(sent).toEqual(["30", "30"]);
      expect(await announced(), "announced exactly once").toEqual([exp.live]);
      await expectTiles(page, exp);
    });

    await test.step("a second refresh is announced again (once)", async () => {
      await page.unrouteAll({ behavior: "wait" });
      const response = nextMetrics(page, 30);
      await page.keyboard.press("Enter"); // focus is still on the button
      const exp = await expectedTexts(page, await response, 30);
      await expect.poll(announced).toHaveLength(2);
      expect((await announced()).at(-1)).toBe(exp.live);
      await expect(u.live).toHaveText(exp.live);
      await expect(u.live.locator("span")).toHaveCount(1);
      await settle(page);
      expect(sent).toEqual(["30", "30", "30"]);
    });
  });

  test("axe: no serious/critical violations in light and dark (table hidden and shown, chart focused)", async ({ page, admin, baseURL }) => {
    await seedMetrics(admin, baseURL);
    const u = ui(page);
    const textColour = {};
    for (const [scheme, days] of [
      ["light", 30],
      ["dark", 90],
    ]) {
      await test.step(scheme, async () => {
        await page.emulateMedia({ colorScheme: scheme });
        await openMetrics(page, `/admin?tab=metrics&days=${days}`, days);
        await expect(u.pending.or(u.top).first()).toBeVisible();
        expect(await page.evaluate((s) => matchMedia(`(prefers-color-scheme: ${s})`).matches, scheme)).toBe(true);
        textColour[scheme] = await page.evaluate(() => getComputedStyle(document.body).color);
        await expectNoSeriousViolations(page, `Métricas (${scheme}, ${days} dias)`);
        await u.showTable.click();
        await expect(u.tableRegion(days)).toBeVisible();
        await u.chart.focus();
        await expect(u.chartRegion.locator('div[aria-hidden="true"]')).toBeVisible();
        await expectNoSeriousViolations(page, `Métricas (${scheme}, table shown, chart focused)`);
      });
    }
    expect(textColour.dark, "the dark theme really applied (text colour)").not.toBe(textColour.light);
  });

  test.describe("phone 360×740", () => {
    test.use({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });

    test("no horizontal scroll (tiles, chart, pending reasons, top series, table shown); the chart fits the screen", async ({ page, admin, baseURL }) => {
      await seedMetrics(admin, baseURL);
      const u = ui(page);
      await openMetrics(page, "/admin?tab=metrics&days=90", 90);
      await expect(u.pending.getByRole("listitem").first()).toBeVisible();
      await expect(u.top.getByRole("link").first()).toBeVisible();
      await noHorizontalScroll(page, "90 dias");
      const box = await u.chart.boundingBox();
      expect(box.x, "the chart starts on screen").toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, "the chart ends on screen").toBeLessThanOrEqual(360);

      await u.showTable.click();
      await expect(u.tableRegion(90)).toBeVisible();
      await noHorizontalScroll(page, "table shown");

      const response = nextMetrics(page, 7);
      await u.radio(7).click();
      await response;
      await expect(u.radio(7)).toBeChecked();
      await expect(u.table(7)).toHaveCount(1);
      await noHorizontalScroll(page, "7 dias");
    });
  });

  test("a normal user gets 403 from the API and never sees the tab (sent home, no request); a visitor gets 401 and the login page", async ({ browser, baseURL }) => {
    await test.step("normal user", async () => {
      const context = await newGuardedContext(browser, { baseURL, storageState: EMPTY_STATE });
      try {
        await createUser(context.request, { email: uniqueEmail("nometrics"), displayName: "Sem Métricas" });
        for (const path of ["/api/admin/metrics", "/api/admin/metrics?days=7", "/api/admin/metrics?days=90"]) {
          const res = await context.request.get(path);
          expect(res.status(), path).toBe(403);
          expect(res.headers()["cache-control"]).toBe("private, no-store");
          const text = await res.text();
          expect(JSON.parse(text).error.code).toBe("FORBIDDEN");
          expect(text).not.toMatch(/catalog|pendingQueue|topSeries|daily/);
        }
        const page = await context.newPage();
        const sent = trackMetricsRequests(page);
        await page.goto("/admin?tab=metrics&days=7");
        await expect(page).toHaveURL(`${baseURL}/`);
        await expect(page.getByRole("status").filter({ hasText: "Essa área é só para administradores." })).toBeVisible();
        await expect(page.getByRole("tab", { name: "Métricas" })).toHaveCount(0);
        await expect(page.getByRole("heading", { name: "Métricas" })).toHaveCount(0);
        await expect(page.getByRole("banner").getByRole("link", { name: "Admin" })).toHaveCount(0);
        await settle(page);
        expect(sent, "the page never asks for metrics").toEqual([]);
      } finally {
        await context.close();
      }
    });

    await test.step("visitor", async () => {
      const context = await newGuardedContext(browser, { baseURL, storageState: EMPTY_STATE });
      try {
        const page = await context.newPage();
        const sent = trackMetricsRequests(page);
        await page.goto("/admin?tab=metrics");
        await expect(page).toHaveURL(`${baseURL}/login?next=${encodeURIComponent("/admin?tab=metrics")}`);
        await expect(page.getByRole("tab", { name: "Métricas" })).toHaveCount(0);
        expect(sent).toEqual([]);
        const res = await page.request.get("/api/admin/metrics");
        expect(res.status()).toBe(401);
        expect(res.headers()["cache-control"]).toBe("private, no-store");
        expect(await res.text()).not.toMatch(/catalog|pendingQueue|topSeries|daily/);
      } finally {
        await context.close();
      }
    });
  });
});
