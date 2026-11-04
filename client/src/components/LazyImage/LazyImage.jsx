import { useEffect, useState } from "react";
import { sameOriginImage, sameOriginSrcSet } from "../../lib/images.js";
import styles from "./LazyImage.module.css";

function initials(label = "") {
  const words = String(label).split(/[\s\-—:]+/).filter(Boolean);
  const out = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "").slice(0, 2);
  return out.toUpperCase();
}

/**
 * Lazy, async-decoded image that fades in from a blurred shimmer placeholder.
 * Always reserves space via aspect-ratio (+ width/height attributes), or fills its positioned
 * parent with `fill`. A missing (null) source, one on another origin, or a load error shows the
 * gradient placeholder with the initials of `fallbackLabel`: the one fallback for every
 * thumbnail and cover in the app.
 * `srcSet` + `sizes` (docs/API.md v1.7: Video.thumbnailSrcSet) let the browser pick the
 * 320w or 480w file; the srcset is dropped unless every candidate is same-origin.
 * Lazy by default; `eager` (with fetchPriority="high") is for the one hero/poster image a
 * page shows first. `onSettled` is called once the image has loaded or given way to the
 * placeholder (the episode page waits for its poster before loading anything else, v1.7).
 */
export function LazyImage({ src: rawSrc, srcSet: rawSrcSet, sizes, alt = "", ratio = "16 / 9", width = 480, height = 270, className = "", fallbackLabel = "", eager = false, fill = false, onSettled, ...rest }) {
  const src = sameOriginImage(rawSrc);
  const srcSet = src ? sameOriginSrcSet(rawSrcSet) : null;
  const [state, setState] = useState("loading");
  const [prevSrc, setPrevSrc] = useState(src);
  if (src !== prevSrc) {
    setPrevSrc(src);
    setState("loading");
  }
  const failed = !src || state === "error";
  const settled = failed || state === "loaded";
  useEffect(() => {
    if (settled) onSettled?.();
  }, [settled, onSettled]);

  return (
    <span
      className={`${styles.frame} ${className}`.trim()}
      style={fill ? undefined : { aspectRatio: ratio }}
      data-state={failed ? "error" : state}
      data-fill={fill || undefined}
      data-eager={eager || undefined}
    >
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
          srcSet={srcSet ?? undefined}
          sizes={srcSet ? sizes : undefined}
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
