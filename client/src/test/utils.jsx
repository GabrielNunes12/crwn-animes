import { render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { vi } from "vitest";
import { AuthContext } from "../auth/context.js";
import { I18nProvider } from "../i18n/I18nProvider.jsx";

export function jsonResponse(status, body) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Stub global fetch. `handler(url, init)` returns [status, body] or a Response.
 * Returns the vi.fn so tests can inspect calls.
 */
export function mockFetch(handler) {
  const fn = vi.fn(async (url, init = {}) => {
    const out = await handler(String(url), init);
    return out instanceof Response ? out : jsonResponse(out[0], out[1]);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

export function authValue(user = null, overrides = {}) {
  return { user, status: "ready", login: vi.fn(), logout: vi.fn(), refresh: vi.fn(), setUser: vi.fn(), ...overrides };
}

/** Render `ui` (or a routes array) inside i18n (en), a fake auth state and a memory router. */
export function renderApp(ui, { user = null, auth, path = "/", routes, locale = "en" } = {}) {
  const router = createMemoryRouter(routes ?? [{ path: "*", element: ui }], { initialEntries: [path] });
  const utils = render(
    <I18nProvider locale={locale}>
      <AuthContext.Provider value={auth ?? authValue(user)}>
        <RouterProvider router={router} />
      </AuthContext.Provider>
    </I18nProvider>,
  );
  return { ...utils, router };
}
