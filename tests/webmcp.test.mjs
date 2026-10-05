import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { transformWithOxc } from "vite";
const source = fs.readFileSync(new URL("../client/src/webmcp.ts", import.meta.url), "utf8");
const { code: output } = await transformWithOxc(source, "webmcp.ts");
const { registerWebMcpTools } = await import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("WebMCP registration failures do not shift cleanup names and async handles are disposed", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  const removed = [], definitions = [];
  let delayed;
  Object.defineProperty(globalThis, "document", { configurable: true, value: { modelContext: {
    registerTool(definition) {
      definitions.push(definition);
      if (definition.name === "scormplayer_status") throw new Error("unsupported");
      if (definition.name === "scormplayer_go_to_page") return Promise.reject(new Error("rejected"));
      if (definition.name === "scormplayer_switch_module") return new Promise((resolve) => { delayed = resolve; });
      return undefined;
    },
    unregisterTool(name) { removed.push(name); },
  } } });
  const cleanup = registerWebMcpTools(() => ({}));
  try {
    await tick(); cleanup();
    delayed({ dispose() { removed.push("delayed handle"); } });
    await tick();
    assert.ok(!removed.includes("scormplayer_status"));
    assert.ok(!removed.includes("scormplayer_go_to_page"));
    assert.ok(removed.includes("scormplayer_scorm_data"));
    assert.ok(removed.includes("scormplayer_open_pin"));
    assert.equal(removed.filter((value) => value === "delayed handle").length, 1);
    assert.equal(removed.length, definitions.length - 2);
  } finally { if (previous) Object.defineProperty(globalThis, "document", previous); else delete globalThis.document; }
});

test("WebMCP validates input before activity and reports stale-session errors", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  const tools = new Map();
  let activity = 0;
  Object.defineProperty(globalThis, "document", { configurable: true, value: { modelContext: { registerTool(tool) { tools.set(tool.name, tool); } } } });
  const cleanup = registerWebMcpTools(() => ({ activity: async () => { activity++; throw new Error("The course changed"); } }));
  try {
    const invalid = await tools.get("scormplayer_go_to_page").execute({ page: " " });
    assert.equal(invalid.isError, true);
    assert.equal(activity, 0);
    const stale = await tools.get("scormplayer_status").execute({});
    assert.equal(stale.isError, true);
    assert.match(stale.content[0].text, /course changed/);
    assert.equal(activity, 1);
  } finally { cleanup(); await tick(); if (previous) Object.defineProperty(globalThis, "document", previous); else delete globalThis.document; }
});
