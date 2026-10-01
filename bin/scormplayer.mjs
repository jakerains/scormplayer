#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { startPlayer, resolveCourse, createPinStore, createDashboard, openBrowser, unzipCourse, UserError } from "../server/index.mjs";
import { SKILL_FILE, SKILL_REPO, runSkills, skillsArgs, skillInstalledAnywhere, skillScopes } from "../server/skill.mjs";
import { findConfig, configuredPinsFile, startSync } from "../server/config.mjs";
import { findCourses, isCourseFolder } from "../server/finder.mjs";
import { cacheEntries, clearCache, formatBytes, MAX_AGE_DAYS, MAX_ENTRIES } from "../server/cache.mjs";
import { checkForUpdate, fetchLatest, hasTool, installMethod, installedVersion, isNewer, npmNeedsSudo, NPM_INSTALL, runInstall, tarballInstall, updateHint } from "../server/update.mjs";
import { pickCourse, DROP_PAGE } from "../server/tui.mjs";
import { pinsReport, createJsonReporter, jsonError } from "../server/agent.mjs";

const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const HELP = `scormplayer ${VERSION}

Open a SCORM course in your browser and leave pinned notes on it.

Usage
  scormplayer                     Pick a course found in this folder (or open this folder);
                                  with none, open the player to drop or choose a SCORM zip
  scormplayer <course>            Open a SCORM .zip, a SCORM folder, or a Vite project
  scormplayer pins <course>       Print the open pins as a hand-off for a teammate or an agent
  scormplayer unzip <zip>         Unzip a course to a folder you can edit (beside the zip, or
                                  --to <folder>); its pins move with it
  scormplayer skill install       Teach your coding agents to act on pins (pick agents and scope)
  scormplayer cache [clear]       Show (or empty) the cache of unpacked zips
  scormplayer update              Update scormplayer and its agent skill to the latest version
                                  (--check only reports whether there is a newer one)

Options
  --live            Serve a Vite project from source with hot reload (automatic when the
                    folder has a vite.config and no imsmanifest.xml)
  --port <n>        Port to use (default 4620, or the next free one)
  --host <host>     Host to bind (default 127.0.0.1)
  --pins <file>     Where to keep pins (default: <course>.pins.json beside a zip or folder,
                    .scormplayer/pins.json inside a live project)
  --drop            Start with an empty player: drop or choose a SCORM zip in the browser
  --no-open         Don't open the browser
  --plain           Plain log lines instead of the dashboard (automatic without a terminal)
  --json            Agent mode: JSON on stdout, no colours, prompts or tips (see below)
  -v, --version     Print the version
  -h, --help        Show this help

pins options
  --all             Include resolved pins
  --resolve <n>     Mark pin <n> resolved (repeatable); --note "<text>" records what changed

skill commands (run through the open skills CLI: npx skills, 75+ agents)
  skill install     Pick agents and scope, then install or update the skill
  skill remove      Remove it
  skill print       Print the skill to stdout
  Flags passed to skills: -g/--global, -a/--agent <name>, -y/--yes, --copy;
  --local installs the copy bundled with this version instead of the GitHub one

For agents (--json)
  scormplayer pins <course> --json              {ok, course, pinsFile, counts, pins[]}
  scormplayer pins <course> --resolve 2 --json  {ok, resolved[], counts}
  scormplayer unzip <zip> --json                {ok, folder, pinsFile, reused, movedPins}
  scormplayer <course> --json --no-open         One JSON event per line: ready (url, pid,
                                                pinsFile), then pin, progress, source, browser,
                                                course, log; stopped on exit
  scormplayer update --check --json             {ok, current, latest, updateAvailable, method}
  scormplayer cache --json, skill status --json
  Errors print {ok: false, error, code} and exit 1.

Project settings
  A scormplayer.config.json in the course folder or above it can set where pins go,
  where the course picker looks, and commands to run when files change:
  { "courses": ["lessons/*"], "pins": ".local/pins/{name}.pins.json",
    "sync": [{ "files": ["content/{name}.json"], "run": "npm run sync -- {name}" }] }

Examples
  scormplayer ./my-course.zip
  npx @jakerains/scormplayer@latest ./my-course.zip
  scormplayer ./my-vite-course --live
  scormplayer pins ./my-course.zip | pbcopy
  scormplayer pins ./my-course.zip --json
`;

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      live: { type: "boolean", default: false },
      port: { type: "string" },
      host: { type: "string", default: "127.0.0.1" },
      pins: { type: "string" },
      "no-open": { type: "boolean", default: false },
      plain: { type: "boolean", default: false },
      drop: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      resolve: { type: "string", multiple: true },
      note: { type: "string" },
      to: { type: "string" },
      check: { type: "boolean", default: false },
      global: { type: "boolean", short: "g", default: false },
      agent: { type: "string", short: "a", multiple: true },
      yes: { type: "boolean", short: "y", default: false },
      copy: { type: "boolean", default: false },
      local: { type: "boolean", default: false },
      version: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const json = values.json;
  if (values.version) return void console.log(json ? JSON.stringify({ ok: true, version: VERSION }) : VERSION);
  if (values.help) return void console.log(HELP);
  if (positionals.length === 0 && !values.drop && json) {
    throw new UserError("Pass a course (a SCORM .zip, a SCORM folder or a Vite project), or --drop to start empty.");
  }
  if (positionals.length === 0 && !values.drop) {
    const interactive = process.stdout.isTTY && process.stdin.isTTY && !values.plain;
    if (!interactive) return void console.log(HELP);
    const here = process.cwd();
    const choice = isCourseFolder(here) ? here : await pickCourse({ version: VERSION, courses: findCourses(here) });
    if (!choice) return;
    if (choice !== DROP_PAGE) positionals.push(choice);
  }

  const cacheDir = defaultCacheDir();

  if (positionals[0] === "skill") return runSkill(positionals[1] ?? "status", values);
  if (positionals[0] === "cache") return runCache(positionals[1] ?? "status", defaultCacheDir(), json);
  if (positionals[0] === "update" || positionals[0] === "upgrade") return runUpdate({ cacheDir, check: values.check, json });

  if (positionals[0] === "unzip") {
    const input = positionals[1];
    if (!input) throw new UserError("Usage: scormplayer unzip <zip> [--to <folder>]");
    const explicitPins = values.pins ?? configuredPinsFile(findConfig(input), path.resolve(input));
    const course = resolveCourse(input, { cacheDir, pinsFile: explicitPins });
    const result = unzipCourse(course, { folder: values.to ? path.resolve(values.to) : undefined, keepPinsFile: Boolean(explicitPins) });
    if (json) return void console.log(JSON.stringify({ ok: true, ...result }));
    console.log(result.reused ? `Already unzipped: ${result.folder}` : `Unzipped to ${result.folder}`);
    const open = createPinStore(result.pinsFile, course).list({ status: "open" }).length;
    console.log(`Pins: ${result.pinsFile}${open ? ` (${open} open${result.movedPins ? ", moved here from beside the zip" : ""})` : ""}`);
    console.log(`Open it with: scormplayer ${quote(result.folder)}`);
    return;
  }

  if (positionals[0] === "pins") {
    const input = positionals[1];
    if (!input) throw new UserError("Usage: scormplayer pins <course>");
    const course = resolveCourse(input, { cacheDir, live: values.live, pinsFile: values.pins ?? configuredPinsFile(findConfig(input), path.resolve(input)) });
    const store = createPinStore(course.pinsFile, course);
    const resolved = [];
    for (const id of values.resolve ?? []) {
      const pin = store.update(id, { status: "resolved", resolution: values.note });
      resolved.push(pin);
      if (!json) console.error(`Resolved pin ${pin.number}.`);
    }
    if (resolved.length) {
      if (json) console.log(JSON.stringify({ ok: true, resolved, counts: pinsReport(store, course).counts }));
      return;
    }
    const status = values.all ? "all" : "open";
    if (json) return void console.log(JSON.stringify(pinsReport(store, course, { status })));
    return void process.stdout.write(store.brief({ status }));
  }

  // A bare word that isn't a file or folder here is a mistyped command, or one this version
  // doesn't have yet (it was added later): say so, rather than "Nothing found at …/word".
  const word = positionals[0];
  if (word && /^[a-z][a-z-]*$/i.test(word) && !fs.existsSync(path.resolve(word))) {
    throw new UserError(`"${word}" isn't a command in scormplayer ${VERSION}, or a course in this folder. `
      + `The commands are pins, unzip, update, skill and cache (scormplayer --help). `
      + `If "${word}" is newer than this version, update first: scormplayer update`);
  }

  const port = values.port === undefined ? 4620 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UserError("--port must be a number from 0 to 65535.");
  const input = positionals[0] ? path.resolve(positionals[0]) : null;
  const config = input && fs.existsSync(input) ? findConfig(input) : null;
  const player = await startPlayer({
    input,
    cacheDir,
    host: values.host,
    port,
    live: values.live,
    pinsFile: values.pins ?? (input ? configuredPinsFile(config, input) : null),
  });
  let stopSync = () => {};
  const onQuit = async () => {
    stopSync();
    await player.close();
    process.exit(0);
  };
  if (json) {
    const reporter = createJsonReporter({ player, onQuit });
    if (input) stopSync = startSync(config, input, reporter.log);
    if (!values["no-open"]) openBrowser(player.url);
    return;
  }
  const dashboard = createDashboard({
    version: VERSION,
    entries: [{ id: player.course ? path.basename(player.course.source) : "scormplayer", player }],
    plain: values.plain,
    pinsHint: () => (positionals[0]
      ? `scormplayer pins ${quote(positionals[0])}`
      : `scormplayer pins ${quote(player.course?.source ?? "")} --pins ${quote(player.course?.pinsFile ?? "")}`),
    onQuit,
  });
  if (input) stopSync = startSync(config, input, (message) => dashboard.log(message));
  void checkForUpdate({ current: VERSION, cacheDir }).then((latest) => {
    if (!latest) return;
    dashboard.updateAvailable(latest, updateHint());
    player.setUpdate({ latest, command: updateHint() });
  });
  if (!skillInstalledAnywhere()) dashboard.log("Tip: run `scormplayer skill install` so coding agents can act on your pins");
  if (!values["no-open"]) openBrowser(player.url);
}

