import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * The agent skill ships in skills/scormplayer/, the layout the open `skills` CLI
 * (npx skills, github.com/vercel-labs/skills) discovers. Installing goes through that CLI, so
 * people pick their agents (Claude Code, Codex, Cursor and many more), project or global scope,
 * and symlink or copy from its own prompts. Installing the npm package never writes into agent
 * folders by itself.
 */

export const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const SKILL_FILE = path.join(PACKAGE_ROOT, "skills", "scormplayer", "SKILL.md");
export const SKILL_REPO = "jakerains/scormplayer";

/** Arguments for `npx skills …`; flags are passed through to the skills CLI. */
export function skillsArgs(action, { local = false, global = false, agents = [], yes = false, copy = false } = {}) {
  const flags = [
    ...(global ? ["--global"] : []),
    ...agents.flatMap((agent) => ["--agent", agent]),
    ...(yes ? ["--yes"] : []),
  ];
  if (action === "remove") return ["--yes", "skills@latest", "remove", "scormplayer", ...flags];
  // Refresh just this skill in one scope, leaving the person's other skills alone.
  if (action === "update") return ["--yes", "skills@latest", "update", "scormplayer", global ? "--global" : "--project", "--yes"];
  // From GitHub by default, so `npx skills update` keeps it current; --local uses the copy in
  // this package (offline, or pinned to the installed version).
  const source = local ? PACKAGE_ROOT : SKILL_REPO;
  return ["--yes", "skills@latest", "add", source, "--skill", "scormplayer", ...flags, ...(copy ? ["--copy"] : [])];
}

export function runSkills(args, { env = process.env, stdout = "inherit" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", args, { stdio: ["inherit", stdout, "inherit"], env, shell: process.platform === "win32" });
    child.on("error", (error) => reject(new Error(`Could not run npx: ${error.message}. Install the skill with: npx skills add ${SKILL_REPO}`)));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

/**
 * Where the skill is installed, among the common places agents keep skills: for all projects
 * (global) and in this project. Used for the one-line tip and to refresh it on update.
 */
export function skillScopes({ home = os.homedir(), cwd = process.cwd() } = {}) {
  const has = (dirs) => dirs.some((dir) => fs.existsSync(path.join(dir, "scormplayer", "SKILL.md")));
  return {
    global: has([".claude", ".agents", ".codex", ".cursor", path.join(".config", "agents")].map((dir) => path.join(home, dir, "skills"))),
    project: path.resolve(cwd) !== path.resolve(home) && has([".claude", ".agents"].map((dir) => path.join(cwd, dir, "skills"))),
  };
}

export function skillInstalledAnywhere(options) {
  const scopes = skillScopes(options);
  return scopes.global || scopes.project;
}

/**
 * Install the skill without any prompts, for all projects: into the shared skills folder that
 * Codex, Cursor, Gemini CLI and most other agents read, linked for Claude Code. Used by the
 * dashboard's `s` key and the player's "Install agent skill". Success is judged by the skill
 * being there afterwards, since the skills CLI reports agents that can't take a global install as
 * failures even when the rest worked.
 *
 * @returns {Promise<{ installed: boolean, output: string }>}
 */
export function installSkill({ env = process.env } = {}) {
  return new Promise((resolve) => {
    let output = "";
    let child;
    try {
      child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", skillsArgs("add", { global: true, yes: true }), { stdio: ["ignore", "pipe", "pipe"], env, shell: process.platform === "win32" });
    } catch (error) {
      return resolve({ installed: skillInstalledAnywhere(), output: String(error?.message ?? error) });
    }
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", (error) => { output += error.message; });
    child.on("close", () => resolve({ installed: skillInstalledAnywhere(), output: output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim() }));
  });
}

/**
 * Whether the installed skill matches the one this scormplayer ships with. Every installed copy
 * (for all projects, or in this project) is compared with the bundled SKILL.md, ignoring the
 * version line, so a release that didn't touch the skill doesn't make it look out of date. When
 * a copy differs, its version says which side is behind.
 *
 * @returns {{ state: "missing" | "current" | "outdated" | "newer", version: string,
 *   installed: { file: string, scope: "global" | "project", version: string | null, current: boolean }[] }}
 */
export function skillStatus({ home = os.homedir(), cwd = process.cwd() } = {}) {
  const bundled = fs.readFileSync(SKILL_FILE, "utf8");
  const version = skillVersion(bundled) ?? "0.0.0";
  const installed = installedSkillFiles({ home, cwd }).map(({ file, scope }) => {
    const text = fs.readFileSync(file, "utf8");
    return { file, scope, version: skillVersion(text), current: withoutVersion(text) === withoutVersion(bundled) };
  });
  if (!installed.length) return { state: "missing", version, installed };
  const behind = installed.filter((copy) => !copy.current && !isNewerVersion(copy.version, version));
  const ahead = installed.filter((copy) => !copy.current && isNewerVersion(copy.version, version));
  const state = behind.length ? "outdated" : ahead.length ? "newer" : "current";
  return { state, version, installed };
}

/**
 * Bring out-of-date copies up to date: `skills update` in each scope that has one, then, if a copy
 * is still behind (one copied in by hand, say), a fresh install for all projects.
 */
export async function updateSkills({ env = process.env, home, cwd } = {}) {
  const before = skillStatus({ home, cwd });
  let output = "";
  for (const scope of ["global", "project"]) {
    if (!before.installed.some((copy) => copy.scope === scope && !copy.current)) continue;
    output += await runQuiet(skillsArgs("update", { global: scope === "global" }), env);
  }
  let after = skillStatus({ home, cwd });
  if (after.state === "outdated") {
    output += (await installSkill({ env })).output;
    after = skillStatus({ home, cwd });
  }
  return { ...after, output: output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim() };
}

/** Each installed SKILL.md once, following links (Claude Code's copy is often a link to the shared one). */
function installedSkillFiles({ home, cwd }) {
  const places = [
    ...[".claude", ".agents", ".codex", ".cursor", path.join(".config", "agents")].map((dir) => ({ dir: path.join(home, dir, "skills"), scope: "global" })),
    ...(path.resolve(cwd) === path.resolve(home) ? [] : [".claude", ".agents"].map((dir) => ({ dir: path.join(cwd, dir, "skills"), scope: "project" }))),
  ];
  const seen = new Set();
  const files = [];
  for (const { dir, scope } of places) {
    const file = path.join(dir, "scormplayer", "SKILL.md");
    let real;
    try { real = fs.realpathSync(file); } catch { continue; }
    if (seen.has(real)) continue;
    seen.add(real);
    files.push({ file: real, scope });
  }
  return files;
}

function skillVersion(text) {
  return /^metadata:\s*\n\s+version:\s*"?([^"\s]+)"?/m.exec(text.split(/\n---/)[0] ?? "")?.[1] ?? null;
}

function withoutVersion(text) {
  return text.replace(/\r\n/g, "\n").replace(/^metadata:\s*\n\s+version:.*\n/m, "").trim();
}

/** Is `a` a later version than `b`? A copy with no version predates versioning, so it's older. */
function isNewerVersion(a, b) {
  if (!a) return false;
  const parse = (value) => String(value).split("-")[0].split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i += 1) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

function runQuiet(args, env) {
  return new Promise((resolve) => {
    let output = "";
    let child;
    try { child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", args, { stdio: ["ignore", "pipe", "pipe"], env, shell: process.platform === "win32" }); }
    catch (error) { return resolve(String(error?.message ?? error)); }
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", (error) => { output += error.message; });
    child.on("close", () => resolve(output));
  });
}
