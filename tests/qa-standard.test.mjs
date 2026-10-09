import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { effectiveStandard, saveStandard, scanForStandard, standardsDir, validateStandard } from "../server/qa-standard.mjs";
import { resolveCourse } from "../server/course.mjs";
import { startPlayer } from "../server/index.mjs";
import { MANIFEST_12 } from "./fixtures.mjs";

const BIN = fileURLToPath(new URL("../bin/scormplayer.mjs", import.meta.url));

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "scormplayer-standard-"));
}

/** A small UK-English lesson with mixed conventions for the scan to find. */
function lesson(dir, name = "lesson") {
  const folder = path.join(dir, name);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "imsmanifest.xml"), MANIFEST_12("Safety"));
  fs.writeFileSync(path.join(folder, "index.html"), `<!doctype html><html lang="en-GB"><title>Safety</title><body>
<h1>Spot the common hazards</h1><h2>Keep your workspace tidy</h2><h3>Report what you see</h3>
<p>Welcome to the course. You will learn how to recognise hazards and report them to the Safety Team. Your manager uses the Incident Portal to log each report.</p>
<p>Check your e-mail for a summary. You can also email the Safety Team, or email your manager. Remember to colour-code the bins and organise your area.</p>
<p>Report anything unusual to the safety team before you leave.</p>
<a href="next.html">Click here</a><img src="a.png"></body></html>`);
  return folder;
}

test("standards are checked, and projects can extend a shared standard and override it", () => {
  assert.throws(() => validateStandard({ colour: "blue" }), /Unknown QA standard key colour/);
  assert.throws(() => validateStandard({ spelling: "FR" }), /spelling must be one of/);
  assert.throws(() => validateStandard({ rules: [{ category: "copy" }] }), /needs a "rule"/);
  assert.deepEqual(validateStandard({ rules: [{ rule: "Every quiz question gives feedback.", category: "content" }] }).rules, [{ id: "rule-1", rule: "Every quiz question gives feedback.", category: "content" }]);
  assert.equal(standardsDir({ XDG_CONFIG_HOME: "/x" }, "linux", "/home/u"), path.join("/x", "scormplayer", "qa-standards"));
  assert.equal(standardsDir({}, "darwin", "/Users/u"), path.join("/Users/u", "Library", "Application Support", "scormplayer", "qa-standards"));

  const dir = tempDir();
  const shared = path.join(dir, "standards");
  const course = lesson(dir);
  assert.equal(effectiveStandard(course, { dir: shared }).missing, true);
  assert.equal(effectiveStandard(course, { dir: shared }).projectTarget, path.join(dir, "scormplayer.config.json"));

  // A shared "default" applies to any project without its own.
  saveStandard(course, { target: "shared", name: "default", standard: { spelling: "US", audience: "Everyone" }, dir: shared });
  const fallback = effectiveStandard(course, { dir: shared });
  assert.equal(fallback.missing, false);
  assert.deepEqual(fallback.sources.map((source) => source.kind), ["shared"]);
  assert.equal(fallback.standard.spelling, "US");

  // A named shared standard, used by this project, which then overrides parts of it.
  fs.writeFileSync(path.join(dir, "scormplayer.config.json"), JSON.stringify({ pins: ".local/{name}.pins.json" }));
  const saved = saveStandard(course, { target: "shared", name: "acme", use: true, dir: shared, standard: {
    spelling: "UK", voice: "second-person", terms: { prefer: { "e-mail": "email" }, keep: ["Safety Team"] },
    rules: [{ id: "feedback", rule: "Every quiz question gives feedback.", category: "content", severity: "major" }], ignore: ["Oxford commas"],
  } });
  assert.equal(saved.file, path.join(shared, "acme.json"));
  assert.equal(saved.projectFile, path.join(dir, "scormplayer.config.json"));
  const config = JSON.parse(fs.readFileSync(saved.projectFile, "utf8"));
  assert.equal(config.pins, ".local/{name}.pins.json", "other settings are kept");
  assert.deepEqual(config.qa, { extends: "acme" });

  saveStandard(course, { target: "project", dir: shared, standard: {
    extends: "acme", audience: "Warehouse staff", terms: { avoid: ["click here"] },
    rules: [{ id: "feedback", rule: "Every quiz question gives feedback for each answer.", category: "content", severity: "blocker" }, { id: "no-jargon", rule: "Explain acronyms on first use.", category: "copy" }],
    styleGuide: "docs/style.md",
  } });
  fs.mkdirSync(path.join(dir, "docs"));
  fs.writeFileSync(path.join(dir, "docs", "style.md"), "Use sentence case.");
  const effective = effectiveStandard(course, { dir: shared });
  assert.deepEqual(effective.sources.map((source) => source.kind), ["shared", "project"]);
  assert.equal(effective.standard.spelling, "UK");
  assert.equal(effective.standard.audience, "Warehouse staff");
  assert.deepEqual(effective.standard.terms, { prefer: { "e-mail": "email" }, avoid: ["click here"], keep: ["Safety Team"] });
  assert.deepEqual(effective.standard.rules.map((rule) => `${rule.id}:${rule.severity ?? ""}`), ["feedback:blocker", "no-jargon:"], "the project's rule replaces the shared one with the same id");
  assert.deepEqual(effective.standard.ignore, ["Oxford commas"]);
  assert.equal(effective.standard.styleGuideText, "Use sentence case.");
  assert.deepEqual(effective.shared.map((item) => item.name), ["acme", "default"]);

  // A standard can also come from a file in the team's repo.
  fs.writeFileSync(path.join(dir, "team-standard.json"), JSON.stringify({ readingLevel: "grade 8" }));
  saveStandard(course, { target: "project", dir: shared, standard: { extends: "./team-standard.json", tone: "Friendly" } });
  const fromFile = effectiveStandard(course, { dir: shared });
  assert.equal(fromFile.sources[0].kind, "file");
  assert.equal(fromFile.standard.readingLevel, "grade 8");
  assert.throws(() => saveStandard(course, { target: "shared", standard: { tone: "x" }, dir: shared }), /needs a name/);
  assert.throws(() => saveStandard(course, { target: "project", standard: {}, dir: shared }), /is empty/);
});

