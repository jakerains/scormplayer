import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hostCommand, managePlugins } from "../server/plugins.mjs";

test("Windows npm shims launch through Node and preserve arguments without a shell", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scorm-host-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const folder = path.join(dir, "user & data");
  const entry = path.join(folder, "node_modules", "@openai", "codex", "bin", "codex.js");
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, "// CLI");
  fs.writeFileSync(path.join(folder, "codex.cmd"), '"%_prog%" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*');
  const args = ["plugin", "marketplace", "add", path.join(dir, "space & caret^ % path")];
  assert.deepEqual(hostCommand("codex", args, { platform: "win32", searchPath: folder }), { file: process.execPath, args: [entry, ...args] });
  assert.deepEqual(hostCommand("codex", args, { platform: "linux" }), { file: "codex", args });
});

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scorm-plugin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bundled = path.join(dir, "npm package"), destination = path.join(dir, "user data");
  for (const host of ["codex", "claude", "cursor"]) {
    const root = path.join(bundled, host, host === "cursor" ? "scormplayer-cursor" : "scormplayer");
    const manifest = path.join(root, host === "codex" ? "plugin.json" : `.${host}-plugin/plugin.json`);
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    fs.writeFileSync(manifest, JSON.stringify({ name: host === "cursor" ? "scormplayer-cursor" : "scormplayer", version: "0.2.0" }));
    fs.writeFileSync(path.join(root, "server.mjs"), "// bundled server");
    if (host === "cursor") {
      fs.writeFileSync(path.join(root, "mcp.json"), JSON.stringify({ mcpServers: { scormplayer: { type: "stdio", command: "node", args: ["${CURSOR_PLUGIN_ROOT}/server.mjs"], cwd: "${CURSOR_PLUGIN_ROOT}" } } }));
      continue;
    }
    const marketplace = path.join(bundled, host === "codex" ? ".agents/plugins/marketplace.json" : ".claude-plugin/marketplace.json");
    fs.mkdirSync(path.dirname(marketplace), { recursive: true });
    fs.writeFileSync(marketplace, JSON.stringify({ name: "scormplayer-local", plugins: [{ name: "scormplayer", source: "unused" }] }));
  }
  return { bundled, destination, cursorDirectory: path.join(dir, ".cursor", "plugins", "local"), nodeVersion: "24.0.0" };
}

test("plugin install persists complete packages outside npm and updates existing Claude versions", async (t) => {
  const options = fixture(t), calls = [];
  let claudeVersion = "0.1.1";
  options.execute = async (host, args) => {
    calls.push([host, ...args]);
    if (host === "claude" && args[1] === "update") claudeVersion = "0.2.0";
    if (args[1] !== "list") return {};
    const entry = { id: "scormplayer@scormplayer-local", pluginId: "scormplayer@scormplayer-local", scope: "user", enabled: true, version: host === "claude" ? claudeVersion : "0.2.0" };
    return host === "codex" ? { installed: [entry] } : [entry];
  };
  const result = await managePlugins("install", "all", options);
  assert.equal(result.ok, true, JSON.stringify(result));
  const manifest = JSON.parse(fs.readFileSync(path.join(options.destination, ".agents/plugins/marketplace.json")));
  const snapshot = path.join(options.destination, manifest.plugins[0].source.path);
  fs.rmSync(options.bundled, { recursive: true });
  assert.equal(fs.readFileSync(path.join(snapshot, "server.mjs"), "utf8"), "// bundled server");
  assert.ok(calls.some((args) => args[0] === "claude" && args[2] === "update"));
  assert.ok(calls.some((args) => args.includes(options.destination)), "paths containing spaces remain one argument");
});

test("plugin status is read-only and reports one host failing without hiding the other", async (t) => {
  const options = fixture(t);
  options.execute = async (host, args) => {
    assert.deepEqual(args, ["plugin", "list", "--json"]);
    if (host === "codex") throw new Error("CLI missing");
    return [];
  };
  const result = await managePlugins("status", "all", options);
  assert.equal(result.ok, false);
  assert.equal(result.results[1].installed, false);
  assert.equal(result.results[2].installed, false);
  assert.equal(fs.existsSync(options.destination), false);
  assert.equal(fs.existsSync(options.cursorDirectory), false);
});

