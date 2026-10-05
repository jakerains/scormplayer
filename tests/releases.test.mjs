import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { downloadRelease, githubRelease, RELEASES_API, releaseFilename } from "../server/releases.mjs";
import { checkForUpdate, fetchUpdate } from "../server/update.mjs";

function fixture({ version = "9.0.0", npmVersion = version, npmReady = false, incomplete = false, unavailable = false, corrupt = false, kind = "npm", prerelease = false } = {}) {
  const filename = releaseFilename(version, kind);
  const base = `https://github.com/jakerains/scormplayer/releases/download/v${version}`;
  const bytes = Buffer.from("packed and tested release");
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET" });
    if (url === RELEASES_API) return unavailable ? new Response(null, { status: 403 }) : Response.json({ tag_name: `v${version}`, draft: false, prerelease, assets: (incomplete ? [] : [filename, "SHA256SUMS"]).map((name) => ({ name, state: "uploaded", browser_download_url: `${base}/${name}` })) });
    if (url === `${base}/SHA256SUMS`) return new Response(`${checksum}  ${filename}\n`);
    if (url === `${base}/${filename}`) return new Response(options.method === "HEAD" ? null : corrupt ? "damaged download" : bytes);
    if (url.startsWith("https://registry.npmjs.org/")) return options.method === "HEAD" ? new Response(null, { status: npmReady && url.includes(`scormplayer-${npmVersion}.tgz`) ? 200 : 404 }) : Response.json({ version: npmVersion });
    throw new Error(`Unexpected URL: ${url}`);
  };
  return { bytes, calls, fetchImpl };
}

test("GitHub's complete stable release is ready even while npm is still propagating", async () => {
  const { fetchImpl, calls } = fixture({ npmVersion: "8.8.0" });
  const release = await fetchUpdate({ fetchImpl });
  assert.equal(release.version, "9.0.0");
  assert.equal(release.source, "github");
  assert.equal(release.ready, true);
  assert.equal(calls.some((call) => call.url.startsWith("https://registry.npmjs.org/")), false);
});

test("GitHub outages and older releases without npm assets can use npm", async () => {
  for (const options of [{ unavailable: true }, { incomplete: true }]) {
    const release = await fetchUpdate({ fetchImpl: fixture({ ...options, npmReady: true }).fetchImpl });
    assert.equal(release.source, "npm");
    assert.equal(release.version, "9.0.0");
    assert.equal(release.ready, true);
  }
});

test("incomplete GitHub releases never silently downgrade to an older npm version", async () => {
  const release = await fetchUpdate({ fetchImpl: fixture({ incomplete: true, npmVersion: "8.8.0", npmReady: true }).fetchImpl });
  assert.equal(release.version, "9.0.0");
  assert.equal(release.ready, false);
});

test("standalone discovery never promises to install npm's package format", async () => {
  const release = await fetchUpdate({ kind: "standalone", fetchImpl: fixture({ incomplete: true, npmReady: true, kind: "standalone" }).fetchImpl });
  assert.equal(release.version, "9.0.0");
  assert.equal(release.ready, false);
});

test("an incomplete GitHub release can use its exact npm version despite an older latest tag", async () => {
  const old = fixture({ incomplete: true, npmVersion: "8.8.0" });
  const release = await fetchUpdate({ fetchImpl: (url, options) => options?.method === "HEAD" && url.includes("scormplayer-9.0.0.tgz") ? new Response(null) : old.fetchImpl(url, options) });
  assert.equal(release.version, "9.0.0");
  assert.equal(release.source, "npm");
  assert.equal(release.ready, true);
});

test("cached unavailable releases recheck downloads without rediscovering GitHub each launch", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scorm-release-pending-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = Date.now();
  fs.writeFileSync(path.join(dir, "update-check.json"), JSON.stringify({ checkedAt: now, release: { version: "9.0.0", source: "github", kind: "npm", ready: false, asset: null } }));
  const saved = Object.fromEntries(["CI", "SCORMPLAYER_NO_UPDATE_CHECK", "NO_UPDATE_NOTIFIER"].map((name) => [name, process.env[name]]));
  for (const name of Object.keys(saved)) delete process.env[name];
  t.after(() => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const unavailable = fixture({ npmReady: false });
  assert.equal(await checkForUpdate({ current: "8.8.0", cacheDir: dir, now, fetchImpl: unavailable.fetchImpl }), null);
  const available = fixture({ npmReady: true });
  assert.equal(await checkForUpdate({ current: "8.8.0", cacheDir: dir, now, fetchImpl: available.fetchImpl }), "9.0.0");
  assert.equal([...unavailable.calls, ...available.calls].some((call) => call.url === RELEASES_API), false);
});

test("prereleases and untrusted asset URLs are excluded from GitHub update downloads", async () => {
  await assert.rejects(githubRelease({ fetchImpl: fixture({ prerelease: true }).fetchImpl }), /no stable/);
  const release = await githubRelease({ fetchImpl: async () => Response.json({ tag_name: "v9.0.0", draft: false, prerelease: false, assets: [{ name: releaseFilename("9.0.0"), state: "uploaded", browser_download_url: "https://elsewhere.example/download" }] }) });
  assert.equal(release.ready, false);
  assert.equal(release.asset, null);
});

test("verified downloads preserve the exact package bytes and refuse corrupted packages", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scorm-release-download-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const good = fixture();
  const release = await githubRelease({ fetchImpl: good.fetchImpl });
  const file = await downloadRelease(release, dir, { fetchImpl: good.fetchImpl });
  assert.deepEqual(fs.readFileSync(file), good.bytes);
  fs.unlinkSync(file);
  await assert.rejects(downloadRelease(release, dir, { fetchImpl: fixture({ corrupt: true }).fetchImpl }), (error) => error.code === "checksum_mismatch");
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("automatic GitHub checks cache discovery and respect update-notice opt-outs", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scorm-release-cache-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const saved = Object.fromEntries(["CI", "SCORMPLAYER_NO_UPDATE_CHECK", "NO_UPDATE_NOTIFIER"].map((name) => [name, process.env[name]]));
  for (const name of Object.keys(saved)) delete process.env[name];
  t.after(() => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const { calls, fetchImpl } = fixture();
  const options = { current: "8.8.0", cacheDir: dir, now: Date.now(), fetchImpl };
  assert.equal(await checkForUpdate(options), "9.0.0");
  assert.equal(await checkForUpdate(options), "9.0.0");
  assert.equal(calls.filter((call) => call.url === RELEASES_API).length, 1);
  assert.equal(await checkForUpdate({ ...options, now: options.now + 86400001 }), "9.0.0");
  assert.equal(calls.filter((call) => call.url === RELEASES_API).length, 2);
  process.env.NO_UPDATE_NOTIFIER = "1";
  const before = calls.length;
  assert.equal(await checkForUpdate(options), null);
  assert.equal(calls.length, before);
});
