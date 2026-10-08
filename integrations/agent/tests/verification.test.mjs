import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startPlayer } from "../../../server/index.mjs";
import { scorm12Zip } from "../../../tests/fixtures.mjs";
import { client } from "./helpers.mjs";

test("ordinary stdio MCP verifies and reloads the connected course browser", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scorm-mcp-browser-"));
  const registry = path.join(dir, "registry");
  const zip = path.join(dir, "course.zip");
  fs.writeFileSync(zip, scorm12Zip());
  const player = await startPlayer({ input: zip, port: 0, registryDir: registry, cacheDir: path.join(dir, "cache") });
  const rpc = client(fileURLToPath(new URL("../dist/server.mjs", import.meta.url)), registry, dir);
  const browser = await chromium.launch();
  try {
    await rpc.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ordinary-mcp", version: "1" } });
    rpc.notify("notifications/initialized");
    const call = async (name, args) => {
      const response = await rpc.request("tools/call", { name, arguments: args });
      assert.equal(response.error, undefined);
      return response.result;
    };
    const playerId = `${process.pid}:${new URL(player.url).port}`;
    const status = await call("scormplayer_get_status", { playerId });
    const scope = { playerId, revision: status.structuredContent.revision };
    const pin = player.pins.create({ note: "Check the heading", page: { url: "index.html" }, target: { tag: "h1", kind: "element", selector: "h1", text: "Safety first", attributes: { id: "title" } } });
    const absent = await call("scormplayer_verify_pin", { ...scope, id: pin.id });
    assert.equal(absent.isError, true);
    assert.match(absent.content[0].text, /No connected review browser/);
    const page = await browser.newPage();
    await page.goto(player.url);
    const heading = page.frameLocator("iframe.sp-frame").locator("h1");
    await heading.waitFor();
    // Give the fixture an explicit identity; the MCP still reads it through the browser bridge.
    await heading.evaluate((element) => { element.id = "title"; element.textContent = "Verified through ordinary MCP"; });
    await page.waitForFunction(async () => (await (await fetch("/api/browser/sessions")).json()).sessions.some((s) => s.ready));
    const sessions = await call("scormplayer_list_browser_sessions", scope);
    const sessionId = sessions.structuredContent.sessions[0].sessionId;
    const observed = await call("scormplayer_verify_pin", { ...scope, id: pin.id, sessionId });
    assert.equal(observed.isError, undefined, JSON.stringify(observed));
    assert.equal(observed.structuredContent.observation.status, "observed");
    assert.equal(observed.structuredContent.observation.targets[0].target.rawText, "Verified through ordinary MCP");
    assert.equal(player.pins.list()[0].status, "open");
    const stale = await call("scormplayer_verify_pin", { ...scope, revision: "retired", id: pin.id, sessionId });
    assert.equal(stale.isError, true);
    const reload = await call("scormplayer_reload", { ...scope, sessionId });
    assert.equal(reload.structuredContent.observation.status, "reload-requested");
    await page.waitForFunction(() => document.querySelector("iframe.sp-frame")?.contentDocument?.querySelector("h1")?.textContent !== "Verified through ordinary MCP");
  } finally { await browser.close(); rpc.close(); await player.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
