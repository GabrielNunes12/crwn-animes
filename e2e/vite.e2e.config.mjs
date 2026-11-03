// The client's own Vite config, adapted for e2e:
//   - built into e2e/.client-dist (client/dist is left alone) and served with
//     `vite preview`: a fixed production-like snapshot, so a dev server's
//     dependency re-optimisation reloads or HMR updates (someone editing
//     client/ during a run) can never reload a page in the middle of a test;
//   - the /api proxy points at the e2e API port (the real config hardcodes
//     :4000, which a developer may be using).
// Used by playwright.config.js:
//   npm run build -- --config ../e2e/vite.e2e.config.mjs
//   npm run preview -- --config ../e2e/vite.e2e.config.mjs
import base from "../client/vite.config.js";

const apiPort = Number(process.env.E2E_API_PORT || 4517);
const clientPort = Number(process.env.E2E_CLIENT_PORT || 5517);
const proxy = { "/api": { target: `http://localhost:${apiPort}`, changeOrigin: false } };

export default {
  ...base,
  // The config file lives in e2e/, but the app is in client/.
  root: new URL("../client/", import.meta.url).pathname,
  build: {
    ...base.build,
    outDir: new URL("./.client-dist/", import.meta.url).pathname,
    emptyOutDir: true,
  },
  server: { ...base.server, port: clientPort, strictPort: true, proxy },
  preview: { ...base.preview, port: clientPort, strictPort: true, proxy },
};
