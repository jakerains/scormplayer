import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import lockfile from "proper-lockfile";
import { UserError } from "./course.mjs";

const exec = promisify(execFile);
const ID = "scormplayer@scormplayer-local";
const BUNDLED = fileURLToPath(new URL("../dist/plugins/", import.meta.url));

/** npm's Windows shims launch JavaScript; invoke that entry with Node without shell quoting. */
export function hostCommand(host, args, { platform = process.platform, searchPath = process.env.PATH ?? "" } = {}) {
  if (platform !== "win32") return { file: host, args };
  for (const folder of searchPath.split(";").filter(Boolean)) {
    const native = path.join(folder, `${host}.exe`);
    if (fs.existsSync(native)) return { file: native, args };
    const shim = path.join(folder, `${host}.cmd`);
    if (!fs.existsSync(shim)) continue;
    const entry = /"%dp0%[\\/]([^"\r\n]+\.(?:c?js|mjs))"/i.exec(fs.readFileSync(shim, "utf8"));
    const script = entry && path.join(folder, ...entry[1].split(/[\\/]/));
    if (script && fs.existsSync(script)) return { file: process.execPath, args: [script, ...args] };
    throw new UserError(`The ${host} Windows launcher is unsupported. Use its native installer or npm installation.`);
  }
  return { file: host, args };
}

function dataDirectory() {
  const home = process.env.XDG_DATA_HOME || (process.platform === "win32"
    ? process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
    : path.join(os.homedir(), ".local", "share"));
  return path.join(home, "scormplayer", "plugins");
}

async function run(host, args) {
  try {
    const command = hostCommand(host, args);
    const { stdout } = await exec(command.file, command.args, { timeout: 60000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    return JSON.parse(stdout);
  } catch (error) {
    if (error.code === "ENOENT") throw new UserError(`Install the ${host} CLI first, then run this command again.`);
    throw new UserError(`${host} ${args.slice(0, 2).join(" ")} failed: ${error.stderr?.trim() || error.stdout?.trim() || error.message}`);
  }
}

function hostsFor(target) {
  if (target === "all") return ["codex", "claude", "cursor"];
  if (["codex", "claude", "cursor"].includes(target)) return [target];
  throw new UserError("Usage: scormplayer plugin install <codex|claude|cursor|all> (or plugin status [codex|claude|cursor|all])");
}

function nodeSupported(version) {
  const [major, minor, patch] = version.split(".").map(Number);
  return major > 22 || (major === 22 && (minor > 22 || (minor === 22 && patch >= 2)));
}

// Keep the registered source outside npm/npx directories, which may disappear on upgrade.
// Each snapshot is immutable. Only the selected host's marketplace pointer is updated.
function bundledSource(host, bundled) {
  const source = path.join(bundled, host, host === "cursor" ? "scormplayer-cursor" : "scormplayer");
  if (!fs.existsSync(path.join(source, "server.mjs"))) {
    throw new UserError("This copy has no bundled plugins. In a source checkout, run npm ci --prefix integrations/agent && npm run build:plugins.");
  }
  return source;
}

function fingerprint(source) {
  const hash = createHash("sha256");
  const visit = (dir, prefix = "") => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = path.join(prefix, entry.name);
      // mcp-use writes its usage counters in cwd when the host starts the server.
      if (relative === ".scormplayer-install.json" || relative === path.join(".mcp-use", "usage.json")) continue;
      if (entry.isDirectory()) visit(path.join(dir, entry.name), relative);
      else if (entry.isFile()) hash.update(relative).update("\0").update(fs.readFileSync(path.join(dir, entry.name))).update("\0");
      else throw new UserError("Bundled plugins must contain regular files and directories only.");
    }
  };
  visit(source);
  return hash.digest("hex");
}

