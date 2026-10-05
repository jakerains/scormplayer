import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { transformWithOxc } from "vite";

const source = fs.readFileSync(new URL("../client/src/scorm-state.ts", import.meta.url), "utf8");
const { code } = await transformWithOxc(source, "scorm-state.ts");
const { ScormPersistence } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);

test("a failed earlier commit cannot replace a newer queued save on retry", async () => {
  const previous = globalThis.window;
  globalThis.window = { setTimeout, clearTimeout };
  const writes = [];
  let rejectFirst;
  const state = { saved: true, epoch: 0, selectedSco: "", modules: {} };
  const persistence = new ScormPersistence(state, async (patch) => {
    writes.push(structuredClone(patch));
    if (writes.length === 1) await new Promise((_, reject) => { rejectFirst = reject; });
    return { ...state, ...patch };
  }, () => {});
  try {
    persistence.update("", { "cmi.suspend_data": "earlier" });
    const first = persistence.flush();
    await new Promise((resolve) => setImmediate(resolve));
    persistence.update("", { "cmi.suspend_data": "newer" });
    const second = persistence.flush();
    rejectFirst(new Error("Temporary outage"));
    await first;
    await second;
    await persistence.flush();
    assert.equal(writes.at(-1).modules[""]["cmi.suspend_data"], "newer");
  } finally { globalThis.window = previous; }
});
