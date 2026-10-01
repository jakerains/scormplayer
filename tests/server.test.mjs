import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseManifestXml, resolveCourse, UserError } from "../server/course.mjs";
import { createPinStore } from "../server/pins.mjs";
import { findSourceText } from "../server/source-match.mjs";
import { startPlayer } from "../server/index.mjs";
import { MANIFEST_12, MANIFEST_2004, multiScoZip, scorm12Zip, scorm2004Zip, traversalZip } from "./fixtures.mjs";

const BIN = fileURLToPath(new URL("../bin/scormplayer.mjs", import.meta.url));
// Keep the players these tests start out of the real registry of running players.
process.env.XDG_CACHE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "scormplayer-test-cache-"));

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
  // A bare word that isn't a file: an unknown (perhaps newer) command, not a missing course.
  assert.throws(() => execFileSync(process.execPath, [BIN, "frobnicate"], { encoding: "utf8", env, stdio: "pipe", cwd: dir }), /"frobnicate" isn't a command in scormplayer [\d.]+[\s\S]*scormplayer update/);
});

test("agent mode: --json prints parseable results, errors and player events", async () => {
  const dir = tempDir();
  const zipPath = path.join(dir, "demo.zip");
  fs.writeFileSync(zipPath, scorm12Zip());
  const env = { ...process.env, XDG_CACHE_HOME: path.join(dir, "cache") };
  const run = (args) => JSON.parse(execFileSync(process.execPath, [BIN, ...args, "--json"], { encoding: "utf8", env }));
  const fail = (args) => {
    try { execFileSync(process.execPath, [BIN, ...args, "--json"], { encoding: "utf8", env, stdio: "pipe" }); }
    catch (error) { assert.equal(error.status, 1); return JSON.parse(error.stdout); }
    assert.fail("expected a non-zero exit");
  };

  const store = createPinStore(path.join(dir, "demo.pins.json"), { title: "Demo 1.2 course", source: zipPath, kind: "package", scormVersion: "1.2" });
  store.create({ note: "Check this", target: { name: "Heading" } });
  const report = run(["pins", zipPath]);
  assert.equal(report.ok, true);
  assert.equal(report.course.title, "Demo 1.2 course");
  assert.deepEqual(report.counts, { open: 1, resolved: 0 });
  assert.equal(report.pins[0].note, "Check this");
  const resolved = run(["pins", zipPath, "--resolve", "1", "--note", "Fixed"]);
  assert.equal(resolved.resolved[0].resolution, "Fixed");
  assert.deepEqual(resolved.counts, { open: 0, resolved: 1 });
  assert.equal(run(["pins", zipPath]).pins.length, 0);
  assert.equal(run(["pins", zipPath, "--all"]).pins.length, 1);
  assert.equal(typeof run(["cache"]).bytes, "number");

  assert.deepEqual(fail(["pins", zipPath, "--resolve", "9"]), { ok: false, error: "No pin 9.", code: "user_error" });
  assert.equal(fail([path.join(dir, "nope.zip")]).code, "user_error");
  assert.equal(fail([]).code, "user_error");

  // The player: a "ready" line first, then one event per line, "stopped" on exit.
  const child = spawn(process.execPath, [BIN, zipPath, "--json", "--no-open", "--port", "0"], { env });
  const lines = [];
  let buffer = "";
  const next = (event) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`No ${event} event`)), 10_000);
    const check = () => {
      const failed = lines.find((line) => line.ok === false);
      if (failed) { clearTimeout(timeout); child.stdout.off("data", check); return reject(new Error(failed.error)); }
      const found = lines.find((line) => line.event === event);
      if (found) { clearTimeout(timeout); child.stdout.off("data", check); resolve(found); }
    };
    child.stdout.on("data", check);
    check();
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const parts = buffer.split("\n");
    buffer = parts.pop();
    lines.push(...parts.map((line) => JSON.parse(line)));
  });
  const ready = await next("ready");
  assert.match(ready.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal(ready.pinsFile, path.join(dir, "demo.pins.json"));
  assert.equal(lines[0].event, "ready");
  await fetch(`${ready.url}api/pins`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ note: "New one" }) });
  const pin = await next("pin");
  assert.equal(pin.change, "created");
  assert.equal(pin.pin.note, "New one");
  child.kill("SIGTERM");
  // Windows ends a killed process outright, so it has no chance to report "stopped".
  if (process.platform !== "win32") assert.deepEqual((await next("stopped")).counts, { open: 1, resolved: 1 });
});

