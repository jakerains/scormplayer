#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { startPlayer, resolveCourse, createPinStore, createDashboard, openBrowser, UserError } from "../server/index.mjs";
import { SKILL_FILE, SKILL_REPO, runSkills, skillsArgs, skillInstalledAnywhere } from "../server/skill.mjs";

const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const HELP = `scormplayer ${VERSION}

Open a SCORM course in your browser and leave pinned notes on it.

Usage
  scormplayer <course>            Open a SCORM .zip, a SCORM folder, or a Vite project
  scormplayer pins <course>       Print the open pins as a hand-off for a teammate or an agent
  scormplayer skill install       Teach your coding agents to act on pins (pick agents and scope)

Options
  --live            Serve a Vite project from source with hot reload (automatic when the
                    folder has a vite.config and no imsmanifest.xml)
  --port <n>        Port to use (default 4620, or the next free one)
  --host <host>     Host to bind (default 127.0.0.1)
  --pins <file>     Where to keep pins (default: <course>.pins.json beside a zip or folder,
                    .scormplayer/pins.json inside a live project)
  --no-open         Don't open the browser
  --plain           Plain log lines instead of the dashboard (automatic without a terminal)
  -v, --version     Print the version
  -h, --help        Show this help

pins options
  --all             Include resolved pins
  --json            Print the pins as JSON
  --resolve <n>     Mark pin <n> resolved (repeatable); --note "<text>" records what changed

skill commands (run through the open skills CLI: npx skills, 75+ agents)
  skill install     Pick agents and scope, then install or update the skill
  skill remove      Remove it
  skill print       Print the skill to stdout
  Flags passed to skills: -g/--global, -a/--agent <name>, -y/--yes, --copy;
  --local installs the copy bundled with this version instead of the GitHub one

Examples
  scormplayer ./my-course.zip
  npx @jakerains/scormplayer@latest ./my-course.zip
  scormplayer ./my-vite-course --live
  scormplayer pins ./my-course.zip | pbcopy
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
      all: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      resolve: { type: "string", multiple: true },
      note: { type: "string" },
      global: { type: "boolean", short: "g", default: false },
      agent: { type: "string", short: "a", multiple: true },
      yes: { type: "boolean", short: "y", default: false },
      copy: { type: "boolean", default: false },
      local: { type: "boolean", default: false },
      version: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.version) return void console.log(VERSION);
  if (values.help || positionals.length === 0) return void console.log(HELP);

  const cacheDir = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "scormplayer");

  if (positionals[0] === "skill") return runSkill(positionals[1] ?? "status", values);

  if (positionals[0] === "pins") {
    const input = positionals[1];
    if (!input) throw new UserError("Usage: scormplayer pins <course>");
    const course = resolveCourse(input, { cacheDir, live: values.live, pinsFile: values.pins ?? null });
    const store = createPinStore(course.pinsFile, course);
    for (const id of values.resolve ?? []) {
      const pin = store.update(id, { status: "resolved", resolution: values.note });
      console.error(`Resolved pin ${pin.number}.`);
    }
    if (values.resolve?.length) return;
    if (values.json) return void console.log(JSON.stringify(store.list({ status: values.all ? "all" : "open" }), null, 2));
    return void process.stdout.write(store.brief({ status: values.all ? "all" : "open" }));
  }

  const port = values.port === undefined ? 4620 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UserError("--port must be a number from 0 to 65535.");
  const player = await startPlayer({
    input: positionals[0],
    cacheDir,
    host: values.host,
    port,
    live: values.live,
    pinsFile: values.pins ?? null,
  });
  const dashboard = createDashboard({
    version: VERSION,
    entries: [{ id: path.basename(player.course.source), player }],
    plain: values.plain,
    pinsHint: () => `scormplayer pins ${quote(positionals[0])}`,
    onQuit: async () => {
      await player.close();
      process.exit(0);
    },
  });
  if (!skillInstalledAnywhere()) dashboard.log("Tip: run `scormplayer skill install` so coding agents can act on your pins");
  if (!values["no-open"]) openBrowser(player.url);
}

function quote(value) {
  return /^[\w./~:-]+$/.test(value) ? value : JSON.stringify(value);
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
    console.log(skillInstalledAnywhere()
      ? "The scormplayer skill is installed. Update it with: scormplayer skill install"
      : `Not installed. Run: scormplayer skill install   (or: npx skills add ${SKILL_REPO})`);
    return;
  }
  throw new UserError(`Unknown skill command "${action}". Use install, remove or print.`);
}


main(process.argv.slice(2)).catch((error) => {
  console.error(`scormplayer: ${error instanceof UserError ? error.message : error?.stack ?? error}`);
  process.exit(1);
});
