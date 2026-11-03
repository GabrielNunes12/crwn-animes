import { describe, expect, it } from "vitest";
import { safeNext } from "./validation.js";

describe("safeNext (?next= after login)", () => {
  it("keeps same-site paths", () => {
    expect(safeNext("/anime/op/episode/1")).toBe("/anime/op/episode/1");
    expect(safeNext("/search?q=a%20b")).toBe("/search?q=a%20b");
  });

  it("refuses anything that a URL parser could turn into another origin", () => {
    for (const bad of [null, undefined, "", "https://evil.com", "//evil.com", "/\\evil.com", "/\t/evil.com", "/\n/evil.com", "/\r//evil.com", "/ /evil.com", "javascript:alert(1)", "/a\\b"]) {
      expect(safeNext(bad)).toBe("/");
    }
    // What a browser would actually make of the tab case:
    expect(new URL("/\t/evil.com", "https://crwn.example").host).toBe("evil.com");
  });
});
