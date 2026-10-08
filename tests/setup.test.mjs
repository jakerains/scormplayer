import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { SETUP_APPS, parseSetupSelection, installSetup, runSetup, runSetupMenu, shouldOfferSetup, mcpConfigPath } from "../server/setup.mjs";

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "scorm setup spaces "));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const source = path.join(home, "package", "dist", "mcp");
  fs.mkdirSync(path.join(source, "assets"), { recursive: true });
  fs.writeFileSync(path.join(source, "server.mjs"), 'console.log("fixture");');
  fs.writeFileSync(path.join(source, "assets", "widget.html"), "widget");
  fs.writeFileSync(path.join(source, "skills.json"), JSON.stringify({ serverVersion: "0.4.4", skills: [] }));
  return { home, source, directory: path.join(home, "persistent setup"), env: {}, node: "/Applications/Node Runtime/node", nodeVersion: "24.0.0", pluginStatus: async () => ({ results: [] }) };
}

test("one app selection drives MCP and one noninteractive skills install", async (t) => {
  const options = fixture(t);
  const hosts = [], skills = [];
  const result = await installSetup(["codex", "cursor", "claude-code", "claude-desktop", "cursor"], {
    ...options, skills: true, execute: async (...args) => { if (args[1][1] === "add") hosts.push(args); }, installSkills: async (...args) => { skills.push(args); return 0; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.results.length, 4);
  assert.equal(result.results[3].skills, "unsupported");
  assert.equal(skills.length, 1);
  const args = skills[0][0];
  assert.deepEqual(args.filter((arg, index) => args[index - 1] === "--agent"), ["codex", "cursor", "claude-code"]);
  assert.ok(args.includes("--global") && args.includes("--copy") && args.at(-2) === "--yes");
  assert.deepEqual(hosts[0][1].slice(0, 5), ["mcp", "add", "scormplayer", "--", options.node]);
  const cursor = JSON.parse(fs.readFileSync(path.join(options.home, ".cursor", "mcp.json"), "utf8"));
  assert.equal(cursor.mcpServers.scormplayer.command, options.node);
  const entry = cursor.mcpServers.scormplayer.args[0];
  assert.ok(entry.includes("persistent setup"));
  fs.rmSync(path.dirname(options.source), { recursive: true });
  assert.ok(fs.existsSync(entry));
  assert.equal(fs.readFileSync(path.join(path.dirname(entry), "assets", "widget.html"), "utf8"), "widget");
});

test("MCP JSON installs preserve other settings and update only owned snapshots", async (t) => {
  const options = fixture(t);
  const file = path.join(options.home, ".cursor", "mcp.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const initial = JSON.stringify({ preference: "keep", mcpServers: { other: { command: "other" } } });
  fs.writeFileSync(file, initial);
  assert.equal((await installSetup(["cursor"], { ...options, skills: false })).ok, true);
  assert.equal(fs.readFileSync(`${file}.scormplayer-backup`, "utf8"), initial);
  fs.writeFileSync(path.join(options.source, "server.mjs"), "updated");
  assert.equal((await installSetup(["cursor"], { ...options, skills: false })).ok, true);
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(config.preference, "keep");
  assert.equal(config.mcpServers.other.command, "other");
  assert.equal(fs.readFileSync(config.mcpServers.scormplayer.args[0], "utf8"), "updated");
});

test("default setup carries MCP guidance without running a filesystem skills installer", async (t) => {
  const options = fixture(t);
  const result = await installSetup(["cursor", "claude-desktop"], { ...options, installSkills: async () => assert.fail("default setup must stay local") });
  assert.equal(result.ok, true);
  assert.ok(result.results.every((item) => item.mcp === "configured" && item.skills === "bundled"));
  const config = JSON.parse(fs.readFileSync(path.join(options.home, ".cursor", "mcp.json"), "utf8"));
  assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(config.mcpServers.scormplayer.args[0]), "skills.json"), "utf8")).serverVersion, "0.4.4");
});