/** Unpacked zips live here: %LOCALAPPDATA% on Windows, XDG_CACHE_HOME or ~/.cache elsewhere. */
function defaultCacheDir() {
  if (process.platform === "win32" && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, "scormplayer", "Cache");
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "scormplayer");
}

function quote(value) {
  return /^[\w./~:-]+$/.test(value) ? value : JSON.stringify(value);
}

function runCache(action, cacheDir, json) {
  if (action === "clear") {
    const removed = clearCache(cacheDir);
    const bytes = removed.reduce((sum, entry) => sum + entry.bytes, 0);
    if (json) return void console.log(JSON.stringify({ ok: true, cacheDir, removed: removed.length, bytes }));
    return void console.log(`Removed ${removed.length} cached ${removed.length === 1 ? "course" : "courses"} (${formatBytes(bytes)}) from ${cacheDir}`);
  }
  if (action !== "status") throw new UserError(`Unknown cache command "${action}". Use: scormplayer cache, or scormplayer cache clear`);
  const entries = cacheEntries(cacheDir);
  const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  if (json) return void console.log(JSON.stringify({ ok: true, cacheDir, entries: entries.length, bytes, maxEntries: MAX_ENTRIES, maxAgeDays: MAX_AGE_DAYS }));
  console.log(`${cacheDir}\n${entries.length} cached ${entries.length === 1 ? "course" : "courses"}, ${formatBytes(bytes)}.`);
  console.log(`Kept automatically: the ${MAX_ENTRIES} most recent, nothing unused for ${MAX_AGE_DAYS} days. Empty it with: scormplayer cache clear`);
}

