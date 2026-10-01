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
  // From GitHub by default, so `npx skills update` keeps it current; --local uses the copy in
  // this package (offline, or pinned to the installed version).
  const source = local ? PACKAGE_ROOT : SKILL_REPO;
  return ["--yes", "skills@latest", "add", source, "--skill", "scormplayer", ...flags, ...(copy ? ["--copy"] : [])];
}

export function runSkills(args, { env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", args, { stdio: "inherit", env, shell: process.platform === "win32" });
    child.on("error", (error) => reject(new Error(`Could not run npx: ${error.message}. Install the skill with: npx skills add ${SKILL_REPO}`)));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

/** Common places agents keep skills. Used only to decide whether to show the one-line tip. */
export function skillInstalledAnywhere({ home = os.homedir(), cwd = process.cwd() } = {}) {
  const dirs = [
    path.join(home, ".claude", "skills"),
    path.join(home, ".agents", "skills"),
    path.join(home, ".codex", "skills"),
    path.join(home, ".cursor", "skills"),
    path.join(home, ".config", "agents", "skills"),
    path.join(cwd, ".claude", "skills"),
    path.join(cwd, ".agents", "skills"),
  ];
  return dirs.some((dir) => fs.existsSync(path.join(dir, "scormplayer", "SKILL.md")));
}
