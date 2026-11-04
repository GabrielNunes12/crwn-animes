// Rasterises the PWA icons in public/icons/ from their SVG sources with the
// Chromium that Playwright already uses for the e2e suite (no new dependency):
//
//   node scripts/generate-icons.js         (from client/, after `npm ci --prefix e2e`)
//
// PW_CHROMIUM_PATH overrides the browser; otherwise the sandbox's pre-installed
// /opt/pw-browsers/chromium is used when present, else Playwright's own download.
// The PNGs are committed: the build never runs this script.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const iconsDir = path.resolve(here, "../public/icons");
const require = createRequire(path.resolve(here, "../../e2e/package.json"));
const { chromium } = require("playwright");

const OUTPUTS = [
  { source: "icon.svg", file: "icon-192.png", size: 192 },
  { source: "icon.svg", file: "icon-512.png", size: 512 },
  { source: "icon-maskable.svg", file: "icon-maskable-192.png", size: 192 },
  { source: "icon-maskable.svg", file: "icon-maskable-512.png", size: 512 },
  // iOS rounds the corners itself and ignores transparency: use the full-bleed artwork.
  { source: "icon-maskable.svg", file: "apple-touch-icon.png", size: 180 },
];

const LOCAL_CHROMIUM = "/opt/pw-browsers/chromium";
const executablePath = process.env.PW_CHROMIUM_PATH || (fs.existsSync(LOCAL_CHROMIUM) ? LOCAL_CHROMIUM : undefined);

const browser = await chromium.launch({ executablePath });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const { source, file, size } of OUTPUTS) {
    const svg = fs.readFileSync(path.join(iconsDir, source), "utf8");
    const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:transparent"><img id="i" src="${src}" width="${size}" height="${size}" style="display:block"></body></html>`,
    );
    await page.locator("#i").evaluate((img) => img.decode());
    const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    fs.writeFileSync(path.join(iconsDir, file), png);
    console.log(`${file} (${size}×${size}, ${png.length} bytes)`);
  }
} finally {
  await browser.close();
}