/**
 * Update scormplayer with whatever installed it, then refresh the agent skill wherever it is
 * installed. With --check, only report. Under npx, in a project or in a source checkout there is
 * nothing global to reinstall, so it says what to do instead.
 */
async function runUpdate({ cacheDir, check, json }) {
  const say = (text) => { if (!json) console.log(text); };
  let latest;
  try { latest = await fetchLatest({ cacheDir }); }
  catch (error) { throw new UserError(`Couldn't reach the npm registry to check for updates (${error.message}).`); }
  const updateAvailable = isNewer(latest, VERSION);
  const method = installMethod();
  if (check || !updateAvailable) {
    if (json) return void console.log(JSON.stringify({ ok: true, current: VERSION, latest, updateAvailable, method: method.kind }));
    if (!updateAvailable) return say(`scormplayer ${VERSION} is the latest version.`);
    return say(`scormplayer ${latest} is available (you have ${VERSION}). Update with: ${method.hint}`);
  }
  if (!method.command) {
    if (method.kind === "npx") throw new UserError(`You're running scormplayer through npx, so there's nothing to install. Run it as: ${method.hint}`);
    if (method.kind === "source") throw new UserError(`This scormplayer runs from a source checkout. Update it there: ${method.hint}`);
    throw new UserError(`This scormplayer is a dependency of a project, not a global install. Update it in that project: ${method.hint}`);
  }

  // Installed with pnpm, yarn or bun that has since gone: npm comes with Node, so use it.
  let command = method.command;
  let tool = method.kind;
  if (tool !== "npm" && !hasTool(tool)) {
    say(`${tool} isn't installed any more, so updating with npm instead.`);
    command = NPM_INSTALL;
    tool = "npm";
  }
  // Node from the nodejs.org installer keeps global packages in /usr/local, which needs admin rights.
  const sudo = tool === "npm" && npmNeedsSudo();
  const interactive = process.stdin.isTTY && process.stdout.isTTY && !json;
  if (sudo && !interactive) {
    throw new UserError(`npm's global folder needs admin rights on this machine. Update with: sudo ${command.join(" ")}`);
  }

  say(`Updating scormplayer ${VERSION} → ${latest} with ${tool}…`);
  if (sudo) say("npm needs admin rights to update global packages here, so this runs with sudo. Enter your Mac password if asked.");
  // In agent mode the installer's output goes to stderr, keeping stdout to the one JSON answer.
  const output = json ? process.stderr : "inherit";
  let code = await runInstall(command, { stdout: output, sudo });
  if (code !== 0 && tool === "npm") {
    // Just after a release npm can know the new version before it can install it by name.
    say(`npm couldn't install ${latest} by name (its servers can lag just after a release). Trying the package file directly…`);
    command = tarballInstall(latest);
    code = await runInstall(command, { stdout: output, sudo });
  }
  if (code !== 0) throw new UserError(`${sudo ? "sudo " : ""}${command.join(" ")} failed (exit ${code}). Its output above says why.`);
  const now = installedVersion();

  // Refresh the agent skill in each scope it's installed in, so it describes this version.
  const scopes = skillScopes();
  const skill = { global: scopes.global ? "updated" : "not installed", project: scopes.project ? "updated" : "not installed" };
  for (const scope of ["global", "project"]) {
    if (!scopes[scope]) continue;
    say(`Updating the agent skill (${scope})…`);
    const skillCode = await runSkills(skillsArgs("update", { global: scope === "global" }), { stdout: output }).catch(() => 1);
    if (skillCode !== 0) skill[scope] = "failed";
  }

  if (json) return void console.log(JSON.stringify({ ok: true, from: VERSION, to: now, method: tool, skill }));
  say(`scormplayer is now ${now}.`);
  if (Object.values(skill).includes("failed")) say("The agent skill didn't update; run: npx skills update scormplayer");
}

