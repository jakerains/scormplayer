import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { MANIFEST_12 } from "./fixtures.mjs";
import { RELEASES_API } from "../server/releases.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const artifacts = path.join(root, "artifacts", "standalone");
const asset = `scormplayer-${version}-standalone.tar.gz`;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "scorm bash install spaces "));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const files = new Map([[`/v${version}/${asset}`, fs.readFileSync(path.join(artifacts, asset))], [`/v${version}/SHA256SUMS`, fs.readFileSync(path.join(artifacts, "SHA256SUMS"))]]);
  const server = http.createServer((req, res) => { const bytes = files.get(req.url); res.writeHead(bytes ? 200 : 404); res.end(bytes); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const env = { ...process.env, HOME: home, SHELL: "/bin/bash", SCORMPLAYER_VERSION: `v${version}`, SCORMPLAYER_RELEASE_BASE_URL: `http://127.0.0.1:${server.address().port}`, SCORMPLAYER_INSTALL_DIR: path.join(home, "private install"), SCORMPLAYER_BIN_DIR: path.join(home, "my bin"), SCORMPLAYER_NODE: process.execPath, SCORMPLAYER_REGISTRY_DIR: path.join(home, "registry"), SCORMPLAYER_NO_UPDATE_CHECK: "1", CI: "1" };
  const catalog = path.join(home, "release.json");
  const setReleaseVersion = (latest) => {
    const names = [`scormplayer-${latest}-standalone.tar.gz`, "SHA256SUMS"];
    fs.writeFileSync(catalog, JSON.stringify({ tag_name: `v${latest}`, draft: false, prerelease: false, assets: names.map((name) => ({ name, state: "uploaded", browser_download_url: `https://github.com/jakerains/scormplayer/releases/download/v${latest}/${name}` })) }));
  };
  setReleaseVersion(version);
  const preload = path.join(home, "release-fetch.mjs");
  fs.writeFileSync(preload, `import fs from "node:fs";
const original = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (url === ${JSON.stringify(RELEASES_API)}) return Response.json(JSON.parse(fs.readFileSync(${JSON.stringify(catalog)},"utf8")));
  const prefix = "https://github.com/jakerains/scormplayer/releases/download";
  if (String(url).startsWith(prefix)) return original(${JSON.stringify(env.SCORMPLAYER_RELEASE_BASE_URL)}+String(url).slice(prefix.length),options);
  if (String(url).startsWith("https://registry.npmjs.org/")) throw new Error("npm is unavailable in this standalone test");
  return original(url,options);
};`);
  env.NODE_OPTIONS = `--import=${JSON.stringify(preload)}`;
  return { home, files, env, setReleaseVersion, launcher: path.join(env.SCORMPLAYER_BIN_DIR, "scormplayer"), install: () => exec("bash", [path.join(root, "install.sh")], { env, cwd: home }) };
}

test("Bash installs without npm, preserves profiles, opens the current course folder and carries MCP", async (t) => {
  const fixture_ = await fixture(t);
  const { home, env, launcher, install } = fixture_;
  fs.writeFileSync(path.join(home, ".bashrc"), "# existing preferences\n");
  await install();
  await install();
  const profile = fs.readFileSync(path.join(home, ".bashrc"), "utf8");
  assert.match(profile, /^# existing preferences/);
  assert.equal(profile.split("# SCORM Player user commands").length, 2, "PATH added once");
  const result = JSON.parse((await exec(launcher, ["--version", "--json"], { env, cwd: home })).stdout);
  assert.equal(result.version, version);
  const fallback = JSON.parse((await exec(launcher, ["update", "--json"], { env, cwd: home })).stdout);
  assert.equal(fallback.method, "standalone");
  assert.equal(fallback.source, "github");
  assert.equal(fallback.updateAvailable, false);
  const setup = JSON.parse((await exec(launcher, ["setup", "--app", "claude-desktop", "--json"], { env, cwd: home })).stdout);
  assert.equal(setup.results[0].skills, "bundled");
  const course = path.join(home, "current course");
  fs.mkdirSync(course);
  fs.writeFileSync(path.join(course, "imsmanifest.xml"), MANIFEST_12("Standalone course"));
  fs.writeFileSync(path.join(course, "index.html"), "<h1>Standalone course</h1><p>Original source text for a pin</p>");
  const child = spawn(launcher, ["--json", "--no-open", "--port", "0"], { env, cwd: course });
  t.after(() => child.kill("SIGTERM"));
  let stdout = "", stderr = "";
  child.stderr.on("data", (bytes) => { stderr += bytes; });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No player: ${stderr} ${stdout}`)), 10000);
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`Player exited ${code}: ${stderr} ${stdout}`)); });
    child.stdout.on("data", (bytes) => {
      stdout += bytes;
      for (const line of stdout.trim().split("\n")) {
        try { const data = JSON.parse(line); if (data.event === "ready") { clearTimeout(timer); resolve(data); } } catch { /* wait for a complete line */ }
      }
    });
  });
  assert.equal((await fetch(ready.url)).status, 200);
  const info = await (await fetch(`${ready.url}api/course`)).json();
  assert.equal(info.kind, "folder");
  assert.equal(fs.realpathSync(info.source), fs.realpathSync(course));
  const pin = await fetch(`${ready.url}api/pins`, { method: "POST", headers: { "content-type": "application/json", origin: new URL(ready.url).origin, "x-scormplayer-revision": info.revision }, body: JSON.stringify({ note: "Review", target: { name: "Original source text for a pin", text: "Original source text for a pin", selector: "p" } }) });
  assert.equal(pin.status, 201);
  let sources = [];
  for (let i = 0; i < 40 && !sources.length; i++) { sources = (await (await fetch(`${ready.url}api/pins`)).json()).pins[0].source ?? []; if (!sources.length) await new Promise((resolve) => setTimeout(resolve, 50)); }
  assert.ok(sources.some((item) => item.file === "index.html"), "bundled source worker enriches pins");
});

test("standalone update uses GitHub without npm and keeps the same cached shell command", async (t) => {
  const { home, files, env, install, setReleaseVersion } = await fixture(t);
  await install();
  const parts = version.split(".").map(Number);
  parts[2] += 1;
  const next = parts.join(".");
  const work = path.join(home, "updated-bundle");
  fs.mkdirSync(work);
  execFileSync("tar", ["-xzf", path.join(artifacts, asset), "-C", work]);
  const packageFile = path.join(work, "scormplayer/package.json");
  const pkg = JSON.parse(fs.readFileSync(packageFile, "utf8"));
  pkg.version = next;
  fs.writeFileSync(packageFile, JSON.stringify(pkg));
  const file = path.join(home, "updated.tar.gz");
  execFileSync("tar", ["-czf", file, "-C", work, "scormplayer"]);
  const bytes = fs.readFileSync(file);
  const name = `scormplayer-${next}-standalone.tar.gz`;
  files.set(`/v${next}/${name}`, bytes);
  files.set(`/v${next}/SHA256SUMS`, Buffer.from(`${sha(bytes)}  ${name}\n`));
  setReleaseVersion(next);
  const shellEnv = { ...env, PATH: `${env.SCORMPLAYER_BIN_DIR}${path.delimiter}${process.env.PATH}` };
  const { stdout } = await exec("bash", ["-c", "scormplayer --version; hash scormplayer; scormplayer update --json || exit $?; scormplayer --version"], { env: shellEnv, cwd: home });
  const [before, updated, after] = stdout.trim().split("\n");
  assert.equal(before, version);
  assert.deepEqual(JSON.parse(updated), { ok: true, from: version, to: next, method: "standalone", source: "github", skill: "bundled" });
  assert.equal(after, next);
  assert.equal(fs.readdirSync(path.join(env.SCORMPLAYER_INSTALL_DIR, "versions")).length, 2, "previous bundle retained");
});

test("Bash refuses damaged downloads and preserves an unrelated launcher", async (t) => {
  const { files, launcher, env, install } = await fixture(t);
  files.set(`/v${version}/${asset}`, Buffer.from("damaged download"));
  await assert.rejects(install(), (error) => /Checksum mismatch/.test(error.stderr));
  assert.equal(fs.existsSync(launcher), false);
  fs.mkdirSync(env.SCORMPLAYER_BIN_DIR, { recursive: true });
  fs.writeFileSync(launcher, "#!/bin/bash\necho custom\n");
  await assert.rejects(install(), (error) => /already exists and was preserved/.test(error.stderr));
  assert.match(fs.readFileSync(launcher, "utf8"), /echo custom/);
});

test("Bash downloads and verifies a private Node runtime when Node is unavailable", async (t) => {
  const { home, files, env, launcher, install } = await fixture(t);
  const folder = `node-v24.0.0-${process.platform}-${process.arch}`;
  const runtime = path.join(home, "node-fixture", folder, "bin");
  fs.mkdirSync(runtime, { recursive: true });
  fs.copyFileSync(process.execPath, path.join(runtime, "node"));
  fs.chmodSync(path.join(runtime, "node"), 0o755);
  const tarball = path.join(home, "node.tar.gz");
  execFileSync("tar", ["-czf", tarball, "-C", path.dirname(path.dirname(runtime)), folder]);
  const bytes = fs.readFileSync(tarball);
  files.set("/latest-v24.x/SHASUMS256.txt", Buffer.from(`${sha(bytes)}  ${folder}.tar.gz\n`));
  files.set(`/v24.0.0/${folder}.tar.gz`, bytes);
  env.SCORMPLAYER_NODE = path.join(home, "missing-node");
  env.SCORMPLAYER_NODE_BASE_URL = env.SCORMPLAYER_RELEASE_BASE_URL;
  await install();
  assert.match(fs.readFileSync(launcher, "utf8"), /runtime\/node-v24/);
  assert.equal(JSON.parse((await exec(launcher, ["--version", "--json"], { env })).stdout).version, version);
});
