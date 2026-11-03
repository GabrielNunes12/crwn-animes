import dotenv from "dotenv";
import path from "node:path";
import { SERVER_DIR, loadConfig } from "./config.js";
import { openDatabase } from "./db.js";

/** Loads server/.env (wherever the process was started from) and returns the config. */
export function loadEnvConfig() {
  dotenv.config({ path: path.join(SERVER_DIR, ".env"), quiet: true });
  return loadConfig(process.env);
}

/** Opens DATABASE_FILE, resolved relative to server/. */
export function openConfiguredDatabase(config) {
  const file = config.databaseFile === ":memory:" ? ":memory:" : path.resolve(SERVER_DIR, config.databaseFile);
  return openDatabase(file);
}
