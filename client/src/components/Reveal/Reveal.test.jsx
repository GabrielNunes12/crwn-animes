import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { Reveal } from "./Reveal.jsx";

function stubMatchMedia(reduce) {
  vi.stubGlobal("matchMedia", (query) => ({
    matches: reduce && query.includes("prefers-reduced-motion: reduce"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
}

describe("Reveal", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows content immediately and never observes under prefers-reduced-motion", () => {
    stubMatchMedia(true);
    const IO = vi.fn(function () {
      this.observe = vi.fn();
      this.disconnect = vi.fn();
    });
    vi.stubGlobal("IntersectionObserver", IO);
    render(<Reveal index={3}>hello</Reveal>);
    const el = screen.getByText("hello");
    expect(el).toHaveAttribute("data-revealed", "true");
    expect(el).toHaveAttribute("data-reveal", "none");
    expect(IO).not.toHaveBeenCalled();
  });

  it("reveals once on intersection with a staggered --i", () => {
    stubMatchMedia(false);
    let callback;
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      vi.fn(function (cb) {
        callback = cb;
        this.observe = observe;
        this.disconnect = disconnect;
      }),
    );
    render(<Reveal index={2}>card</Reveal>);
    const el = screen.getByText("card");
    expect(el).toHaveAttribute("data-revealed", "false");
    expect(el.style.getPropertyValue("--i")).toBe("2");
    expect(observe).toHaveBeenCalledWith(el);
    act(() => callback([{ isIntersecting: true }]));
    expect(el).toHaveAttribute("data-revealed", "true");
    expect(disconnect).toHaveBeenCalled();
  });
});
