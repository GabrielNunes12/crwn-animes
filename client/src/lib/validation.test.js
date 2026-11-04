import { describe, expect, it } from "vitest";
import { isEmail, safeNext } from "./validation.js";

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

describe("isEmail", () => {
  it("accepts normal addresses and rejects malformed ones", () => {
    expect(isEmail("ana@example.com")).toBe(true);
    expect(isEmail("josé@exemplo.com.br")).toBe(true);
    expect(isEmail("no-at-sign.com")).toBe(false);
    expect(isEmail("a@b")).toBe(false);
  });

  it("rejects over-long input quickly instead of backtracking (30k chars)", () => {
    const hostile = `a@${".".repeat(30_000)}`;
    const started = performance.now();
    expect(isEmail(hostile)).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
    expect(isEmail(`${"a".repeat(250)}@b.co`)).toBe(false); // 255 chars
  });
});
