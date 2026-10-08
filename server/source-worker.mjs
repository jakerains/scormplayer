import { parentPort } from "node:worker_threads";
import { findSourceEvidence } from "./source-match.mjs";

parentPort.on("message", ({ id, root, target }) => {
  let matches = { source: [], sourceSearch: { truncated: true, advice: "Source search failed." } };
  try { matches = findSourceEvidence(root, target); } catch { /* enrichment is optional */ }
  parentPort.postMessage({ id, matches });
});
