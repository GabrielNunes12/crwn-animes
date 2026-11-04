import { createBrowserRouter } from "react-router";
import { Layout } from "./components/Layout/Layout.jsx";
import { RequireAdmin } from "./auth/guards.jsx";
import { RootError, RouteError } from "./pages/Error/RouteError.jsx";
import { PageSkeleton } from "./components/Skeleton/Skeleton.jsx";
import { loader as homeLoader } from "./pages/Home/loader.js";
import { loader as sectionLoader } from "./pages/Section/loader.js";
import { loader as seriesLoader, shouldRevalidate as seriesShouldRevalidate } from "./pages/Series/loader.js";
import { loader as watchLoader } from "./pages/Watch/loader.js";

export const SECTIONS = ["anime", "manga"];

/**
 * A lazy route: the page module (its Component, JS and CSS) downloads on demand. Loaders are
 * small and defined statically, so React Router runs them in parallel with `lazy` and the data
 * requests start together with the module download instead of after it (docs/API.md v1.7).
 * `lazy` is also what the hover/focus prefetch calls (hooks/useRoutePrefetch.js): module only,
 * never data. `section` is injected into the loader.
 */
function page(importer, { loader, shouldRevalidate, section } = {}) {
  const route = { lazy: async () => ({ Component: (await importer()).Component }) };
  if (loader) route.loader = section ? (args) => loader({ ...args, section }) : loader;
  if (shouldRevalidate) route.shouldRevalidate = shouldRevalidate;
  return route;
}

const sectionPage = () => import("./pages/Section/Section.jsx");
const seriesPage = () => import("./pages/Series/Series.jsx");
const watchPage = () => import("./pages/Watch/Watch.jsx");
const watch = (section) => page(watchPage, { loader: watchLoader, section });

export const routes = [
  {
    path: "/",
    Component: Layout,
    errorElement: <RootError />,
    HydrateFallback: PageSkeleton,
    children: [
      {
        errorElement: <RouteError />,
        children: [
          { index: true, ...page(() => import("./pages/Home/Home.jsx"), { loader: homeLoader }) },
          ...SECTIONS.flatMap((section) => [
            { path: section, ...page(sectionPage, { loader: sectionLoader, section }) },
            { path: `${section}/:slug`, ...page(seriesPage, { loader: seriesLoader, shouldRevalidate: seriesShouldRevalidate, section }) },
          ]),
          { path: "anime/:slug/episode/:number", ...watch("anime") },
          { path: "anime/:slug/season/:season/episode/:number", ...watch("anime") },
          { path: "manga/:slug/chapter/:number", ...watch("manga") },
          { path: "search", ...page(() => import("./pages/Search/Search.jsx")) },
          { path: "genre/:genre", ...page(() => import("./pages/Genre/Genre.jsx")) },
          { path: "login", ...page(() => import("./pages/Auth/Login.jsx")) },
          { path: "register", ...page(() => import("./pages/Auth/Register.jsx")) },
          { path: "check-email", ...page(() => import("./pages/Auth/CheckEmail.jsx")) },
          { path: "verify-email", ...page(() => import("./pages/Auth/VerifyEmail.jsx")) },
          { path: "forgot-password", ...page(() => import("./pages/Auth/ForgotPassword.jsx")) },
          { path: "reset-password", ...page(() => import("./pages/Auth/ResetPassword.jsx")) },
          { path: "account", ...page(() => import("./pages/Account/Account.jsx")) },
          { path: "privacy", ...page(() => import("./pages/Privacy/Privacy.jsx")) },
          {
            path: "admin",
            Component: RequireAdmin,
            // Never prefetched for visitors who are not admins (hooks/useRoutePrefetch.js).
            handle: { admin: true },
            children: [
              { index: true, ...page(() => import("./pages/Admin/Admin.jsx")) },
              // v1.4: per-series board (order, edit, trash) and draft preview.
              { path: "series/:id", ...page(() => import("./pages/Admin/SeriesBoard.jsx")) },
              { path: "preview/:id", ...page(() => import("./pages/Admin/DraftPreview.jsx")) },
            ],
          },
          { path: "*", ...page(() => import("./pages/NotFound/NotFound.jsx")) },
        ],
      },
    ],
  },
];

export function createRouter() {
  return createBrowserRouter(routes);
}
