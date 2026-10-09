import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

/**
 * Optional project settings in scormplayer.config.json, found by walking up from the course:
 *
 *   {
 *     "courses": ["lessons/*"],                         // where the course finder looks
 *     "pins": ".local/pins/{name}.pins.json",            // where pins go ({name} = course folder)
 *     "sync": [{                                         // keep generated files current while open
 *       "files": ["content/lessons/{name}/learner-content.json"],
 *       "run": "node scripts/sync.mjs --lesson {name}"
 *     }],
 *     "qa": {                                            // house rules for an agent's QA pass
 *       "focus": ["copy", "accessibility"], "styleGuide": "docs/style.md", "maxPinsPerPage": 5,
 *       "audience": "new hires", "readingLevel": "grade 8", "terms": { "avoid": [], "prefer": {} }
 *     }
 *   }
 *
 * Paths are relative to the config file. Nothing here is required.
 */
export const CONFIG_FILE = "scormplayer.config.json";

export function findConfig(start) {
  let dir = path.resolve(start);
  if (fs.existsSync(dir) && fs.statSync(dir).isFile()) dir = path.dirname(dir);
  for (;;) {
    const file = path.join(dir, CONFIG_FILE);
    if (fs.existsSync(file)) {
      let data;
      try { data = JSON.parse(fs.readFileSync(file, "utf8")); }
      catch (error) { throw new Error(`${file} is not valid JSON: ${error.message}`); }
      return { file, root: dir, data: data && typeof data === "object" ? data : {} };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The course's name for templates: its folder or zip name. */
export function courseName(source) {
  const parsed = path.parse(source);
  return parsed.ext.toLowerCase() === ".zip" ? parsed.name : parsed.base;
}

function fill(template, name) {
  return String(template).replaceAll("{name}", name);
}

export function configuredPinsFile(config, source) {
  if (!config?.data.pins) return null;
  return path.resolve(config.root, fill(config.data.pins, courseName(source)));
}

/** Course folders/zips the config points the finder at (simple trailing-* globs). */
export function configuredCourses(config) {
  const patterns = Array.isArray(config?.data.courses) ? config.data.courses : [];
  const out = [];
  for (const pattern of patterns) {
    const absolute = path.resolve(config.root, pattern);
    if (!absolute.endsWith(`${path.sep}*`)) {
      if (fs.existsSync(absolute)) out.push(absolute);
      continue;
    }
    const dir = absolute.slice(0, -2);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.name.startsWith(".")) out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/**
 * Run the config's sync commands when their files change while a course is open.
 * `report(message)` receives a line for the dashboard. Returns a stop function.
 */
export function startSync(config, source, report = () => {}) {
  const rules = Array.isArray(config?.data.sync) ? config.data.sync : [];
  if (!rules.length) return () => {};
  const name = courseName(source);
  const stops = [];
  for (const rule of rules) {
    if (!rule?.run || !Array.isArray(rule.files)) continue;
    const command = fill(rule.run, name);
    const files = rule.files.map((file) => path.resolve(config.root, fill(file, name))).filter((file) => fs.existsSync(file));
    let stopped = false;
    let timer = null;
    let running = false;
    let again = false;
    const run = () => {
      if (stopped) return;
      if (running) { again = true; return; }
      running = true;
      const child = spawn(command, { cwd: config.root, shell: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-8192); });
      child.stderr.on("data", (chunk) => { output = (output + chunk).slice(-8192); });
      let finished = false;
      const finish = (code) => {
        if (finished) return;
        finished = true;
        running = false;
        if (stopped) return;
        report(code === 0 ? `Synced: ${command}` : `Sync failed (${code}): ${output.trim().split("\n").pop() ?? command}`);
        if (again) { again = false; run(); }
      };
      child.once("error", (error) => { output = error.message; finish("spawn"); });
      child.once("close", finish);
    };
    const listeners = [];
    for (const file of files) {
      const listener = (current, previous) => {
        if (stopped) return;
        if (current.mtimeMs === previous.mtimeMs) return;
        clearTimeout(timer);
        timer = setTimeout(run, 150);
      };
      listeners.push([file, listener]);
      fs.watchFile(file, { interval: 300 }, listener);
    }
    stops.push(() => {
      stopped = true;
      again = false;
      clearTimeout(timer);
      listeners.forEach(([file, listener]) => fs.unwatchFile(file, listener));
    });
  }
  return () => stops.forEach((stop) => stop());
}
