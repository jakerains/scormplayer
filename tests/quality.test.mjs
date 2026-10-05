import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { startPlayer } from "../server/index.mjs";
import { createPinStore } from "../server/pins.mjs";
import { resolveCourse } from "../server/course.mjs";
import { findSourceText } from "../server/source-match.mjs";
import { startSync } from "../server/config.mjs";
import { MANIFEST_12, scorm12Zip } from "./fixtures.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "scormplayer-quality-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bin = fileURLToPath(new URL("../bin/scormplayer.mjs", import.meta.url));
function fixture(name) {
  const folder = path.join(root, name);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "imsmanifest.xml"), MANIFEST_12(name));
  fs.writeFileSync(path.join(folder, "index.html"), `<h1>${name}</h1>`);
  return folder;
}
function player(options = {}) {
  return startPlayer({ cacheDir: path.join(root, "cache"), port: 0, registryDir: null, ...options });
}

test("concurrent processes preserve every pin and unique number", async () => {
  const file = path.join(root, "concurrent.pins.json");
  const gate = path.join(root, "gate");
  const course = { title: "Concurrency", source: root, kind: "folder" };
  const store = createPinStore(file, course);
  store.create({ note: "Seed" });
  const source = `import fs from 'node:fs'; import {createPinStore} from ${JSON.stringify(new URL("../server/pins.mjs", import.meta.url).href)};
    const store=createPinStore(${JSON.stringify(file)},${JSON.stringify(course)});
    console.log('ready'); while(!fs.existsSync(${JSON.stringify(gate)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2);
    for(let i=0;i<60;i++){store.create({note:process.argv[1]+'-'+i});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1);}`;
  const children = ["A", "B"].map((label) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, label], { stdio: ["ignore", "pipe", "pipe"] });
    const ready = new Promise((resolve) => child.stdout.once("data", resolve));
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const done = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
    });
    return { ready, done, child };
  });
  try {
    await Promise.all(children.map((child) => child.ready));
    fs.writeFileSync(gate, "go");
    await Promise.all(children.map((child) => child.done));
    const pins = store.list();
    assert.equal(pins.length, 121);
    assert.equal(new Set(pins.map((pin) => pin.number)).size, 121);
  } finally { children.forEach(({ child }) => child.kill()); }
});

test("cache pruning and clearing preserve courses in other active players", async () => {
  const cacheDir = path.join(root, "shared-cache");
  const zip = (i) => {
    const file = path.join(root, `cache-${i}.zip`);
    fs.writeFileSync(file, scorm12Zip({ title: `Cache ${i}` }));
    return file;
  };
  const a = await player({ input: zip(0), cacheDir });
  const b = await player({ input: zip(1), cacheDir });
  const aRoot = a.course.root;
  try {
    for (let i = 2; i < 23; i += 1) { await pause(2); await b.open(zip(i)); }
    assert.equal((await fetch(`${a.url}course/index.html`)).status, 200);
    const { clearCache } = await import("../server/cache.mjs");
    clearCache(cacheDir);
    assert.ok(fs.existsSync(aRoot));
    assert.equal((await fetch(`${b.url}course/index.html`)).status, 200);
  } finally { await a.close(); await b.close(); }
  const { clearCache } = await import("../server/cache.mjs");
  clearCache(cacheDir);
  assert.equal(fs.existsSync(aRoot), false);
});

test("stale course revisions reject pin and progress writes", async () => {
  const a = fixture("revision-a");
  const b = fixture("revision-b");
  const p = await player({ input: a });
  try {
    const before = await (await fetch(`${p.url}api/course`)).json();
    await p.switchCourse(b);
    for (const endpoint of ["pins", "progress"]) {
      const response = await fetch(`${p.url}api/${endpoint}`, { method: "POST", headers: { "content-type": "application/json", "x-scormplayer-revision": before.revision ?? "missing" }, body: JSON.stringify({ note: "Old A note", completion: "completed" }) });
      assert.equal(response.status, 409);
    }
    assert.equal(p.pins.list().length, 0);
    assert.equal(p.progress(), null);
    const stateResponse = await fetch(`${p.url}api/scorm`, { method: "PUT", headers: { "content-type": "application/json", "x-scormplayer-revision": before.revision }, body: JSON.stringify({ epoch: 0, selectedSco: "", modules: { "": { "cmi.suspend_data": "Old A state" } } }) });
    assert.equal(stateResponse.status, 409);
    assert.equal((await (await fetch(`${p.url}api/scorm`)).json()).saved, false);
    const current = await (await fetch(`${p.url}api/course`)).json();
    const response = await fetch(`${p.url}api/pins`, { method: "POST", headers: { "content-type": "application/json", "x-scormplayer-revision": current.revision }, body: JSON.stringify({ note: "B note" }) });
    assert.equal(response.status, 201);
    const listed = await fetch(`${p.url}api/pins`, { headers: { "x-scormplayer-revision": current.revision } });
    const etag = listed.headers.get("etag");
    assert.ok(etag);
    assert.equal((await fetch(`${p.url}api/pins`, { headers: { "if-none-match": etag, "x-scormplayer-revision": current.revision } })).status, 304);
    p.pins.create({ note: "External CLI update" });
    assert.equal((await fetch(`${p.url}api/pins`, { headers: { "if-none-match": etag, "x-scormplayer-revision": current.revision } })).status, 200);
    await Promise.all([p.open(a), p.open(b)]);
    assert.equal(p.course.source, b);
  } finally { await p.close(); }
});

