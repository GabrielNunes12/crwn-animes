import { describe, expect, it } from "vitest";
import { createI18n } from "../i18n/core.js";
import { videoLabel } from "./format.js";

describe("videoLabel", () => {
  const { t } = createI18n("pt-BR");

  it("never groups long episode numbers (One Piece has 1000+ episodes)", () => {
    const label = videoLabel(t, { section: "anime", number: 1100, season: 1 });
    expect(label).toContain("1100");
    expect(label).not.toContain("1.100");
  });

  it("labels manga chapters and later seasons", () => {
    expect(videoLabel(t, { section: "manga", number: 1120, season: 1 })).toContain("1120");
    expect(videoLabel(t, { section: "anime", number: 3, season: 2 })).toMatch(/2.*·.*3/);
  });
});