test("setup refreshes an older native provider and verifies its version without adding MCP twice", async (t) => {
  const options = fixture(t);
  let calls = 0;
  const result = await installSetup(["cursor"], { ...options,
    pluginStatus: async () => ({ results: [{ host: "cursor", installed: true, versions: ["0.4.2"] }] }),
    installPlugin: async (host) => { calls++; assert.equal(host, "cursor"); return { ok: true, results: [{ host, installed: true, versions: ["0.4.4"] }] }; },
    writeConfig: async () => assert.fail("duplicate server"), installSkills: async () => assert.fail("duplicate filesystem skills"),
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.results[0].mcp, "updated-plugin");
  assert.equal(result.results[0].skills, "bundled");
  const failed = await installSetup(["cursor"], { ...options,
    pluginStatus: async () => ({ results: [{ host: "cursor", installed: true, versions: ["0.4.2"] }] }),
    installPlugin: async () => ({ ok: true, results: [{ host: "cursor", installed: true, versions: ["0.4.2"] }] }),
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.results[0].mcp, "failed");
  assert.equal(failed.results[0].skills, "skipped");
});

test("skill-only fallback runs once and does not touch MCP or plugin configuration", async (t) => {
  const calls = [];
  const result = await installSetup(["cursor", "claude-code"], { ...fixture(t), mcp: false, skills: true,
    pluginStatus: async () => assert.fail("no MCP"), writeConfig: async () => assert.fail("no MCP"),
    installSkills: async (args) => { calls.push(args); return 0; },
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.ok(result.results.every((item) => item.mcp === "skipped" && item.skills === "installed"));
});

test("invalid or unrelated SCORM config is preserved and other selected apps continue", async (t) => {
  const options = fixture(t);
  const file = path.join(options.home, ".cursor", "mcp.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const original of ["invalid json", JSON.stringify({ mcpServers: { scormplayer: { command: "custom" } } })]) {
    fs.writeFileSync(file, original);
    const result = await installSetup(["cursor", "gemini-cli"], { ...options, skills: false });
    assert.equal(result.ok, false);
    assert.equal(result.results[0].mcp, "failed");
    assert.equal(result.results[1].mcp, "configured");
    assert.equal(fs.readFileSync(file, "utf8"), original);
  }
});

test("existing native provider is reused without a duplicate MCP server", async (t) => {
  const options = fixture(t);
  const result = await installSetup(["codex", "cursor"], { ...options, skills: false,
    pluginStatus: async () => ({ results: [{ installed: true, enabled: true, versions: ["0.4.4"] }] }),
    execute: async () => assert.fail("duplicate MCP command"), writeConfig: async () => assert.fail("duplicate MCP config"),
  });
  assert.equal(result.ok, true);
  assert.ok(result.results.every((item) => item.mcp === "existing-plugin"));
  assert.equal(fs.existsSync(options.directory), false);
});

test("skill failure is reported independently of successfully configured MCP", async (t) => {
  const result = await installSetup(["cursor"], { ...fixture(t), skills: true, installSkills: async () => 1 });
  assert.equal(result.ok, false);
  assert.equal(result.results[0].mcp, "configured");
  assert.equal(result.results[0].skills, "failed");
});

test("MCP runtime guard allows skill-only setup on Node 20", async (t) => {
  const options = { ...fixture(t), nodeVersion: "20.0.0", installSkills: async () => 0 };
  await assert.rejects(installSetup(["cursor"], options), /22.22.2/);
  assert.equal((await installSetup(["cursor"], { ...options, mcp: false, skills: true })).ok, true);
});

test("first-run setup never prompts in CI, JSON, plain mode or without a terminal", async (t) => {
  const options = { ...fixture(t), input: { isTTY: true }, output: { isTTY: true } };
  assert.equal(shouldOfferSetup(options), true);
  for (const changes of [{ env: { CI: "true" } }, { json: true }, { plain: true }, { input: {} }, { output: {} }]) assert.equal(shouldOfferSetup({ ...options, ...changes }), false);
  fs.mkdirSync(options.directory, { recursive: true });
  fs.writeFileSync(path.join(options.directory, "choice.json"), "{}");
  assert.equal(shouldOfferSetup(options), false);
});

test("explicit setup bypasses picker and suppresses skills stdout in JSON mode", async (t) => {
  const options = fixture(t);
  let output = "", calls = 0;
  const stream = new Writable({ write(chunk, encoding, callback) { output += chunk; callback(); } });
  await assert.rejects(runSetup({ ...options, output: stream }), /terminal/);
  const result = await runSetup({ ...options, ids: ["cursor"], json: true, output: stream,
    install: async (ids, config) => { calls++; assert.deepEqual(ids, ["cursor"]); assert.equal(config.quiet, true); return { ok: true, results: [] }; },
  });
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(output), result);
  assert.ok(fs.existsSync(path.join(options.directory, "choice.json")));
});

test("terminal setup chooses an install mode before one shared app picker, with safe cancel and retry", async () => {
  const input = { isTTY: true }, output = { isTTY: true, write() {} };
  const modes = [{ mcp: true, skills: false }, { mcp: true, skills: true }, { mcp: false, skills: true }];
  for (const [index, mode] of modes.entries()) {
    let calls = 0, menus = 0;
    const result = await runSetupMenu({ input, output, env: {},
      choose: async ({ items }) => { menus++; assert.equal(items.length, menus === 1 ? 3 : 1); return index; },
      setup: async (options) => { calls++; assert.equal(options.mcp, mode.mcp); assert.equal(options.skills, mode.skills); assert.equal(options.ids, undefined, "the existing setup owns the single app picker"); return { ok: true }; },
    });
    assert.equal(result.ok, true);
    assert.equal(calls, 1);
    assert.equal(menus, 2, "results remain visible until the user returns");
  }
  assert.equal(await runSetupMenu({ input, output, env: {}, choose: async () => null, setup: async () => assert.fail("cancel must not install") }), null);
  let errorText = "", menus = 0;
  await runSetupMenu({ input, output: { isTTY: true, write: (text) => { errorText += text; } }, env: {}, choose: async () => { menus++; return 0; }, setup: async () => { throw new Error("Host unavailable"); } });
  assert.match(errorText, /Host unavailable/);
  assert.equal(menus, 2, "a setup failure still returns to the player");
  await assert.rejects(runSetupMenu({ input, output, env: { CI: "1" }, choose: async () => assert.fail("no prompt in CI") }), /terminal/);
});

test("app selection and platform config paths are explicit", () => {
  assert.deepEqual(parseSetupSelection("1,3,1"), ["codex", "cursor"]);
  assert.deepEqual(parseSetupSelection(""), []);
  assert.throws(() => parseSetupSelection("9"));
  const app = SETUP_APPS.find((item) => item.id === "claude-desktop");
  assert.equal(mcpConfigPath(app, { home: "/home/test", platform: "darwin", env: {} }), "/home/test/Library/Application Support/Claude/claude_desktop_config.json");
  assert.equal(mcpConfigPath(app, { home: "/home/test", platform: "linux", env: { XDG_CONFIG_HOME: "/configs" } }), "/configs/Claude/claude_desktop_config.json");
  assert.equal(mcpConfigPath(app, { home: "/home/test", platform: "win32", env: { APPDATA: "/roaming" } }), "/roaming/Claude/claude_desktop_config.json");
});

test("CLI config guards preserve an unrelated Codex server and disabled native packages", async (t) => {
  const options = fixture(t);
  const result = await installSetup(["codex"], { ...options, skills: false,
    execute: async (host, args) => {
      assert.equal(args[1], "get");
      return JSON.stringify({ transport: { command: "custom", args: [] } });
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.results[0].error, /preserved/);
  const disabled = await installSetup(["cursor"], { ...options, skills: false, pluginStatus: async () => ({ results: [{ installed: true, enabled: false }] }) });
  assert.equal(disabled.ok, false);
  assert.match(disabled.results[0].error, /disabled/);
});
