import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PACKAGE = "@jakerains/scormplayer";
const DAY = 86_400_000;
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * The newer published version, or null. Asks the npm registry at most once a day (the answer is
 * kept in the cache), gives up after a moment, and never runs in CI or when
 * SCORMPLAYER_NO_UPDATE_CHECK / NO_UPDATE_NOTIFIER is set.
 */
export async function checkForUpdate({ current, cacheDir, now = Date.now(), fetchImpl = globalThis.fetch }) {
  if (process.env.CI || process.env.SCORMPLAYER_NO_UPDATE_CHECK || process.env.NO_UPDATE_NOTIFIER) return null;
  const file = path.join(cacheDir, "update-check.json");
  let latest = null;
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    // A saved answer older than the running version is stale (it was upgraded by hand since): ask again.
    if (now - saved.checkedAt < DAY && !isNewer(current, saved.latest)) latest = saved.latest;
  } catch { /* no saved answer */ }
  if (!latest) {
    try {
      latest = await fetchLatest({ cacheDir, now, fetchImpl, timeout: 1500 });
    } catch {
      return null;
    }
  }
  return typeof latest === "string" && isNewer(latest, current) ? latest : null;
}

/** The latest published version, asked fresh, and remembered for the daily check. Throws when npm can't be reached. */
export async function fetchLatest({ cacheDir, now = Date.now(), fetchImpl = globalThis.fetch, timeout = 8000 }) {
  const response = await fetchImpl(`https://registry.npmjs.org/${PACKAGE.replace("/", "%2f")}/latest`, { signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`The npm registry answered ${response.status}.`);
  const latest = (await response.json()).version;
  if (typeof latest !== "string") throw new Error("The npm registry gave no version.");
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, "update-check.json"), JSON.stringify({ latest, checkedAt: now }));
  } catch { /* the cache is only a convenience */ }
  return latest;
}

export function isNewer(candidate, current) {
  const parse = (version) => String(version).split("-")[0].split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

/**
 * How this copy of scormplayer was installed, which decides how it updates:
 * - a global install (npm, pnpm, yarn or bun): `scormplayer update` reinstalls it with that tool
 * - npx: nothing to install; `npx @jakerains/scormplayer@latest` always fetches the newest
 * - a dependency inside a project, or a source checkout: update it there, not globally
 *
 * @returns {{ kind: "npm" | "pnpm" | "yarn" | "bun" | "npx" | "project" | "source", command: string[] | null, hint: string }}
 */
export function installMethod({ packageRoot = PACKAGE_ROOT } = {}) {
  const where = packageRoot.split(path.sep).join("/");
  const install = (tool, args) => ({ kind: tool, command: [tool, ...args], hint: "scormplayer update" });
  if (where.includes("/_npx/")) return { kind: "npx", command: null, hint: `npx ${PACKAGE}@latest` };
  if (!where.includes("/node_modules/")) return { kind: "source", command: null, hint: "git pull && npm install && npm run build" };
  if (where.includes("/.bun/install/global/")) return install("bun", ["add", "-g", `${PACKAGE}@latest`]);
  if (/\/pnpm\/(.*\/)?global\//i.test(where)) return install("pnpm", ["add", "-g", `${PACKAGE}@latest`]);
  if (where.includes("/yarn/global/")) return install("yarn", ["global", "add", `${PACKAGE}@latest`]);
  // A project keeps a package.json beside its node_modules; npm's global folder (/usr/local/lib,
  // /opt/homebrew/lib, ~/.nvm/…/lib, %APPDATA%\npm) doesn't. Worked out from the path rather than
  // by asking npm, which is slower and can mask parts of the path in its output.
  if (!fs.existsSync(path.join(path.dirname(nodeModulesDir(packageRoot)), "package.json"))) return install("npm", ["install", "-g", `${PACKAGE}@latest`]);
  return { kind: "project", command: null, hint: `npm install ${PACKAGE}@latest (in the project that depends on it)` };
}

/** What to tell someone to run when a newer version is out. */
export function updateHint(packageRoot = PACKAGE_ROOT) {
  const method = installMethod({ packageRoot });
  return method.kind === "npx" || method.kind === "source" ? method.hint : "scormplayer update";
}

/** The npm command that installs the latest version globally: the fallback when another tool is missing. */
export const NPM_INSTALL = ["npm", "install", "-g", `${PACKAGE}@latest`];

/**
 * Install one version from its package file. Right after a release, npm's full version list
 * can lag the "latest" answer by an hour, and `npm install -g …@latest` then fails with
 * "No matching version found" although the package file is already there.
 */
export function tarballInstall(version) {
  return ["npm", "install", "-g", `https://registry.npmjs.org/${PACKAGE}/-/${PACKAGE.split("/")[1]}-${version}.tgz`];
}

/**
 * Whether npm's global folder needs admin rights to write. True on a Mac (or Linux) whose Node
 * came from the nodejs.org installer, where global packages live in /usr/local. Homebrew, nvm,
 * fnm, Volta and Windows installs don't.
 */
export function npmNeedsSudo(packageRoot = PACKAGE_ROOT) {
  if (process.platform === "win32") return false;
  try { fs.accessSync(nodeModulesDir(packageRoot), fs.constants.W_OK); return false; } catch { return true; }
}

/** The node_modules folder this package sits in (above its @scope folder). */
function nodeModulesDir(packageRoot) {
  let dir = path.resolve(packageRoot);
  while (path.basename(dir) !== "node_modules" && path.dirname(dir) !== dir) dir = path.dirname(dir);
  return dir;
}

/** Whether a command-line tool can be found on this machine. */
export function hasTool(tool) {
  const result = spawnSync(process.platform === "win32" ? `${tool}.cmd` : tool, ["--version"], { stdio: "ignore", shell: process.platform === "win32" });
  return result.status === 0;
}

/**
 * Run an install command, its output going to `stdout` (stderr in agent mode); `sudo` prefixes
 * it, so sudo asks for the password in the terminal. Resolves to the exit code.
 */
export function runInstall(command, { stdout = "inherit", sudo = false } = {}) {
  const [tool, ...args] = sudo ? ["sudo", ...command] : command;
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === "win32" ? `${tool}.cmd` : tool, args, { stdio: [sudo ? "inherit" : "ignore", stdout, "inherit"], shell: process.platform === "win32" });
    child.on("error", (error) => reject(new Error(`Could not run ${tool}: ${error.message}`)));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

/** The version on disk now, which differs from the running one right after an update. */
export function installedVersion(packageRoot = PACKAGE_ROOT) {
  return JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
}
