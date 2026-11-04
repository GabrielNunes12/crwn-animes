import { createApp } from "./app.js";
import { assertSafeConfig } from "./config.js";
import { loadEnvConfig, openConfiguredDatabase } from "./env.js";
import { startHealthChecks, startRetention } from "./retention.js";

let config;
try {
  config = loadEnvConfig();
  assertSafeConfig(config);
} catch (error) {
  console.error(`Refusing to start: ${error.message}`);
  process.exit(1);
}
const db = openConfiguredDatabase(config);
const app = createApp({ db, config });

const stopRetention = startRetention(db, { thumbnails: app.locals.services.thumbnails });
const stopHealthChecks = startHealthChecks(app.locals.services.videos);

const server = app.listen(config.port, () => {
  console.log(`Crwn Animes API listening on http://localhost:${config.port} (${config.nodeEnv})`);
  if (!config.smtp) console.log("No SMTP_HOST set: e-mails go to the dev outbox and links are printed here.");
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
