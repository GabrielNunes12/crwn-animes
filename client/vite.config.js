import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { serviceWorkerPlugin } from "./scripts/vite-plugin-sw.js";

export default defineConfig({
  // serviceWorkerPlugin: dist/sw.js (docs/API.md v1.5), production builds only.
  plugins: [react(), serviceWorkerPlugin()],
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
