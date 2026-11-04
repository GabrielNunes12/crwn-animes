// Lighthouse CI configuration (docs/API.md v1.7 budgets). Used by run.mjs, which starts the
// seeded API and passes LH_BASE_URL / LH_PATHS; running `lhci autorun` by hand needs both too.
const base = process.env.LH_BASE_URL || "http://localhost:4717";
const paths = JSON.parse(process.env.LH_PATHS || '["/"]');

/** Same thresholds for every audited URL; the median run of each URL is asserted. */
const median = { aggregationMethod: "median-run" };

module.exports = {
  ci: {
    collect: {
      url: paths.map((p) => base + p),
      numberOfRuns: Number(process.env.LH_RUNS || 3),
      settings: {
        // Lighthouse's defaults, spelled out: the mobile preset (Moto G Power screen) with
        // simulated throttling (slow 4G, 4× CPU slowdown).
        formFactor: "mobile",
        throttlingMethod: "simulate",
        onlyCategories: ["performance", "accessibility", "best-practices", "seo"],
        // --no-sandbox: CI containers and root sandboxes cannot use Chrome's user-namespace sandbox.
        chromeFlags: "--headless=new --no-sandbox --disable-dev-shm-usage",
      },
    },
    assert: {
      assertions: {
        "categories:performance": ["error", { minScore: 0.9, ...median }],
        "categories:accessibility": ["error", { minScore: 0.9, ...median }],
        "categories:best-practices": ["error", { minScore: 0.9, ...median }],
        "categories:seo": ["error", { minScore: 0.9, ...median }],
        "cumulative-layout-shift": ["error", { maxNumericValue: 0.05, ...median }],
        "largest-contentful-paint": ["error", { maxNumericValue: 2500, ...median }],
        // Total JS the page downloads, as transferred (gzip when the server compresses). The
        // contract's "≤ 200 KB gzip" is also checked on the files themselves by run.mjs.
        "resource-summary:script:size": ["error", { maxNumericValue: 200 * 1024, ...median }],
        // Nothing on the audited pages may come from another host (YouTube loads only on Play).
        "resource-summary:third-party:count": ["error", { maxNumericValue: 0, ...median }],
      },
    },
    upload: {
      // Reports stay on the runner (uploaded as a CI artifact): no LHCI server, no public storage.
      target: "filesystem",
      outputDir: "./.lighthouseci/reports",
    },
  },
};
