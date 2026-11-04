// Service worker entry (docs/API.md v1.5). Bundled into dist/sw.js as one classic script by
// scripts/vite-plugin-sw.js, which replaces the two build-time constants below.
/* global __SW_BUILD_ID__, __SW_PRECACHE__ */
import { createServiceWorker } from "./handlers.js";

const sw = createServiceWorker({
  buildId: __SW_BUILD_ID__,
  precache: __SW_PRECACHE__,
  caches: self.caches,
  fetch: (input, init) => self.fetch(input, init),
  origin: self.location.origin,
  clients: self.clients,
  skipWaiting: () => self.skipWaiting(),
});

self.addEventListener("install", (event) => {
  event.waitUntil(sw.install());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(sw.activate());
});

self.addEventListener("message", (event) => {
  const done = sw.message(event.data);
  if (done) event.waitUntil(done);
});

self.addEventListener("fetch", (event) => {
  const response = sw.respond(event);
  if (response) event.respondWith(response);
});
