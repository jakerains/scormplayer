import { parentPort } from "node:worker_threads";
import { findSourceText } from "./source-match.mjs";

parentPort.on("message", ({ id, root, text }) => {
  let matches = [];
  try { matches = findSourceText(root, text); } catch { /* enrichment is optional */ }
  parentPort.postMessage({ id, matches });
});
