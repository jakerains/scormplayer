import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startPlayer } from "../../../server/index.mjs";
import { multiScoZip } from "../../../tests/fixtures.mjs";
import { client } from "./helpers.mjs";

test("an agent QA pass over stdio MCP drives the review tab, suggests pins and writes the log", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scorm-mcp-qa-"));
  const registry = path.join(dir, "registry");
  const zip = path.join(dir, "course.zip");
  fs.writeFileSync(zip, multiScoZip());
  process.env.SCORMPLAYER_STANDARDS_DIR = path.join(dir, "standards");
  const player = await startPlayer({ input: zip, port: 0, registryDir: registry, cacheDir: path.join(dir, "cache") });
  const rpc = client(fileURLToPath(new URL("../dist/server.mjs", import.meta.url)), registry, dir);
  const browser = await chromium.launch();
  try {
    await rpc.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "qa-agent", version: "1" } });
    rpc.notify("notifications/initialized");
    const call = async (name, args) => {
      const response = await rpc.request("tools/call", { name, arguments: args });
      assert.equal(response.error, undefined, JSON.stringify(response.error));
      return response.result;
    };
    const guide = await call("scormplayer_get_review_guide", { name: "qa" });
    assert.match(guide.content[0].text, /# Agent QA pass with SCORM Player/);

    const playerId = `${process.pid}:${new URL(player.url).port}`;
    const status = await call("scormplayer_get_status", { playerId });
    const scope = { playerId, revision: status.structuredContent.revision };
    const refused = await call("scormplayer_qa_start", { ...scope, agent: "Test agent" });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /No review tab is connected/);

    // Build the QA standard first: none yet, scan for a proposal, save it as a shared standard this project uses.
    assert.equal((await call("scormplayer_qa_standard", scope)).structuredContent.missing, true);
    const scan = await call("scormplayer_qa_standard_scan", scope);
    assert.equal(scan.isError, undefined, scan.content?.[0]?.text);
    assert.ok(scan.structuredContent.findings.headings.count >= 1);
    const saved = await call("scormplayer_qa_standard_save", { ...scope, target: "shared", name: "test-house", use: true, standard: { ...scan.structuredContent.proposal, audience: "New staff", rules: [{ id: "name-the-topic", rule: "Headings name what the page teaches.", category: "copy", severity: "minor" }] } });
    assert.equal(saved.isError, undefined, saved.content?.[0]?.text);
    assert.equal(saved.structuredContent.effective.sources[0].name, "test-house");

    const page = await browser.newPage({ viewport: { width: 1300, height: 820 } });
    await page.goto(player.url);
    await page.frameLocator("iframe.sp-frame").locator("h1", { hasText: "Module 1" }).waitFor();
    await page.waitForFunction(async () => (await (await fetch("/api/browser/sessions")).json()).sessions.some((s) => s.ready));

    const started = await call("scormplayer_qa_start", { ...scope, agent: "Test agent" });
    assert.equal(started.isError, undefined, started.content?.[0]?.text);
    const { run, course, position, rubric, standardMissing } = started.structuredContent;
    assert.equal(standardMissing, false);
    assert.equal(rubric.audience, "New staff");
    assert.equal(rubric.rules[0].id, "name-the-topic");
    assert.deepEqual(course.modules.map((module) => module.title), ["Module 1", "Module 2", "Module 3"]);
    assert.deepEqual(position.module, { index: 0, of: 3, title: "Module 1" });
    const runScope = { ...scope, runId: run.id };

    const snapshot = await call("scormplayer_qa_snapshot", { ...runScope, screenshot: true });
    assert.equal(snapshot.isError, undefined, snapshot.content?.[0]?.text);
    assert.deepEqual(snapshot.structuredContent.page.headings, [{ level: 1, text: "Module 1", selector: "h1" }]);
    assert.ok(Array.isArray(snapshot.structuredContent.accessibility));
    assert.equal(snapshot.content[1].type, "image");

    const suggested = await call("scormplayer_qa_suggest", { ...runScope, note: "The heading only says \"Module 1\"; name what the module teaches.", selector: "h1", category: "copy", severity: "minor", evidence: "\"Module 1\"" });
    assert.equal(suggested.isError, undefined, suggested.content?.[0]?.text);
    assert.equal(suggested.structuredContent.outcome, "created");
    assert.equal(suggested.structuredContent.status, "suggested");
    // The reviewer sees it in their tab straight away.
    await page.waitForFunction(async () => (await (await fetch("/api/pins")).json()).pins.some((pin) => pin.status === "suggested"));
    const logged = await call("scormplayer_qa_log_page", { ...runScope, status: "reviewed", notes: "Heading and body read" });
    assert.equal(logged.structuredContent.stop, false);

    const moved = await call("scormplayer_qa_go", { ...runScope, next: true });
    assert.equal(moved.structuredContent.reached, true);
    assert.equal(moved.structuredContent.position.module.title, "Module 2");
    await page.frameLocator("iframe.sp-frame").locator("h1", { hasText: "Module 2" }).waitFor();
    await call("scormplayer_qa_log_page", { ...runScope, status: "unreachable", notes: "Pretend gate" });

    const finished = await call("scormplayer_qa_finish", { ...runScope, summary: "Two modules checked; one heading to rename." });
    assert.equal(finished.isError, undefined, finished.content?.[0]?.text);
    assert.equal(finished.structuredContent.run.state, "finished");
    assert.equal(finished.structuredContent.suggestions.length, 1);
    assert.deepEqual(finished.structuredContent.suggestions[0].where, { module: "Module 1", page: "Module 1", pageIndex: null });
    const log = fs.readFileSync(finished.structuredContent.logFile, "utf8");
    assert.match(log, /Coverage: 1 reviewed, 0 skipped, 1 unreachable/);
    assert.match(log, /Two modules checked; one heading to rename\./);

    const id = finished.structuredContent.suggestions[0].id;
    const triaged = await call("scormplayer_triage_suggestions", { ...scope, ids: [id], action: "accept" });
    assert.equal(triaged.structuredContent.pins[0].status, "open");
    const handoff = await call("scormplayer_get_handoff", scope);
    assert.match(handoff.structuredContent.markdown, /Origin: agent QA suggestion by Test agent/);
    const cleared = await call("scormplayer_clear_qa_pins", scope);
    assert.equal(cleared.structuredContent.removed, 0, "accepted suggestions stay");
  } finally { delete process.env.SCORMPLAYER_STANDARDS_DIR; await browser.close(); rpc.close(); await player.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