test("unzip: a zip becomes an editable folder beside it, and its pins move along", async () => {
  const dir = tempDir();
  const zipPath = path.join(dir, "my-course.zip");
  fs.writeFileSync(zipPath, scorm12Zip());
  const cacheDir = path.join(dir, "cache");
  const clientDir = path.join(dir, "client");
  fs.mkdirSync(clientDir);
  fs.writeFileSync(path.join(clientDir, "index.html"), "<!doctype html><title>player</title>");
  const player = await startPlayer({ input: zipPath, cacheDir, port: 0, clientDir });
  try {
    player.pins.create({ note: "Fix the heading" });
    player.pins.saveFrame(1, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
    const course = await (await fetch(`${player.url}api/course`)).json();
    assert.equal(course.editable, false);
    assert.deepEqual(course.unzip, { folder: path.join(dir, "my-course"), existing: null });
    assert.match(player.pins.brief(), /This is a zip, so it can't be edited in place[\s\S]*scormplayer unzip /);

    const response = await fetch(`${player.url}api/unzip`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const result = await response.json();
    assert.equal(result.folder, path.join(dir, "my-course"));
    assert.equal(result.reused, false);
    assert.ok(fs.existsSync(path.join(dir, "my-course", "imsmanifest.xml")));
    assert.ok(!fs.existsSync(path.join(dir, "my-course", ".extracted")), "no cache bookkeeping in the folder");
    assert.equal(player.course.kind, "folder");
    assert.equal(player.pins.list({ status: "open" })[0].note, "Fix the heading");
    assert.equal((await (await fetch(`${player.url}api/course`)).json()).editable, true);

    // Elsewhere: the pins and their screenshots move beside the new folder.
    await player.open(zipPath);
    const elsewhere = path.join(dir, "edits", "reviewed");
    const moved = await player.unzip(elsewhere);
    assert.equal(moved.movedPins, 1);
    assert.equal(moved.pinsFile, path.join(dir, "edits", "reviewed.pins.json"));
    assert.ok(!fs.existsSync(path.join(dir, "my-course.pins.json")));
    assert.ok(fs.existsSync(player.pins.frameFile(1)), "the screenshot moved with its pin");

    // Reopening the zip remembers the earlier folder; a folder with other files is refused.
    await player.open(zipPath);
    assert.equal((await (await fetch(`${player.url}api/course`)).json()).unzip.existing, path.join(dir, "my-course"));
    fs.mkdirSync(path.join(dir, "busy"));
    fs.writeFileSync(path.join(dir, "busy", "notes.txt"), "mine");
    const refused = await fetch(`${player.url}api/unzip`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ folder: path.join(dir, "busy") }) });
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /already exists and has other files/);
    assert.equal((await player.unzip()).reused, true);
  } finally {
    await player.close();
  }

  // The CLI does the same for agents.
  const zip2 = path.join(dir, "second.zip");
  fs.writeFileSync(zip2, scorm12Zip());
  const env = { ...process.env, XDG_CACHE_HOME: cacheDir };
  const result = JSON.parse(execFileSync(process.execPath, [BIN, "unzip", zip2, "--json"], { encoding: "utf8", env }));
  assert.equal(result.folder, path.join(dir, "second"));
  assert.ok(fs.existsSync(path.join(dir, "second", "index.html")));
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

test("project config: pins location, course list and sync commands", async () => {
  const { findConfig, configuredPinsFile, configuredCourses, startSync } = await import("../server/config.mjs");
  const { findCourses, isCourseFolder } = await import("../server/finder.mjs");
  const project = tempDir();
  for (const id of ["m01-l01", "m01-l02"]) {
    fs.mkdirSync(path.join(project, "lessons", id), { recursive: true });
    fs.writeFileSync(path.join(project, "lessons", id, "vite.config.js"), "export default {};\n");
    fs.writeFileSync(path.join(project, "lessons", id, "index.html"), `<title>Lesson ${id}</title>`);
  }
  fs.mkdirSync(path.join(project, "content"));
  fs.writeFileSync(path.join(project, "content", "m01-l01.json"), "{}");
  fs.writeFileSync(path.join(project, "scormplayer.config.json"), JSON.stringify({
    courses: ["lessons/*"],
    pins: ".local/pins/{name}.pins.json",
    sync: [{ files: ["content/{name}.json"], run: "node -e \"require('fs').writeFileSync('synced-{name}.txt','ok')\"" }],
  }));

  const lesson = path.join(project, "lessons", "m01-l01");
  const config = findConfig(lesson);
  assert.equal(config.root, project);
  assert.equal(configuredPinsFile(config, lesson), path.join(project, ".local", "pins", "m01-l01.pins.json"));
  assert.equal(configuredCourses(config).length, 2);
  assert.ok(isCourseFolder(lesson));

  // From a parent folder, the nested config's courses are listed (not a blind scan).
  const parent = path.dirname(project);
  const found = findCourses(parent).filter((course) => course.path.startsWith(project));
  assert.deepEqual(found.map((course) => [course.kind, course.title]), [["live", "Lesson m01-l01"], ["live", "Lesson m01-l02"]]);

  const messages = [];
  const stop = startSync(config, lesson, (message) => messages.push(message));
  await new Promise((resolve) => setTimeout(resolve, 400));
  fs.writeFileSync(path.join(project, "content", "m01-l01.json"), '{"changed":true}');
  for (let i = 0; i < 40 && !messages.length; i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  stop();
  assert.match(messages[0] ?? "", /^Synced: /);
  assert.equal(fs.readFileSync(path.join(project, "synced-m01-l01.txt"), "utf8"), "ok");
});

test("finder: lists SCORM zips and folders, skipping zips without a manifest", async () => {
  const { findCourses } = await import("../server/finder.mjs");
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "safety.zip"), scorm12Zip({ title: "Safety" }));
  const { default: AdmZip } = await import("adm-zip");
  const photos = new AdmZip();
  photos.addFile("holiday.jpg", Buffer.from("not a course"));
  fs.writeFileSync(path.join(dir, "photos.zip"), photos.toBuffer());
  fs.mkdirSync(path.join(dir, "unzipped"));
  fs.writeFileSync(path.join(dir, "unzipped", "imsmanifest.xml"), MANIFEST_12("Unzipped course"));
  fs.writeFileSync(path.join(dir, "unzipped", "index.html"), "<p>hi</p>");
  assert.deepEqual(findCourses(dir).map((course) => [course.kind, course.title]), [["zip", "safety.zip"], ["folder", "Unzipped course"]]);
});

