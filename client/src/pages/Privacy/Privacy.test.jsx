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

describe("Privacy notice — same-origin images, search terms and the offline copy (v1.5)", () => {
  it("says thumbnails and covers come from our own server, search terms stay off the device, and what clearing removes (en)", () => {
    renderApp(<Privacy />);
    const media = screen.getByRole("heading", { name: "Videos, thumbnails and covers" }).closest("section");
    expect(media).toHaveTextContent("Episode thumbnails and series covers are now served from our own server");
    expect(media).toHaveTextContent("doesn't make your browser contact YouTube, Google or any other site: YouTube is only contacted when you press Play.");
    expect(media).not.toHaveTextContent("i.ytimg.com");
    expect(screen.getByText(/^Thumbnails and covers come from our own server, and what you type in search is never stored on your device/)).toBeInTheDocument();
    const device = screen.getByRole("heading", { name: "Stored only on your device" }).closest("section");
    expect(device).toHaveTextContent("What you type in search is never stored there");
    expect(device).toHaveTextContent("“Clear watch history” deletes your progress and the offline copy of catalog pages and images");
  });

  it("pt-BR", () => {
    renderApp(<Privacy />, { locale: "pt-BR" });
    const media = screen.getByRole("heading", { name: "Vídeos, miniaturas e capas" }).closest("section");
    expect(media).toHaveTextContent("As miniaturas dos episódios e as capas das séries agora são servidas pelo nosso próprio servidor");
    expect(media).toHaveTextContent("o YouTube só é contatado quando você aperta Play.");
    expect(media).not.toHaveTextContent("i.ytimg.com");
    const device = screen.getByRole("heading", { name: "Guardado só no seu dispositivo" }).closest("section");
    expect(device).toHaveTextContent("O que você digita na busca nunca é guardado ali");
    expect(device).toHaveTextContent("“Limpar histórico” apaga o progresso e a cópia offline das páginas e imagens do catálogo");
  });
});
