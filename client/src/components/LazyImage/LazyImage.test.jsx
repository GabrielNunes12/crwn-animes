import { describe, expect, it } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { LazyImage } from "./LazyImage.jsx";
import { sameOriginImage } from "../../lib/images.js";

const ORIGIN = "https://crwn.example";

describe("sameOriginImage", () => {
  it("keeps paths on our own server", () => {
    expect(sameOriginImage("/api/thumbs/dQw4w9WgXcQ.jpg", ORIGIN)).toBe("/api/thumbs/dQw4w9WgXcQ.jpg");
    expect(sameOriginImage("/api/covers/12.img?v=1a2b3c4d", ORIGIN)).toBe("/api/covers/12.img?v=1a2b3c4d");
    expect(sameOriginImage(`${ORIGIN}/api/covers/1.img`, ORIGIN)).toBe(`${ORIGIN}/api/covers/1.img`);
  });

  it("drops other hosts, however they are spelled, and empty values", () => {
    for (const src of [
      "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
      "https://img1.ak.crunchyroll.com/x.jpg",
      "//evil.example/x.jpg",
      "/\\evil.example/x.jpg",
      "/\t/evil.example/x.jpg",
      "http://crwn.example/api/covers/1.img", // other scheme = other origin
      "data:image/png;base64,AAAA",
      "",
      "   ",
      null,
      undefined,
      42,
    ]) {
      expect(sameOriginImage(src, ORIGIN), String(src)).toBeNull();
    }
  });
});

describe("<LazyImage> — the one placeholder for missing, foreign or broken images", () => {
  const placeholder = (container) => container.querySelector('[data-state="error"] [aria-hidden="true"]');

  it("renders a same-origin image", () => {
    const { container } = render(<LazyImage src="/api/thumbs/dQw4w9WgXcQ.jpg" alt="" fallbackLabel="One Piece" />);
    expect(container.querySelector("img")).toHaveAttribute("src", "/api/thumbs/dQw4w9WgXcQ.jpg");
    expect(placeholder(container)).toBeNull();
  });

  it("null (e.g. a trashed video's thumbnail) → gradient placeholder with initials, no <img>", () => {
    const { container } = render(<LazyImage src={null} alt="" fallbackLabel="One Piece" />);
    expect(container.querySelector("img")).toBeNull();
    expect(placeholder(container)).toHaveTextContent("OP");
  });

  it("an external URL is never requested: placeholder instead", () => {
    const { container } = render(<LazyImage src="https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" alt="" fallbackLabel="Naruto" />);
    expect(container.querySelector("img")).toBeNull();
    expect(placeholder(container)).toHaveTextContent("NA");
  });

  it("a load error (502 from the proxy) swaps in the placeholder", () => {
    const { container } = render(<LazyImage src="/api/covers/3.img?v=x" alt="Cover" fallbackLabel="Bleach" />);
    fireEvent.error(container.querySelector("img"));
    expect(container.querySelector("img")).toBeNull();
    expect(placeholder(container)).toHaveTextContent("BL");
  });

  it("`fill` covers the positioned parent instead of reserving an aspect ratio", () => {
    const { container } = render(<LazyImage src="/api/thumbs/dQw4w9WgXcQ.jpg" fill eager fetchPriority="high" />);
    const frame = container.firstChild;
    expect(frame).toHaveAttribute("data-fill", "true");
    expect(frame.style.aspectRatio).toBe("");
    expect(container.querySelector("img")).toHaveAttribute("loading", "eager");
    expect(container.querySelector("img")).toHaveAttribute("fetchpriority", "high");
  });
});
