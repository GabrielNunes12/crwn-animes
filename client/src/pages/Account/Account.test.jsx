import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Component as Account } from "./Account.jsx";
import { renderApp } from "../../test/utils.jsx";
import { getAllProgress, MAX_IMPORT_BYTES, saveProgress } from "../../lib/progress.js";

const id = (n) => `vid${String(n).padStart(8, "0")}`;
const entry = (at) => ({ t: 30, d: 100, at, route: "/anime/naruto/episode/1", title: "Naruto", thumb: null });
const jsonFile = (data, name = "crwn-animes-progress.json") => new File([typeof data === "string" ? data : JSON.stringify(data)], name, { type: "application/json" });

describe("Account — your progress on this device (logged out)", () => {
  it("imports a file, merging and reporting 'X imported, Y skipped'", async () => {
    saveProgress(id(1), { position: 10, duration: 100, now: 5000 });
    renderApp(<Account />);
    expect(screen.getByRole("heading", { name: "Your progress on this device" })).toBeInTheDocument();
    expect(screen.getByText("1 video in your watch history.")).toBeInTheDocument();

    const input = screen.getByLabelText("Import watch history");
    await userEvent.setup().upload(input, jsonFile({ version: 1, exportedAt: "x", entries: { [id(1)]: entry(1), [id(2)]: entry(2), bad: entry(3) } }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("1 imported, 2 skipped."));
    expect(Object.keys(getAllProgress()).sort()).toEqual([id(1), id(2)]);
    expect(screen.getByText("2 videos in your watch history.")).toBeInTheDocument();
    expect(input.value).toBe("");
  });

  it("reports a bad file and an oversized one without throwing or changing anything", async () => {
    renderApp(<Account />);
    const user = userEvent.setup();
    const input = screen.getByLabelText("Import watch history");

    await user.upload(input, jsonFile("{ definitely not json"));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("That isn't a Crwn Animes watch history file. Nothing was imported."));

    const big = jsonFile("x");
    Object.defineProperty(big, "size", { value: MAX_IMPORT_BYTES + 1 });
    await user.upload(input, big);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("That file is larger than 1 MB. Nothing was imported."));
    expect(getAllProgress()).toEqual({});
  });

  it("says so when the merged history can't be saved (storage full)", async () => {
    renderApp(<Account />);
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    try {
      await userEvent.setup().upload(screen.getByLabelText("Import watch history"), jsonFile({ version: 1, entries: { [id(1)]: entry(1) } }));
      await waitFor(() =>
        expect(screen.getByRole("status")).toHaveTextContent("Couldn't save the imported history — is this browser's storage full? Nothing was imported."),
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("exports crwn-animes-progress.json", async () => {
    saveProgress(id(1), { position: 10, duration: 100, now: 5000 });
    const blobs = [];
    vi.stubGlobal("URL", Object.assign(Object.create(URL), URL, { createObjectURL: (b) => (blobs.push(b), "blob:x"), revokeObjectURL: () => {} }));
    let downloaded = null;
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function () {
      downloaded = this.download;
    });
    renderApp(<Account />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Export watch history" }));
    click.mockRestore();

    expect(downloaded).toBe("crwn-animes-progress.json");
    const data = JSON.parse(await blobs[0].text());
    expect(data).toMatchObject({ version: 1, entries: { [id(1)]: { t: 10, d: 100, at: 5000 } } });
    expect(new Date(data.exportedAt).toISOString()).toBe(data.exportedAt);
    expect(screen.getByRole("status")).toHaveTextContent("Exported 1 video.");
  });
});

describe("Account — “Clear watch history” (v1.5)", () => {
  it("also deletes the offline copy of catalog pages and images, keeping the app shell", async () => {
    const left = new Set(["crwn-shell-b1", "crwn-api-b1", "crwn-thumbs-b1"]);
    vi.stubGlobal("caches", { keys: async () => [...left], delete: async (name) => left.delete(name) });
    saveProgress(id(1), { position: 10, duration: 100, now: 5000 });
    renderApp(<Account />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Clear watch history" }));
    const dialog = screen.getByRole("dialog", { name: "Clear watch history" });
    expect(dialog).toHaveTextContent("plus the offline copy of the catalog pages and images you opened");
    await user.click(within(dialog).getByRole("button", { name: "Clear", exact: true }));
    await waitFor(() => expect([...left]).toEqual(["crwn-shell-b1"]));
    expect(getAllProgress()).toEqual({});
  });

  it("still clears the history where Cache Storage does not exist", async () => {
    vi.stubGlobal("caches", undefined);
    saveProgress(id(1), { position: 10, duration: 100, now: 5000 });
    renderApp(<Account />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Clear watch history" }));
    await user.click(within(screen.getByRole("dialog", { name: "Clear watch history" })).getByRole("button", { name: "Clear", exact: true }));
    expect(getAllProgress()).toEqual({});
    expect(screen.getByRole("status")).toHaveTextContent("Watch history cleared.");
  });
});
