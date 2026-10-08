import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseManifestXml, resolveCourse, UserError } from "../server/course.mjs";
import { createPinStore } from "../server/pins.mjs";
import { findSourceText } from "../server/source-match.mjs";
import { startPlayer } from "../server/index.mjs";
import { MANIFEST_12, MANIFEST_2004, bundleZip, multiScoZip, scorm12Zip, scorm2004Zip, traversalZip } from "./fixtures.mjs";

test("dropped ZIPs with the same name keep separate pins through reupload and cache cleanup", async () => {
  const dir = tempDir();
  const player = await startPlayer({ cacheDir: path.join(dir, "cache"), pinsDir: dir, port: 0, registryDir: null });
  const safety = scorm12Zip({ title: "Safety" });
  const finance = scorm12Zip({ title: "Finance" });
  const upload = async (body) => {
    const response = await fetch(`${player.url}api/open`, { method: "POST", headers: { "content-type": "application/zip", "x-file-name": "course.zip" }, body });
    assert.equal(response.status, 200, await response.text());
  };
  try {
    await upload(safety);
    const safetyPins = player.course.pinsFile;
    player.pins.create({ note: "Safety only" });
    await upload(finance);
    assert.notEqual(player.course.pinsFile, safetyPins);
    assert.deepEqual(player.pins.list(), []);
    player.pins.create({ note: "Finance only" });
    await upload(safety);
    assert.equal(player.course.pinsFile, safetyPins);
    assert.deepEqual(player.pins.list().map((pin) => pin.note), ["Safety only"]);
    fs.rmSync(path.join(dir, "cache", "uploads"), { recursive: true, force: true });
    await upload(finance);
    assert.deepEqual(player.pins.list().map((pin) => pin.note), ["Finance only"]);
  } finally { await player.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

const BIN = fileURLToPath(new URL("../bin/scormplayer.mjs", import.meta.url));

test("durable progress merges modules, survives cache cleanup, and rejects saves from before reset", async () => {
  const dir = tempDir();
  const input = path.join(dir, "modules.zip");
  const cacheDir = path.join(dir, "cache");
  fs.writeFileSync(input, multiScoZip());
  const a = await startPlayer({ input, cacheDir, port: 0, registryDir: null });
  const b = await startPlayer({ input, cacheDir, port: 0, registryDir: null });
  const read = async (player) => (await fetch(`${player.url}api/scorm`)).json();
  const write = (player, data) => fetch(`${player.url}api/scorm`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  try {
    const ids = a.course.scos.map((sco) => sco.id);
    assert.equal((await read(a)).saved, false);
    const writes = await Promise.all([
      write(a, { epoch: 0, selectedSco: ids[0], modules: { [ids[0]]: { "cmi.suspend_data": "one" } } }),
      write(b, { epoch: 0, selectedSco: ids[1], modules: { [ids[1]]: { "cmi.suspend_data": "two" } } }),
    ]);
    assert.deepEqual(writes.map((response) => response.status), [200, 200]);
    assert.deepEqual((await read(b)).modules, { [ids[0]]: { "cmi.suspend_data": "one" }, [ids[1]]: { "cmi.suspend_data": "two" } });
    const { clearCache } = await import("../server/cache.mjs");
    clearCache(cacheDir);
    assert.equal((await read(a)).modules[ids[1]]["cmi.suspend_data"], "two");
    assert.equal((await write(a, { epoch: 0, selectedSco: ids[0], reset: true })).status, 200);
    assert.equal((await write(b, { epoch: 0, selectedSco: ids[1], modules: { [ids[1]]: { "cmi.suspend_data": "old tab" } } })).status, 409);
    assert.deepEqual(await read(b), { saved: true, epoch: 1, selectedSco: ids[0], modules: {} });
    for (const invalid of [{ epoch: 1, selectedSco: ids[0], modules: [] }, { epoch: 1, selectedSco: "missing" }, { epoch: 1, selectedSco: ids[0], modules: { [ids[0]]: { score: 1 } } }]) {
      assert.equal((await write(a, invalid)).status, 400);
    }
  } finally { await a.close(); await b.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
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

test("pin screenshots load from a hidden project directory", async () => {
  const dir = tempDir();
  const zip = path.join(dir, "course.zip");
  fs.writeFileSync(zip, scorm2004Zip());
  const player = await startPlayer({ input: zip, pinsFile: path.join(dir, ".scormplayer", "pins.json"), cacheDir: path.join(dir, "cache"), port: 0, registryDir: null });
  try {
    const pin = player.pins.create({ note: "Screenshot in project" });
    const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
    player.pins.saveFrame(pin.id, png);
    const response = await fetch(new URL(`api/pins/${pin.id}/frame`, player.url));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /image\/png/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  } finally { await player.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("only the player's own page can make changes; it reports the agent skill", async () => {
  const dir = tempDir();
  const zipPath = path.join(dir, "demo.zip");
  fs.writeFileSync(zipPath, scorm12Zip());
  const clientDir = path.join(dir, "client");
  fs.mkdirSync(clientDir);
  fs.writeFileSync(path.join(clientDir, "index.html"), "<!doctype html><title>player</title>");
  const player = await startPlayer({ input: zipPath, cacheDir: path.join(dir, "cache"), port: 0, clientDir, registryDir: null });
  try {
    const revision = (await (await fetch(`${player.url}api/course`)).json()).revision;
    const post = (origin) => fetch(`${player.url}api/pins`, { method: "POST", headers: { "content-type": "application/json", "x-scormplayer-revision": revision, ...(origin ? { origin } : {}) }, body: JSON.stringify({ note: "Hello" }) });
    assert.equal((await post("https://evil.example")).status, 403, "another website can't save pins");
    assert.equal((await post(new URL(player.url).origin)).status, 201, "the player's own page can");
    assert.equal((await post(null)).status, 201, "and so can local tools that send no origin");
    assert.equal((await fetch(`${player.url}api/unzip`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" })).status, 403);
    const skill = await (await fetch(`${player.url}api/skill`)).json();
    assert.match(skill.state, /^(missing|current|outdated|newer)$/);
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

test("agent mode: --json prints parseable results, errors and player events", async (t) => {
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
  t.after(() => child.kill("SIGKILL"));
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

test("the agent skill is stamped with this version, and installed copies are checked against it", async () => {
  const { skillStatus, SKILL_FILE } = await import("../server/skill.mjs");
  const bundled = fs.readFileSync(SKILL_FILE, "utf8");
  const version = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  assert.match(bundled, new RegExp(`^metadata:\\n  version: "${version.replace(/\./g, "\\.")}"$`, "m"), "run npm version (or scripts/sync-skill-version.mjs) so the skill carries the package version");

  const home = tempDir();
  const cwd = tempDir();
  const install = (dir, text) => {
    fs.mkdirSync(path.join(home, dir, "skills", "scormplayer"), { recursive: true });
    fs.writeFileSync(path.join(home, dir, "skills", "scormplayer", "SKILL.md"), text);
  };
  const stamp = (text, v) => text.replace(/^(metadata:\n  version: )".*"$/m, `$1"${v}"`);
  assert.equal(skillStatus({ home, cwd }).state, "missing");
  install(".agents", bundled);
  assert.equal(skillStatus({ home, cwd }).state, "current");
  // A link to the same copy (as Claude Code's often is) counts once.
  fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
  fs.symlinkSync(path.join(home, ".agents", "skills", "scormplayer"), path.join(home, ".claude", "skills", "scormplayer"), process.platform === "win32" ? "junction" : "dir");
  assert.equal(skillStatus({ home, cwd }).installed.length, 1);
  // Same text from an earlier release is still current; different text from one is behind.
  install(".agents", stamp(bundled, "0.0.1"));
  assert.equal(skillStatus({ home, cwd }).state, "current");
  install(".agents", `${stamp(bundled, "0.0.1")}\nAn old line.\n`);
  const behind = skillStatus({ home, cwd });
  assert.equal(behind.state, "outdated");
  assert.equal(behind.installed[0].version, "0.0.1");
  // From a later scormplayer: the player is the one behind.
  install(".agents", `${stamp(bundled, "99.0.0")}\nA new line.\n`);
  assert.equal(skillStatus({ home, cwd }).state, "newer");
  // A copy from before versioning, with other text, is behind.
  install(".agents", "---\nname: scormplayer\ndescription: old\n---\nOld skill.\n");
  assert.equal(skillStatus({ home, cwd }).state, "outdated");
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

test("dashboard: arrow keys open the course list and choose adjacent lessons without pressing l", async (t) => {
  const { createDashboard } = await import("../server/tui.mjs");
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const previousCi = process.env.CI;
  delete process.env.CI;
  t.after(() => { if (previousCi === undefined) delete process.env.CI; else process.env.CI = previousCi; });
  const courses = ["A", "B"].map((name) => ({ path: `/test/lesson-${name}`, kind: "folder", title: `Lesson ${name}` }));
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = 112;
  stdout.rows = 30;
  let output = "";
  stdout.on("data", (chunk) => { output += chunk; });
  const player = { url: "http://127.0.0.1:4620/", events: new EventEmitter(), course: { ...courses[0], source: courses[0].path, kind: "package", scormVersion: "1.2" } };
  const chosen = [];
  const dashboard = createDashboard({ version: "test", entries: [{ id: "lesson", player }], stdin, stdout, onQuit: () => {}, courses: () => courses, switchCourse: async (target) => { chosen.push(target); player.course.source = target; } });
  try {
    stdin.write("\x1b[B\r");
    assert.match(output, /Switch course/);
    assert.deepEqual(chosen, [courses[1].path], "normal down arrow selects the next lesson");
    stdin.write("\x1bOA\r");
    assert.deepEqual(chosen, [courses[1].path, courses[0].path], "application-mode up arrow selects the previous lesson");
  } finally { await dashboard.quit(); stdin.destroy(); stdout.destroy(); }
});

test("launcher setup shortcut stays outside courses and preserves title filtering", async () => {
  const { pickCourse, SETUP_MENU } = await import("../server/tui.mjs");
  const { PassThrough } = await import("node:stream");
  for (const sequence of ["\x1b[12~", "\x1bOQ"]) {
    for (const courses of [[], [{ path: "/test/safety", title: "Safety", kind: "folder" }]]) {
      const stdin = new PassThrough(), stdout = new PassThrough();
      stdin.setRawMode = () => {};
      stdout.isTTY = true;
      stdout.rows = 30;
      stdout.columns = 80;
      let output = "";
      stdout.on("data", (chunk) => { output += chunk; });
      const picked = pickCourse({ version: "test", courses, stdin, stdout });
      stdin.write(sequence);
      assert.equal(await picked, SETUP_MENU);
      assert.match(output, /F2.*Set up MCP \/ skills/);
      assert.doesNotMatch(output, /❯.*Set up MCP/, "setup is never a course row");
      stdin.destroy(); stdout.destroy();
    }
  }
  const stdin = new PassThrough(), stdout = new PassThrough();
  stdin.setRawMode = () => {};
  const picked = pickCourse({ version: "test", courses: [{ path: "/test/safety", title: "Safety", kind: "folder" }], stdin, stdout });
  stdin.write("safety\r");
  assert.equal(await picked, "/test/safety", "typing s still filters course titles");
  stdin.destroy(); stdout.destroy();
});

test("dashboard setup suspends input and painting then restores the running player", async (t) => {
  const { createDashboard } = await import("../server/tui.mjs");
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  const previousCi = process.env.CI;
  delete process.env.CI;
  t.after(() => { if (previousCi === undefined) delete process.env.CI; else process.env.CI = previousCi; });
  const stdin = new PassThrough(), stdout = new PassThrough();
  stdin.isTTY = stdout.isTTY = true;
  stdout.columns = 112; stdout.rows = 30;
  const rawModes = [];
  stdin.setRawMode = (raw) => { rawModes.push(raw); };
  let output = "", calls = 0, quit = 0, finish;
  stdout.on("data", (chunk) => { output += chunk; });
  const events = new EventEmitter();
  const dashboard = createDashboard({ version: "test", entries: [{ id: "empty", player: { url: "http://127.0.0.1:4620/", events } }], stdin, stdout,
    skill: { status: () => ({ state: "current", installed: [] }) },
    onQuit: () => { quit++; },
    setup: () => { calls++; return new Promise((resolve) => { finish = resolve; }); },
  });
  try {
    assert.match(output, /MCP \/ skills setup/, "setup remains available with current skills and no lesson");
    stdin.write("s");
    assert.deepEqual(rawModes, [true, false]);
    const pausedOutput = output;
    stdin.write("sq");
    events.emit("browser");
    dashboard.render();
    assert.equal(output, pausedOutput, "dashboard cannot paint over installer prompts");
    assert.equal(calls, 1);
    assert.equal(quit, 0, "installer keystrokes must not control the player");
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(rawModes, [true, false, true]);
    assert.match(output, /Player opened in the browser/, "events still arrive while setup is open");
    stdin.write("q");
    assert.equal(quit, 1, "normal dashboard keys work again after setup");
  } finally { await dashboard.quit(); stdin.destroy(); stdout.destroy(); }
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

test("finder: a mixed folder keeps the picker instead of opening only its unpacked lesson", async () => {
  const { findCourses, isCourseFolder } = await import("../server/finder.mjs");
  const dir = tempDir();
  const lesson = path.join(dir, "lesson-a");
  fs.mkdirSync(lesson);
  fs.writeFileSync(path.join(lesson, "imsmanifest.xml"), MANIFEST_12("Lesson A"));
  fs.writeFileSync(path.join(lesson, "index.html"), "<h1>Lesson A</h1>");
  assert.equal(isCourseFolder(dir), true, "a single wrapped package still opens directly");
  const { default: AdmZip } = await import("adm-zip");
  const photos = new AdmZip();
  photos.addFile("photo.jpg", Buffer.from("not a course"));
  fs.writeFileSync(path.join(dir, "photos.zip"), photos.toBuffer());
  assert.equal(isCourseFolder(dir), true, "unrelated archives do not turn it into a course collection");
  fs.writeFileSync(path.join(dir, "lesson-b.zip"), scorm12Zip({ title: "Lesson B" }));
  assert.equal(isCourseFolder(dir), false, "other courses require the picker");
  assert.equal(isCourseFolder(lesson), true, "the actual lesson still opens directly");
  assert.deepEqual(findCourses(dir).map((course) => course.path), [lesson, path.join(dir, "lesson-b.zip")]);
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
    const initial = await (await fetch(`${player.url}api/course`)).json();
    assert.equal(initial.empty, true);
    assert.equal(typeof initial.revision, "string");
    assert.equal(player.course, null);

    const send = (name, body) => fetch(`${player.url}api/open`, { method: "POST", headers: { "Content-Type": "application/zip", "X-File-Name": encodeURIComponent(name) }, body });
    const first = await send("Safety Basics.zip", scorm12Zip({ title: "Safety Basics" }));
    assert.equal(first.status, 200);
    const course = await (await fetch(`${player.url}api/course`)).json();
    assert.equal(course.title, "Safety Basics");
    assert.equal(course.source, "Safety Basics.zip");
    assert.equal(course.pinsFile, path.join(dir, `Safety Basics-${player.course.sha256.slice(0, 12)}.pins.json`));
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
  // Count only "what's the latest?" questions; the readiness check asks for the package file.
  let fileReady = true;
  const fetchImpl = async (url, options) => {
    if (url.startsWith("https://api.github.com/")) return { ok: false, status: 503 };
    if (options?.method === "HEAD") return { ok: fileReady };
    calls += 1;
    return { ok: true, json: async () => ({ version: "9.0.0" }) };
  };
  const saved = { CI: process.env.CI, OFF: process.env.SCORMPLAYER_NO_UPDATE_CHECK };
  delete process.env.CI;
  delete process.env.SCORMPLAYER_NO_UPDATE_CHECK;
  try {
    assert.equal(await checkForUpdate({ current: "0.6.0", cacheDir, fetchImpl }), "9.0.0");
    assert.equal(await checkForUpdate({ current: "0.6.0", cacheDir, fetchImpl }), "9.0.0");
    assert.equal(calls, 1, "the second check uses the saved answer");
    // Published but not downloadable yet (npm can take minutes): not announced until it is.
    fileReady = false;
    assert.equal(await checkForUpdate({ current: "0.6.0", cacheDir, fetchImpl }), null);
    fileReady = true;
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
  assert.deepEqual(installMethod({ packageRoot: globalNpm }).command, ["npm", "install", "-g", "--prefix", path.join(base, process.platform === "win32" ? "usr/local/lib" : "usr/local"), "@jakerains/scormplayer@latest"]);
  assert.equal(updateHint(globalNpm), "scormplayer update");
  assert.equal(kind(at("proj/node_modules/@jakerains/scormplayer", "proj/package.json")), "project");
  assert.equal(kind(at("home/.npm/_npx/1a2b/node_modules/@jakerains/scormplayer")), "npx");
  assert.equal(updateHint(at("home/.npm/_npx/3c4d/node_modules/@jakerains/scormplayer")), "npx @jakerains/scormplayer@latest");
  assert.equal(kind(at("home/Library/pnpm/global/5/node_modules/@jakerains/scormplayer")), "pnpm");
  assert.equal(kind(at("home/.bun/install/global/node_modules/@jakerains/scormplayer")), "bun");
  assert.equal(kind(at("home/.config/yarn/global/node_modules/@jakerains/scormplayer")), "yarn");
  assert.equal(kind(at("src/scormplayer")), "source");
  const standalone = at("home/.local/share/scormplayer/standalone/versions/v0.9.0");
  fs.writeFileSync(path.join(standalone, ".standalone-install.json"), '{"kind":"standalone"}');
  assert.equal(kind(standalone), "standalone");
  assert.equal(installMethod({ packageRoot: standalone }).command, null);
  assert.equal(installMethod({ packageRoot: standalone }).hint, "scormplayer update");
  const { tarballInstall, summarizeInstallError, packageReady } = await import("../server/update.mjs");
  assert.equal(await packageReady("1.2.3", { fetchImpl: async (url, options) => ({ ok: options.method === "HEAD" && url.includes("scormplayer-1.2.3.tgz") }) }), true);
  assert.equal(await packageReady("1.2.3", { fetchImpl: async () => ({ ok: false }) }), false);
  assert.equal(await packageReady("1.2.3", { fetchImpl: async () => { throw new Error("offline"); } }), false);
  // npm's wall of errors comes down to what went wrong and where the log is.
  const npmOutput = [
    "npm error code E404",
    "npm error 404 Not Found - GET https://registry.npmjs.org/@jakerains/scormplayer/-/scormplayer-0.8.9.tgz - Not found",
    "npm error 404",
    "npm error 404  The requested resource '@jakerains/scormplayer@0.8.9' could not be found or you do not have permission to access it.",
    "npm error 404",
    "npm error 404 Note that you can also install from a",
    "npm error A complete log of this run can be found in: /Users/x/.npm/_logs/debug-0.log",
  ].join("\n");
  const summary = summarizeInstallError(npmOutput).split("\n");
  assert.ok(summary.length <= 4);
  assert.match(summary[0], /^404 Not Found - GET .*scormplayer-0\.8\.9\.tgz/);
  assert.match(summary.at(-1), /^A complete log of this run can be found in: /);
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

test("running players: registry, reuse, ps and stop, and stopping when idle", async (t) => {
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

  // Whatever happens in the test, don't leave a player running (it would keep the runner waiting).
  const children = [];
  t.after(() => children.forEach((child) => child.kill("SIGKILL")));
  const first = spawn(process.execPath, [BIN, zipPath, "--json", "--no-open", "--port", "0"], { env });
  children.push(first);
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
  // Windows ends the process outright, so it can't report why.
  if (process.platform !== "win32") assert.match((await next("stopped")).reason, /SIGTERM/);
  assert.equal(listPlayers(registry).length, 0, "a stopped player leaves the registry");

  // The page's "Still there?" close is refused while someone is using the player, accepted after.
  const clientDir = path.join(dir, "client");
  fs.mkdirSync(clientDir);
  fs.writeFileSync(path.join(clientDir, "index.html"), "<!doctype html><title>player</title>");
  const quiet = await startPlayer({ input: zipPath, cacheDir: path.join(dir, "cache2"), port: 0, clientDir, idleMinutes: 0.01, registryDir: null });
  try {
    let closes = 0;
    quiet.events.on("idle-close", () => { closes += 1; });
    await fetch(`${quiet.url}api/active`, { method: "POST" });
    assert.deepEqual(await (await fetch(`${quiet.url}api/idle-close`, { method: "POST" })).json(), { closed: false });
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.deepEqual(await (await fetch(`${quiet.url}api/idle-close`, { method: "POST" })).json(), { closed: true });
    assert.equal(closes, 1);
    assert.equal((await (await fetch(`${quiet.url}api/course`)).json()).idleMinutes, 0.01);
  } finally {
    await quiet.close();
  }

  // A background player nobody uses stops by itself.
  const idle = spawn(process.execPath, [BIN, zipPath, "--json", "--no-open", "--port", "0", "--idle", "0.02"], { env });
  children.push(idle);
  assert.match((await lines(idle)("stopped")).reason, /nobody has used the player/);
});

test("several packages in one zip or folder: first by default, pick by name, own pins and progress", async () => {
  const dir = tempDir();
  const cacheDir = path.join(dir, "cache");
  const zipPath = path.join(dir, "bundle.zip");
  fs.writeFileSync(zipPath, bundleZip());

  // A zip of two packages opens the first, lists both, and keeps pins per package.
  const first = resolveCourse(zipPath, { cacheDir });
  assert.equal(first.title, "Lesson one");
  assert.equal(first.package, "lesson-1");
  assert.deepEqual(first.packages, [{ name: "lesson-1", title: "Lesson one" }, { name: "more/lesson-2", title: "Lesson two" }]);
  assert.equal(first.pinsFile, path.join(dir, "bundle.lesson-1.pins.json"));
  // By folder, by the end of its folder path, or by part of its title.
  for (const pkg of ["more/lesson-2", "lesson-2", "two"]) assert.equal(resolveCourse(zipPath, { cacheDir, pkg }).title, "Lesson two");
  assert.throws(() => resolveCourse(zipPath, { cacheDir, pkg: "nope" }), /No package "nope"[\s\S]*lesson-1 \(Lesson one\)/);
  // One package nested three folders down is found too.
  const deep = path.join(dir, "deep.zip");
  fs.writeFileSync(deep, bundleZip({ "export/scorm/package": "Deep lesson" }));
  assert.equal(resolveCourse(deep, { cacheDir }).title, "Deep lesson");
  assert.equal(resolveCourse(deep, { cacheDir }).packages, undefined);

  // A folder of two course folders is a list to pick from, not one broken course.
  const { findCourses, isCourseFolder } = await import("../server/finder.mjs");
  const lessons = path.join(dir, "lessons");
  for (const [name, title] of [["a", "Lesson A"], ["b", "Lesson B"]]) {
    fs.mkdirSync(path.join(lessons, name), { recursive: true });
    fs.writeFileSync(path.join(lessons, name, "imsmanifest.xml"), MANIFEST_12(title));
    fs.writeFileSync(path.join(lessons, name, "index.html"), "<!doctype html><title>x</title>");
  }
  assert.equal(isCourseFolder(lessons), false);
  assert.deepEqual(findCourses(lessons).map((course) => course.title), ["Lesson A", "Lesson B"]);
  // Pointed at directly, it still opens (the first), rather than refusing.
  assert.equal(resolveCourse(lessons, { cacheDir }).title, "Lesson A");

  // The player switches packages, each with its own progress key and pins.
  const clientDir = path.join(dir, "client");
  fs.mkdirSync(clientDir);
  fs.writeFileSync(path.join(clientDir, "index.html"), "<!doctype html><title>player</title>");
  const player = await startPlayer({ input: zipPath, cacheDir, port: 0, clientDir, registryDir: null });
  try {
    const one = await (await fetch(`${player.url}api/course`)).json();
    assert.equal(one.package, "lesson-1");
    assert.equal(one.packages.length, 2);
    await fetch(`${player.url}api/package`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "more/lesson-2" }) });
    const two = await (await fetch(`${player.url}api/course`)).json();
    assert.equal(two.title, "Lesson two");
    assert.notEqual(two.courseKey, one.courseKey);
    assert.equal(two.pinsFile, path.join(dir, "bundle.more-lesson-2.pins.json"));
    assert.match(await (await fetch(new URL(two.launchUrl, player.url))).text(), /Lesson two/);
  } finally {
    await player.close();
  }

  // The CLI: --package picks, and agent output lists the packages.
  const env = { ...process.env, XDG_CACHE_HOME: cacheDir };
  const report = JSON.parse(execFileSync(process.execPath, [BIN, "pins", zipPath, "--package", "lesson-2", "--json"], { encoding: "utf8", env }));
  assert.equal(report.course.title, "Lesson two");
  assert.equal(report.course.packages.length, 2);
});

test("switching courses: a filterable list, only listed courses, and open pages follow", async () => {
  const { createCourseList } = await import("../server/tui.mjs");
  const courses = ["Welcome", "Shape how Mira talks", "Build and test your Mira", "Follow the phone route"].map((title, i) => ({ path: `/c/m0${i}`, kind: "folder", title }));
  const list = createCourseList({ courses, current: "/c/m02" });
  for (const key of "mira") list.key(key);
  assert.equal(list.count, 2, "typing filters by title");
  assert.deepEqual(list.key("enter"), { choose: "/c/m01" });
  list.key("down");
  assert.deepEqual(list.key("enter"), { choose: "/c/m02" });
  assert.equal(list.key("escape"), null, "Esc first clears the filter");
  assert.equal(list.count, 4);
  assert.deepEqual(list.key("escape"), { cancel: true }, "then leaves");
  for (const key of "zzz") list.key(key);
  assert.equal(list.key("enter"), null, "nothing to open when nothing matches");
  ["\x7f", "\x7f", "\x7f"].forEach((key) => list.key(key));
  assert.equal(list.query, "");

  const dir = tempDir();
  const lessons = ["a", "b"].map((name) => {
    const folder = path.join(dir, "lessons", name);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "imsmanifest.xml"), MANIFEST_12(`Lesson ${name.toUpperCase()}`));
    fs.writeFileSync(path.join(folder, "index.html"), "<!doctype html><title>x</title>");
    return folder;
  });
  const clientDir = path.join(dir, "client");
  fs.mkdirSync(clientDir);
  fs.writeFileSync(path.join(clientDir, "index.html"), "<!doctype html><title>player</title>");
  const { findCourses } = await import("../server/finder.mjs");
  const player = await startPlayer({ input: lessons[0], cacheDir: path.join(dir, "cache"), port: 0, clientDir, registryDir: null, courseList: () => findCourses(dir), pinsFor: (course) => path.join(dir, "pins", `${path.basename(course)}.json`) });
  try {
    const listed = await (await fetch(`${player.url}api/courses`)).json();
    assert.deepEqual(listed.courses.map((course) => [course.title, course.current]), [["Lesson A", true], ["Lesson B", false]]);
    const before = (await (await fetch(`${player.url}api/player`)).json()).courseVersion;
    const post = (target) => fetch(`${player.url}api/switch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: target }) });
    assert.equal((await post(path.join(dir, "elsewhere"))).status, 400, "only courses in the list can be opened");
    assert.equal((await post(lessons[1])).status, 200);
    assert.equal(player.course.title, "Lesson B");
    assert.equal(player.course.pinsFile, path.join(dir, "pins", "b.json"), "the switched-to course keeps its pins where pinsFor says");
    assert.equal((await (await fetch(`${player.url}api/player`)).json()).courseVersion, before + 1, "open pages see the change and reload");
  } finally {
    await player.close();
  }
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


test("closing a live player also closes a retired WebSocket upgrade", async (t) => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(dir, "vite.config.mjs"), "export default {};");
  fs.writeFileSync(path.join(dir, "index.html"), "<h1>Live socket cleanup</h1>");
  fs.symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), path.join(dir, "node_modules"), "junction");
  const player = await startPlayer({ input: dir, live: true, port: 0, registryDir: null, cacheDir: path.join(dir, "cache") });
  const port = Number(new URL(player.url).port);
  const socket = net.connect(port, "127.0.0.1");
  t.after(async () => { socket.destroy(); await player.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  socket.write(`GET /course/retired-session HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Protocol: vite-ping\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await Promise.race([player.close(), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Retired upgrade prevented shutdown")), 2000); timer.unref(); })]);
});