test("starts empty and opens zips sent from the browser", async () => {
  const dir = tempDir();
  const clientDir = path.join(dir, "client");
  fs.mkdirSync(clientDir);
  fs.writeFileSync(path.join(clientDir, "index.html"), "<!doctype html><title>player</title>");
  const player = await startPlayer({ cacheDir: path.join(dir, "cache"), port: 0, clientDir, pinsDir: dir });
  const opened = [];
  player.events.on("course", (course) => opened.push(course.title));
  try {
    assert.deepEqual(await (await fetch(`${player.url}api/course`)).json(), { empty: true });
    assert.equal(player.course, null);

    const send = (name, body) => fetch(`${player.url}api/open`, { method: "POST", headers: { "Content-Type": "application/zip", "X-File-Name": encodeURIComponent(name) }, body });
    const first = await send("Safety Basics.zip", scorm12Zip({ title: "Safety Basics" }));
    assert.equal(first.status, 200);
    const course = await (await fetch(`${player.url}api/course`)).json();
    assert.equal(course.title, "Safety Basics");
    assert.equal(course.source, "Safety Basics.zip");
    assert.equal(course.pinsFile, path.join(dir, "Safety Basics.pins.json"));
    assert.match(await (await fetch(new URL(course.launchUrl, player.url))).text(), /Welcome to the demo/);

    assert.equal((await send("second.zip", scorm2004Zip({ title: "Second" }))).status, 200);
    assert.equal(player.course.title, "Second");
    assert.deepEqual(opened, ["Safety Basics", "Second"]);

    const { default: AdmZip } = await import("adm-zip");
    const notScorm = new AdmZip();
    notScorm.addFile("photo.jpg", Buffer.from("x"));
    const refused = await send("photos.zip", notScorm.toBuffer());
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /imsmanifest\.xml/);
    assert.equal(player.course.title, "Second", "a refused zip leaves the open course in place");
  } finally {
    await player.close();
  }
});

