#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { startPlayer, resolveCourse, createPinStore, createDashboard, openBrowser, unzipCourse, UserError, PORT_RANGE } from "../server/index.mjs";
import { listPlayers, findPlayer, stopPlayer, askPlayer, unregisteredPlayers, isAlive } from "../server/registry.mjs";
import { SKILL_FILE, SKILL_REPO, runSkills, skillsArgs, skillInstalledAnywhere, skillScopes, installSkill, skillStatus, updateSkills } from "../server/skill.mjs";
import { findConfig, configuredPinsFile, startSync } from "../server/config.mjs";
import { findCourses, isCourseFolder } from "../server/finder.mjs";
import { cacheEntries, clearCache, formatBytes, MAX_AGE_DAYS, MAX_ENTRIES } from "../server/cache.mjs";
import { checkForUpdate, fetchLatest, hasTool, installMethod, installedVersion, isNewer, npmNeedsSudo, NPM_INSTALL, packageReady, runInstall, summarizeInstallError, tarballInstall, updateHint } from "../server/update.mjs";
import { pickCourse, pickFromList, DROP_PAGE } from "../server/tui.mjs";
import { pinsReport, createJsonReporter, jsonError } from "../server/agent.mjs";
import { managePlugins } from "../server/plugins.mjs";
import { runSetup, shouldOfferSetup } from "../server/setup.mjs";

// Who started this process, read first thing: if it exits later, the player has been left behind.
const STARTED_BY = process.ppid;
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
  scormplayer setup               Pick apps once for MCP with bundled review guidance
  scormplayer skill               Install the agent skill, or update it if it's out of date
  scormplayer mcp                 Run the normal stdio MCP server (Node.js 22.22.2+)
  scormplayer plugin install <codex|claude|cursor|all>
                                  Install normal MCP tools, pin checklist UI and skills
  scormplayer plugin status      Check installed integrations (optional: codex, claude or cursor)
  scormplayer cache [clear]       Show (or empty) the cache of unpacked zips
  scormplayer update              Update scormplayer and its agent skill to the latest version
                                  (--check only reports whether there is a newer one)
  scormplayer ps                  List running players: port, course, when a browser last looked
  scormplayer stop <port|pid>     Stop a running player (--all stops every one)

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
  --new             Start another player even if this course is already open in one
  --package <name>  For a zip or folder holding several courses: which one to open (its folder
                    or part of its title). Without it, a terminal asks; elsewhere the first opens
  --idle <minutes>  A player in the background (no terminal: agents, scripts) stops after this
                    long with no browser looking at it, or when what started it exits.
                    Default 30; 0 never stops on its own. A terminal dashboard never does.
  --json            Agent mode: JSON on stdout, no colours, prompts or tips (see below)
  -v, --version     Print the version
  -h, --help        Show this help

pins options
  --all             Include resolved pins
  --resolve <n>     Mark pin <n> resolved (repeatable); --note "<text>" records what changed

skill commands (run through the open skills CLI: npx skills, 75+ agents)
  skill             Install it if no agent has it, update it if it's behind this version
  skill install     Pick agents and scope, then install or update the skill
  skill status      Which version is installed, and whether it matches this scormplayer
  skill remove      Remove it
  skill print       Print the skill to stdout
  Flags passed to skills: -g/--global, -a/--agent <name>, -y/--yes, --copy;
  --local installs the copy bundled with this version instead of the GitHub one

setup options
  --app <name>      Select an app (repeatable); omit to choose interactively
  --with-skills     Also install filesystem skills using the same app selection
  --skills-only     Install filesystem skills without MCP (fallback)
  --mcp-only        Alias for the default MCP with bundled guidance
  Supported apps: codex, claude-code, cursor, claude-desktop, gemini-cli, windsurf