async function runSkill(action, values) {
  if (action === "print") return void process.stdout.write(fs.readFileSync(SKILL_FILE, "utf8"));
  if (action === "install" || action === "add" || action === "update") {
    const code = await runSkills(skillsArgs("add", { local: values.local, global: values.global, agents: values.agent ?? [], yes: values.yes, copy: values.copy }));
    process.exitCode = code;
    return;
  }
  if (action === "remove" || action === "uninstall") {
    process.exitCode = await runSkills(skillsArgs("remove", { global: values.global, agents: values.agent ?? [], yes: values.yes }));
    return;
  }
  if (action === "status") {
    if (values.json) return void console.log(JSON.stringify({ ok: true, installed: skillInstalledAnywhere(), install: "scormplayer skill install" }));
    console.log(skillInstalledAnywhere()
      ? "The scormplayer skill is installed. Update it with: scormplayer skill install"
      : `Not installed. Run: scormplayer skill install   (or: npx skills add ${SKILL_REPO})`);
    return;
  }
  throw new UserError(`Unknown skill command "${action}". Use install, remove or print.`);
}


const ARGV = process.argv.slice(2);
main(ARGV).catch((error) => {
  if (ARGV.includes("--json")) {
    const user = error instanceof UserError || error?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" || error?.statusCode === 404;
    process.stdout.write(jsonError(error?.message ?? String(error), user ? "user_error" : "internal_error"));
  } else {
    console.error(`scormplayer: ${error instanceof UserError ? error.message : error?.stack ?? error}`);
  }
  process.exit(1);
});
