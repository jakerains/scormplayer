import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline/promises";
import lockfile from "proper-lockfile";
import { PACKAGE_ROOT, runSkills, skillsArgs } from "./skill.mjs";
import { hostCommand, managePlugins } from "./plugins.mjs";

const exec = promisify(execFile);
export const SETUP_APPS = [
  { id: "codex", label: "Codex", agent: "codex", plugin: "codex", cli: "codex" },
  { id: "claude-code", label: "Claude Code", agent: "claude-code", plugin: "claude", folder: [".claude.json"] },
  { id: "cursor", label: "Cursor", agent: "cursor", plugin: "cursor", folder: [".cursor", "mcp.json"] },
  { id: "claude-desktop", label: "Claude Desktop", agent: null },
  { id: "gemini-cli", label: "Gemini CLI", agent: "gemini-cli", folder: [".gemini", "settings.json"] },
  { id: "windsurf", label: "Windsurf", agent: "windsurf", folder: [".codeium", "windsurf", "mcp_config.json"] },
];

export function setupDirectory({ home = os.homedir(), env = process.env, platform = process.platform } = {}) {
  const base = env.XDG_DATA_HOME || (platform === "win32" ? env.LOCALAPPDATA || path.join(home, "AppData", "Local") : path.join(home, ".local", "share"));
  return path.join(base, "scormplayer", "setup");
}

export function parseSetupSelection(answer) {
  if (!answer.trim() || /^(skip|q|0)$/i.test(answer.trim())) return [];
  const tokens = answer.trim().split(/[\s,]+/);
  const ids = tokens.map((token) => /^\d+$/.test(token) ? SETUP_APPS[Number(token) - 1]?.id : token);
  if (ids.some((id) => !SETUP_APPS.some((app) => app.id === id))) throw new Error("Choose app numbers or names from the list, separated by commas.");
  return [...new Set(ids)];
}