For agents (--json)
  scormplayer pins <course> --json              {ok, course, pinsFile, counts, pins[]}
  scormplayer pins <course> --resolve 2 --json  {ok, resolved[], counts}
  scormplayer unzip <zip> --json                {ok, folder, pinsFile, reused, movedPins}
  scormplayer <course> --json --no-open         One JSON event per line: ready (url, pid,
                                                pinsFile), then pin, progress, source, browser,
                                                course, log; stopped (with a reason) on exit.
                                                If the course is already open, ready has
                                                reused: true and the command exits.
  scormplayer update --check --json             {ok, current, latest, updateAvailable, method}
  scormplayer ps --json                         {ok, players[]: port, pid, url, title, idleSeconds}
  scormplayer stop <port> --json                {ok, stopped[], failed[]}
  scormplayer skill status --json               {ok, state: missing|current|outdated|newer, version, installed[]}
  scormplayer cache --json
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
      new: { type: "boolean", default: false },
      package: { type: "string" },
      idle: { type: "string" },
      global: { type: "boolean", short: "g", default: false },
      app: { type: "string", multiple: true },
      "mcp-only": { type: "boolean", default: false },
      "skills-only": { type: "boolean", default: false },
      "with-skills": { type: "boolean", default: false },
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
  if (positionals[0] === "setup") {
    if (positionals.length !== 1 || (values["mcp-only"] && (values["skills-only"] || values["with-skills"])) || (values["with-skills"] && values["skills-only"])) throw new UserError("Usage: scormplayer setup [--app codex --app cursor] [--with-skills | --skills-only]");
    const result = await runSetup({ ids: values.app, mcp: !values["skills-only"], skills: values["skills-only"] || values["with-skills"], json });
    if (!result.ok) process.exitCode = 1;
    return;
  }
  const commands = ["mcp", "skill", "plugin", "cache", "update", "upgrade", "ps", "stop", "pins", "unzip"];
  if (!commands.includes(positionals[0]) && (!positionals[0] || fs.existsSync(path.resolve(positionals[0]))) && shouldOfferSetup({ json, plain: values.plain })) {
    try { await runSetup(); }
    catch (error) { console.error(`Setup: ${error.message}\nYou can continue using the player and run scormplayer setup later.`); }
  }
  if (positionals.length === 0 && !values.drop && json && !isCourseFolder(process.cwd())) {
    throw new UserError("Pass a course (a SCORM .zip, a SCORM folder or a Vite project), or --drop to start empty.");
  }
  // Picked from the list of courses here: switching later shows that same list.
  let listHome = null;
  if (positionals.length === 0 && !values.drop) {
    listHome = process.cwd();
    const interactive = process.stdout.isTTY && process.stdin.isTTY && !values.plain;
    const here = process.cwd();
    if (!interactive && !isCourseFolder(here)) return void console.log(HELP);
    const choice = isCourseFolder(here) ? here : await pickCourse({ version: VERSION, courses: findCourses(here) });
    if (!choice) return;
    if (choice !== DROP_PAGE) positionals.push(choice);
  }

  const cacheDir = defaultCacheDir();

  if (positionals[0] === "mcp") {
    if (positionals.length !== 1) throw new UserError("Usage: scormplayer mcp");
    const [major, minor, patch] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && (minor < 22 || (minor === 22 && patch < 2)))) throw new UserError("The MCP server requires Node.js 22.22.2 or newer.");
    const entry = new URL("../dist/mcp/server.mjs", import.meta.url);
    if (!fs.existsSync(entry)) throw new UserError("The MCP server is not built. Run npm run build:plugins.");
    await import(entry.href);
    return;
  }
  if (positionals[0] === "skill") return runSkill(positionals[1] ?? "auto", values);
  if (positionals[0] === "plugin") {
    if (positionals.length > 3 || (positionals[1] === "install" && !positionals[2])) throw new UserError("Usage: scormplayer plugin install <codex|claude|cursor|all>");
    const result = await managePlugins(positionals[1] ?? "status", positionals[2] ?? "all");
    if (json) console.log(JSON.stringify(result));
    else {
      for (const item of result.results) console.log(`${item.host}: ${item.ok ? item.installed ? `installed (${item.versions.join(", ")}), ${item.enabled === null ? "activation managed in host" : item.enabled ? "enabled" : "disabled"}` : "not installed" : item.error}`);
      if (result.reload && result.results.some((item) => item.ok)) console.log(result.reload);
    }
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (positionals[0] === "cache") return runCache(positionals[1] ?? "status", defaultCacheDir(), json);
  if (positionals[0] === "update" || positionals[0] === "upgrade") return runUpdate({ cacheDir, check: values.check, json });
  if (positionals[0] === "ps") return runPs({ json, host: values.host });
  if (positionals[0] === "stop") return runStop(positionals.slice(1), { all: values.all, json, host: values.host });

  if (positionals[0] === "unzip") {
    const input = positionals[1];
    if (!input) throw new UserError("Usage: scormplayer unzip <zip> [--to <folder>]");
    const explicitPins = values.pins ?? configuredPinsFile(findConfig(input), path.resolve(input));
    const course = resolveCourse(input, { cacheDir, pinsFile: explicitPins, pkg: values.package });
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
    const course = resolveCourse(input, { cacheDir, live: values.live, pkg: values.package, pinsFile: values.pins ?? configuredPinsFile(findConfig(input), path.resolve(input)) });
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
      + `The commands are pins, unzip, update, ps, stop, skill, mcp, plugin, setup and cache (scormplayer --help). `
      + `If "${word}" is newer than this version, update first: scormplayer update`);
  }

  const port = values.port === undefined ? 4620 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UserError("--port must be a number from 0 to 65535.");
  const input = positionals[0] ? path.resolve(positionals[0]) : null;
  const config = input && fs.existsSync(input) ? findConfig(input) : null;
  const pinsFile = values.pins ?? (input ? configuredPinsFile(config, input) : null);

  // A dashboard in a terminal someone is watching runs until they quit it. A player in the
  // background (an agent, a script, CI) stops by itself once nobody is using it.
  const mode = process.stdout.isTTY && process.stdin.isTTY && !values.plain && !json && !process.env.CI ? "dashboard" : "background";

  // A zip or folder holding several courses: in a terminal, ask which one; elsewhere the first opens.
  let pkg = values.package ?? null;
  if (input && !pkg && mode === "dashboard" && fs.existsSync(input)) {
    const packages = (() => { try { return resolveCourse(input, { cacheDir, live: values.live }).packages; } catch { return null; } })();
    if (packages) {
      pkg = await askWhichPackage(input, packages);
      if (!pkg) return;
    }
  }

  // One player per course: if this course is already open (same pins), use that player.
  if (input && !values.new) {
    const running = findPlayer({ input, pinsFile, pkg });
    if (running && await askPlayer(running.url)) return reusePlayer(running, { json, open: !values["no-open"] });
  }

  const idleMinutes = values.idle !== undefined ? Number(values.idle) : mode === "background" ? 30 : 0;
  if (!Number.isFinite(idleMinutes) || idleMinutes < 0) throw new UserError("--idle must be a number of minutes (0 to never stop on its own).");

  let player;
  try {
    player = await startPlayer({
      input, cacheDir, host: values.host, port, live: values.live, pinsFile, mode, idleMinutes: idleMinutes || null, pkg,
      // Switching courses while it runs: the ones in this project (or beside this course), with
      // each one's pins where the project config says.
      courseList: () => findCourses(listHome ?? courseHome(input)),
      pinsFor: (course) => values.pins ? null : configuredPinsFile(findConfig(course), course),
    });
  } catch (error) {
    if (error.code === "PORTS_FULL") throw new UserError(await portsFullMessage(error.firstPort, values.host));
    throw error;
  }
  let stopSync = () => {};
  let reportSync = () => {};
  const moveSync = (course) => {
    stopSync();
    stopSync = startSync(findConfig(course.source), course.source, (message) => reportSync(message));
  };
  player.events.on("course", moveSync);
  const onQuit = async () => {
    stopSync();
    player.events.off("course", moveSync);
    await player.close();
    process.exit(0);
  };
  if (json) {
    const reporter = createJsonReporter({ player, onQuit });
    reportSync = reporter.log;
    if (player.course) moveSync(player.course);
    watchForAbandonment(player, idleMinutes, (reason) => reporter.quit(reason));
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
    skill: { status: () => skillStatus(), install: () => installSkill(), update: () => updateSkills() },
    courses: () => findCourses(listHome ?? courseHome(input)),
    switchCourse: (course) => player.switchCourse(course),
  });
  reportSync = (message) => dashboard.log(message);
  if (player.course) moveSync(player.course);
  watchForAbandonment(player, idleMinutes, (reason) => { dashboard.log(`Stopping: ${reason}`); void dashboard.quit(); });
  void checkForUpdate({ current: VERSION, cacheDir }).then((latest) => {
    if (!latest) return;
    dashboard.updateAvailable(latest, updateHint());
    player.setUpdate({ latest, command: updateHint() });
  });
  if (player.course?.packages) dashboard.log(packagesNote(player.course, positionals[0]));
  // The full dashboard offers the s key instead; plain output gets a one-line tip.
  if (mode !== "dashboard") {
    const skill = skillStatus();
    if (skill.state === "missing") dashboard.log("Tip: run `scormplayer skill` so coding agents can act on your pins");
    else if (skill.state === "outdated") dashboard.log(`The agent skill is behind scormplayer ${skill.version}. Update it: scormplayer skill`);
  }
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

