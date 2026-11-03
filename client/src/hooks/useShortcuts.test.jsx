import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { useShortcuts } from "./useShortcuts.js";
import { SINGLE_KEY_SHORTCUTS_KEY } from "../lib/prefs.js";

function Probe({ map }) {
  useShortcuts(map);
  return <input aria-label="field" />;
}

describe("useShortcuts", () => {
  it("runs single-key and Shift shortcuts, but not while typing", () => {
    const t = vi.fn();
    const next = vi.fn();
    const { getByLabelText } = render(<Probe map={{ t, "shift+n": next }} />);
    fireEvent.keyDown(window, { key: "t" });
    fireEvent.keyDown(window, { key: "N", shiftKey: true });
    fireEvent.keyDown(getByLabelText("field"), { key: "t" });
    expect(t).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("single-key shortcuts can be turned off (WCAG 2.1.4); Shift ones keep working", () => {
    localStorage.setItem(SINGLE_KEY_SHORTCUTS_KEY, "0");
    const t = vi.fn();
    const slash = vi.fn();
    const next = vi.fn();
    render(<Probe map={{ t, "/": slash, "shift+n": next }} />);
    fireEvent.keyDown(window, { key: "t" });
    fireEvent.keyDown(window, { key: "/" });
    fireEvent.keyDown(window, { key: "N", shiftKey: true });
    expect(t).not.toHaveBeenCalled();
    expect(slash).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
