import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { withFileLock } from "./file-lock.mjs";

/**
 * Agent QA runs: an agent walks the course, suggests pins and records what it covered. Runs
 * live in `<course>.qa.json` beside the pins file, and the last finished run is written out as
 * `<course>.qa-log.md`, a plain log a reviewer can read or share.
 */

const KEEP_RUNS = 20;
/** A run nobody has touched for this long no longer blocks a new one. */
const STALE_MS = 2 * 60 * 60 * 1000;
export const PAGE_STATUSES = ["reviewed", "skipped", "unreachable"];

/** `course.pins.json` → `course.qa.json` and `course.qa-log.md`; `.scormplayer/pins.json` → `.scormplayer/qa.json`. */
export function qaFiles(pinsFile) {
  const dir = path.dirname(pinsFile);
  const stem = path.basename(pinsFile).replace(/\.json$/i, "");
  const prefix = stem === "pins" ? "" : `${stem.replace(/\.pins$/i, "")}.`;
  return { runsFile: path.join(dir, `${prefix}qa.json`), logFile: path.join(dir, `${prefix}qa-log.md`) };
}

export function createQaStore(pinsFile) {
  const { runsFile, logFile } = qaFiles(pinsFile);
  const fail = (message, statusCode) => { throw Object.assign(new Error(message), { statusCode }); };

  function read() {
    if (!fs.existsSync(runsFile)) return { version: 1, runs: [] };
    const data = JSON.parse(fs.readFileSync(runsFile, "utf8"));
    return Array.isArray(data.runs) ? data : { version: 1, runs: [] };
  }
  function write(data) {
    fs.mkdirSync(path.dirname(runsFile), { recursive: true });
    const temp = `${runsFile}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`);
    fs.renameSync(temp, runsFile);
  }
  const transaction = (fn) => withFileLock(runsFile, () => { const data = read(); const result = fn(data); write(data); return result; });
  const live = (run) => (run.state === "running" || run.state === "stopping") && Date.now() - Date.parse(run.updatedAt) < STALE_MS;
  const find = (data, id) => data.runs.find((run) => run.id === id) ?? fail(`No QA run ${id}.`, 404);
  const running = (data, id) => {
    const run = find(data, id);
    if (!live(run)) fail(`QA run ${id} has ended.`, 409);
    return run;
  };
  const touch = (run) => { run.updatedAt = new Date().toISOString(); };

  return {
    runsFile,
    logFile,

    /** The run in progress (or being stopped), if any. */
    active() {
      return read().runs.find(live) ?? null;
    },

    list() {
      return read().runs;
    },

    get(id) {
      return find(read(), id);
    },

    /** Start a run. Another one in progress is refused unless `replace` is set. */
    start({ agent = "agent", focus = [], modules = null, rubric = null, replace = false } = {}) {
      return transaction((data) => {
        const current = data.runs.find(live);
        if (current && !replace) fail(`A QA run is already in progress (${current.id}, started ${current.startedAt}). Finish or stop it first.`, 409);
        for (const run of data.runs) if (run.state === "running" || run.state === "stopping") Object.assign(run, { state: "abandoned", endedAt: new Date().toISOString() });
        const now = new Date().toISOString();
        const run = {
          id: `qa-${now.slice(0, 10)}-${randomUUID().slice(0, 6)}`,
          agent: String(agent).slice(0, 80),
          state: "running",
          startedAt: now,
          updatedAt: now,
          focus: Array.isArray(focus) ? focus.map(String).slice(0, 20) : [],
          modules: Array.isArray(modules) ? modules.slice(0, 200) : null,
          rubric,
          pages: [],
          suggestions: [],
          summary: "",
        };
        data.runs = [...data.runs, run].slice(-KEEP_RUNS);
        return run;
      });
    },

    /** Record one page: reviewed, skipped or unreachable, with what was checked and placed. */
    logPage(id, entry) {
      if (!PAGE_STATUSES.includes(entry?.status)) fail(`status must be ${PAGE_STATUSES.join(", ")}.`, 400);
      return transaction((data) => {
        const run = running(data, id);
        const page = {
          module: entry.module ?? null,
          page: entry.page ?? null,
          status: entry.status,
          notes: String(entry.notes ?? "").slice(0, 2000),
          checks: Array.isArray(entry.checks) ? entry.checks.map(String).slice(0, 20) : [],
          at: new Date().toISOString(),
        };
        const key = pageKey(page);
        const existing = run.pages.find((item) => pageKey(item) === key);
        if (existing) { Object.assign(existing, page, { pins: existing.pins ?? [] }); delete existing.pending; }
        else run.pages.push({ ...page, pins: [] });
        touch(run);
        return { run, stop: run.state === "stopping" };
      });
    },

    /** Note a suggestion this run placed (or merged into), against the page it is on. */
    noteSuggestion(id, pin, outcome, where = {}) {
      return transaction((data) => {
        const run = running(data, id);
        if (!run.suggestions.includes(pin.number)) run.suggestions.push(pin.number);
        const key = pageKey(where);
        let page = run.pages.find((item) => pageKey(item) === key);
        if (!page) { page = { ...where, status: "reviewed", notes: "", checks: [], pins: [], at: new Date().toISOString(), pending: true }; run.pages.push(page); }
        if (!page.pins.includes(pin.number)) page.pins.push(pin.number);
        run.outcomes = { ...(run.outcomes ?? {}), [outcome]: (run.outcomes?.[outcome] ?? 0) + 1 };
        touch(run);
        return { run, stop: run.state === "stopping" };
      });
    },

    /** Ask the agent to stop: its next QA call is told so, and it finishes. */
    stop(id) {
      return transaction((data) => {
        const run = running(data, id);
        run.state = "stopping";
        touch(run);
        return run;
      });
    },

    /** End the run and write the log. `pins` are the course's pins, for the suggestions section. */
    finish(id, { summary = "", checks = null } = {}, { course, pins = [] } = {}) {
      const run = transaction((data) => {
        const found = find(data, id);
        if (!["running", "stopping"].includes(found.state)) fail(`QA run ${id} already ended (${found.state}).`, 409);
        found.state = found.state === "stopping" ? "stopped" : "finished";
        found.endedAt = new Date().toISOString();
        found.summary = String(summary).slice(0, 8000);
        if (checks) found.checks = checks;
        touch(found);
        return found;
      });
      fs.writeFileSync(logFile, formatQaLog(course, run, pins));
      return { run, logFile };
    },
  };
}