test("Cursor installs real local assets, survives npm removal and preserves other configuration", async (t) => {
  const options = fixture(t);
  options.execute = () => { throw new Error("Cursor installation needs no CLI"); };
  fs.mkdirSync(path.join(options.cursorDirectory, "other-plugin"), { recursive: true });
  fs.writeFileSync(path.join(options.cursorDirectory, "other-plugin", "keep.txt"), "keep");
  const userConfig = path.resolve(options.cursorDirectory, "../../mcp.json");
  fs.writeFileSync(userConfig, '{"mcpServers":{"other":{"command":"other"}}}');
  const result = await managePlugins("install", "cursor", options);
  assert.equal(result.ok, true, JSON.stringify(result));
  const installed = result.results[0].location;
  assert.equal(result.results[0].enabled, null, "files cannot prove Cursor has enabled it");
  assert.equal(result.results[0].activation, "reload-required");
  assert.equal(fs.lstatSync(installed).isSymbolicLink(), false);
  const config = JSON.parse(fs.readFileSync(path.join(installed, "mcp.json")));
  assert.equal(config.mcpServers.scormplayer.command, process.execPath);
  assert.deepEqual(config.mcpServers.scormplayer.args, ["${CURSOR_PLUGIN_ROOT}/server.mjs"]);
  fs.rmSync(options.bundled, { recursive: true });
  assert.equal((await managePlugins("status", "cursor", options)).results[0].installed, true);
  assert.equal(fs.readFileSync(path.join(installed, "server.mjs"), "utf8"), "// bundled server");
  assert.equal(fs.readFileSync(userConfig, "utf8"), '{"mcpServers":{"other":{"command":"other"}}}');
  assert.equal(fs.readFileSync(path.join(options.cursorDirectory, "other-plugin", "keep.txt"), "utf8"), "keep");
});

test("Cursor upgrades preserve a previous copy and reject overwriting local edits or unmanaged plugins", async (t) => {
  const options = fixture(t);
  assert.equal((await managePlugins("install", "cursor", options)).ok, true);
  const usage = path.join(options.cursorDirectory, "scormplayer-cursor", ".mcp-use", "usage.json");
  fs.mkdirSync(path.dirname(usage));
  fs.writeFileSync(usage, '{"tools":1}');
  const source = path.join(options.bundled, "cursor", "scormplayer-cursor");
  fs.writeFileSync(path.join(source, "server.mjs"), "// upgraded server");
  const upgraded = await managePlugins("install", "cursor", options);
  assert.equal(upgraded.ok, true, JSON.stringify(upgraded));
  assert.equal(fs.readFileSync(path.join(upgraded.results[0].backup, "server.mjs"), "utf8"), "// bundled server");
  const installed = upgraded.results[0].location;
  fs.writeFileSync(path.join(installed, "custom.txt"), "local edit");
  const changed = await managePlugins("install", "cursor", options);
  assert.equal(changed.ok, false);
  assert.match(changed.results[0].error, /Preserve local edits/);
  assert.equal(fs.readFileSync(path.join(installed, "custom.txt"), "utf8"), "local edit");
  fs.rmSync(path.join(installed, ".scormplayer-install.json"));
  const unmanaged = await managePlugins("install", "cursor", options);
  assert.equal(unmanaged.ok, false);
  assert.match(unmanaged.results[0].error, /unmanaged/);
  assert.equal(fs.readFileSync(path.join(installed, "custom.txt"), "utf8"), "local edit");
});

test("Cursor rejects a bundled symlink rather than installing escaping assets", async (t) => {
  const options = fixture(t);
  const source = path.join(options.bundled, "cursor", "scormplayer-cursor");
  fs.symlinkSync(options.bundled, path.join(source, "outside"), "junction");
  const result = await managePlugins("install", "cursor", options);
  assert.equal(result.ok, false);
  assert.match(result.results[0].error, /regular files and directories/);
  assert.equal(fs.existsSync(options.cursorDirectory), false);
});

test("plugin install rejects unsupported Node and stale host versions", async (t) => {
  const options = fixture(t);
  await assert.rejects(managePlugins("install", "codex", { ...options, nodeVersion: "20.19.0" }), /22.22.2/);
  options.execute = async (_host, args) => args[1] === "list" ? { installed: [{ pluginId: "scormplayer@scormplayer-local", enabled: true, version: "0.1.1" }] } : {};
  const result = await managePlugins("install", "codex", options);
  assert.equal(result.ok, false);
  assert.match(result.results[0].error, /bundled version 0.2.0/);
});

test("repeated plugin installation reuses its snapshot and preserves unrelated files", async (t) => {
  const options = fixture(t);
  fs.mkdirSync(options.destination, { recursive: true });
  fs.writeFileSync(path.join(options.destination, "keep.txt"), "keep");
  options.execute = async (_host, args) => args[1] === "list" ? { installed: [{ pluginId: "scormplayer@scormplayer-local", enabled: true, version: "0.2.0" }] } : {};
  assert.equal((await managePlugins("install", "codex", options)).ok, true);
  const first = fs.readFileSync(path.join(options.destination, ".agents/plugins/marketplace.json"), "utf8");
  assert.equal((await managePlugins("install", "codex", options)).ok, true);
  assert.equal(fs.readFileSync(path.join(options.destination, ".agents/plugins/marketplace.json"), "utf8"), first);
  assert.equal(fs.readFileSync(path.join(options.destination, "keep.txt"), "utf8"), "keep");
});
