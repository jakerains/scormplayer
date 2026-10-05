import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { MANIFEST_12 } from "./fixtures.mjs";
import { updateHint } from "../server/update.mjs";

const entry = fileURLToPath(new URL("../bin/scormplayer.mjs", import.meta.url));

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
