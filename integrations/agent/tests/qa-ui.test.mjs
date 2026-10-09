import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "../../../node_modules/playwright/index.mjs";
import { client } from "./helpers.mjs";

// The QA suggestions checklist in a fixture MCP Apps host (as ui.test.mjs does for pins).
let resourcePromise;
function resource() {
  return resourcePromise ??= (async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scorm-qa-resource-"));
    const rpc = client(fileURLToPath(new URL("../dist/server.mjs", import.meta.url)), path.join(dir, "registry"), dir);
    try {
      await rpc.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "UI test", version: "1" } });
      rpc.notify("notifications/initialized");
      const tools = (await rpc.request("tools/list")).result.tools;
      const finish = tools.find((tool) => tool.name === "scormplayer_qa_finish");
      const listing = tools.find((tool) => tool.name === "scormplayer_qa_suggestions");
      assert.equal(finish._meta.ui.resourceUri, "ui://scormplayer/qa-suggestions.html");
      assert.equal(listing._meta.ui.resourceUri, finish._meta.ui.resourceUri);
      return (await rpc.request("resources/read", { uri: finish._meta.ui.resourceUri })).result.contents[0].text;
    } finally { rpc.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  })();
}

const suggestion = (id, number, severity, note, where, extra = {}) => ({
  id, number, status: "suggested", note, category: "copy", severity, evidence: `"${note.split(" ")[0]}"`,
  where, target: "Heading", alsoOn: [], hasScreenshot: false, ...extra,
});
const snapshot = {
  playerId: "test:4620", revision: "r1", title: "Safety basics", logFile: "/courses/safety.qa-log.md",
  run: { id: "qa-1", agent: "Test agent", state: "finished", pages: [{ status: "reviewed" }, { status: "reviewed" }, { status: "unreachable" }], summary: "Done." },
  suggestions: [
    suggestion("s1", 1, "minor", "Typo: Welcom should be Welcome.", { module: "Module 1", page: "Intro", pageIndex: 0 }, { hasScreenshot: true, alsoOn: [{ title: "Summary" }] }),
    suggestion("s2", 2, "major", "The quiz feedback names the wrong answer.", { module: "Module 2", page: "Quiz", pageIndex: 3 }, { category: "content" }),
    suggestion("s3", 3, "polish", "Shorten this paragraph.", { module: "Module 2", page: "Quiz", pageIndex: 3 }),
  ],
};

