import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MANIFEST_12 } from "./fixtures.mjs";
import { updateHint } from "../server/update.mjs";
import { createHash } from "node:crypto";
import { RELEASES_API, releaseFilename } from "../server/releases.mjs";

const entry = fileURLToPath(new URL("../bin/scormplayer.mjs", import.meta.url));
const exec = promisify(execFile);

for (const ready of [true, false]) {
  test(`normal CLI ${ready ? "announces a downloadable update with advice" : "does not announce an unavailable download"}`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scorm-update-notice-"));
    const course = path.join(dir, "course");
    fs.mkdirSync(course);
    fs.writeFileSync(path.join(course, "imsmanifest.xml"), MANIFEST_12("Update notice"));
    fs.writeFileSync(path.join(course, "index.html"), "<h1>Update notice</h1>");
    // Isolate only the external registry. The CLI, dashboard and local HTTP API run normally.
    const preload = path.join(dir, "registry.mjs");
    const checked = path.join(dir, "download-checked");
    fs.writeFileSync(preload, `import fs from "node:fs";
const original = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (String(url).startsWith("https://api.github.com/")) return new Response(null, { status: 503 });
  if (String(url).startsWith("https://registry.npmjs.org/")) {
    if (options?.method === "HEAD") { fs.writeFileSync(${JSON.stringify(checked)}, "checked"); return new Response(null, { status: ${ready ? 200 : 404} }); }
    return Response.json({version:"99.0.0"});
  }
  return original(url, options);
};`);
    const env = { ...process.env, HOME: dir, XDG_CACHE_HOME: path.join(dir, "cache"), SCORMPLAYER_REGISTRY_DIR: path.join(dir, "registry"), CI: "", SCORMPLAYER_NO_UPDATE_CHECK: "", NO_UPDATE_NOTIFIER: "" };
    const child = spawn(process.execPath, ["--import", preload, entry, course, "--plain", "--no-open", "--new", "--port", "0"], { env });
    let output = "";
    child.stdout.on("data", (bytes) => { output += bytes; });
    child.stderr.on("data", (bytes) => { output += bytes; });
    t.after(async () => {
      if (child.exitCode === null) { const closed = new Promise((resolve) => child.once("close", resolve)); child.kill("SIGTERM"); await closed; }
      fs.rmSync(dir, { recursive: true, force: true });
    });
    let url;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      url = output.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0];
      if (url && fs.existsSync(checked) && (!ready || output.includes("99.0.0 is available"))) break;
      assert.equal(child.exitCode, null, output);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(url && fs.existsSync(checked), output);
    const { update: advice } = await (await fetch(`${url}api/update`)).json();
    if (ready) {
      assert.ok(output.includes(`scormplayer 99.0.0 is available: ${updateHint()}`), output);
      assert.equal(advice.latest, "99.0.0");
      assert.equal(advice.command, updateHint());
    } else {
      assert.equal(advice, null);
      assert.equal(output.includes("is available"), false, output);
    }
  });
}

