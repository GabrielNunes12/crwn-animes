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

describe("Privacy notice — same-origin thumbnails and the offline copy (v1.5)", () => {
  it("says thumbnails come from our own server, so YouTube/Google is only contacted on Play (en)", () => {
    renderApp(<Privacy />);
    const youtube = screen.getByRole("heading", { name: "YouTube videos and thumbnails" }).closest("section");
    expect(youtube).toHaveTextContent("Thumbnails are now served from our own server");
    expect(youtube).toHaveTextContent("they are only contacted when you press Play.");
    expect(youtube).not.toHaveTextContent("i.ytimg.com");
    expect(screen.getByText("Thumbnails come from our own server: nothing from YouTube loads until you press Play.")).toBeInTheDocument();
    expect(screen.getByText(/^Offline copy \(Cache Storage\)/)).toHaveTextContent("Nothing from your account, your ratings or any personal data is stored there");
  });

  it("pt-BR", () => {
    renderApp(<Privacy />, { locale: "pt-BR" });
    const youtube = screen.getByRole("heading", { name: "Vídeos e miniaturas do YouTube" }).closest("section");
    expect(youtube).toHaveTextContent("As miniaturas agora são servidas pelo nosso próprio servidor");
    expect(youtube).toHaveTextContent("eles só são contatados quando você aperta Play.");
    expect(youtube).not.toHaveTextContent("i.ytimg.com");
    expect(screen.getByText(/^Cópia offline \(Cache Storage\)/)).toBeInTheDocument();
  });
});