/**
 * Stop a player that has been left behind: no page has asked it for anything in `idleMinutes`
 * (an open page asks every few seconds), an open page asked "Still there?" and nobody answered,
 * or the program that started it has exited, which on macOS and Linux shows as a new parent
 * process (whoever adopted it). 0 minutes turns all three off.
 */
function watchForAbandonment(player, idleMinutes, stop) {
  if (!idleMinutes) return;
  // An open page asked "Still there?" and nobody answered.
  player.events.once("idle-close", () => stop("nobody answered \"Still there?\" in the browser"));
  const timer = setInterval(() => {
    if (player.idleFor() > idleMinutes * 60_000) {
      clearInterval(timer);
      stop(`nobody has used the player for ${idleMinutes} ${idleMinutes === 1 ? "minute" : "minutes"}`);
    } else if (process.platform !== "win32" && process.ppid !== STARTED_BY) {
      clearInterval(timer);
      stop("the program that started it has exited");
    }
  }, Math.min(5_000, idleMinutes * 60_000));
  timer.unref();
}

/**
 * Where to look for courses to switch to: the project root when the course has a
 * scormplayer.config.json, otherwise the folder holding it (its siblings), or here.
 */
function courseHome(input) {
  if (!input) return process.cwd();
  const config = fs.existsSync(input) ? findConfig(input) : null;
  if (config) return config.root;
  return path.resolve(input) === process.cwd() ? process.cwd() : path.dirname(path.resolve(input));
}