test("cache: prunes old and surplus entries, keeps the one in use", async () => {
  const { pruneCache, cacheEntries, clearCache, touchCacheEntry } = await import("../server/cache.mjs");
  const cache = tempDir();
  const now = Date.now();
  const make = (name, daysAgo) => {
    const dir = path.join(cache, "packages", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), "x".repeat(100));
    touchCacheEntry(dir);
    const when = new Date(now - daysAgo * 86_400_000);
    fs.utimesSync(path.join(dir, ".last-used"), when, when);
    return dir;
  };
  const old = make("old", 30);
  const inUse = make("in-use", 40);
  for (let i = 0; i < 5; i += 1) make(`recent-${i}`, i);
  const removed = pruneCache(cache, { keep: [inUse], now, maxEntries: 3 });
  const left = cacheEntries(cache).map((entry) => entry.name).sort();
  assert.ok(removed.some((entry) => entry.path === old));
  assert.deepEqual(left, ["in-use", "recent-0", "recent-1", "recent-2"]);
  assert.equal(clearCache(cache).length, 4);
  assert.equal(cacheEntries(cache).length, 0);
});

test("update check: newer versions only, asked at most once a day", async () => {
  const { checkForUpdate, isNewer } = await import("../server/update.mjs");
  assert.equal(isNewer("0.10.0", "0.9.9"), true);
  assert.equal(isNewer("0.6.0", "0.6.0"), false);
  assert.equal(isNewer("0.5.9", "0.6.0"), false);
  const cacheDir = tempDir();
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, json: async () => ({ version: "9.0.0" }) }; };
  const saved = { CI: process.env.CI, OFF: process.env.SCORMPLAYER_NO_UPDATE_CHECK };
  delete process.env.CI;
  delete process.env.SCORMPLAYER_NO_UPDATE_CHECK;
  try {
    assert.equal(await checkForUpdate({ current: "0.6.0", cacheDir, fetchImpl }), "9.0.0");
    assert.equal(await checkForUpdate({ current: "0.6.0", cacheDir, fetchImpl }), "9.0.0");
    assert.equal(calls, 1, "the second check uses the saved answer");
    assert.equal(await checkForUpdate({ current: "9.0.0", cacheDir, fetchImpl }), null);
    // Upgraded by hand past the saved answer: that answer is stale, so it asks npm again.
    assert.equal(await checkForUpdate({ current: "9.5.0", cacheDir, fetchImpl }), null);
    assert.equal(calls, 2, "a saved answer older than the running version is asked again");
    process.env.SCORMPLAYER_NO_UPDATE_CHECK = "1";
    assert.equal(await checkForUpdate({ current: "0.1.0", cacheDir: tempDir(), fetchImpl }), null);
  } finally {
    if (saved.CI === undefined) delete process.env.CI; else process.env.CI = saved.CI;
    if (saved.OFF === undefined) delete process.env.SCORMPLAYER_NO_UPDATE_CHECK; else process.env.SCORMPLAYER_NO_UPDATE_CHECK = saved.OFF;
  }
});

