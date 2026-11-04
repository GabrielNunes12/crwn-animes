import { describe, expect, it } from "vitest";
import { columnPath, fillDays, labelIndices, niceTicks, readPeriod, summarize, tooltipLeft } from "./metrics.js";

describe("metrics helpers", () => {
  it("reads the period from ?days= (7, 30 or 90; anything else is 30)", () => {
    expect(readPeriod("7")).toBe(7);
    expect(readPeriod("90")).toBe(90);
    expect(readPeriod(null)).toBe(30);
    expect(readPeriod("14")).toBe(30);
    expect(readPeriod("abc")).toBe(30);
  });

  it("fills exactly `days` consecutive UTC days, zero-activity days included, oldest first", () => {
    const daily = [
      { day: "2026-11-04", count: 4, average: 5 },
      { day: "2026-11-01", count: 6, average: 4.5 },
      { day: "2026-10-30", count: 0, average: null },
    ];
    const out = fillDays(daily, 7, "2026-11-04T14:32:00Z");
    expect(out.map((d) => d.day)).toEqual(["2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"]);
    expect(out.map((d) => d.count)).toEqual([0, 0, 0, 6, 0, 0, 4]);
    expect(out[3].average).toBe(4.5);
    expect(out[0].average).toBeNull();
  });

  it("ends on generatedAt's UTC date when the server sent no days, and crosses month ends", () => {
    const out = fillDays([], 3, "2026-03-01T01:00:00Z");
    expect(out.map((d) => d.day)).toEqual(["2026-02-27", "2026-02-28", "2026-03-01"]);
    expect(out.every((d) => d.count === 0 && d.average === null)).toBe(true);
    expect(fillDays(undefined, 2, "2026-01-01T00:00:00Z").map((d) => d.day)).toEqual(["2025-12-31", "2026-01-01"]);
  });

  it("summarizes total, empty days and the (latest) peak", () => {
    const s = summarize([
      { day: "a", count: 3 },
      { day: "b", count: 0 },
      { day: "c", count: 3 },
    ]);
    expect(s).toEqual({ total: 6, empty: 1, peak: { day: "c", count: 3 } });
    expect(summarize([{ day: "a", count: 0 }]).peak).toBeNull();
  });

  it("picks clean integer ticks, with an axis even when everything is zero", () => {
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(3)).toEqual([0, 1, 2, 3]);
    expect(niceTicks(9)).toEqual([0, 5, 10]);
    expect(niceTicks(37)).toEqual([0, 10, 20, 30, 40]);
    expect(niceTicks(1)).toEqual([0, 1]);
  });

  it("labels evenly spaced days, always the first and the last", () => {
    expect(labelIndices(5, 8)).toEqual([0, 1, 2, 3, 4]);
    const many = labelIndices(90, 4);
    expect(many[0]).toBe(0);
    expect(many.at(-1)).toBe(89);
    expect(many.length).toBeLessThanOrEqual(4);
    expect(labelIndices(30, 1)).toEqual([0, 29]);
    // 30 days, 13 labels' room: step 3 → …24, 27 would crowd 29 (end-anchored), so 27 goes.
    expect(labelIndices(30, 13).slice(-3)).toEqual([21, 24, 29]);
    // 30 days at phone width (3 labels): the middle one stays.
    expect(labelIndices(30, 3)).toEqual([0, 15, 29]);
  });

  it("puts the tooltip beside the active column and clamps it inside the chart", () => {
    const col = { colStart: 100, colEnd: 120, width: 360 };
    // Room on the side it prefers: 8px off the column.
    expect(tooltipLeft({ ...col, align: "after", tipWidth: 150 })).toBe(128);
    expect(tooltipLeft({ ...col, colStart: 300, colEnd: 320, align: "before", tipWidth: 150 })).toBe(142);
    // No room: pushed back inside [0, width − tipWidth] instead of overflowing (the 360px bug).
    expect(tooltipLeft({ ...col, colStart: 290, colEnd: 300, align: "after", tipWidth: 150 })).toBe(210);
    expect(tooltipLeft({ ...col, colStart: 40, colEnd: 50, align: "before", tipWidth: 150 })).toBe(0);
    // A long pt-BR date at 320px: never past the right edge…
    expect(tooltipLeft({ colStart: 200, colEnd: 210, width: 320, align: "after", tipWidth: 220 })).toBe(100);
    // …and a tooltip wider than the chart starts at 0 (CSS caps it at 100% and wraps).
    expect(tooltipLeft({ colStart: 200, colEnd: 210, width: 320, align: "before", tipWidth: 400 })).toBe(0);
  });

  it("draws columns square at the baseline with at most a 4px rounded data end", () => {
    expect(columnPath(10, 20, 12, 50)).toBe("M10,70V24A4,4 0 0 1 14,20H18A4,4 0 0 1 22,24V70Z");
    // Thin columns: the radius never exceeds half the width.
    expect(columnPath(0, 0, 2, 10)).toContain("A1,1");
  });
});