async function host(engine, capabilities = { serverTools: {}, message: {} }) {
  const browser = await engine.launch();
  const page = await browser.newPage({ viewport: { width: 560, height: 640 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("http://127.0.0.1:49998/", (route) => route.fulfill({ contentType: "text/html", body: '<body style="margin:0"><iframe id="app" style="width:100%;height:100vh;border:0"></iframe></body>' }));
  await page.goto("http://127.0.0.1:49998/");
  await page.evaluate(({ html, snapshot, capabilities }) => {
    window.calls = [];
    window.qa = structuredClone(snapshot);
    const frame = document.querySelector("#app");
    const spec = () => ({ root: "qa", elements: {
      qa: { type: "QaLayout", props: {}, children: ["summary", "list", "actions"] },
      summary: { type: "QaSummary", props: {}, children: [] },
      list: { type: "QaList", props: {}, children: [] },
      actions: { type: "QaActions", props: {}, children: [] },
    }, state: { suggestions: window.qa } });
    const data = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
    window.addEventListener("message", (event) => {
      if (event.source !== frame.contentWindow || event.data?.jsonrpc !== "2.0") return;
      const { method, id, params } = event.data;
      window.calls.push({ method, params });
      const reply = (result) => frame.contentWindow.postMessage({ jsonrpc: "2.0", id, result }, "*");
      if (method === "ui/initialize") reply({ protocolVersion: "2026-01-26", hostInfo: { name: "Test host", version: "1" }, hostCapabilities: capabilities, hostContext: { theme: "light", displayMode: "inline" } });
      else if (method === "ui/notifications/initialized") frame.contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: data({ ...window.qa, spec: spec() }) }, "*");
      else if (method === "tools/call") {
        const args = params.arguments;
        if (params.name === "scormplayer_qa_suggestions") reply(data({ ...window.qa, spec: spec() }));
        else if (params.name === "scormplayer_triage_suggestions") {
          for (const item of window.qa.suggestions) if (args.ids.includes(item.id)) item.status = args.action === "accept" ? "open" : "dismissed";
          reply(data({ ok: true, pins: [] }));
        }
        else if (params.name === "scormplayer_clear_qa_pins") {
          const before = window.qa.suggestions.length;
          window.qa.suggestions = window.qa.suggestions.filter((item) => item.status === "open");
          reply(data({ ok: true, removed: before - window.qa.suggestions.length }));
        }
        else if (params.name === "scormplayer_show_pin") reply(data({ ok: true }));
        else if (params.name === "scormplayer_read_screenshot") reply({ content: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB9sAAAAASUVORK5CYII=" }] });
        else if (params.name === "scormplayer_get_handoff") reply(data({ markdown: args.ids.map((id) => window.qa.suggestions.find((item) => item.id === id).note).join("\n\n") }));
        else reply({ isError: true, content: [{ type: "text", text: "Unknown fixture tool" }] });
      } else if (method === "ui/message") reply({ isError: false });
      else if (id !== undefined) reply({});
    });
    frame.srcdoc = html;
  }, { html: await resource(), snapshot, capabilities });
  const app = page.frameLocator("#app");
  await app.getByRole("heading", { name: "3 suggestions to review", exact: true }).waitFor({ timeout: 10_000 });
  return { browser, page, app, errors };
}

for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
  test(`${name}: QA suggestions widget groups by page, triages, shows in player and clears`, async () => {
    const { browser, page, app, errors } = await host(engine);
    try {
      assert.match(await app.locator("header").innerText(), /Test agent · 2 pages reviewed, 1 not/);
      assert.deepEqual(await app.locator(".group h2").allInnerTexts(), ["Module 1 › Intro", "Module 2 › Quiz"]);
      assert.match(await app.locator("main").innerText(), /Also on Summary/);
      if (name === "chromium") {
        const output = path.resolve("../../artifacts/releases");
        fs.mkdirSync(output, { recursive: true });
        await app.locator("main").screenshot({ path: path.join(output, "qa-widget.png") });
      }
      await app.getByRole("button", { name: "Screenshot" }).click();
      await app.getByRole("img", { name: "Screenshot for suggestion 1" }).waitFor();
      await app.getByRole("button", { name: "Show in player ↗" }).first().click();
      await app.getByRole("status").filter({ hasText: "Showing suggestion 1 in the player." }).waitFor();
      assert.deepEqual((await page.evaluate(() => window.calls)).find((call) => call.params?.name === "scormplayer_show_pin").params.arguments, { playerId: "test:4620", revision: "r1", id: "s1" });

      await app.getByLabel("Severity").selectOption("major");
      assert.equal(await app.locator("article").count(), 1);
      await app.getByRole("button", { name: "Accept", exact: true }).click();
      await app.getByRole("status").filter({ hasText: "Accepted 1." }).waitFor();
      await app.getByLabel("Severity").selectOption("all");
      await app.getByRole("checkbox", { name: "Select suggestion 3" }).check();
      await app.getByRole("button", { name: "Dismiss", exact: true }).last().click();
      await app.getByRole("status").filter({ hasText: "Dismissed 1." }).waitFor();
      await app.getByRole("heading", { name: "1 suggestion to review", exact: true }).waitFor();

      await app.getByRole("button", { name: "Send 1 accepted to agent" }).click();
      await app.getByRole("status").filter({ hasText: "Sent to agent." }).waitFor();
      const message = (await page.evaluate(() => window.calls)).find((call) => call.method === "ui/message");
      assert.match(message.params.content[0].text, /The quiz feedback names the wrong answer\./);

      await app.getByRole("button", { name: "Clear QA pins" }).click();
      await app.getByRole("button", { name: "Click again to clear" }).click();
      await app.getByRole("status").filter({ hasText: "Cleared 2 QA suggestions. Accepted ones stay." }).waitFor();
      await app.getByRole("heading", { name: "0 suggestions to review", exact: true }).waitFor();
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}

test("without tool calls the QA widget stays readable and says how to triage", async () => {
  const { browser, app } = await host(chromium, { message: {} });
  try {
    assert.equal(await app.locator("article").count(), 3);
    await app.getByText("Buttons aren't available here.").waitFor();
    assert.equal(await app.getByRole("button", { name: "Accept", exact: true }).first().isDisabled(), true);
  } finally { await browser.close(); }
});
