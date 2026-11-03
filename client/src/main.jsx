import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import "@fontsource-variable/outfit/wght.css";
import "@fontsource-variable/inter/wght.css";
import "./styles/global.css";
import { AuthProvider } from "./auth/AuthProvider.jsx";
import { I18nProvider } from "./i18n/I18nProvider.jsx";
import { createRouter } from "./router.jsx";

const router = createRouter();

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <I18nProvider>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </I18nProvider>
  </StrictMode>,
);
