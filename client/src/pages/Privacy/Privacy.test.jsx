import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { Component as Privacy } from "./Privacy.jsx";
import { renderApp } from "../../test/utils.jsx";

describe("Privacy notice — ratings and the 7-day trash", () => {
  it("says ratings on a trashed video are kept up to 7 more days, frozen, then deleted (en)", () => {
    renderApp(<Privacy />);
    const row = screen.getByRole("rowheader", { name: /^Ratings/ }).closest("tr");
    expect(row).toHaveTextContent("If the video is moved to the trash, its ratings are kept for up to 7 more days and can’t be changed while it is there; then they are deleted with it.");
  });

  it("pt-BR", () => {
    renderApp(<Privacy />, { locale: "pt-BR" });
    expect(screen.getByText(/Se o vídeo for para a lixeira, as avaliações dele ficam guardadas por até mais 7 dias e não podem ser alteradas enquanto ele estiver lá; depois, são apagadas junto com ele\./)).toBeInTheDocument();
  });
});
