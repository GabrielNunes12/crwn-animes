// The e2e API: server/src/index.js, except that it serves the e2e client build
// (e2e/.client-dist, built by the "client" webServer) instead of client/dist.
//
// Why: the API serves the built React app with server-rendered SEO tags
// (docs/API.md v1.2) only when its clientDist holds an index.html, and that
// path (../client/dist) is fixed in server/src/config.js with no env var.
// client/dist is a developer's (possibly stale, possibly missing) build, so
// the SEO specs would test whatever happens to be there. Pointing the API at
// the bundle this very run built makes `GET http://localhost:<API_PORT>/...`
// deterministic. Everything else (config, safety checks, background jobs,
// shutdown) mirrors index.js; keep the two in sync.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../server/src/app.js";
import { assertSafeConfig } from "../server/src/config.js";
import { loadEnvConfig, openConfiguredDatabase } from "../server/src/env.js";
import { startHealthChecks, startRetention } from "../server/src/retention.js";

const clientDist = path.join(path.dirname(fileURLToPath(import.meta.url)), ".client-dist");

let config;
try {
  config = { ...loadEnvConfig(), clientDist };
  assertSafeConfig(config);
} catch (error) {
  console.error(`Refusing to start: ${error.message}`);
  process.exit(1);
}
// The "client" webServer is listed first in playwright.config.js, so its build
// is done before this starts; the app only serves pages if index.html exists now.
if (!fs.existsSync(path.join(clientDist, "index.html"))) {
  console.error(`Refusing to start: ${clientDist}/index.html is missing (the e2e client build must finish first).`);
  process.exit(1);
}

const db = openConfiguredDatabase(config);
const app = createApp({ db, config });

const stopRetention = startRetention(db);
const stopHealthChecks = startHealthChecks(app.locals.services.videos);

const server = app.listen(config.port, () => {
  console.log(`Crwn Animes e2e API listening on http://localhost:${config.port} (serving ${clientDist})`);
});

function shutdown() {
  stopRetention();
  stopHealthChecks();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
