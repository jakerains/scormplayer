import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { buildSkillCatalog } from "../skill-catalog.mjs";
import { client } from "./helpers.mjs";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scorm skill spaces "));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

test("bundled skills expose complete verified content and the same fallback guide to older hosts", async (t) => {
  const dir = fixture(t);
  const installed = path.join(dir, "installed");
  fs.mkdirSync(installed);
  for (const name of ["server.mjs", "review.html", "skills.json"]) fs.copyFileSync(fileURLToPath(new URL(`../dist/${name}`, import.meta.url)), path.join(installed, name));
  const rpc = client(path.join(installed, "server.mjs"), path.join(dir, "registry"), dir);
  t.after(() => rpc.close());
  const init = await rpc.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "plain-client", version: "1" } });
  assert.equal(init.error, undefined);
  assert.equal(init.result.protocolVersion, "2025-06-18", "do not claim a newer base protocol");
  assert.deepEqual(init.result.capabilities.extensions["io.modelcontextprotocol/skills"], {});
  assert.ok(init.result.capabilities.resources);
  assert.match(init.result.instructions, /scormplayer_get_review_guide/);
  rpc.notify("notifications/initialized");
  const listing = await rpc.request("skills/list");
  assert.equal(listing.error, undefined);
  assert.equal(listing.result.resultType, "complete");
  assert.equal(listing.result.cacheScope, "public");
  assert.ok(listing.result.ttlMs > 0);
  assert.equal(listing.result.nextCursor, undefined);
  assert.deepEqual(listing.result.skills.map((item) => item.frontmatter.name).sort(), ["scormplayer", "scormplayer-qa", "scormplayer-review"]);
  const resources = (await rpc.request("resources/list")).result.resources;
  assert.ok(resources.some((item) => item.uri === "ui://scormplayer/pin-checklist.html"));
  const bodies = new Map();
  for (const entry of listing.result.skills) {
    assert.deepEqual((await rpc.request("skills/get", { uri: entry.uri })).result.skill, entry);
    assert.ok(entry.resources.some((file) => file.uri === entry.uri));
    for (const file of entry.resources) {
      const response = await rpc.request("resources/read", { uri: file.uri });
      assert.equal(response.error, undefined);
      const content = response.result.contents[0];
      const bytes = content.text !== undefined ? Buffer.from(content.text, "utf8") : Buffer.from(content.blob, "base64");
      assert.equal(bytes.length, file.size);
      assert.equal(digest(bytes), file.digest);
      bodies.set(file.uri, bytes.toString("utf8"));
      assert.ok(resources.some((item) => item.uri === file.uri));
    }
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(bodies.get(entry.uri));
    assert.deepEqual(entry.frontmatter, parse(frontmatter[1]), "every authored YAML field passes through unchanged");
  }
  const packageVersion = JSON.parse(fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version;
  assert.equal(listing.result.skills.find((item) => item.frontmatter.name === "scormplayer").frontmatter.metadata.version, packageVersion);
  const tools = (await rpc.request("tools/list")).result.tools;
  assert.equal(tools.find((item) => item.name === "scormplayer_get_review_guide").annotations.readOnlyHint, true);
  const getGuide = () => rpc.request("tools/call", { name: "scormplayer_get_review_guide", arguments: {} });
  const guide = (await getGuide()).result;
  assert.equal(guide.content[0].text, bodies.get("skill://scormplayer-review/SKILL.md"));
  assert.equal(guide.structuredContent.digest, digest(Buffer.from(guide.content[0].text)));
  assert.deepEqual((await rpc.request("tools/call", { name: "scormplayer_list_players", arguments: {} })).result.structuredContent.players, []);
  for (const uri of ["skill://missing/SKILL.md", "skill://scormplayer-review/../scormplayer/SKILL.md", "skill://scormplayer-review/%2e%2e/package.json", "file:///etc/passwd"]) {
    assert.equal((await rpc.request("skills/get", { uri })).error.code, -32602);
    assert.equal((await rpc.request("resources/read", { uri })).error.code, -32602);
  }
  assert.equal((await rpc.request("skills/get", {})).error.code, -32602);
  assert.equal((await rpc.request("skills/list", { cursor: "invented" })).error.code, -32602);
  assert.equal((await rpc.request("resources/directory/read", { uri: "skill://scormplayer-review" })).error.code, -32601, "directory reads are not advertised");
  fs.rmSync(path.join(installed, "skills.json"));
  assert.deepEqual((await rpc.request("skills/list")).result, listing.result, "running server retains an immutable catalog");
  assert.deepEqual((await getGuide()).result, guide);
});

test("skill catalog preserves YAML metadata and manifests nested binary and UTF-8 bytes", (t) => {
  const dir = fixture(t);
  const root = path.join(dir, "sample");
  fs.mkdirSync(path.join(root, "references"), { recursive: true });
  const authored = '---\nname: sample\ndescription: A test skill\nlicense: MIT\nmetadata:\n  version: "01"\n  nested: [a, b]\n---\n\nCafé\n';
  fs.writeFileSync(path.join(root, "SKILL.md"), authored);
  fs.writeFileSync(path.join(root, "references", "some bytes.bin"), Buffer.from([0, 255, 3, 128]));
  fs.writeFileSync(path.join(root, "references", "BOM.txt"), Buffer.from("\ufefftext"));
  const catalog = buildSkillCatalog([root], "test");
  assert.equal(catalog.skills[0].resources.length, 3);
  assert.deepEqual(catalog.skills[0].frontmatter.metadata, { version: "01", nested: ["a", "b"] });
  const binary = catalog.files.find((file) => file.uri.endsWith("some%20bytes.bin"));
  assert.equal(binary.mimeType, "application/octet-stream");
  assert.deepEqual(Buffer.from(binary.blob, "base64"), Buffer.from([0, 255, 3, 128]));
  for (const file of catalog.files) {
    const bytes = Buffer.from(file.blob, "base64");
    assert.equal(bytes.length, file.size);
    assert.equal(digest(bytes), file.digest);
  }
  fs.symlinkSync(path.join(root, "SKILL.md"), path.join(root, "linked.md"));
  assert.throws(() => buildSkillCatalog([root], "test"), /regular files/);
});

test("an inconsistent packaged digest fails before a server advertises skills", async (t) => {
  const dir = fixture(t);
  for (const name of ["server.mjs", "review.html", "skills.json"]) fs.copyFileSync(fileURLToPath(new URL(`../dist/${name}`, import.meta.url)), path.join(dir, name));
  const file = path.join(dir, "skills.json");
  const catalog = JSON.parse(fs.readFileSync(file, "utf8"));
  catalog.files[0].blob = Buffer.from("replaced bytes").toString("base64");
  fs.writeFileSync(file, JSON.stringify(catalog));
  const rpc = client(path.join(dir, "server.mjs"), path.join(dir, "registry"), dir);
  t.after(() => rpc.close());
  await assert.rejects(rpc.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } }), /Invalid skill content/);
});
