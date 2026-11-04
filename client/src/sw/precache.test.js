import { describe, expect, it } from "vitest";
import { precacheList } from "../../scripts/vite-plugin-sw.js";
import { SHELL_URL, STATIC_URLS } from "./strategy.js";

const chunk = (fileName, { isEntry = false, imports = [], dynamicImports = [], facade = null, css = [] } = {}) => ({
  type: "chunk",
  fileName,
  isEntry,
  imports,
  dynamicImports,
  facadeModuleId: facade,
  viteMetadata: { importedCss: new Set(css) },
});
const asset = (fileName) => ({ type: "asset", fileName });

describe("precacheList (scripts/vite-plugin-sw.js)", () => {
  const bundle = Object.fromEntries(
    [
      chunk("assets/index-1.js", {
        isEntry: true,
        imports: ["assets/shared-2.js"],
        dynamicImports: ["assets/Home-3.js", "assets/Admin-4.js", "assets/SeriesBoard-5.js"],
        css: ["assets/index-1.css"],
      }),
      chunk("assets/shared-2.js"),
      chunk("assets/Home-3.js", { facade: "/app/client/src/pages/Home/Home.jsx", css: ["assets/Home-3.css"] }),
      chunk("assets/Admin-4.js", { facade: "/app/client/src/pages/Admin/Admin.jsx", imports: ["assets/adminOnly-6.js"], css: ["assets/Admin-4.css"] }),
      chunk("assets/SeriesBoard-5.js", { facade: "C:\\app\\client\\src\\pages\\Admin\\SeriesBoard.jsx" }),
      chunk("assets/adminOnly-6.js"),
      asset("assets/index-1.css"),
      asset("assets/Home-3.css"),
      asset("assets/Admin-4.css"),
      asset("assets/inter-latin-wght-normal-AbC.woff2"),
      asset("assets/inter-cyrillic-wght-normal-XyZ.woff2"),
      asset("index.html"),
      asset("favicon.svg"),
    ].map((f) => [f.fileName, f]),
  );

  it("starts with the shell and the static files the offline page needs", () => {
    const list = precacheList(bundle, "/");
    expect(list.slice(0, 1 + STATIC_URLS.length)).toEqual([SHELL_URL, ...STATIC_URLS]);
  });

  it("precaches what a visitor can reach, plus the Latin fonts — not admin pages or other font subsets", () => {
    const assets = precacheList(bundle, "/").filter((u) => u.startsWith("/assets/"));
    expect(assets).toEqual([
      "/assets/Home-3.css",
      "/assets/Home-3.js",
      "/assets/index-1.css",
      "/assets/index-1.js",
      "/assets/inter-latin-wght-normal-AbC.woff2",
      "/assets/shared-2.js",
    ]);
  });
});