test("source matching handles malformed entities and reads fallback candidates once", async () => {
  const folder = fixture("source-safety");
  fs.writeFileSync(path.join(folder, "other.html"), "&#9999999; &#x110000;");
  const originalRead = fs.readFileSync;
  let reads = 0;
  try {
    fs.readFileSync = (...args) => { reads += 1; return originalRead(...args); };
    assert.deepEqual(findSourceText(folder, "This absent first sentence has many distinct words. Another sentence follows."), []);
    assert.ok(reads <= 3, `${reads} reads for three files`);
  } finally { fs.readFileSync = originalRead; }
  fs.writeFileSync(path.join(folder, "other.html"), "<p>New source text after an edit.</p>");
  assert.equal(findSourceText(folder, "New source text after an edit.")[0]?.file, "other.html");
  const p = await player({ input: folder });
  try {
    fs.writeFileSync(path.join(folder, "other.html"), "&#9999999;");
    const response = await fetch(`${p.url}api/pins`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ note: "Save despite bad source", target: { name: "Unmatched heading" } }) });
    assert.equal(response.status, 201);
    assert.equal(p.pins.list().length, 1);
  } finally { await p.close(); }
});

test("launch filenames decode spaces and Unicode without admitting traversal", () => {
  const folder = fixture("encoded-launch");
  const file = "start café.html";
  fs.writeFileSync(path.join(folder, file), "<h1>Encoded filename</h1>");
  const manifest = (href) => MANIFEST_12("Encoded").replace('href="index.html"', `href="${href}"`);
  fs.writeFileSync(path.join(folder, "imsmanifest.xml"), manifest(encodeURIComponent(file)));
  assert.equal(resolveCourse(folder, { cacheDir: root }).launch, encodeURIComponent(file));
  fs.writeFileSync(path.join(folder, "imsmanifest.xml"), manifest("%2e%2e%2foutside.html"));
  fs.writeFileSync(path.join(root, "outside.html"), "outside");
  assert.throws(() => resolveCourse(folder, { cacheDir: root }), /not in the package/);
});

// File watchers poll every 300 ms and take their first reading in the background, so a change
// made straight after watching starts can be taken as the starting state and never noticed.
// These tests let the watchers settle first, and give up instead of hanging.
const SETTLE = 700;
const within = (promise, ms, what) => Promise.race([promise, pause(ms).then(() => { throw new Error(`Timed out waiting for ${what}`); })]);

test("stopping sync cancels a pending debounce without stopping another watcher", { timeout: 20_000 }, async () => {
  const folder = path.join(root, "sync-stop");
  fs.mkdirSync(folder);
  const input = path.join(folder, "input.txt");
  const output = path.join(folder, "ran.txt");
  fs.writeFileSync(input, "before");
  const script = path.join(folder, "run.mjs");
  fs.writeFileSync(script, `import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(output)},'ran\\n');`);
  let notice;
  const noticed = new Promise((resolve) => { notice = resolve; });
  let notices = 0;
  const observer = (now, before) => { if (now.mtimeMs !== before.mtimeMs) { notices += 1; notice(); } };
  fs.watchFile(input, { interval: 300 }, observer);
  const config = { root: folder, data: { sync: [{ files: ["input.txt"], run: `"${process.execPath}" "${script}"` }] } };
  const stop = startSync(config, folder);
  await pause(SETTLE);
  fs.writeFileSync(input, "changed");
  await within(noticed, 5000, "the watcher to notice the change");
  stop();
  await pause(500);
  try {
    assert.equal(fs.existsSync(output), false);
    fs.writeFileSync(input, "changed again");
    for (let i = 0; i < 30 && notices < 2; i += 1) await pause(100);
    assert.ok(notices >= 2, "the independent watcher stays attached");
  } finally { fs.unwatchFile(input, observer); }
});

