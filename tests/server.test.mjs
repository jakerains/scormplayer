import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseManifestXml, resolveCourse, UserError } from "../server/course.mjs";
import { createPinStore } from "../server/pins.mjs";
import { findSourceText } from "../server/source-match.mjs";
import { startPlayer } from "../server/index.mjs";
import { MANIFEST_12, MANIFEST_2004, scorm12Zip, scorm2004Zip, traversalZip } from "./fixtures.mjs";

const BIN = fileURLToPath(new URL("../bin/scormplayer.mjs", import.meta.url));

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "scormplayer-test-"));
}

test("reads title, SCORM version and launch from 1.2 and 2004 manifests", () => {
  const v12 = parseManifestXml(MANIFEST_12("Safety basics"));
  assert.deepEqual([v12.title, v12.scormVersion, v12.href], ["Safety basics", "1.2", "index.html"]);
  const v2004 = parseManifestXml(MANIFEST_2004("Onboarding"));
  assert.deepEqual([v2004.title, v2004.scormVersion, v2004.href], ["Onboarding", "2004", "content/start.html?page=1"]);
});

test("opens a zip (including one wrapped in a folder) and keeps pins beside it", () => {
  const dir = tempDir();
  const zipPath = path.join(dir, "course.zip");
  fs.writeFileSync(zipPath, scorm12Zip({ wrapper: "package" }));
  const course = resolveCourse(zipPath, { cacheDir: path.join(dir, "cache") });
  assert.equal(course.kind, "package");
  assert.equal(course.launch, "package/index.html");
  assert.equal(course.pinsFile, path.join(dir, "course.pins.json"));
  assert.ok(fs.existsSync(path.join(course.root, "package/index.html")));
});

test("refuses a zip that writes outside its folder", () => {
  const dir = tempDir();
  const zipPath = path.join(dir, "bad.zip");
  fs.writeFileSync(zipPath, traversalZip());
  assert.throws(() => resolveCourse(zipPath, { cacheDir: path.join(dir, "cache") }), UserError);
  assert.equal(fs.existsSync(path.join(dir, "cache", "packages", "escape.txt")), false);
});

test("explains what is wrong with a folder that is not a course", () => {
  const dir = tempDir();
  assert.throws(() => resolveCourse(dir, { cacheDir: path.join(dir, "cache") }), /No imsmanifest\.xml/);
  assert.throws(() => resolveCourse(path.join(dir, "missing.zip"), { cacheDir: dir }), /Nothing found/);
});

test("pins: create, number, resolve, brief and delete", () => {
  const dir = tempDir();
  const course = { title: "Demo", source: "/x/demo.zip", kind: "package", scormVersion: "1.2" };
  const store = createPinStore(path.join(dir, "demo.pins.json"), course);
  const first = store.create({ note: "Fix the typo", page: { title: "Intro", url: "index.html" }, target: { name: "Paragraph: hello", selector: "#intro", text: "hello wrold" } });
  const second = store.create({ note: "Bigger button", target: { name: "Button: Next", selector: "button" } });
  assert.deepEqual([first.number, second.number], [1, 2]);
  assert.throws(() => store.create({ note: "  " }), /needs a note/);

  store.update("2", { status: "resolved", resolution: "Done" });
  assert.equal(store.list({ status: "open" }).length, 1);
  const brief = store.brief();
  assert.match(brief, /# Pinned notes: Demo/);
  assert.match(brief, /## Pin 1 · Intro/);
  assert.match(brief, /Fix the typo/);
  assert.doesNotMatch(brief, /Bigger button/);

  store.remove(first.id);
  assert.equal(store.list().length, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "demo.pins.json"), "utf8"));
  assert.equal(saved.course.title, "Demo");
});

test("finds pinned text in source files, skipping bundles and minified lines", () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, "src/content"), { recursive: true });
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src/content/pages.json"), '{\n  "intro": "Welcome \\u2014 let\\u2019s get started.",\n  "other": "x"\n}\n');
  fs.writeFileSync(path.join(dir, "assets/index-a1b2c3d4.js"), 'const a="Welcome — let’s get started.";');
  fs.writeFileSync(path.join(dir, "assets/app.js"), `${"x".repeat(500)}"Welcome — let’s get started."`);
  const matches = findSourceText(dir, "Welcome – let’s get started.");
  assert.deepEqual(matches.map((match) => `${match.file}:${match.line}`), ["src/content/pages.json:2"]);
  assert.deepEqual(findSourceText(dir, "Nowhere in the files"), []);
});

