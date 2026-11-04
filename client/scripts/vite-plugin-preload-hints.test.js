import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { LOCALE_META, preloadHints } from "./vite-plugin-preload-hints.js";
import { initialLocale } from "../src/i18n/locale.js";

const chunk = (fileName, extra = {}) => ({ type: "chunk", fileName, name: fileName.replace(/^assets\/|-\w+\.js$/g, ""), isEntry: false, ...extra });
const asset = (fileName) => ({ type: "asset", fileName });

describe("preloadHints (scripts/vite-plugin-preload-hints.js, docs/API.md v1.7)", () => {
  it("finds the Latin fonts, the catalog chunk and each locale's dictionary chunk", () => {
    const bundle = Object.fromEntries(
      [
        chunk("assets/index-a1.js", { isEntry: true, name: "index" }),
        chunk("assets/catalog-b2.js", { name: "catalog" }),
        chunk("assets/Home-c3.js", { facadeModuleId: "/app/client/src/pages/Home/Home.jsx" }),
        chunk("assets/en-d4.js", { facadeModuleId: "/app/client/src/i18n/en.json" }),
        chunk("assets/pt-BR-e5.js", { facadeModuleId: "C:\\app\\client\\src\\i18n\\pt-BR.json" }),
        asset("assets/inter-latin-wght-normal-AbC.woff2"),
        asset("assets/outfit-latin-wght-normal-DeF.woff2"),
        asset("assets/inter-latin-ext-wght-normal-XyZ.woff2"),
        asset("assets/inter-cyrillic-wght-normal-Qq.woff2"),
      ].map((f) => [f.fileName, f]),
    );
    expect(preloadHints(bundle, "/")).toEqual({
      fonts: ["/assets/inter-latin-wght-normal-AbC.woff2", "/assets/outfit-latin-wght-normal-DeF.woff2"],
      modules: ["/assets/catalog-b2.js"],
      locales: { en: "/assets/en-d4.js", "pt-BR": "/assets/pt-BR-e5.js" },
    });
  });
});

describe("public/theme-init.js preloads the dictionary the app will start with (initialLocale)", () => {
  // Vitest runs from client/ (its root).
  const source = fs.readFileSync(path.join(process.cwd(), "public", "theme-init.js"), "utf8");
  const URLS = { "pt-BR": "/assets/pt-BR-e5.js", en: "/assets/en-d4.js" };

  afterEach(() => {
    document.head.innerHTML = "";
    delete document.documentElement.dataset.theme;
  });

  function run({ saved = null, languages = [], meta = `en=${URLS.en} pt-BR=${URLS["pt-BR"]}` } = {}) {
    document.head.innerHTML = meta === null ? "" : `<meta name="${LOCALE_META}" content="${meta}">`;
    if (saved) localStorage.setItem("crwn:locale", saved);
    vi.spyOn(navigator, "languages", "get").mockReturnValue(languages);
    new Function(source)();
    return [...document.head.querySelectorAll('link[rel="modulepreload"]')].map((l) => l.getAttribute("href"));
  }

  it.each([
    [null, ["en-US", "en"]],
    [null, ["pt-BR"]],
    [null, ["fr-FR", "en-GB", "pt-PT"]],
    [null, ["fr-FR", "pt-PT", "en"]],
    [null, ["de-DE"]],
    [null, []],
    ["en", ["pt-BR"]],
    ["pt-BR", ["en-US"]],
    ["xx", ["en-US"]],
  ])("saved %s, browser %j", (saved, languages) => {
    const preloaded = run({ saved, languages });
    expect(preloaded).toEqual([URLS[initialLocale()]]); // same storage and navigator as the script saw
  });

  it("does nothing without the build's meta, and never preloads another origin", () => {
    expect(run({ meta: null, languages: ["en"] })).toEqual([]);
    expect(run({ meta: "en=//evil.example/x.js", languages: ["en"] })).toEqual([]);
    expect(run({ meta: "en=https://evil.example/x.js", languages: ["en"] })).toEqual([]);
  });

  it("still applies the saved theme", () => {
    localStorage.setItem("crwn:theme", "light");
    run({ languages: ["en"] });
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