function stage(host, bundled, destination) {
  const source = bundledSource(host, bundled);
  const snapshot = `versions/${fingerprint(source).slice(0, 24)}/${host}/scormplayer`;
  const installed = path.join(destination, snapshot);
  if (!fs.existsSync(installed)) {
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    const temporary = fs.mkdtempSync(path.join(path.dirname(installed), ".staging-"));
    try {
      fs.cpSync(source, temporary, { recursive: true });
      fs.renameSync(temporary, installed);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
  const manifest = host === "codex" ? ".agents/plugins/marketplace.json" : ".claude-plugin/marketplace.json";
  const marketplace = JSON.parse(fs.readFileSync(path.join(bundled, manifest), "utf8"));
  marketplace.plugins[0].source = host === "codex" ? { source: "local", path: `./${snapshot}` } : `./${snapshot}`;
  const file = path.join(destination, manifest);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(marketplace, null, 2) + "\n");
  return destination;
}

const CURSOR_RECEIPT = ".scormplayer-install.json";
const CURSOR_MANAGER = "@jakerains/scormplayer";

function cursorStatus(directory, { checkRuntime = true } = {}) {
  const location = path.join(directory, "scormplayer-cursor");
  if (!fs.existsSync(location)) return { host: "cursor", ok: true, installed: false, enabled: null, versions: [], location, activation: "host-managed" };
  if (fs.lstatSync(location).isSymbolicLink()) throw new UserError("Cursor's scormplayer plugin is a symlink. Cursor may skip links outside its local plugins folder; install a real copy.");
  const manifest = JSON.parse(fs.readFileSync(path.join(location, ".cursor-plugin", "plugin.json"), "utf8"));
  const config = JSON.parse(fs.readFileSync(path.join(location, "mcp.json"), "utf8"));
  if (manifest.name !== "scormplayer-cursor" || !fs.existsSync(path.join(location, "server.mjs")) || !config.mcpServers?.scormplayer) throw new UserError("Cursor's local scormplayer package is incomplete. Reinstall the plugin.");
  const receiptPath = path.join(location, CURSOR_RECEIPT);
  const receipt = fs.existsSync(receiptPath) ? JSON.parse(fs.readFileSync(receiptPath, "utf8")) : null;
  if (receipt && (receipt.manager !== CURSOR_MANAGER || receipt.hash !== fingerprint(location))) throw new UserError("Cursor's installed plugin has changed since installation. Preserve local edits before reinstalling.");
  const node = config.mcpServers.scormplayer.command;
  if (typeof node !== "string") throw new UserError("Cursor's plugin has no Node command. Reinstall the plugin.");
  if (checkRuntime && path.isAbsolute(node) && !fs.existsSync(node)) throw new UserError(`Cursor's configured Node executable is missing: ${node}. Reinstall using your current Node.js 22.22.2+ runtime.`);
  // Files establish installation, not whether Cursor has loaded/enabled its components.
  return { host: "cursor", ok: true, installed: true, enabled: null, versions: [manifest.version], location, node, activation: "host-managed" };
}

async function installCursor(bundled, directory) {
  const source = bundledSource("cursor", bundled);
  fingerprint(source); // Reject symlinks before copying; Cursor needs real local assets.
  fs.mkdirSync(directory, { recursive: true });
  const parent = path.dirname(directory);
  const release = await lockfile.lock(directory, { lockfilePath: path.join(parent, ".scormplayer-install.lock"), stale: 60000 });
  let temporary;
  const location = path.join(directory, "scormplayer-cursor");
  try {
    const existing = fs.existsSync(location);
    if (existing) {
      cursorStatus(directory, { checkRuntime: false });
      const receipt = path.join(location, CURSOR_RECEIPT);
      if (!fs.existsSync(receipt)) throw new UserError(`An unmanaged Cursor plugin already exists at ${location}. Move it aside before installing; its files have been preserved.`);
    }
    temporary = fs.mkdtempSync(path.join(parent, ".scormplayer-install-"));
    const next = path.join(temporary, "next");
    fs.cpSync(source, next, { recursive: true });
    const configPath = path.join(next, "mcp.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    // Dock-launched editors often have a different PATH from the installing shell.
    config.mcpServers.scormplayer.command = process.execPath;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    fs.writeFileSync(path.join(next, CURSOR_RECEIPT), JSON.stringify({ manager: CURSOR_MANAGER, hash: fingerprint(next) }, null, 2) + "\n");
    const backup = path.join(temporary, "previous");
    if (existing) fs.renameSync(location, backup);
    try { fs.renameSync(next, location); }
    catch (error) {
      if (existing) fs.renameSync(backup, location);
      throw error;
    }
    const result = { ...cursorStatus(directory), activation: "reload-required", ...(existing ? { backup } : {}) };
    if (!existing) fs.rmSync(temporary, { recursive: true, force: true });
    return result;
  } finally {
    // A failed rollback must leave the recoverable previous copy intact.
    if (temporary && !fs.existsSync(path.join(temporary, "previous"))) fs.rmSync(temporary, { recursive: true, force: true });
    await release();
  }
}

export async function managePlugins(action = "status", target = "all", {
  bundled = BUNDLED, destination = dataDirectory(), execute = run, nodeVersion = process.versions.node,
  cursorDirectory = path.join(os.homedir(), ".cursor", "plugins", "local"),
} = {}) {
  if (!["install", "status"].includes(action)) throw new UserError("Plugin commands: install <codex|claude|cursor|all>, status [codex|claude|cursor|all].");
  const hosts = hostsFor(target);
  if (action === "install" && !nodeSupported(nodeVersion)) throw new UserError("The plugin requires Node.js 22.22.2 or newer. The player itself can still run on Node.js 20.");
  const results = [];
  for (const host of hosts) {
    try {
      if (host === "cursor") {
        results.push(action === "install" ? await installCursor(bundled, cursorDirectory) : cursorStatus(cursorDirectory));
        continue;
      }
      let expectedVersion;
      if (action === "install") {
        const manifest = host === "codex" ? "plugin.json" : ".claude-plugin/plugin.json";
        const versionFile = path.join(bundled, host, "scormplayer", manifest);
        if (fs.existsSync(versionFile)) expectedVersion = JSON.parse(fs.readFileSync(versionFile, "utf8")).version;
        const source = stage(host, bundled, destination);
        await execute(host, ["plugin", "marketplace", "add", source, "--json"]);
        await execute(host, ["plugin", host === "codex" ? "add" : "install", ID, ...(host === "claude" ? ["--scope", "user"] : []), "--json"]);
        // Claude's install command leaves an existing version intact. Explicitly refresh it.
        if (host === "claude") await execute(host, ["plugin", "update", ID, "--scope", "user", "--json"]);
      }
      const listing = await execute(host, ["plugin", "list", "--json"]);
      const entries = host === "codex" ? listing.installed : listing;
      if (!Array.isArray(entries)) throw new Error("Unrecognized plugin list response; update the host CLI.");
      const matches = entries.filter((entry) => (entry.pluginId ?? entry.id) === ID);
      const installed = matches.length > 0;
      const enabled = matches.some((entry) => entry.enabled === true);
      if (action === "install" && (!installed || !enabled)) throw new Error("The host did not confirm an enabled installation. Check its plugin settings.");
      if (action === "install" && !matches.some((entry) => entry.version === expectedVersion && entry.enabled && (host !== "claude" || entry.scope === "user"))) throw new Error(`The host has not activated bundled version ${expectedVersion}. Check its plugin settings.`);
      results.push({ host, ok: true, installed, enabled, versions: [...new Set(matches.map((entry) => entry.version))] });
    } catch (error) { results.push({ host, ok: false, error: error.message }); }
  }
  return { ok: results.every((result) => result.ok), action, plugin: target === "cursor" ? "scormplayer-cursor" : ID, ...(action === "install" ? { source: target === "cursor" ? path.join(cursorDirectory, "scormplayer-cursor") : destination, reload: "Reload plugins or reopen the host chat. In Cursor, run Reload Window and check Customize → Plugins and MCP tools. Cursor activation is managed by the host." } : {}), results };
}
