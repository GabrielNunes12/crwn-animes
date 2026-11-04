// WCAG 1.4.3: text/background token pairs used by components must reach 4.5:1
// in BOTH themes. Colours are read from tokens.css (oklch) and converted to sRGB.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const tokens = readFileSync(join(here, "tokens.css"), "utf8");
const seriesCss = readFileSync(join(here, "../pages/Series/Series.module.css"), "utf8");
const globalCss = readFileSync(join(here, "global.css"), "utf8");

/** Token values of a block: the base :root, overridden by the light block when asked. */
function theme(light) {
  const base = tokens.slice(tokens.indexOf(":root {"), tokens.indexOf("@media (prefers-color-scheme: light)"));
  const lightBlock = tokens.slice(tokens.indexOf(':root[data-theme="light"] {'));
  const read = (css) => Object.fromEntries([...css.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  return { ...read(base), ...(light ? read(lightBlock) : {}) };
}

function resolve(vars, value) {
  let v = value;
  for (let i = 0; i < 5 && /^var\(/.test(v); i++) v = vars[v.match(/^var\((--[\w-]+)\)/)[1]];
  return v;
}

function oklchToLinearRgb(css) {
  const [, l, c, h] = css.match(/oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)/).map(Number);
  const L = l / 100;
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ].map((x) => Math.min(1, Math.max(0, x)));
}

const luminance = (css) => {
  const [r, g, b] = oklchToLinearRgb(css);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (fg, bg) => {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe("colour contrast", () => {
  it("'Watched everything ✓' (.allDone) is ≥ 4.5:1 in dark and light themes", () => {
    const rule = seriesCss.slice(seriesCss.indexOf(".allDone {"), seriesCss.indexOf("}", seriesCss.indexOf(".allDone {")));
    const fg = rule.match(/\scolor:\s*([^;]+);/)[1].trim();
    const bg = rule.match(/background:\s*([^;]+);/)[1].trim();
    for (const light of [false, true]) {
      const vars = theme(light);
      expect(contrast(resolve(vars, fg), resolve(vars, bg))).toBeGreaterThanOrEqual(4.5);
    }
  });

  /** "a, :where(b, c):hover" → ["a", ":where(b, c):hover"] (commas inside parentheses don't split). */
  function splitSelectors(list) {
    const out = [];
    let depth = 0;
    let cur = "";
    for (const ch of list) {
      if (ch === "(") depth += 1;
      if (ch === ")") depth -= 1;
      if (ch === "," && depth === 0) {
        out.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    out.push(cur.trim());
    return out.filter(Boolean);
  }
  // Selector specificity [b, c] for the simple selectors used here (no ids); :where() counts 0.
  function specificity(selector) {
    const sel = selector.replace(/:where\([^)]*\)/g, "");
    const b = (sel.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? []).length;
    const c = (sel.replace(/\[[^\]]+\]|\.[\w-]+|:[\w-]+/g, " ").match(/\b[a-z]+\b/g) ?? []).length;
    return b * 100 + c;
  }
  const rules = [...globalCss.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selectors: splitSelectors(m[1]), body: m[2] }));

  it("a pressed / current chip keeps its on-accent text and outline on hover (≥ 4.5:1 text, ≥ 3:1 outline)", () => {
    const pressed = rules.find((r) => r.selectors.includes('.chip[aria-pressed="true"]'));
    const hovers = rules.filter((r) => r.selectors.some((x) => x.includes("chip") && x.includes(":hover")));
    expect(hovers.length).toBeGreaterThan(0);
    // Hover may never out-rank the pressed/current rule (it used to: button.chip:hover set --text on the pink fill).
    for (const h of hovers) {
      if (!/\bcolor:|border-color:|background/.test(h.body)) continue;
      for (const sel of h.selectors) {
        for (const p of pressed.selectors) expect(specificity(sel), `${sel} vs ${p}`).toBeLessThan(specificity(p));
      }
    }
    const fg = pressed.body.match(/\scolor:\s*([^;]+);/)[1].trim();
    const bg = pressed.body.match(/background:\s*([^;]+);/)[1].trim();
    const outline = pressed.body.match(/border-color:\s*([^;]+);/)[1].trim();
    for (const light of [false, true]) {
      const vars = theme(light);
      expect(contrast(resolve(vars, fg), resolve(vars, bg))).toBeGreaterThanOrEqual(4.5);
      // WCAG 1.4.11: the pressed chip's boundary against the page and against cards.
      for (const around of ["var(--bg)", "var(--surface)"]) {
        expect(contrast(resolve(vars, outline), resolve(vars, around))).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
