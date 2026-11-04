import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { precompressDir, shouldPrecompress } from "./vite-plugin-precompress.js";

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("precompress (scripts/vite-plugin-precompress.js, docs/API.md v1.7)", () => {
  it("picks JS, CSS, SVG, HTML and the web manifest from 1 KB up — never fonts or raster images", () => {
    for (const f of ["assets/index-a1.js", "sw.js", "assets/x.css", "icons/icon.svg", "offline.html", "manifest.webmanifest"]) {
      expect(shouldPrecompress(f, 1024), f).toBe(true);
      expect(shouldPrecompress(f, 1023), f).toBe(false);
    }
    for (const f of ["assets/inter-latin.woff2", "icons/icon-192.png", "x.jpg", "sw.js.br", "x.js.gz"]) {
      expect(shouldPrecompress(f, 50_000), f).toBe(false);
    }
  });

  it("writes .br and .gz siblings that decompress to the original, and leaves everything else alone", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "precompress-"));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, "assets"));
    const js = "export const answer = 42;\n".repeat(200);
    fs.writeFileSync(path.join(dir, "assets", "index-a1.js"), js);
    fs.writeFileSync(path.join(dir, "theme-init.js"), "small();");
    fs.writeFileSync(path.join(dir, "assets", "font.woff2"), Buffer.alloc(4096, 7));

    expect(await precompressDir(dir)).toEqual([path.join("assets", "index-a1.js")]);
    const br = fs.readFileSync(path.join(dir, "assets", "index-a1.js.br"));
    const gz = fs.readFileSync(path.join(dir, "assets", "index-a1.js.gz"));
    expect(zlib.brotliDecompressSync(br).toString()).toBe(js);
    expect(zlib.gunzipSync(gz).toString()).toBe(js);
    expect(fs.existsSync(path.join(dir, "theme-init.js.br"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "assets", "font.woff2.gz"))).toBe(false);

    // Running again (a rebuild into the same folder) does not compress the siblings themselves.
    expect(await precompressDir(dir)).toEqual([path.join("assets", "index-a1.js")]);
    expect(fs.readdirSync(path.join(dir, "assets")).sort()).toEqual(["font.woff2", "index-a1.js", "index-a1.js.br", "index-a1.js.gz"]);
  });
});
