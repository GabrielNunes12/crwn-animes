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

// Creating the router starts the first page's module download and its data requests; the
// visitor's dictionary (its own chunk) downloads at the same time, and the app renders once
// it has arrived. If it cannot be fetched (offline, not cached yet), pt-BR is tried instead.
const router = createRouter();
const locale = initialLocale();
loadMessages(locale)
  .then(
    () => locale,
    () => loadMessages(DEFAULT_LOCALE).then(() => DEFAULT_LOCALE),
  )
  .catch(() => locale)
  .then((ready) => {
    createRoot(document.getElementById("root")).render(
      <StrictMode>
        <I18nProvider locale={ready}>
          <AuthProvider>
            <RouterProvider router={router} />
            <RoutePrefetch routes={routes} />
            <UpdateToast />
          </AuthProvider>
        </I18nProvider>
      </StrictMode>,
    );
  });

// Offline shell + catalog cache (docs/API.md v1.5): production builds only, after load.
registerServiceWorker();