async function updateFixture(t, { unchanged = false, github = false, corrupt = false, unavailable = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scorm update same shell "));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.dirname(path.dirname(entry));
  const packageRoot = path.join(dir, "original prefix/lib/node_modules/@jakerains/scormplayer");
  fs.mkdirSync(packageRoot, { recursive: true });
  const prefix = fs.realpathSync(path.join(dir, "original prefix"));
  for (const folder of ["bin", "server", "skills"]) fs.cpSync(path.join(root, folder), path.join(packageRoot, folder), { recursive: true });
  fs.symlinkSync(path.join(root, "node_modules"), path.join(packageRoot, "node_modules"), "dir");
  fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ type: "module", version: "0.1.0" }));
  const launcher = path.join(prefix, "bin/scormplayer");
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.chmodSync(path.join(packageRoot, "bin/scormplayer.mjs"), 0o755);
  fs.symlinkSync("../lib/node_modules/@jakerains/scormplayer/bin/scormplayer.mjs", launcher);
  const tools = path.join(dir, "tools");
  fs.mkdirSync(tools);
  const calls = path.join(dir, "install-calls.json");
  // Only the registry and installer are fixtures. Both shell sessions and CLI launches are real.
  fs.writeFileSync(path.join(tools, "npm"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const file = ${JSON.stringify(calls)};
const calls = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : [];
calls.push(args); fs.writeFileSync(file, JSON.stringify(calls));
if (args[args.indexOf("--prefix") + 1] !== ${JSON.stringify(prefix)}) process.exit(2);
if (!${unchanged}) {
  // Model stale npm metadata: @latest would successfully install the wrong version.
  const version = args.at(-1).endsWith("scormplayer-99.0.0.tgz") ? "99.0.0" : "0.8.8";
  fs.writeFileSync(${JSON.stringify(path.join(packageRoot, "package.json"))}, JSON.stringify({type:"module",version}));
  const entry = ${JSON.stringify(path.join(packageRoot, "bin/scormplayer.mjs"))};
  fs.writeFileSync(entry, fs.readFileSync(entry, "utf8").replace("Open a SCORM course", "Updated CLI: open a SCORM course"));
}
`, { mode: 0o755 });
  const preload = path.join(dir, "registry.mjs");
  const filename = releaseFilename("99.0.0");
  const bytes = Buffer.from("verified release package fixture");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const base = "https://github.com/jakerains/scormplayer/releases/download/v99.0.0";
  const metadata = { tag_name: "v99.0.0", draft: false, prerelease: false, assets: [filename, "SHA256SUMS"].map((name) => ({ name, state: "uploaded", browser_download_url: `${base}/${name}` })) };
  fs.writeFileSync(preload, `globalThis.fetch = async (url, options) => {
  if (url === ${JSON.stringify(RELEASES_API)}) return ${github} ? Response.json(${JSON.stringify(metadata)}) : new Response(null, {status:503});
  if (url === ${JSON.stringify(`${base}/SHA256SUMS`)}) return new Response(${JSON.stringify(`${sha256}  ${filename}\n`)});
  if (url === ${JSON.stringify(`${base}/${filename}`)}) {
    if (options?.method === "HEAD") return new Response(null);
    return new Response(${JSON.stringify((corrupt ? Buffer.from("damaged download") : bytes).toString())}, {status:${unavailable ? 503 : 200}});
  }
  return options?.method === "HEAD" ? new Response(null) : Response.json({version:"99.0.0"});
};`);
  const env = { ...process.env, HOME: dir, XDG_CACHE_HOME: path.join(dir, "cache"), CI: "1", NODE_OPTIONS: `--import=${JSON.stringify(preload)}`, PATH: `${path.dirname(launcher)}${path.delimiter}${tools}${path.delimiter}${process.env.PATH}`, npm_config_prefix: path.join(dir, "different npm prefix") };
  return { dir, env, launcher, calls, prefix };
}

for (const shell of ["bash", "zsh"]) {
  const available = process.platform !== "win32" && spawnSync(shell, ["--version"], { stdio: "ignore" }).status === 0;
  test(`update installs the checked release despite stale npm metadata and replaces the cached command in the same ${shell} session`, { skip: !available }, async (t) => {
    const { dir, env, calls, prefix } = await updateFixture(t);
    const { stdout } = await exec(shell, ["-c", "scormplayer --version; hash scormplayer; scormplayer update || exit $?; scormplayer --version; scormplayer --help"], { env, cwd: dir });
    assert.match(stdout, /^0\.1\.0\n/);
    assert.match(stdout, /scormplayer is now 99\.0\.0/);
    assert.match(stdout, /Ready in this terminal; no shell refresh needed\./);
    assert.match(stdout, /\n99\.0\.0\nscormplayer 99\.0\.0\n/);
    assert.match(stdout, /Updated CLI: open a SCORM course/);
    const commands = JSON.parse(fs.readFileSync(calls));
    assert.equal(commands.length, 1);
    for (const command of commands) assert.equal(command[command.indexOf("--prefix") + 1], prefix);
    assert.match(commands[0].at(-1), /scormplayer-99\.0\.0\.tgz$/);
  });
}

test("update does not claim success when the installer leaves the invoked CLI on the old version", { skip: process.platform === "win32" }, async (t) => {
  const { dir, env, launcher } = await updateFixture(t, { unchanged: true });
  await assert.rejects(exec(process.execPath, [launcher, "update", "--json"], { env, cwd: dir }), (error) => {
    const result = JSON.parse(error.stdout);
    assert.equal(result.ok, false);
    assert.match(result.error, /still runs 0\.1\.0.*expected 99\.0\.0/);
    return true;
  });
});

test("GitHub updates install the verified package file through npm in the same shell", { skip: process.platform === "win32" }, async (t) => {
  const { dir, env, calls } = await updateFixture(t, { github: true });
  const { stdout } = await exec("bash", ["-c", "scormplayer --version; hash scormplayer; scormplayer update --json || exit $?; scormplayer --version"], { env, cwd: dir });
  const [before, update, after] = stdout.trim().split("\n");
  assert.equal(before, "0.1.0");
  assert.equal(JSON.parse(update).source, "github");
  assert.equal(after, "99.0.0");
  const file = JSON.parse(fs.readFileSync(calls))[0].at(-1);
  assert.equal(path.basename(file), releaseFilename("99.0.0"));
  assert.equal(fs.existsSync(path.dirname(file)), false, "temporary download removed after installation");
});

test("a GitHub checksum failure preserves the installed CLI and never runs npm", { skip: process.platform === "win32" }, async (t) => {
  const { dir, env, calls, launcher } = await updateFixture(t, { github: true, corrupt: true });
  await assert.rejects(exec(process.execPath, [launcher, "update", "--json"], { env, cwd: dir }), (error) => {
    assert.match(JSON.parse(error.stdout).error, /checksum did not match/);
    return true;
  });
  assert.equal(fs.existsSync(calls), false);
  assert.equal((await exec(launcher, ["--version"], { env })).stdout.trim(), "0.1.0");
});

test("a GitHub download outage falls back to the same exact release on npm", { skip: process.platform === "win32" }, async (t) => {
  const { dir, env, calls, launcher } = await updateFixture(t, { github: true, unavailable: true });
  const { stdout } = await exec(launcher, ["update", "--json"], { env, cwd: dir });
  const result = JSON.parse(stdout);
  assert.equal(result.source, "npm");
  assert.equal(result.to, "99.0.0");
  assert.match(JSON.parse(fs.readFileSync(calls))[0].at(-1), /^https:\/\/registry\.npmjs\.org\/.+scormplayer-99\.0\.0\.tgz$/);
});
