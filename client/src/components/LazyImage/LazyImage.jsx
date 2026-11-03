import { useState } from "react";
import styles from "./LazyImage.module.css";

function initials(label = "") {
  const words = String(label).split(/[\s\-—:]+/).filter(Boolean);
  const out = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "").slice(0, 2);
  return out.toUpperCase();
}

/**
 * Lazy, async-decoded image that fades in from a blurred shimmer placeholder.
 * Always reserves space via aspect-ratio (+ width/height attributes).
 */
export function LazyImage({ src, alt = "", ratio = "16 / 9", width = 480, height = 270, className = "", fallbackLabel = "", eager = false, ...rest }) {
  const [state, setState] = useState("loading");
  const [prevSrc, setPrevSrc] = useState(src);
  if (src !== prevSrc) {
    setPrevSrc(src);
    setState("loading");
  }
  const failed = !src || state === "error";

  return (
    <span className={`${styles.frame} ${className}`.trim()} style={{ aspectRatio: ratio }} data-state={failed ? "error" : state}>
      {failed ? (
        <span className={styles.fallback} aria-hidden="true">
          {initials(fallbackLabel)}
        </span>
      ) : (
        <img
          ref={(img) => {
            // Cached images may finish before React attaches onLoad.
            if (img?.complete && img.naturalWidth > 0 && state === "loading") setState("loaded");
          }}
          src={src}
          alt={alt}
          width={width}
          height={height}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          onLoad={() => setState("loaded")}
          onError={() => setState("error")}
          {...rest}
        />
      )}
    </span>
  );
}
