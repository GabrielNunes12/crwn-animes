// Scratch analysis (deleted after use): Lantern node timings of the LCP estimate.
import {loadArtifacts} from "lighthouse/core/lib/asset-saver.js";
import {LanternLargestContentfulPaint} from "lighthouse/core/computed/metrics/lantern-largest-contentful-paint.js";
import {LanternFirstContentfulPaint} from "lighthouse/core/computed/metrics/lantern-first-contentful-paint.js";
import defaultConfig from "lighthouse/core/config/default-config.js";
import {initializeConfig} from "lighthouse/core/config/config.js";
const dir = process.argv[2];
const artifacts = await loadArtifacts(dir);
const {resolvedConfig} = await initializeConfig("navigation", defaultConfig);
const settings = resolvedConfig.settings;
const context = {computedCache: new Map(), settings};
const trace = artifacts.Trace ?? artifacts.traces.defaultPass;
const devtoolsLog = artifacts.DevtoolsLog ?? artifacts.devtoolsLogs.defaultPass;
const data = {trace, devtoolsLog, gatherContext: artifacts.GatherContext, settings, URL: artifacts.URL, SourceMaps: [], simulator: null};
for (const [name, M] of [["FCP", LanternFirstContentfulPaint], ["LCP", LanternLargestContentfulPaint]]) {
  const r = await M.request(data, context);
  console.log(`\n=== ${name} ${Math.round(r.timing)} (opt ${Math.round(r.optimisticEstimate.timeInMs)}, pess ${Math.round(r.pessimisticEstimate.timeInMs)})`);
  if (name !== "LCP") continue;
  const rows = [...r.pessimisticEstimate.nodeTimings.entries()].map(([node, t]) => ({ node, ...t })).sort((a, b) => a.startTime - b.startTime);
  for (const x of rows) {
    const n = x.node;
    const label = n.type === "network" ? `NET ${n.request.url.replace(/http:\/\/localhost:\d+/, "")} ${n.request.transferSize}B` : `CPU ${Math.round(n.duration ?? (n.endTime - n.startTime))}us-observed`;
    if (n.type === "cpu" && x.duration < 15) continue;
    console.log(String(Math.round(x.startTime)).padStart(6), String(Math.round(x.endTime)).padStart(6), String(Math.round(x.duration)).padStart(5), label);
  }
}
{
  const r = await LanternLargestContentfulPaint.request(data, context);
  const label = (n) => n.type === "network" ? `NET ${n.request.url.replace(/http:\/\/localhost:\d+/, "")}` : `CPU@${Math.round((n.startTime - r.pessimisticGraph.startTime) / 1000)}ms obs ${Math.round((n.endTime - n.startTime) / 1000)}ms`;
  console.log("\n--- dependencies");
  r.pessimisticGraph.traverse((n) => {
    if (n.type === "network" && /api|en-|Home-|index-/.test(n.request.url)) console.log(label(n), "<=", n.getDependencies().map(label).join(" | "));
    if (n.type === "cpu" && (n.endTime - n.startTime) > 5000) console.log(label(n), "<=", n.getDependencies().map(label).join(" | "), " => ", n.getDependents().map(label).slice(0, 12).join(" | "));
  });
}
