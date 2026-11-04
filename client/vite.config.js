import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { serviceWorkerPlugin } from "./scripts/vite-plugin-sw.js";
import { preloadHintsPlugin } from "./scripts/vite-plugin-preload-hints.js";
import { precompressPlugin } from "./scripts/vite-plugin-precompress.js";

export default defineConfig({
  // serviceWorkerPlugin: dist/sw.js (docs/API.md v1.5), production builds only.
  // preloadHintsPlugin: Latin font subset, catalog chunk and visitor's dictionary preloads (v1.7).
  // precompressPlugin: .br/.gz next to every compressible file the server sends (v1.7), last.
  plugins: [react(), serviceWorkerPlugin(), preloadHintsPlugin(), precompressPlugin()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: "http://localhost:4000", changeOrigin: false },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      "/api": { target: "http://localhost:4000", changeOrigin: false },
    },
  },
  build: {
    // One stylesheet for the whole app (≈14 KB brotli; every page stylesheet is a CSS module,
    // so nothing leaks between pages). With per-page CSS, Vite's preloader waits for a page's
    // stylesheets to LOAD before it even requests the page's JS — one more round trip on every
    // first visit and navigation (docs/API.md v1.7).
    cssCodeSplit: false,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            // What the catalog pages (home, section, series, episode, genre, search) share — cards,
            // reveal, player, progress and title hooks — is ONE chunk and one stylesheet, loaded
            // with the page, instead of about ten 1–3 KB files: on HTTP/1.1 (6 connections) each
            // extra request on a page's critical path queues behind the others (docs/API.md v1.7).
            // Not recursive: React, the router and what the entry already holds stay where they are.
            {
              name: "catalog",
              test: /[\\/]src[\\/](?:components[\\/](?:Cards|Reveal|Player)[\\/]|hooks[\\/]use(?:Progress|Reveal|Title)\.js|lib[\\/](?:progress|seasons|youtube)\.js)/,
              includeDependenciesRecursively: false,
            },
          ],
        },
      },
    },
  },
  css: {
    modules: { localsConvention: "camelCase" },
  },
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["./src/test/setup.js"],
    css: { modules: { classNameStrategy: "non-scoped" } },
    restoreMocks: true,
  },
});