/** Several courses in one zip or folder: choose one with the arrow keys. Null when cancelled. */
async function askWhichPackage(input, packages) {
  const index = await pickFromList({
    title: `${path.basename(input)} holds ${packages.length} courses. Open which?`,
    items: packages.map((item) => ({ label: item.title, note: item.name })),
  });
  return index === null ? null : packages[index].name;
}

/** Which of several courses is open, and how to open the others. */
function packagesNote(course, input) {
  const others = course.packages.filter((item) => item.name !== course.package);
  return `This holds ${course.packages.length} courses; opened ${course.package}. Others: ${others.map((item) => item.name).join(", ")} `
    + `(switch in the player under More, or: scormplayer ${quote(input ?? course.source)} --package ${quote(others[0]?.name ?? "")})`;
}

/** The course is already open in another player: point at that one instead of starting another. */
async function reusePlayer(running, { json, open }) {
  if (open) openBrowser(running.url);
  if (json) {
    return void console.log(JSON.stringify({
      event: "ready", at: new Date().toISOString(), reused: true, url: running.url, pid: running.pid,
      course: { title: running.title, kind: running.kind, source: running.source, editable: running.kind !== "package" },
      pinsFile: running.pinsFile,
    }));
  }
  console.log(`${running.title ?? "This course"} is already open at ${running.url} (started ${since(running.startedAt)} ago, process ${running.pid}).`);
  console.log(`${open ? "Opened it in your browser. " : ""}Stop it with: scormplayer stop ${running.port}   Start another anyway with: --new`);
}

/** Every player on this machine: the registered ones, plus ones from older versions found on the port range. */
async function allPlayers(host) {
  const registered = await Promise.all(listPlayers().map(async (player) => {
    const info = await askPlayer(player.url);
    return { ...player, registered: true, responding: Boolean(info), idleSeconds: info?.idleSeconds ?? null };
  }));
  const older = (await unregisteredPlayers({ count: PORT_RANGE, known: registered.map((player) => player.port), host }))
    .map((player) => ({ ...player, mode: "unknown", startedAt: null, idleSeconds: null, responding: true }));
  return [...registered, ...older].sort((a, b) => a.port - b.port);
}

