import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OFFLINE_SCRIPT_URL, OFFLINE_URL, STATIC_URLS } from "../sw/strategy.js";

const here = dirname(fileURLToPath(import.meta.url));
/** A public URL path ("/icons/x.png") → the file in client/public. */
const file = (path) => join(here, "../../public", path);
const read = (path) => fs.readFileSync(file(path), "utf8");
const exists = (path) => fs.existsSync(file(path));
/** [width, height] from a PNG's IHDR chunk. */
function pngSize(path) {
  const buf = fs.readFileSync(file(path));
  expect(buf.subarray(1, 4).toString("latin1")).toBe("PNG");
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

describe("manifest.webmanifest", () => {
  const manifest = JSON.parse(read("manifest.webmanifest"));

  it("has the installability fields from docs/API.md v1.5", () => {
    expect(manifest).toMatchObject({
      name: "Crwn Animes",
      short_name: "Crwn",
      start_url: "/",
      scope: "/",
      display: "standalone",
      lang: "pt-BR",
    });
    // Midnight Sakura --bg (oklch(15.5% 0.019 283.9) ≈ #0b0b14).
    expect(manifest.theme_color).toBe("#0b0b14");
    expect(manifest.background_color).toBe("#0b0b14");
  });

  it("lists 192/512 PNG icons for any and maskable, plus the SVG — and every file exists at its declared size", () => {
    const has = (size, purpose) => manifest.icons.some((i) => i.sizes === size && i.type === "image/png" && i.purpose === purpose);
    for (const size of ["192x192", "512x512"]) {
      expect(has(size, "any"), size).toBe(true);
      expect(has(size, "maskable"), size).toBe(true);
    }
    expect(manifest.icons.some((i) => i.type === "image/svg+xml" && i.sizes === "any")).toBe(true);
    for (const icon of [...manifest.icons, ...manifest.shortcuts.flatMap((s) => s.icons ?? [])]) {
      expect(exists(icon.src), icon.src).toBe(true);
      if (icon.type === "image/png") expect(pngSize(icon.src).join("x"), icon.src).toBe(icon.sizes);
      if (icon.type === "image/svg+xml") expect(read(icon.src)).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    }
  });

  it("has shortcuts to /anime and /manga", () => {
    expect(manifest.shortcuts.map((s) => s.url)).toEqual(["/anime", "/manga"]);
    for (const s of manifest.shortcuts) expect(s.name).toBeTruthy();
  });
});

describe("index.html", () => {
  const html = fs.readFileSync(join(here, "../../index.html"), "utf8");

  it("links the manifest, the apple-touch-icon and a theme colour per colour scheme", () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    const touch = /<link rel="apple-touch-icon" href="([^"]+)"/.exec(html)?.[1];
    expect(touch).toBeTruthy();
    expect(pngSize(touch)).toEqual([180, 180]);
    expect(html).toMatch(/<meta name="theme-color" content="#[0-9a-f]{6}" media="\(prefers-color-scheme: dark\)" \/>/);
    expect(html).toMatch(/<meta name="theme-color" content="#[0-9a-f]{6}" media="\(prefers-color-scheme: light\)" \/>/);
  });
});

describe("offline page", () => {
  const html = read(OFFLINE_URL);

  it("is precached with its script, and every precached static file exists", () => {
    expect(STATIC_URLS).toEqual(expect.arrayContaining([OFFLINE_URL, OFFLINE_SCRIPT_URL]));
    for (const url of STATIC_URLS) expect(exists(url), url).toBe(true);
  });

  it("is self-contained: inline CSS, no inline script (CSP), no request to another host", () => {
    expect(html).toMatch(/<style>[\s\S]+<\/style>/);
    expect(html).not.toMatch(/<link[^>]+rel="stylesheet"/);
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts.map(([, attrs, body]) => [attrs.trim(), body.trim()])).toEqual([[`src="${OFFLINE_SCRIPT_URL}"`, ""]]);
    // Only the SVG namespace may mention a URL (it is an identifier, never fetched).
    const urls = html.match(/(?:https?:)?\/\/[\w.-]+/g) ?? [];
    expect(urls.filter((u) => u !== "http://www.w3.org")).toEqual([]);
    expect(html).not.toMatch(/\b(?:src|href)="\/(?!offline\.js")/); // nothing else from our own server either
  });

  it("speaks pt-BR and en, with a retry button", () => {
    expect(html).toContain('<html lang="pt-BR">');
    expect(html).toContain("Você está offline");
    expect(html).toContain("You're offline");
    expect(html).toMatch(/<button type="button" id="retry">/);
    expect(html).toContain("Tentar novamente");
    expect(html).toContain("Try again");
  });

  describe("offline.js", () => {
    const script = read(OFFLINE_SCRIPT_URL);
    const run = (languages) => {
      vi.spyOn(navigator, "languages", "get").mockReturnValue(languages);
      document.documentElement.lang = "pt-BR";
      new Function(script)();
      return document.documentElement.lang;
    };
    afterEach(() => {
      document.documentElement.lang = "";
      delete document.documentElement.dataset.theme;
    });

    it("picks the language from navigator.languages like the app (pt → pt-BR, en → en, else pt-BR)", () => {
      expect(run(["en-US", "en"])).toBe("en");
      expect(document.title).toBe("You're offline · Crwn Animes");
      expect(run(["pt-PT"])).toBe("pt-BR");
      expect(document.title).toBe("Você está offline · Crwn Animes");
      expect(run(["fr-FR", "en-GB"])).toBe("en");
      expect(run(["de-DE"])).toBe("pt-BR");
    });

    it("prefers the language and theme saved in the app", () => {
      localStorage.setItem("crwn:locale", "pt-BR");
      localStorage.setItem("crwn:theme", "light");
      expect(run(["en-US"])).toBe("pt-BR");
      expect(document.documentElement.dataset.theme).toBe("light");
    });
  });
});
