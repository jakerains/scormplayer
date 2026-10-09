import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPinStore } from "../server/pins.mjs";
import { createQaStore, qaFiles } from "../server/qa.mjs";
import { startPlayer } from "../server/index.mjs";
import { scorm12Zip } from "./fixtures.mjs";

const BIN = fileURLToPath(new URL("../bin/scormplayer.mjs", import.meta.url));
const course = { title: "QA course", source: "/tmp/qa-course.zip", kind: "package" };
const target = { kind: "element", anchorVersion: 1, tag: "p", selector: "#intro", name: "intro paragraph", text: "Welcom to the course", rect: { x: 0, y: 0, width: 10, height: 10 }, viewport: { width: 1024, height: 768 } };
const page = (title, navIndex = 0) => ({ url: "index.html", title, navIndex, scoId: "m1", scoTitle: "Module 1" });
const qa = (extra = {}) => ({ runId: "run-1", agent: "test-agent", category: "copy", severity: "minor", evidence: "\"Welcom to the course\"", ...extra });

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "scormplayer-qa-"));
}

test("QA suggestions: kept out of the hand-off, merged when repeated, dismissed ones not suggested again", () => {
  const dir = tempDir();
  const store = createPinStore(path.join(dir, "course.pins.json"), course);
  const human = store.create({ note: "Make the logo bigger", page: page("Intro"), target });
  assert.equal(human.status, "open");
  assert.equal(human.origin, undefined);

  const first = store.suggest({ note: "Typo: \"Welcom\" should be \"Welcome\".", page: page("Intro"), target, qa: qa() });
  assert.equal(first.outcome, "created");
  assert.equal(first.pin.status, "suggested");
  assert.deepEqual(first.pin.origin, { kind: "agent", agent: "test-agent", runId: "run-1" });
  assert.equal(store.suggest({ note: "Same typo", page: page("Intro"), target, qa: qa({ evidence: "Welcom to the course." }) }).outcome, "duplicate");
  const merged = store.suggest({ note: "Same typo", page: page("Summary", 3), target, qa: qa() });
  assert.equal(merged.outcome, "merged");
  assert.deepEqual(merged.pin.alsoOn.map((where) => where.title), ["Summary"]);
  assert.throws(() => store.suggest({ note: "x", page: page("Intro"), target, qa: qa({ category: "vibes" }) }), /category must be one of/);
  assert.throws(() => store.suggest({ note: "x", page: page("Intro"), target, qa: qa({ evidence: " " }) }), /needs evidence/);

  const other = store.suggest({ note: "Image has no alt text", page: page("Intro"), target, qa: qa({ category: "accessibility", severity: "major", evidence: "img src=hazard.png has no alt" }) }).pin;
  assert.equal(store.brief().includes("Typo:"), false, "suggestions stay out of the hand-off");
  assert.match(store.brief({ status: "suggested" }), /QA suggestion, not accepted/);

  store.triage([first.pin.number], "accept");
  const accepted = store.list().find((pin) => pin.id === first.pin.id);
  assert.equal(accepted.status, "open");
  assert.match(store.brief(), /Origin: agent QA suggestion by test-agent \(run run-1\), accepted by the reviewer · copy · minor/);
  assert.match(store.brief(), /Also on: Summary/);

  store.triage([String(other.number)], "dismiss");
  assert.throws(() => store.suggest({ note: "again", page: page("Intro"), target, qa: qa({ category: "accessibility", severity: "major", evidence: "IMG src=hazard.png has no alt!" }) }), /dismissed this before/);
  assert.throws(() => store.triage([human.number], "accept"), /isn't a QA suggestion/);
  assert.throws(() => store.update(human.number, { status: "dismissed" }), /Only QA suggestions/);

  const third = store.suggest({ note: "Unclear button label", page: page("Quiz", 2), target, qa: qa({ category: "content", evidence: "Button says \"Go\"" }) }).pin;
  assert.equal(third.status, "suggested");
  const removed = store.clearQa();
  assert.deepEqual(removed.map((pin) => pin.number).sort(), [other.number, third.number].sort());
  assert.deepEqual(store.list().map((pin) => pin.number).sort(), [human.number, first.pin.number].sort(), "accepted and human pins stay");
});

test("QA runs: one at a time, pages logged, stop requested, log written", () => {
  const dir = tempDir();
  const pinsFile = path.join(dir, "course.pins.json");
  assert.deepEqual(qaFiles(pinsFile), { runsFile: path.join(dir, "course.qa.json"), logFile: path.join(dir, "course.qa-log.md") });
  assert.deepEqual(qaFiles(path.join(dir, ".scormplayer", "pins.json")), { runsFile: path.join(dir, ".scormplayer", "qa.json"), logFile: path.join(dir, ".scormplayer", "qa-log.md") });
  const store = createPinStore(pinsFile, course);
  const runs = createQaStore(pinsFile);
  const run = runs.start({ agent: "test-agent", focus: ["copy"] });
  assert.throws(() => runs.start({ agent: "other" }), /already in progress/);
  assert.equal(runs.active().id, run.id);

  const where = { module: { index: 0, title: "Module 1" }, page: { index: 0, of: 3, title: "Intro" } };
  runs.logPage(run.id, { ...where, status: "reviewed", notes: "Read all text" });
  const pin = store.suggest({ note: "Typo", page: page("Intro"), target, qa: qa({ runId: run.id }) }).pin;
  runs.noteSuggestion(run.id, pin, "created", { module: { title: "Module 1" }, page: { index: 0, title: "Intro" } });
  runs.logPage(run.id, { module: where.module, page: { index: 2, of: 3, title: "Quiz" }, status: "unreachable", notes: "Locked until the video ends" });
  assert.throws(() => runs.logPage(run.id, { status: "great" }), /status must be/);
  assert.equal(runs.get(run.id).pages.length, 2, "a suggestion joins the page already logged");

  runs.stop(run.id);
  assert.equal(runs.logPage(run.id, { ...where, status: "reviewed" }).stop, true);
  const { run: ended, logFile } = runs.finish(run.id, { summary: "One typo; the quiz was locked." }, { course, pins: store.list() });
  assert.equal(ended.state, "stopped");
  assert.equal(runs.active(), null);
  const log = fs.readFileSync(logFile, "utf8");
  assert.match(log, /# QA log: QA course/);
  assert.match(log, /Coverage: 1 reviewed, 0 skipped, 1 unreachable/);
  assert.match(log, /\| Module 1 › Quiz \| unreachable \|  \| Locked until the video ends \|/);
  assert.match(log, /\*\*#1\*\* \[copy\] Module 1 › Intro \(suggested\): Typo/);
  assert.match(log, /One typo; the quiz was locked\./);
  assert.ok(runs.start({ agent: "next" }).id, "a new run can start after one ends");
});

test("QA over HTTP and the CLI: suggestions, triage, clear, separate progress, and the log", async () => {
  const dir = tempDir();
  const zip = path.join(dir, "course.zip");
  fs.writeFileSync(zip, scorm12Zip());
  const cacheDir = path.join(dir, "cache");
  const player = await startPlayer({ input: zip, cacheDir, port: 0, registryDir: null });
  const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...process.env, XDG_CACHE_HOME: cacheDir, LOCALAPPDATA: cacheDir } });
  try {
    const { revision } = await (await fetch(`${player.url}api/course`)).json();
    const headers = { "Content-Type": "application/json", "X-Scormplayer-Revision": revision };
    // Without a connected review tab, a QA pass can't start.
    const refused = await fetch(`${player.url}api/qa/runs`, { method: "POST", headers, body: JSON.stringify({ agent: "test" }) });
    assert.equal(refused.status, 409);
    assert.match((await refused.json()).error, /No review tab is connected/);

    // The page posts suggestions like ordinary pins, with QA fields.
    const created = await fetch(`${player.url}api/pins`, { method: "POST", headers, body: JSON.stringify({ note: "Typo in the intro", page: page("Intro"), target, qa: qa() }) });
    assert.equal(created.status, 201);
    const pin = await created.json();
    assert.equal(pin.outcome, "created");
    assert.equal(pin.status, "suggested");
    const again = await (await fetch(`${player.url}api/pins`, { method: "POST", headers, body: JSON.stringify({ note: "Typo", page: page("Outro", 4), target, qa: qa() }) })).json();
    assert.equal(again.outcome, "merged");
    await fetch(`${player.url}api/pins`, { method: "POST", headers, body: JSON.stringify({ note: "Low contrast", page: page("Intro"), target, qa: qa({ category: "accessibility", evidence: "grey on white" }) }) });

    const listed = JSON.parse(run("pins", zip, "--suggested", "--json").stdout);
    assert.deepEqual(listed.counts, { open: 0, resolved: 0, suggested: 2 });
    assert.equal(listed.pins.length, 2);
    const accepted = JSON.parse(run("pins", zip, "--accept", String(pin.number), "--json").stdout);
    assert.equal(accepted.accepted[0].status, "open");
    assert.match(run("pins", zip).stdout, /Typo in the intro/);
    const triage = await (await fetch(`${player.url}api/pins/triage`, { method: "POST", headers, body: JSON.stringify({ ids: [pin.id], action: "dismiss" }) })).json();
    assert.equal(triage.pins[0].status, "dismissed");
    const cleared = await (await fetch(`${player.url}api/qa/pins`, { method: "DELETE", headers })).json();
    assert.equal(cleared.removed, 2);
    assert.equal(JSON.parse(run("pins", zip, "--all", "--json").stdout).pins.length, 0);

    const status = await (await fetch(`${player.url}api/qa`)).json();
    assert.equal(status.active, null);
    assert.equal(JSON.parse(run("qa", zip, "--json").stdout).run, null);
    assert.match(run("qa", zip).stdout, /No agent QA pass yet/);
  } finally { await player.close(); }
});