async function runPs({ json, host }) {
  const players = await allPlayers(host);
  if (json) return void console.log(JSON.stringify({ ok: true, players, range: { first: 4620, last: 4620 + PORT_RANGE - 1 } }));
  const inRange = players.filter((player) => player.port >= 4620 && player.port < 4620 + PORT_RANGE).length;
  if (!players.length) return void console.log(`No players running. (Ports 4620–${4620 + PORT_RANGE - 1} are free.)`);
  console.log(`${players.length} ${players.length === 1 ? "player" : "players"} running · ${PORT_RANGE - inRange} of ${PORT_RANGE} ports free\n`);
  const rows = players.map((player) => [
    String(player.port),
    String(player.pid ?? "?"),
    player.mode === "dashboard" ? "terminal" : player.mode === "background" ? "background" : "older version",
    player.idleSeconds === null ? "—" : player.idleSeconds < 20 ? "now" : `${since(Date.now() - player.idleSeconds * 1000)} ago`,
    `${player.title ?? "No course open"}${player.kind === "live" ? " (live)" : ""}`,
  ]);
  const head = ["PORT", "PID", "RUNNING IN", "LAST USED", "COURSE"];
  const widths = head.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column].length)));
  for (const row of [head, ...rows]) console.log(`  ${row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]))).join("  ")}`);
  console.log("\nStop one with: scormplayer stop <port>   Stop all: scormplayer stop --all");
}

async function runStop(targets, { all, json, host }) {
  const players = await allPlayers(host);
  if (!all && !targets.length) {
    if (players.length !== 1) throw new UserError(players.length ? "Say which: scormplayer stop <port> (scormplayer ps lists them), or --all." : "No players running.");
  }
  const chosen = all || !targets.length ? players : targets.map((target) => {
    const number = Number(target);
    const player = players.find((item) => item.port === number) ?? players.find((item) => item.pid === number);
    if (!player) throw new UserError(`No player on port or with process id ${target}. scormplayer ps lists them.`);
    return player;
  });
  const stopped = [];
  const failed = [];
  for (const player of chosen) {
    if (!player.pid || player.pid === process.pid) { failed.push({ port: player.port, reason: "no process id" }); continue; }
    if (await stopPlayer(player.pid)) stopped.push({ port: player.port, pid: player.pid, title: player.title });
    else failed.push({ port: player.port, pid: player.pid, reason: isAlive(player.pid) ? "still running" : "unknown" });
  }
  if (json) return void console.log(JSON.stringify({ ok: !failed.length, stopped, failed }));
  for (const item of stopped) console.log(`Stopped port ${item.port}${item.title ? `: ${item.title}` : ""}`);
  for (const item of failed) console.log(`Couldn't stop port ${item.port} (${item.reason})${item.pid ? `. Try: kill ${item.pid}` : ""}`);
  if (!chosen.length) console.log("No players running.");
  if (failed.length) process.exitCode = 1;
}

/** When every port in the range is taken: say what holds them and how to free them. */
async function portsFullMessage(first, host) {
  const players = (await allPlayers(host)).filter((player) => player.port >= first && player.port < first + PORT_RANGE);
  const lines = [`All ${PORT_RANGE} player ports (${first}–${first + PORT_RANGE - 1}) are in use.`];
  if (players.length) {
    lines.push(`${players.length} of them are scormplayer players, probably left running:`);
    for (const player of players.slice(0, 8)) lines.push(`  ${player.port}  ${player.title ?? "No course open"}${player.idleSeconds !== null ? ` (last used ${since(Date.now() - player.idleSeconds * 1000)} ago)` : ""}`);
    if (players.length > 8) lines.push(`  … and ${players.length - 8} more`);
    lines.push("See them all: scormplayer ps   Stop them: scormplayer stop --all");
  } else {
    lines.push("Other programs hold them. Pass --port to choose another, like --port 5000.");
  }
  return lines.join("\n");
}

