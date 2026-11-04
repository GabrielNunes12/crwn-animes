import { createBrowserRouter } from "react-router";
import { Layout } from "./components/Layout/Layout.jsx";
import { RequireAdmin } from "./auth/guards.jsx";
import { RootError, RouteError } from "./pages/Error/RouteError.jsx";
import { PageSkeleton } from "./components/Skeleton/Skeleton.jsx";

export const SECTIONS = ["anime", "manga"];

/** Lazy route module (exports Component and optionally loader / shouldRevalidate), with `section` injected into the loader. */
function page(importer, extra) {
  return async () => {
    const mod = await importer();
    const route = { Component: mod.Component };
    if (mod.loader) route.loader = extra ? (args) => mod.loader({ ...args, ...extra }) : mod.loader;
    if (mod.shouldRevalidate) route.shouldRevalidate = mod.shouldRevalidate;
    return route;
  };
}

const sectionPage = () => import("./pages/Section/Section.jsx");
const seriesPage = () => import("./pages/Series/Series.jsx");
const watchPage = () => import("./pages/Watch/Watch.jsx");

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
          { index: true, lazy: page(() => import("./pages/Home/Home.jsx")) },
          ...SECTIONS.flatMap((section) => [
            { path: section, lazy: page(sectionPage, { section }) },
            { path: `${section}/:slug`, lazy: page(seriesPage, { section }) },
          ]),
          { path: "anime/:slug/episode/:number", lazy: page(watchPage, { section: "anime" }) },
          { path: "anime/:slug/season/:season/episode/:number", lazy: page(watchPage, { section: "anime" }) },
          { path: "manga/:slug/chapter/:number", lazy: page(watchPage, { section: "manga" }) },
          { path: "search", lazy: page(() => import("./pages/Search/Search.jsx")) },
          { path: "genre/:genre", lazy: page(() => import("./pages/Genre/Genre.jsx")) },
          { path: "login", lazy: page(() => import("./pages/Auth/Login.jsx")) },
          { path: "register", lazy: page(() => import("./pages/Auth/Register.jsx")) },
          { path: "check-email", lazy: page(() => import("./pages/Auth/CheckEmail.jsx")) },
          { path: "verify-email", lazy: page(() => import("./pages/Auth/VerifyEmail.jsx")) },
          { path: "forgot-password", lazy: page(() => import("./pages/Auth/ForgotPassword.jsx")) },
          { path: "reset-password", lazy: page(() => import("./pages/Auth/ResetPassword.jsx")) },
          { path: "account", lazy: page(() => import("./pages/Account/Account.jsx")) },
          { path: "privacy", lazy: page(() => import("./pages/Privacy/Privacy.jsx")) },
          {
            path: "admin",
            Component: RequireAdmin,
            children: [
              { index: true, lazy: page(() => import("./pages/Admin/Admin.jsx")) },
              // v1.4: per-series board (order, edit, trash) and draft preview.
              { path: "series/:id", lazy: page(() => import("./pages/Admin/SeriesBoard.jsx")) },
              { path: "preview/:id", lazy: page(() => import("./pages/Admin/DraftPreview.jsx")) },
            ],
          },
          { path: "*", lazy: page(() => import("./pages/NotFound/NotFound.jsx")) },
        ],
      },
    ],
  },
];

export function createRouter() {
  return createBrowserRouter(routes);
}
