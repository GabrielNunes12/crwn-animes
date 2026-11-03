import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { RequireAdmin } from "./guards.jsx";
import { authValue, renderApp } from "../test/utils.jsx";

const routes = [
  { path: "/", element: <p>home page</p> },
  { path: "/login", element: <p>login page</p> },
  { path: "/admin", element: <RequireAdmin />, children: [{ index: true, element: <p>admin area</p> }] },
];

describe("RequireAdmin", () => {
  it("redirects logged-in non-admins home", async () => {
    const { router } = renderApp(null, { routes, path: "/admin", user: { id: 1, displayName: "U", email: "u@x.co", role: "user" } });
    expect(await screen.findByText("home page")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
    expect(screen.queryByText("admin area")).not.toBeInTheDocument();
  });

  it("sends logged-out visitors to /login with ?next", async () => {
    const { router } = renderApp(null, { routes, path: "/admin" });
    expect(await screen.findByText("login page")).toBeInTheDocument();
    expect(router.state.location.search).toBe("?next=%2Fadmin");
  });

  it("waits while auth is loading, then lets admins in", async () => {
    const { rerender } = renderApp(null, { routes, path: "/admin", auth: authValue(null, { status: "loading" }) });
    expect(screen.queryByText("login page")).not.toBeInTheDocument();
    rerender(null);
    const admin = { id: 2, displayName: "A", email: "a@x.co", role: "admin" };
    renderApp(null, { routes, path: "/admin", user: admin });
    expect(await screen.findByText("admin area")).toBeInTheDocument();
  });
});