/** "3 min", "2 h", "5 days": how long ago a time was. */
function since(time) {
  const seconds = Math.max(0, (Date.now() - new Date(time).getTime()) / 1000);
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min`;
  if (seconds < 36 * 3600) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86400)} days`;
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
  const method = installMethod();
  if (method.kind === "standalone" && !check) {
    if (json) return void console.log(JSON.stringify({ ok: true, method: "standalone", manual: true, command: method.hint }));
    return say(`Update this standalone install through GitHub:\n${method.hint}`);
  }
  let latest;
  try { latest = await fetchLatest({ cacheDir }); }
  catch (error) { throw new UserError(`Couldn't reach the npm registry to check for updates (${error.message}).`); }
  const updateAvailable = isNewer(latest, VERSION);
  // Just after a release npm names the new version before its file can be downloaded.
  const ready = updateAvailable ? await packageReady(latest) : true;
  const stillProcessing = `Version ${latest} is published, but npm is still getting it ready to download (usually a few minutes, now and then up to 20).`;
  if (check || !updateAvailable) {
    if (json) return void console.log(JSON.stringify({ ok: true, current: VERSION, latest, updateAvailable, ready, method: method.kind }));
    if (!updateAvailable) return say(`scormplayer ${VERSION} is the latest version.`);
    if (!ready) return say(`${stillProcessing} You have ${VERSION}; check again shortly.`);
    return say(`scormplayer ${latest} is available (you have ${VERSION}). Update with: ${method.hint}`);
  }
  if (!ready) throw Object.assign(new UserError(`${stillProcessing} Try \`scormplayer update\` again shortly.`), { code: "not_ready" });
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
  let result = await runInstall(command, { sudo });
  if (result.code !== 0 && tool === "npm") {
    // npm's full version list can lag its "latest" answer; the package file itself is there (checked above).
    command = tarballInstall(latest);
    result = await runInstall(command, { sudo });
  }
  if (result.code !== 0) {
    throw new UserError(`The update didn't install. npm said:\n${summarizeInstallError(result.output)}\nTo try it by hand: ${sudo ? "sudo " : ""}${NPM_INSTALL.join(" ")}`);
  }
  const now = installedVersion();

  // Bring the agent skill up to this version wherever it's installed (it only changes when it's behind).
  const before = skillStatus();
  let skill = before.state === "missing" ? "not installed" : "current";
  if (before.state === "outdated") {
    say("Updating the agent skill…");
    skill = (await updateSkills().catch(() => ({ state: "outdated" }))).state === "outdated" ? "failed" : "updated";
  }

  if (json) return void console.log(JSON.stringify({ ok: true, from: VERSION, to: now, method: tool, skill }));
  say(`scormplayer is now ${now}.${skill === "updated" ? " The agent skill is updated too." : ""}`);
  if (skill === "failed") say("The agent skill didn't update; run: scormplayer skill");
}

/** One line on the installed skill against this scormplayer's. */
function describeSkill(status) {
  const where = status.installed.map((copy) => `${copy.scope === "global" ? "all projects" : "this project"}${copy.version ? ` ${copy.version}` : ""}`).join(", ");
  if (status.state === "missing") return `No coding agent has the scormplayer skill. Install it with: scormplayer skill`;
  if (status.state === "current") return `The agent skill matches scormplayer ${status.version} (${where}).`;
  if (status.state === "newer") return `The agent skill (${where}) is newer than scormplayer ${status.version}. Update scormplayer: scormplayer update`;
  return `The agent skill (${where}) is behind scormplayer ${status.version}.`;
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
    const status = skillStatus();
    if (values.json) return void console.log(JSON.stringify({ ok: true, ...status, installed: status.installed }));
    return void console.log(describeSkill(status));
  }
  // Plain `scormplayer skill`: whatever it takes to have a current skill.
  if (action === "auto") {
    const status = skillStatus();
    if (status.state === "missing") {
      if (values.json || !process.stdin.isTTY) throw new UserError("No agent has the scormplayer skill. Install it with: scormplayer skill install (add -g -y to skip the questions)");
      console.log("No coding agent has the scormplayer skill yet. Installing it (choose your agents and scope):");
      process.exitCode = await runSkills(skillsArgs("add", { local: values.local, global: values.global, agents: values.agent ?? [], yes: values.yes, copy: values.copy }));
      return;
    }
    if (status.state === "outdated") {
      if (!values.json) console.log(`${describeSkill(status)} Updating it…`);
      const after = await updateSkills();
      if (values.json) return void console.log(JSON.stringify({ ok: after.state !== "outdated", state: after.state, version: after.version, installed: after.installed }));
      console.log(after.state === "outdated" ? `It didn't update. Run: scormplayer skill install${after.output ? `\n${after.output.split("\n").slice(-3).join("\n")}` : ""}` : `The agent skill is now ${after.version}.`);
      if (after.state === "outdated") process.exitCode = 1;
      return;
    }
    if (values.json) return void console.log(JSON.stringify({ ok: true, ...status }));
    return void console.log(describeSkill(status));
  }
  throw new UserError(`Unknown skill command "${action}". Use install, status, remove or print, or just: scormplayer skill`);
}


const ARGV = process.argv.slice(2);
main(ARGV).catch((error) => {
  if (ARGV.includes("--json")) {
    const user = error instanceof UserError || error?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" || error?.statusCode === 404;
    process.stdout.write(jsonError(error?.message ?? String(error), error?.code === "not_ready" ? "not_ready" : user ? "user_error" : "internal_error"));
  } else {
    console.error(`scormplayer: ${error instanceof UserError ? error.message : error?.stack ?? error}`);
  }
  process.exit(1);
});