test("agent mode switches configured sync rules with the course", { timeout: 30_000 }, async () => {
  const folder = path.join(root, "agent-sync");
  fs.mkdirSync(path.join(folder, "source"), { recursive: true });
  const courses = ["a", "b"].map((name) => {
    const dir = path.join(folder, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "imsmanifest.xml"), MANIFEST_12(name));
    fs.writeFileSync(path.join(dir, "index.html"), `<h1>${name}</h1>`);
    fs.writeFileSync(path.join(folder, "source", `${name}.txt`), "before");
    return dir;
  });
  const output = path.join(folder, "runs.txt");
  const script = path.join(folder, "sync.mjs");
  fs.writeFileSync(script, `import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(output)},process.argv[2]+'\\n');`);
  fs.writeFileSync(path.join(folder, "scormplayer.config.json"), JSON.stringify({ courses: ["a", "b"], sync: [{ files: ["source/{name}.txt"], run: `"${process.execPath}" "${script}" {name}` }] }));
  const child = spawn(process.execPath, [bin, courses[0], "--json", "--no-open", "--new", "--idle", "0", "--port", "0"], { cwd: folder, env: { ...process.env, XDG_CACHE_HOME: path.join(folder, "cache") }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    for (let i = 0; i < 100 && !stdout.includes('"event":"ready"'); i += 1) await pause(50);
    const ready = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((event) => event.event === "ready");
    assert.ok(ready, stderr);
    const switched = await fetch(`${ready.url}api/switch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: courses[1] }) });
    assert.equal(switched.status, 200);
    await pause(SETTLE);
    fs.writeFileSync(path.join(folder, "source", "b.txt"), "B edited");
    for (let i = 0; i < 50 && !fs.existsSync(output); i += 1) await pause(100);
    assert.equal(fs.existsSync(output), true, "B sync runs after switching");
    assert.equal(fs.readFileSync(output, "utf8").trim(), "b");
    fs.writeFileSync(path.join(folder, "source", "a.txt"), "A edited");
    await pause(700);
    assert.equal(fs.readFileSync(output, "utf8").trim(), "b", "A is no longer watched");
  } finally { child.kill("SIGTERM"); await within(exited, 5000, "the player to stop").catch(() => child.kill("SIGKILL")); }
});

test("hashed UI assets negotiate compression and cache safely", async () => {
  const clientDir = path.join(root, ".installed", "client");
  fs.mkdirSync(path.join(clientDir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(clientDir, "index.html"), "<title>Player</title>");
  const bytes = Buffer.from("console.log('compressed asset');".repeat(100));
  const asset = path.join(clientDir, "assets", "index-12345678.js");
  fs.writeFileSync(asset, bytes);
  fs.writeFileSync(`${asset}.gz`, gzipSync(bytes));
  fs.writeFileSync(`${asset}.br`, brotliCompressSync(bytes));
  const p = await player({ clientDir });
  try {
    const response = await fetch(`${p.url}assets/index-12345678.js`, { headers: { "accept-encoding": "br,gzip" } });
    assert.equal(response.headers.get("content-encoding"), "br");
    assert.match(response.headers.get("cache-control"), /immutable/);
    assert.match(response.headers.get("vary"), /Accept-Encoding/i);
    assert.equal(await response.text(), bytes.toString());
    const plain = await fetch(`${p.url}assets/index-12345678.js`, { headers: { "accept-encoding": "identity" } });
    assert.equal(plain.headers.get("content-encoding"), null);
    assert.equal(await plain.text(), bytes.toString());
    const gzip = await fetch(`${p.url}assets/index-12345678.js`, { headers: { "accept-encoding": "br;q=0,gzip" } });
    assert.equal(gzip.headers.get("content-encoding"), "gzip");
    assert.equal(await gzip.text(), bytes.toString());
    assert.equal((await fetch(`${p.url}assets/index-12345678.js`, { headers: { "accept-encoding": "*;q=0" } })).status, 406);
    for (const name of ["index-missing12.css", "old.css", "index-missing12.js"]) {
      const missing = await fetch(`${p.url}assets/${name}`);
      assert.equal(missing.status, 404);
      assert.equal(missing.headers.get("cache-control"), "no-store");
      assert.match(missing.headers.get("content-type"), /text\/plain/);
      assert.doesNotMatch(await missing.text(), /<title>/);
    }
    assert.equal((await fetch(p.url)).headers.get("cache-control"), "no-store");
    assert.equal((await fetch(`${p.url}api/course`)).headers.get("cache-control"), "no-store");
  } finally { await p.close(); }
});
