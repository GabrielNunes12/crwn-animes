import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import "@fontsource-variable/outfit/wght.css";
import "@fontsource-variable/inter/wght.css";
import "./styles/global.css";
import { AuthProvider } from "./auth/AuthProvider.jsx";
import { I18nProvider } from "./i18n/I18nProvider.jsx";
import { createRouter } from "./router.jsx";
import { getTheme } from "./lib/prefs.js";
import { registerServiceWorker } from "./pwa/serviceWorker.js";
import { UpdateToast } from "./pwa/UpdateToast.jsx";

// Fallback in case /theme-init.js did not run (blocked or failed).
const savedTheme = getTheme();
if (savedTheme) document.documentElement.dataset.theme = savedTheme;

const router = createRouter();

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <I18nProvider>
      <AuthProvider>
        <RouterProvider router={router} />
        <UpdateToast />
      </AuthProvider>
    </I18nProvider>
  </StrictMode>,
);

// Offline shell + catalog cache (docs/API.md v1.5): production builds only, after load.
registerServiceWorker();