export function mcpConfigPath(app, { home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  if (app.folder) return path.join(home, ...app.folder);
  if (app.id !== "claude-desktop") throw new Error("This app uses its own MCP CLI.");
  const base = platform === "darwin" ? path.join(home, "Library", "Application Support") : platform === "win32" ? env.APPDATA || path.join(home, "AppData", "Roaming") : env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(base, "Claude", "claude_desktop_config.json");
}

// Stage complete self-contained MCP assets outside transient npx/npm directories.
export function stageSetupServer(source, destination) {
  if (!fs.existsSync(path.join(source, "server.mjs"))) throw new Error("MCP assets are missing. Run npm run build:plugins first.");
  const hash = createHash("sha256");
  const visit = (dir, relative = "") => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(path.join(dir, entry.name), name);
      else if (entry.isFile()) hash.update(name).update("\0").update(fs.readFileSync(path.join(dir, entry.name))).update("\0");
      else throw new Error("MCP assets must contain regular files and directories only.");
    }
  };
  visit(source);
  const snapshot = path.join(destination, "servers", hash.digest("hex"));
  if (!fs.existsSync(snapshot)) {
    fs.mkdirSync(path.dirname(snapshot), { recursive: true });
    const temporary = fs.mkdtempSync(path.join(path.dirname(snapshot), ".staging-"));
    try {
      fs.cpSync(source, temporary, { recursive: true });
      fs.renameSync(temporary, snapshot);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
  return path.join(snapshot, "server.mjs");
}

function ownsServer(server, directory) {
  return typeof server?.command === "string" && Array.isArray(server.args) && server.args.length === 1
    && typeof server.args[0] === "string" && path.dirname(path.dirname(server.args[0])) === path.join(directory, "servers");
}

async function writeMcpConfig(file, server) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const release = await lockfile.lock(path.dirname(file), { lockfilePath: `${file}.scormplayer.lock`, retries: { retries: 4, minTimeout: 50 } });
  let temporary;
  try {
    const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    const config = before === null ? {} : JSON.parse(before);
    if (!config || Array.isArray(config) || typeof config !== "object" || (config.mcpServers !== undefined && (!config.mcpServers || Array.isArray(config.mcpServers) || typeof config.mcpServers !== "object"))) throw new Error(`Invalid MCP config in ${file}; it was preserved.`);
    const existing = config.mcpServers?.scormplayer;
    if (existing && JSON.stringify(existing) !== JSON.stringify(server)) {
      const owned = ownsServer(existing, path.dirname(path.dirname(path.dirname(server.args[0]))));
      if (!owned) throw new Error(`A different scormplayer server exists in ${file}; it was preserved. Remove that entry before using setup.`);
    }
    config.mcpServers = { ...config.mcpServers, scormplayer: server };
    if (before !== null) fs.writeFileSync(`${file}.scormplayer-backup`, before, { mode: 0o600 });
    temporary = `${file}.scormplayer-${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    if (temporary) fs.rmSync(temporary, { force: true });
    await release();
  }
}

async function executeHost(host, args, { env = process.env } = {}) {
  const command = hostCommand(host, args, { searchPath: env.PATH });
  try {
    const result = await exec(command.file, command.args, { env, timeout: 60000, maxBuffer: 1024 * 1024 });
    return result.stdout;
  } catch (error) {
    if (args[1] === "get" && /no MCP server|not found|does not exist/i.test(`${error.stderr || ""} ${error.stdout || ""}`)) return null;
    throw new Error(`${host} MCP setup failed: ${error.stderr?.trim() || error.message}`);
  }
}

export async function installSetup(ids, {
  mcp = true, skills = false, home = os.homedir(), env = process.env, platform = process.platform,
  directory = setupDirectory({ home, env, platform }), source = path.join(PACKAGE_ROOT, "dist", "mcp"),
  node = process.execPath, nodeVersion = process.versions.node,
  execute = executeHost, installSkills = runSkills, pluginStatus = (host) => managePlugins("status", host),
  installPlugin = (host) => managePlugins("install", host),
  writeConfig = writeMcpConfig, quiet = false,
} = {}) {
  const apps = [...new Set(ids)].map((id) => {
    const app = SETUP_APPS.find((item) => item.id === id);
    if (!app) throw new Error(`Unknown setup app: ${id}`);
    return app;
  });
  if (!mcp && !skills) throw new Error("Select MCP, skills, or both.");
  if (mcp && apps.length) {
    const [major, minor, patch] = nodeVersion.split(".").map(Number);
    if (major < 22 || (major === 22 && (minor < 22 || (minor === 22 && patch < 2)))) throw new Error("MCP setup requires Node.js 22.22.2 or newer. Use --skills-only with Node.js 20.");
  }
  let entry;
  const catalogFile = path.join(source, "skills.json");
  const bundledVersion = mcp && fs.existsSync(catalogFile) ? JSON.parse(fs.readFileSync(catalogFile, "utf8")).serverVersion : null;
  const results = [];
  for (const app of apps) {
    const result = { app: app.id, mcp: mcp ? "pending" : "skipped", skills: skills ? app.agent ? "pending" : "unsupported" : "skipped" };
    if (mcp) {
      try {
        const status = app.plugin ? await pluginStatus(app.plugin) : null;
        const existing = status?.results?.find((item) => item.installed);
        if (existing) {
          if (existing.enabled === false) throw new Error(`SCORM Player's plugin is disabled in ${app.label}. Enable it in that app, then run setup again.`);
          if (bundledVersion && !existing.versions?.includes(bundledVersion)) {
            const updated = await installPlugin(app.plugin);
            const active = updated?.results?.find((item) => item.host === app.plugin);
            if (!updated?.ok || !active?.installed || !active.versions?.includes(bundledVersion)) throw new Error(active?.error || `Could not update ${app.label}'s existing SCORM Player plugin.`);
            result.mcp = "updated-plugin";
          } else result.mcp = "existing-plugin";
        } else {
          entry ??= stageSetupServer(source, directory);
          const server = { command: node, args: [entry] };
          if (app.cli) {
            // Check before a CLI can replace an unrelated same-name server.
            fs.mkdirSync(env.CODEX_HOME || path.join(home, ".codex"), { recursive: true });
            const text = await execute(app.cli, ["mcp", "get", "scormplayer", "--json"], { env });
            const config = text ? JSON.parse(text) : null;
            const previous = config?.transport ?? config;
            if (previous && !ownsServer(previous, directory)) throw new Error(`A different scormplayer server is configured in ${app.label}; it was preserved. Remove that entry before using setup.`);
            // Host CLIs preserve their config formats; execFile preserves spaces in paths.
            const args = ["mcp", "add", "scormplayer", "--", node, entry];
            await execute(app.cli, args, { env });
          } else await writeConfig(mcpConfigPath(app, { home, platform, env }), server);
          result.mcp = "configured";
        }
        // This denotes guidance available over the connection, not host skill activation.
        if (!skills && bundledVersion) result.skills = "bundled";
      } catch (error) { result.mcp = "failed"; result.error = error.message; }
    }
    results.push(result);
  }
  const agents = apps.filter((app) => app.agent).map((app) => app.agent);
  if (skills && agents.length) {
    try {
      // One Vercel CLI invocation with the same selection, global scope and no second picker.
      const code = await installSkills(skillsArgs("add", { local: true, global: true, agents, yes: true, copy: true }), { env, stdout: quiet ? "ignore" : "inherit" });
      if (code !== 0) throw new Error(`Skills installer exited with status ${code}.`);
      for (const result of results) if (result.skills === "pending") result.skills = "installed";
    } catch (error) {
      for (const result of results) if (result.skills === "pending") { result.skills = "failed"; result.skillError = error.message; }
    }
  }
  return { ok: results.every((item) => item.mcp !== "failed" && item.skills !== "failed"), results };
}