test("scanning proposes a standard from the course's own conventions and what the reviewer dismissed", () => {
  const dir = tempDir();
  const course = resolveCourse(lesson(dir), { cacheDir: path.join(dir, "cache") });
  const pins = Array.from({ length: 3 }, (_, index) => ({ origin: { kind: "agent" }, category: "layout", status: "dismissed", note: `Spacing looks tight ${index}` }));
  pins.push({ origin: { kind: "agent" }, category: "copy", status: "open", note: "Typo" });
  const { findings, proposal } = scanForStandard([course], { pins });
  assert.equal(findings.language, "en-GB");
  assert.equal(findings.spelling.UK >= 3, true);
  assert.deepEqual(findings.variants.find((item) => item.forms["e-mail"]).forms, { email: 2, "e-mail": 1 });
  assert.ok(findings.inconsistentCase.includes("Safety Team"));
  assert.deepEqual(findings.links.vague, ["Click here"]);
  assert.equal(findings.accessibility.imagesWithoutAlt, 1);
  assert.deepEqual(findings.triage.layout, { accepted: 0, dismissed: 3, waiting: 0, dismissedExamples: ["Spacing looks tight 0", "Spacing looks tight 1", "Spacing looks tight 2"] });
  assert.equal(proposal.spelling, "UK");
  assert.equal(proposal.headingCase, "sentence");
  assert.equal(proposal.voice, "second-person");
  assert.deepEqual(proposal.terms.prefer, { "e-mail": "email" });
  assert.ok(proposal.terms.keep.includes("Safety Team"));
  assert.deepEqual(proposal.terms.avoid, ["click here"]);
  assert.match(proposal.ignore[0], /^layout suggestions like: Spacing looks tight/);
  assert.match(proposal.rules[0].rule, /Safety Team/);
  assert.doesNotThrow(() => validateStandard(proposal, { partial: false }), "a proposal is a valid standard");
});

test("the QA standard over HTTP and the CLI", async () => {
  const dir = tempDir();
  const folder = lesson(dir);
  const shared = path.join(dir, "standards");
  const env = { ...process.env, SCORMPLAYER_STANDARDS_DIR: shared, XDG_CACHE_HOME: path.join(dir, "cache") };
  const previous = process.env.SCORMPLAYER_STANDARDS_DIR;
  process.env.SCORMPLAYER_STANDARDS_DIR = shared;
  const player = await startPlayer({ input: folder, cacheDir: path.join(dir, "cache"), port: 0, registryDir: null });
  try {
    const { revision } = await (await fetch(`${player.url}api/course`)).json();
    const headers = { "Content-Type": "application/json", "X-Scormplayer-Revision": revision };
    assert.equal((await (await fetch(`${player.url}api/qa/standard`)).json()).missing, true);
    const scan = await (await fetch(`${player.url}api/qa/standard/scan`, { method: "POST", headers, body: JSON.stringify({}) })).json();
    assert.equal(scan.proposal.spelling, "UK");
    const bad = await fetch(`${player.url}api/qa/standard`, { method: "PUT", headers, body: JSON.stringify({ target: "project", standard: { mood: "sunny" } }) });
    assert.equal(bad.status, 400);
    const saved = await (await fetch(`${player.url}api/qa/standard`, { method: "PUT", headers, body: JSON.stringify({ target: "project", standard: scan.proposal }) })).json();
    assert.equal(saved.file, path.join(dir, "scormplayer.config.json"));
    assert.equal(saved.effective.missing, false);
    assert.equal(saved.effective.standard.spelling, "UK");

    const shown = JSON.parse(spawnSync(process.execPath, [BIN, "qa", folder, "--standard", "--json"], { encoding: "utf8", env }).stdout);
    assert.equal(shown.standard.voice, "second-person");
    assert.deepEqual(shown.sources.map((source) => source.kind), ["project"]);
    const text = spawnSync(process.execPath, [BIN, "qa", folder, "--scan"], { encoding: "utf8", env }).stdout;
    assert.match(text, /Language en-GB · spelling US 0 \/ UK \d+/);
    assert.match(text, /Mixed term variants: email ×2 \/ e-mail ×1/);
    assert.match(text, /Proposed standard/);
  } finally {
    await player.close();
    if (previous === undefined) delete process.env.SCORMPLAYER_STANDARDS_DIR; else process.env.SCORMPLAYER_STANDARDS_DIR = previous;
  }
});