test("update: tells how scormplayer was installed, and how to update it", async () => {
  const { installMethod, updateHint, fetchLatest } = await import("../server/update.mjs");
  const { skillsArgs } = await import("../server/skill.mjs");
  const base = tempDir();
  const at = (rel, projectFile) => {
    const dir = path.join(base, ...rel.split("/"));
    fs.mkdirSync(dir, { recursive: true });
    if (projectFile) fs.writeFileSync(path.join(base, ...projectFile.split("/")), "{}");
    return dir;
  };
  const kind = (dir) => installMethod({ packageRoot: dir }).kind;
  const globalNpm = at("usr/local/lib/node_modules/@jakerains/scormplayer");
  assert.equal(kind(globalNpm), "npm");
  assert.deepEqual(installMethod({ packageRoot: globalNpm }).command, ["npm", "install", "-g", "@jakerains/scormplayer@latest"]);
  assert.equal(updateHint(globalNpm), "scormplayer update");
  assert.equal(kind(at("proj/node_modules/@jakerains/scormplayer", "proj/package.json")), "project");
  assert.equal(kind(at("home/.npm/_npx/1a2b/node_modules/@jakerains/scormplayer")), "npx");
  assert.equal(updateHint(at("home/.npm/_npx/3c4d/node_modules/@jakerains/scormplayer")), "npx @jakerains/scormplayer@latest");
  assert.equal(kind(at("home/Library/pnpm/global/5/node_modules/@jakerains/scormplayer")), "pnpm");
  assert.equal(kind(at("home/.bun/install/global/node_modules/@jakerains/scormplayer")), "bun");
  assert.equal(kind(at("home/.config/yarn/global/node_modules/@jakerains/scormplayer")), "yarn");
  assert.equal(kind(at("src/scormplayer")), "source");
  const { tarballInstall } = await import("../server/update.mjs");
  assert.deepEqual(tarballInstall("1.2.3"), ["npm", "install", "-g", "https://registry.npmjs.org/@jakerains/scormplayer/-/scormplayer-1.2.3.tgz"]);

  // The update asks npm fresh and remembers the answer for the daily check.
  const cacheDir = tempDir();
  assert.equal(await fetchLatest({ cacheDir, fetchImpl: async () => ({ ok: true, json: async () => ({ version: "1.2.3" }) }) }), "1.2.3");
  assert.equal(JSON.parse(fs.readFileSync(path.join(cacheDir, "update-check.json"), "utf8")).latest, "1.2.3");
  await assert.rejects(fetchLatest({ cacheDir, fetchImpl: async () => ({ ok: false, status: 503 }) }), /503/);

  // Only this skill is refreshed, in the scope it's installed in.
  assert.deepEqual(skillsArgs("update", { global: true }), ["--yes", "skills@latest", "update", "scormplayer", "--global", "--yes"]);
  assert.deepEqual(skillsArgs("update", { global: false }), ["--yes", "skills@latest", "update", "scormplayer", "--project", "--yes"]);

  // The player page hears about a newer version from the CLI.
  const clientDir = path.join(base, "client");
  fs.mkdirSync(clientDir);
  fs.writeFileSync(path.join(clientDir, "index.html"), "<!doctype html><title>player</title>");
  const player = await startPlayer({ cacheDir: path.join(base, "cache"), port: 0, clientDir });
  try {
    assert.deepEqual(await (await fetch(`${player.url}api/update`)).json(), { update: null });
    player.setUpdate({ latest: "9.0.0", command: "scormplayer update" });
    assert.deepEqual(await (await fetch(`${player.url}api/update`)).json(), { update: { latest: "9.0.0", command: "scormplayer update" } });
  } finally {
    await player.close();
  }
});

