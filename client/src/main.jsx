import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import "@fontsource-variable/outfit/wght.css";
import "@fontsource-variable/inter/wght.css";
import "./styles/global.css";
import { AuthProvider } from "./auth/AuthProvider.jsx";
import { I18nProvider } from "./i18n/I18nProvider.jsx";
import { DEFAULT_LOCALE, loadMessages } from "./i18n/core.js";
import { initialLocale } from "./i18n/locale.js";
import { RoutePrefetch } from "./components/RoutePrefetch/RoutePrefetch.jsx";
import { createRouter, routes } from "./router.jsx";
import { getTheme } from "./lib/prefs.js";
import { registerServiceWorker } from "./pwa/serviceWorker.js";
import { UpdateToast } from "./pwa/UpdateToast.jsx";

// Fallback in case /theme-init.js did not run (blocked or failed).
const savedTheme = getTheme();
if (savedTheme) document.documentElement.dataset.theme = savedTheme;

// Start-up order (docs/API.md v1.7): the visitor's dictionary (its own chunk) is requested
// first, then creating the router starts the first page's module download and its data
// requests. Vite issues a dynamic import() one microtask after the call, so the router is
// created one microtask later — on HTTP/1.1 the dictionary is not queued behind the page's
// ~10 requests. If the dictionary cannot be fetched (offline, not cached yet), pt-BR is tried.
const locale = initialLocale();
const ready = loadMessages(locale)
  .then(
    () => locale,
    () => loadMessages(DEFAULT_LOCALE).then(() => DEFAULT_LOCALE),
  )
  .catch(() => locale);

/** Resolves once the router has loaded the landing page's module (or failed to: its error boundary renders). */
function initialized(router) {
  if (router.state.initialized) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = router.subscribe((state) => {
      if (!state.initialized) return;
      unsubscribe();
      resolve();
    });
  });
}

queueMicrotask(() => {
  const router = createRouter();
  // The first render waits for the dictionary AND the landing page's module (both downloading
  // in parallel). Rendering earlier would show the HydrateFallback and then render the page in
  // a router transition, where nothing can be deferred: the page's largest paint would wait for
  // all of its below-the-fold content. Rendered now, the page's own first pass (hero, player)
  // commits at once and the rest follows (useDeferredValue in Home and Watch).
  Promise.all([ready, initialized(router)]).then(([startLocale]) => {
    createRoot(document.getElementById("root")).render(
      <StrictMode>
        <I18nProvider locale={startLocale}>
          <AuthProvider>
            <RouterProvider router={router} />
            <RoutePrefetch routes={routes} />
            <UpdateToast />
          </AuthProvider>
        </I18nProvider>
      </StrictMode>,
    );
  });
});

// Offline shell + catalog cache (docs/API.md v1.5): production builds only, after load.
registerServiceWorker();