test("serves the course, saves pins and frames over HTTP", async () => {
  const dir = tempDir();
  const zipPath = path.join(dir, "demo.zip");
  fs.writeFileSync(zipPath, scorm2004Zip());
  const clientDir = path.join(dir, "client");
  fs.mkdirSync(clientDir);
  fs.writeFileSync(path.join(clientDir, "index.html"), "<!doctype html><title>player</title>");
  const player = await startPlayer({ input: zipPath, cacheDir: path.join(dir, "cache"), port: 0, clientDir });
  try {
    const base = player.url;
    const course = await (await fetch(`${base}api/course`)).json();
    assert.equal(course.scormVersion, "2004");
    assert.equal(course.launchUrl, "/course/content/start.html?page=1");
    assert.match(await (await fetch(new URL(course.launchUrl, base))).text(), /Start here/);
    assert.equal((await fetch(`${base}course/..%2f..%2fetc/passwd`)).status, 403);

    const created = await fetch(`${base}api/pins`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "Reword the heading", target: { name: "Heading: Start here", selector: "h1", text: "Start here" } }),
    });
    assert.equal(created.status, 201);
    const pin = await created.json();
    assert.equal(pin.source?.[0]?.file, "content/start.html");

    const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
    const framed = await fetch(`${base}api/pins/${pin.id}/frame`, { method: "PUT", headers: { "Content-Type": "image/png" }, body: png });
    assert.equal(framed.status, 200);
    assert.equal((await fetch(`${base}api/pins/${pin.id}/frame`)).status, 200);
    assert.match(await (await fetch(`${base}api/brief`)).text(), /Reword the heading[\s\S]*Screenshot: /);
    assert.equal((await fetch(`${base}api/pins/999`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 404);
  } finally {
    await player.close();
  }
});

test("the CLI prints help, version and a pins hand-off", () => {
  assert.match(execFileSync(process.execPath, [BIN, "--help"], { encoding: "utf8" }), /Usage/);
  assert.match(execFileSync(process.execPath, [BIN, "--version"], { encoding: "utf8" }), /^\d+\.\d+\.\d+/);
  const dir = tempDir();
  const zipPath = path.join(dir, "demo.zip");
  fs.writeFileSync(zipPath, scorm12Zip());
  const env = { ...process.env, XDG_CACHE_HOME: path.join(dir, "cache") };
  assert.match(execFileSync(process.execPath, [BIN, "pins", zipPath], { encoding: "utf8", env }), /No pins to hand off/);
  const store = createPinStore(path.join(dir, "demo.pins.json"), { title: "Demo 1.2 course", source: zipPath, kind: "package", scormVersion: "1.2" });
  store.create({ note: "Check this", target: { name: "Heading" } });
  execFileSync(process.execPath, [BIN, "pins", zipPath, "--resolve", "1", "--note", "Fixed"], { encoding: "utf8", env, stdio: "pipe" });
  assert.equal(store.list({ status: "open" }).length, 0);
  assert.throws(() => execFileSync(process.execPath, [BIN, path.join(dir, "nope.zip")], { encoding: "utf8", env, stdio: "pipe" }), /Nothing found/);
});

test("skill commands hand off to the skills CLI with the user's choices", async () => {
  const { skillsArgs, SKILL_FILE, PACKAGE_ROOT } = await import("../server/skill.mjs");
  assert.match(fs.readFileSync(SKILL_FILE, "utf8"), /^---\nname: scormplayer\ndescription: /);
  assert.deepEqual(skillsArgs("add"), ["--yes", "skills@latest", "add", "jakerains/scormplayer", "--skill", "scormplayer"]);
  assert.deepEqual(
    skillsArgs("add", { local: true, global: true, agents: ["claude-code", "codex"], yes: true, copy: true }),
    ["--yes", "skills@latest", "add", PACKAGE_ROOT, "--skill", "scormplayer", "--global", "--agent", "claude-code", "--agent", "codex", "--yes", "--copy"],
  );
  assert.deepEqual(skillsArgs("remove", { global: true }), ["--yes", "skills@latest", "remove", "scormplayer", "--global"]);
});

test("dashboard: plain output without a terminal, and text fits the screen", async () => {
  const { createDashboard, truncate, visible, progressLabel } = await import("../server/tui.mjs");
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  assert.equal(visible("\x1b[1mbold\x1b[22m 名前"), 9);
  assert.equal(truncate("A long pin note about the heading", 12), "A long pin …");
  assert.equal(visible(truncate("日本語のテキストです", 9)), 9);
  assert.deepEqual(progressLabel({ completion: "completed", success: "passed", score: "90%" }), { text: "Passed · 90%", tone: "good" });
  assert.equal(progressLabel(null).tone, "muted");

  const dir = tempDir();
  const course = { title: "Demo", kind: "package", scormVersion: "1.2", source: path.join(dir, "demo.zip"), pinsFile: path.join(dir, "demo.pins.json") };
  const pins = createPinStore(course.pinsFile, course);
  const events = new EventEmitter();
  const player = { url: "http://127.0.0.1:4620/", course, pins, events };
  const out = new PassThrough();
  let text = "";
  out.on("data", (chunk) => { text += chunk; });
  const dashboard = createDashboard({ version: "9.9.9", entries: [{ id: "demo", player }], stdout: out, stdin: new PassThrough(), onQuit: () => {} });
  events.emit("browser");
  events.emit("progress", { completion: "completed", success: "", score: "" }, null);
  pins.create({ note: "Fix the typo", target: { name: "Heading" } });
  events.emit("pin");
  await dashboard.quit();
  assert.match(text, /Demo[\s\S]*Player {2}http:\/\/127\.0\.0\.1:4620\//);
  assert.match(text, /Player opened in the browser/);
  assert.match(text, /Completed/);
  assert.match(text, /Pin 1 saved: Fix the typo/);
  assert.match(text, /scormplayer stopped · 1 open pin/);
  assert.doesNotMatch(text, /\x1b\[/, "no escape codes when not writing to a terminal");
});
