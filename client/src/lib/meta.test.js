import { describe, expect, it } from "vitest";
import { createTranslator } from "../i18n/core.js";
import { watchMeta } from "./meta.js";

// Expected values are the server's (server/src/seo.js) for the same data.
describe("watchMeta (pt-BR matches the server render)", () => {
  const t = createTranslator("pt-BR");
  const series = { name: "One Piece", synopsis: "Piratas  em busca do tesouro." };

  it("anime, season 1", () => {
    expect(watchMeta(t, { section: "anime", season: 1, number: 1100 }, series)).toEqual([
      "One Piece — Episódio 1100",
      "Assista ao episódio 1100 de One Piece no Crwn Animes. Piratas em busca do tesouro.",
    ]);
  });

  it("anime, later season, no synopsis", () => {
    expect(watchMeta(t, { section: "anime", season: 2, number: 3 }, { name: "X" })).toEqual([
      "X — Temporada 2, Episódio 3",
      "Assista ao episódio 3 da temporada 2 de X no Crwn Animes.",
    ]);
  });

  it("manga chapter, long synopsis truncated to 160 characters", () => {
    const [title, description] = watchMeta(t, { section: "manga", season: 1, number: 7 }, { name: "Y", synopsis: "palavra ".repeat(40) });
    expect(title).toBe("Y — Capítulo 7");
    expect(description.startsWith("Assista ao capítulo 7 de Y em vídeo no Crwn Animes. palavra")).toBe(true);
    expect([...description].length).toBeLessThanOrEqual(160);
    expect(description.endsWith("palavra…")).toBe(true);
  });
});
