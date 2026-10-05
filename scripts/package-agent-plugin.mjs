import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, "artifacts", "agent-plugins");
const integration = path.join(root, "integrations", "agent");
const version = JSON.parse(fs.readFileSync(path.join(integration, "package.json"), "utf8")).version;
const identity = { name: "scormplayer", version, description: "Browser playback, MCP tools and an interactive review checklist.", author: { name: "Jake Rains" }, license: "MIT" };
const ui = { displayName: "SCORM Player", logo: "./assets/icon.svg", composerIcon: "./assets/icon.svg", shortDescription: "Review pins and revise lessons", longDescription: "Play lessons in your browser. Use MCP tools to inspect pins, and a standard MCP Apps checklist to choose open pins and send them to the agent. Requires Node.js 22.22.2+. UI calls and messaging depend on host support.", developerName: "Jake Rains", category: "Productivity", capabilities: ["Interactive", "Read", "Write"], defaultPrompt: "Review the open SCORM course and its pins." };
function json(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n"); }
for (const host of ["codex", "claude", "cursor"]) {
  const name = host === "cursor" ? "scormplayer-cursor" : "scormplayer";
  const dir = path.join(out, host, name);
  fs.rmSync(path.join(out, host), { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(path.join(integration, "dist", "player-client"), path.join(dir, "player-client"), { recursive: true });
  fs.cpSync(path.join(integration, "assets"), path.join(dir, "assets"), { recursive: true });
  fs.copyFileSync(path.join(integration, "dist", "server.mjs"), path.join(dir, "server.mjs"));
  fs.copyFileSync(path.join(integration, "dist", "review.html"), path.join(dir, "review.html"));
  fs.copyFileSync(path.join(integration, "dist", "skills.json"), path.join(dir, "skills.json"));
  fs.cpSync(path.join(integration, "plugin", "skills"), path.join(dir, "skills"), { recursive: true });
  fs.cpSync(path.join(root, "skills", "scormplayer"), path.join(dir, "skills", "scormplayer"), { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), `# SCORM Player ${version}\n\nRequires Node.js 22.22.2 or newer.\n\nNormal stdio MCP tools connect to browser players or start an exact requested lesson. The standard MCP Apps pin checklist needs no child lesson frame, localhost certificate or remote assets. Select open pins and send a request with one click; inspect saved screenshots when needed. Messaging depends on host support. Local webhook MCP Events are not enabled.\n\nBoth guides are included as native skills and MCP resources. Compatible hosts can use skills/list and skills/get; other clients can call scormplayer_get_review_guide. Native skill loading is host-dependent. The MCP server keeps the SDK 1.x connection handshake; it does not claim the newer 2026-07-28 base protocol.\n\nSource: https://github.com/jakerains/scormplayer\n`);
  if (fs.existsSync(path.join(root, "LICENSE"))) fs.copyFileSync(path.join(root, "LICENSE"), path.join(dir, "LICENSE"));
  if (host === "codex") {
    json(path.join(dir, "plugin.json"), { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", ...identity, extensions: { "com.openai": { interface: ui } } });
    json(path.join(dir, "mcp.json"), { $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: { scormplayer: { type: "stdio", command: "node", args: ["${PLUGIN_ROOT}/server.mjs"], cwd: "${PLUGIN_ROOT}" } } });
    json(path.join(dir, ".codex-plugin", "plugin.json"), { ...identity, skills: "./skills/", mcpServers: "./.mcp.json", interface: ui });
    json(path.join(dir, ".mcp.json"), { mcpServers: { scormplayer: { command: "node", args: ["${PLUGIN_ROOT}/server.mjs"], cwd: "${PLUGIN_ROOT}" } } });
  } else if (host === "claude") {
    json(path.join(dir, ".claude-plugin", "plugin.json"), { ...identity });
    json(path.join(dir, ".mcp.json"), { mcpServers: { scormplayer: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.mjs"] } } });
  } else {
    // Cursor also imports Claude plugins. A distinct identity avoids coalescing
    // this native package with an older Claude server under the same plugin ID.
    json(path.join(dir, ".cursor-plugin", "plugin.json"), { ...identity, name: "scormplayer-cursor", repository: "https://github.com/jakerains/scormplayer", skills: "./skills/", rules: "./rules/", commands: "./commands/", mcpServers: "./mcp.json" });
    json(path.join(dir, "mcp.json"), { mcpServers: { scormplayer: { type: "stdio", command: "node", args: ["${CURSOR_PLUGIN_ROOT}/server.mjs"], cwd: "${CURSOR_PLUGIN_ROOT}" } } });
    fs.cpSync(path.join(integration, "plugin", "cursor"), dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "README.md"), "\n## Cursor\n\nInstall with `scormplayer plugin install cursor` from the npm player package. The installer copies this bundle into `~/.cursor/plugins/local/scormplayer-cursor` and binds Node to its absolute executable path. It preserves other settings and backs up previous managed versions. Run Reload Window, then check Customize → Plugins → Scormplayer Cursor. Use `/scorm-review` or `/scorm-pins`.\n\nFor manual installation, copy the whole `scormplayer-cursor` folder to that local path and make Node.js 22.22.2+ available to Cursor. Use real files; symlinks outside the plugins root are skipped. The unique folder and manifest name avoid collisions with Cursor's automatically imported Claude plugin. The standard MCP Apps pin checklist and messaging depend on host capabilities; browser playback and structured tools remain available.\n");
  }
  const zip = new AdmZip();
  zip.addLocalFolder(dir, name);
  zip.writeZip(path.join(out, `scormplayer-${host}-${version}.zip`));
}
json(path.join(out, ".agents", "plugins", "marketplace.json"), { name: "scormplayer-local", interface: { displayName: "SCORM Player Local" }, plugins: [{ name: "scormplayer", source: { source: "local", path: "./codex/scormplayer" }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" }] });
json(path.join(out, ".claude-plugin", "marketplace.json"), { name: "scormplayer-local", owner: { name: "Jake Rains" }, plugins: [{ name: "scormplayer", source: "./claude/scormplayer", description: identity.description }] });
json(path.join(out, ".cursor-plugin", "marketplace.json"), { name: "scormplayer-local", owner: { name: "Jake Rains" }, plugins: [{ name: "scormplayer-cursor", source: "./cursor/scormplayer-cursor", description: identity.description }] });
console.log(`Built Codex, Claude and Cursor plugin archives in ${out}`);
// The npm tarball ships complete plugins. Consumers need no build dependencies.
// Retire the former output location so npm does not ship an obsolete plugin.
fs.rmSync(path.join(root, "dist", "agent-plugins"), { recursive: true, force: true });
const bundled = path.join(root, "dist", "plugins");
fs.rmSync(bundled, { recursive: true, force: true });
for (const entry of ["codex", "claude", "cursor", ".agents", ".claude-plugin", ".cursor-plugin"]) {
  fs.cpSync(path.join(out, entry), path.join(bundled, entry), { recursive: true });
}

const standalone = path.join(root, "dist", "mcp");
fs.rmSync(standalone, { recursive: true, force: true });
fs.cpSync(path.join(integration, "dist"), standalone, { recursive: true });