test("running players: registry, reuse, ps and stop, and stopping when idle", async () => {
  const { registerPlayer, listPlayers, findPlayer } = await import("../server/registry.mjs");
  const dir = tempDir();
  const zipPath = path.join(dir, "demo.zip");
  fs.writeFileSync(zipPath, scorm12Zip());
  const env = { ...process.env, XDG_CACHE_HOME: path.join(dir, "cache") };
  const registry = path.join(dir, "cache", "scormplayer", "players");

  // A file left by a process that died is cleaned up when the players are listed.
  const dead = registerPlayer(registry, { pid: 999999, port: 1, url: "http://127.0.0.1:1/", input: zipPath, startedAt: new Date().toISOString() });
  assert.equal(listPlayers(registry).length, 0);
  dead.remove();

  const lines = (child) => {
    const seen = [];
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const parts = buffer.split("\n");
      buffer = parts.pop();
      seen.push(...parts.filter(Boolean).map((line) => JSON.parse(line)));
    });
    return (event) => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`No ${event} event`)), 15_000);
      const check = () => {
        const found = seen.find((line) => line.event === event);
        if (found) { clearTimeout(timeout); clearInterval(poll); resolve(found); }
      };
      const poll = setInterval(check, 50);
      check();
    });
  };

  const first = spawn(process.execPath, [BIN, zipPath, "--json", "--no-open", "--port", "0"], { env });
  const next = lines(first);
  const ready = await next("ready");
  assert.equal(findPlayer({ input: zipPath }, registry).pid, first.pid);

  // Opening the same course again reuses the running player and exits.
  const again = JSON.parse(execFileSync(process.execPath, [BIN, zipPath, "--json", "--no-open"], { encoding: "utf8", env }));
  assert.equal(again.reused, true);
  assert.equal(again.url, ready.url);
  assert.equal(again.pid, first.pid);

  // ps lists it, with how long since anything used it; stop ends it.
  const ps = JSON.parse(execFileSync(process.execPath, [BIN, "ps", "--json"], { encoding: "utf8", env }));
  const listed = ps.players.find((player) => player.pid === first.pid);
  assert.equal(listed.title, "Demo 1.2 course");
  assert.equal(listed.mode, "background");
  assert.equal(typeof listed.idleSeconds, "number");
  const port = new URL(ready.url).port;
  const stopped = JSON.parse(execFileSync(process.execPath, [BIN, "stop", port, "--json"], { encoding: "utf8", env }));
  assert.equal(stopped.stopped[0]?.pid, first.pid, JSON.stringify(stopped));
  assert.match((await next("stopped")).reason, /SIGTERM/);
  assert.equal(listPlayers(registry).length, 0, "a stopped player leaves the registry");

  // A background player nobody uses stops by itself.
  const idle = spawn(process.execPath, [BIN, zipPath, "--json", "--no-open", "--port", "0", "--idle", "0.02"], { env });
  assert.match((await lines(idle)("stopped")).reason, /nobody has used the player/);
});

test("multi-SCO packages list every module in manifest order", async () => {
  const dir = tempDir();
  const zip = path.join(dir, "multi.zip");
  fs.writeFileSync(zip, multiScoZip());
  const course = resolveCourse(zip, { cacheDir: path.join(dir, "cache") });
  assert.deepEqual(course.scos.map((sco) => [sco.title, sco.launch]), [["Module 1", "m1/index.html"], ["Module 2", "m2/index.html"], ["Module 3", "m3/index.html"]]);
  const single = path.join(dir, "single.zip");
  fs.writeFileSync(single, scorm12Zip());
  assert.equal(resolveCourse(single, { cacheDir: path.join(dir, "cache") }).scos.length, 1);
});