export async function runSetup({ ids, mcp = true, skills = false, json = false, input = process.stdin, output = process.stdout, env = process.env, directory = setupDirectory(), install = installSetup } = {}) {
  let chosen = ids;
  if (!chosen?.length) {
    if (json || env.CI || !input.isTTY || !output.isTTY) throw new Error("Run scormplayer setup in a terminal, or pass --app codex --app cursor (optional: --with-skills or --skills-only).");
    output.write(`\nSet up SCORM Player for your apps\nChoose once: ${mcp && skills ? "MCP with bundled guidance + filesystem skills" : mcp ? "MCP with bundled review guidance" : "filesystem skills"}, for all projects. Nothing is installed until you choose.\n`);
    SETUP_APPS.forEach((app, index) => output.write(`  ${index + 1}. ${app.label}${skills && !app.agent ? " (filesystem skills unavailable)" : ""}\n`));
    const prompt = createInterface({ input, output });
    try {
      while (!chosen) {
        const answer = await prompt.question("Apps (e.g. 1,3), or Enter to skip: ");
        try { chosen = parseSetupSelection(answer); } catch (error) { output.write(`${error.message}\n`); }
      }
    } finally { prompt.close(); }
  }
  const result = await install(chosen, { mcp, skills, directory, env, quiet: json });
  if (result.ok) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "choice.json"), `${JSON.stringify({ apps: chosen, mcp, skills })}\n`, { mode: 0o600 });
  }
  if (json) output.write(`${JSON.stringify(result)}\n`);
  else {
    for (const item of result.results) output.write(`${SETUP_APPS.find((app) => app.id === item.app).label}: MCP ${item.mcp}, skills ${item.skills}${item.error ? ` — ${item.error}` : ""}${item.skillError ? ` — ${item.skillError}` : ""}\n`);
    output.write(chosen.length ? "Reopen the selected apps. Bundled guidance is readable through MCP; native skill loading and widgets depend on host support. Use --skills-only for the filesystem fallback.\n" : "Skipped. Run scormplayer setup any time.\n");
  }
  return result;
}

export function shouldOfferSetup({ input = process.stdin, output = process.stdout, env = process.env, json = false, plain = false, directory = setupDirectory() } = {}) {
  return Boolean(input.isTTY && output.isTTY && !env.CI && !json && !plain && !fs.existsSync(path.join(directory, "choice.json")));
}