/** Pages are told apart by module title, page index and page title (what the player reports). */
function pageKey(page = {}) {
  return `${page.module?.title ?? ""}|${page.page?.index ?? ""}|${page.page?.title ?? ""}`;
}

/** Where a pin is, in the same terms as a logged page. */
export function pinPlace(page = {}) {
  return {
    module: page.scoTitle ? { title: page.scoTitle } : null,
    page: { ...(Number.isInteger(page.navIndex) ? { index: page.navIndex } : {}), title: page.title ?? "" },
  };
}

const SEVERITY_ORDER = ["blocker", "major", "minor", "polish"];

/** The log a reviewer reads after a pass: coverage, suggestions by severity, and the agent's summary. */
export function formatQaLog(course, run, pins = []) {
  const own = pins.filter((pin) => pin.origin?.kind === "agent" && pin.origin.runId === run.id);
  const counts = { reviewed: 0, skipped: 0, unreachable: 0 };
  for (const page of run.pages) counts[page.status] = (counts[page.status] ?? 0) + 1;
  // A module without a page list reports its own title as the page's: say it once.
  const join = (parts) => [...new Set(parts.filter(Boolean))].join(" › ");
  const where = (page) => join([page.module?.title ?? (page.module?.index !== undefined ? `Module ${page.module.index + 1}` : null),
    page.page?.title ?? (page.page?.index !== undefined ? `Page ${page.page.index + 1}` : null)]) || "Course";
  const pinWhere = (pin) => join([pin.page?.scoTitle, pin.page?.title]) || pin.page?.url || "";
  const lines = [
    `# QA log: ${course?.title ?? "course"}`,
    "",
    `- Run: ${run.id} by ${run.agent} · ${run.state}`,
    `- Started: ${run.startedAt}${run.endedAt ? ` · ended ${run.endedAt}` : ""}`,
    ...(course?.source ? [`- Course: ${course.source}`] : []),
    ...(run.focus?.length ? [`- Focus: ${run.focus.join(", ")}`] : []),
    `- Coverage: ${counts.reviewed} reviewed, ${counts.skipped} skipped, ${counts.unreachable} unreachable`,
    `- Suggestions: ${own.length} (${SEVERITY_ORDER.map((severity) => `${own.filter((pin) => pin.severity === severity).length} ${severity}`).join(", ")})`,
    "",
  ];
  if (run.summary) lines.push("## Summary", "", run.summary, "");
  lines.push("## Coverage", "", "| Where | Status | Pins | Notes |", "| --- | --- | --- | --- |");
  for (const page of run.pages) {
    lines.push(`| ${cell(where(page))} | ${page.status}${page.pending ? " (not logged)" : ""} | ${page.pins?.length ? page.pins.map((number) => `#${number}`).join(" ") : ""} | ${cell(page.notes)} |`);
  }
  if (!run.pages.length) lines.push("| — | nothing logged | | |");
  lines.push("");
  if (own.length) {
    lines.push("## Suggestions", "");
    for (const severity of SEVERITY_ORDER) {
      const group = own.filter((pin) => pin.severity === severity);
      if (!group.length) continue;
      lines.push(`### ${severity[0].toUpperCase()}${severity.slice(1)}`, "");
      for (const pin of group) {
        const state = pin.status === "open" ? "accepted" : pin.status;
        lines.push(`- **#${pin.number}** [${pin.category}] ${pinWhere(pin)} (${state}): ${oneLine(pin.note)}`);
        if (pin.evidence) lines.push(`  - Evidence: ${oneLine(pin.evidence)}`);
        if (pin.alsoOn?.length) lines.push(`  - Also on: ${pin.alsoOn.map((page) => page.title || page.url).join("; ")}`);
      }
      lines.push("");
    }
  }
  if (run.checks) lines.push("## Automated checks", "", "```json", JSON.stringify(run.checks, null, 2), "```", "");
  lines.push("Suggestions are not part of the hand-off until a reviewer accepts them (Pins → Suggestions, or `scormplayer pins <course> --accept <n>`).", "");
  return lines.join("\n");
}

function cell(value) {
  return oneLine(value ?? "").replace(/\|/g, "\\|");
}

function oneLine(value) {
  return String(value).replace(/\s+/g, " ").trim();
}
