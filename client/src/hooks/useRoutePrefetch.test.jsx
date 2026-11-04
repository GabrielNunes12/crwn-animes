import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { HOVER_DELAY_MS, prefetchRoute, saveDataOn, useRoutePrefetch } from "./useRoutePrefetch.js";

/** A route table shaped like router.jsx: lazy pages, static loaders, an admin subtree. */
function makeRoutes() {
  const lazy = {
    home: vi.fn(async () => ({ Component: () => null })),
    series: vi.fn(async () => ({ Component: () => null })),
    admin: vi.fn(async () => ({ Component: () => null })),
  };
  const loader = vi.fn(() => ({}));
  const routes = [
    {
      path: "/",
      children: [
        { index: true, lazy: lazy.home, loader },
        { path: "anime/:slug", lazy: lazy.series, loader },
        { path: "admin", handle: { admin: true }, children: [{ index: true, lazy: lazy.admin }] },
      ],
    },
  ];
  return { routes, lazy, loader };
}

function Harness({ routes, isAdmin = false }) {
  useRoutePrefetch(routes, { isAdmin });
  return (
    <nav>
      <a href="/anime/one-piece">
        <span data-testid="series-label">One Piece</span>
      </a>
      <a href="/admin">Admin</a>
      <a href="https://elsewhere.example/anime/x">Elsewhere</a>
      <a href="/anime/naruto" target="_blank">
        New tab
      </a>
      <a href="/">Home</a>
    </nav>
  );
}

const link = (container, href) => container.querySelector(`a[href="${href}"]`);
const flush = () => act(async () => {});

function setSaveData(value) {
  Object.defineProperty(navigator, "connection", { value: value === undefined ? undefined : { saveData: value }, configurable: true });
}

describe("useRoutePrefetch — route-module prefetch on hover / focus (docs/API.md v1.7)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    setSaveData(undefined);
  });

  it(`hovering a link for ${HOVER_DELAY_MS} ms loads its route module — and never its data`, async () => {
    const { routes, lazy, loader } = makeRoutes();
    const { container } = render(<Harness routes={routes} />);
    fireEvent.pointerOver(link(container, "/anime/one-piece"));
    act(() => vi.advanceTimersByTime(HOVER_DELAY_MS - 1));
    await flush();
    expect(lazy.series).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    await flush();
    expect(lazy.series).toHaveBeenCalledTimes(1);
    expect(loader).not.toHaveBeenCalled();
  });

  it("a hover that leaves before the delay loads nothing; moving inside the link keeps the timer", async () => {
    const { routes, lazy } = makeRoutes();
    const { container, getByTestId } = render(<Harness routes={routes} />);
    const a = link(container, "/anime/one-piece");
    fireEvent.pointerOver(a);
    act(() => vi.advanceTimersByTime(50));
    fireEvent.pointerOut(a, { relatedTarget: document.body });
    act(() => vi.advanceTimersByTime(500));
    await flush();
    expect(lazy.series).not.toHaveBeenCalled();

    fireEvent.pointerOver(a);
    act(() => vi.advanceTimersByTime(60));
    fireEvent.pointerOut(a, { relatedTarget: getByTestId("series-label") });
    fireEvent.pointerOver(getByTestId("series-label"));
    act(() => vi.advanceTimersByTime(40));
    await flush();
    expect(lazy.series).toHaveBeenCalledTimes(1);
  });

  it("touch pointers are ignored (the tap navigates right away)", async () => {
    const { routes, lazy } = makeRoutes();
    const { container } = render(<Harness routes={routes} />);
    fireEvent.pointerOver(link(container, "/anime/one-piece"), { pointerType: "touch" });
    act(() => vi.advanceTimersByTime(1000));
    await flush();
    expect(lazy.series).not.toHaveBeenCalled();
  });

  it("focusing a link loads its module immediately, once", async () => {
    const { routes, lazy } = makeRoutes();
    const { container } = render(<Harness routes={routes} />);
    const a = link(container, "/");
    fireEvent.focusIn(a);
    await flush();
    expect(lazy.home).toHaveBeenCalledTimes(1);
    fireEvent.focusIn(a);
    fireEvent.pointerOver(a);
    act(() => vi.advanceTimersByTime(HOVER_DELAY_MS));
    await flush();
    expect(lazy.home).toHaveBeenCalledTimes(1);
  });

  it("navigator.connection.saveData turns it off", async () => {
    setSaveData(true);
    expect(saveDataOn()).toBe(true);
    const { routes, lazy } = makeRoutes();
    const { container } = render(<Harness routes={routes} />);
    fireEvent.focusIn(link(container, "/anime/one-piece"));
    fireEvent.pointerOver(link(container, "/"));
    act(() => vi.advanceTimersByTime(1000));
    await flush();
    expect(lazy.series).not.toHaveBeenCalled();
    expect(lazy.home).not.toHaveBeenCalled();
  });

  it("admin pages are only prefetched for admins", async () => {
    const visitor = makeRoutes();
    const v = render(<Harness routes={visitor.routes} />);
    fireEvent.focusIn(link(v.container, "/admin"));
    await flush();
    expect(visitor.lazy.admin).not.toHaveBeenCalled();
    v.unmount();

    const admin = makeRoutes();
    const a = render(<Harness routes={admin.routes} isAdmin />);
    fireEvent.focusIn(link(a.container, "/admin"));
    await flush();
    expect(admin.lazy.admin).toHaveBeenCalledTimes(1);
  });

  it("other origins and new-tab links are left alone; listeners go away on unmount", async () => {
    const { routes, lazy } = makeRoutes();
    const { container, unmount } = render(<Harness routes={routes} />);
    fireEvent.focusIn(link(container, "https://elsewhere.example/anime/x"));
    fireEvent.focusIn(link(container, "/anime/naruto"));
    await flush();
    expect(lazy.series).not.toHaveBeenCalled();

    const a = link(container, "/anime/one-piece");
    unmount();
    document.body.append(a);
    fireEvent.focusIn(a);
    await flush();
    expect(lazy.series).not.toHaveBeenCalled();
    a.remove();
  });
});

describe("prefetchRoute", () => {
  it("retries a module whose download failed", async () => {
    const lazy = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({});
    const routes = [{ path: "/x", lazy }];
    expect(prefetchRoute(routes, "/x", { origin: "http://localhost:3000" })).toBe(1);
    await act(async () => {});
    expect(prefetchRoute(routes, "/x", { origin: "http://localhost:3000" })).toBe(1);
    await act(async () => {});
    expect(prefetchRoute(routes, "/x", { origin: "http://localhost:3000" })).toBe(0);
    expect(lazy).toHaveBeenCalledTimes(2);
  });

  it("ignores unknown paths and malformed URLs", () => {
    expect(prefetchRoute([{ path: "/x", lazy: vi.fn() }], "/nowhere")).toBe(0);
    expect(prefetchRoute([{ path: "/x", lazy: vi.fn() }], "http://[bad")).toBe(0);
  });
});
