import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "../lib/prefs.js";

function scrollTimelineSupported() {
  return typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("animation-timeline: view()");
}

/**
 * Reveals an element once, when it scrolls into view (IntersectionObserver).
 * - prefers-reduced-motion: revealed immediately, no animation.
 * - mode "scroll" + browser support: revealed immediately and CSS
 *   scroll-driven animations (animation-timeline: view()) do the work.
 * Returns { ref, revealed, mode } where mode is "none" | "io" | "scroll".
 */
export function useReveal({ variant = "io", rootMargin = "0px 0px -8% 0px", threshold = 0.12 } = {}) {
  const ref = useRef(null);
  const [mode] = useState(() => {
    if (prefersReducedMotion() || typeof IntersectionObserver === "undefined") return "none";
    if (variant === "scroll" && scrollTimelineSupported()) return "scroll";
    return "io";
  });
  const [revealed, setRevealed] = useState(mode !== "io");

  useEffect(() => {
    if (mode !== "io") return undefined;
    const el = ref.current;
    if (!el) return undefined;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setRevealed(true);
          io.disconnect();
        }
      },
      { rootMargin, threshold },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [mode, rootMargin, threshold]);

  return { ref, revealed, mode };
}
