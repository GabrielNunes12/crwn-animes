import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { AutoNext } from "./AutoNext.jsx";
import { I18nProvider } from "../../i18n/I18nProvider.jsx";

function setup() {
  const onPlay = vi.fn();
  const onCancel = vi.fn();
  const utils = render(
    <I18nProvider locale="en">
      <AutoNext title="Episode 2 — The Return" onPlay={onPlay} onCancel={onCancel} />
    </I18nProvider>,
  );
  return { onPlay, onCancel, ...utils };
}

describe("AutoNext countdown", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("announces the countdown politely and plays after 10 seconds", () => {
    const { onPlay } = setup();
    expect(screen.getByText(/Next starts in 10 seconds: Episode 2 — The Return/)).toHaveAttribute("aria-live", "polite");
    act(() => vi.advanceTimersByTime(9000));
    expect(onPlay).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1000));
    expect(onPlay).toHaveBeenCalledTimes(1);
  });

  it("Cancel stops it (the parent unmounts it) and nothing plays", () => {
    const { onPlay, onCancel, unmount } = setup();
    act(() => vi.advanceTimersByTime(3000));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    unmount();
    act(() => vi.advanceTimersByTime(20000));
    expect(onPlay).not.toHaveBeenCalled();
  });

  it("Play now plays immediately", () => {
    const { onPlay } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Play now" }));
    expect(onPlay).toHaveBeenCalledTimes(1);
  });
});
