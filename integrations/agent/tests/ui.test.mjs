import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "../../../node_modules/playwright/index.mjs";
import { client } from "./helpers.mjs";

// The shipped resource uses the standard MCP Apps contract. This fixture host
// does not establish a particular desktop host's support.
let resourcePromise;
function resource() {
  return resourcePromise ??= (async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scorm-review-resource-"));
    const rpc = client(fileURLToPath(new URL("../dist/server.mjs", import.meta.url)), path.join(dir, "registry"), dir);
    try {
      await rpc.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "UI test", version: "1" } });
      rpc.notify("notifications/initialized");
      const tools = (await rpc.request("tools/list")).result.tools;
      const pins = tools.find((tool) => tool.name === "scormplayer_list_pins");
      return (await rpc.request("resources/read", { uri: pins._meta.ui.resourceUri })).result.contents[0].text;
    } finally { rpc.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  })();
}
const snapshot = {
  playerId: "test:4620", revision: "r1", title: "Course review", kind: "live",
  source: "/courses/lesson", pinsFile: "/courses/lesson.pins.json", url: "http://127.0.0.1:4620/", lastChangeAt: null,
  pins: [
    { id: "p1", number: 1, status: "open", note: "The diagram label overlaps its button.", page: { title: "Architecture", url: "http://127.0.0.1:4620/course/architecture" }, target: { selector: "#diagram", name: "Diagram" }, source: [{ file: "src/architecture.tsx", line: 42, preview: "<Diagram title=\"Architecture\" />" }], frame: "p1.png" },
    { id: "p2", number: 2, status: "open", note: "Clarify the completion instruction.", page: { title: "Practice", url: "http://127.0.0.1:4620/course/practice" } },
    { id: "p3", number: 3, status: "resolved", note: "Increase the contrast of the heading.", resolution: "Checked the heading in the desktop and tablet player.", page: { title: "Overview" } },
  ],
};
async function host(engine, capabilities = { serverTools: {}, message: {} }, initial = snapshot) {
  const browser = await engine.launch();
  const page = await browser.newPage({ viewport: { width: 540, height: 520 } });
  const errors = [], requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => requests.push(request.url()));
  await page.route("http://127.0.0.1:49999/", (route) => route.fulfill({ contentType: "text/html", body: '<body style="margin:0;background:#15171c"><iframe id="app" style="width:100%;height:100vh;border:0"></iframe></body>' }));
  await page.goto("http://127.0.0.1:49999/");
  await page.evaluate(({ html, snapshot, capabilities }) => {
    window.calls = [];
    window.review = structuredClone(snapshot);
    const frame = document.querySelector("#app");
    const spec = () => ({
      root: "review", elements: {
        review: { type: "ReviewLayout", props: {}, children: ["summary", "pins", "request"] },
        summary: { type: "ReviewSummary", props: {}, children: [] },
        pins: { type: "PinChecklist", props: {}, children: [] },
        request: { type: "RequestComposer", props: {}, children: [] },
      }, state: { review: window.review, filter: "open" },
    });
    const data = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
    window.addEventListener("message", (event) => {
      if (event.source !== frame.contentWindow || event.data?.jsonrpc !== "2.0") return;
      const { method, id, params } = event.data;
      window.calls.push({ method, params });
      const reply = (result) => frame.contentWindow.postMessage({ jsonrpc: "2.0", id, result }, "*");
      if (method === "ui/initialize") reply({ protocolVersion: "2026-01-26", hostInfo: { name: "Test host", version: "1" }, hostCapabilities: capabilities, hostContext: { theme: "dark", displayMode: "inline" } });
      else if (method === "ui/notifications/initialized") frame.contentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: data({ ...window.review, spec: spec() }) }, "*");
      else if (method === "tools/call") {
        const args = params.arguments;
        if (params.name === "scormplayer_get_status") {
          if (window.retiredPlayer) reply({ isError: true, content: [{ type: "text", text: "Player is no longer registered. Call scormplayer_list_players again." }] });
          else reply(data({ revision: window.review.revision }));
        }
        else if (params.name === "scormplayer_show_review") reply(data({ ...window.review, spec: spec() }));
        else if (params.name === "scormplayer_update_pin") {
          if (window.failSave) { window.failSave = false; reply({ isError: true, content: [{ type: "text", text: "The pin could not be saved." }] }); }
          else {
            const pin = window.review.pins.find((pin) => pin.id === args.id);
            for (const key of ["note", "status", "resolution"]) if (args[key] !== undefined) pin[key] = args[key];
            reply(data({ pin }));
          }
        }
        else if (params.name === "scormplayer_get_handoff") {
          const markdown = args.ids.map((id) => window.review.pins.find((pin) => pin.id === id).note).join("\n\n");
          if (window.changeDuringHandoff) window.review.pins[0].note = "Changed while building the request.";
          reply(data({ markdown }));
        }
        else if (params.name === "scormplayer_read_screenshot") reply({ content: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB9sAAAAASUVORK5CYII=" }] });
        else if (params.name === "scormplayer_open_browser") reply(data({ url: window.review.url, launched: true }));
        else reply({ isError: true, content: [{ type: "text", text: "Unknown fixture tool" }] });
      } else if (method === "ui/message") reply({ isError: Boolean(window.rejectMessage) });
      else if (id !== undefined) reply({});
    });
    frame.srcdoc = html;
  }, { html: await resource(), snapshot: initial, capabilities });
  const app = page.frameLocator("#app");
  try { await app.getByRole("heading", { name: `${initial.pins.filter(pin => pin.status === "open").length} ${initial.pins.filter(pin => pin.status === "open").length === 1 ? "pin" : "pins"} left`, exact: true }).waitFor({ timeout: 10_000 }); }
  catch (error) { console.error("Fixture calls:", await page.evaluate(() => window.calls)); console.error("Fixture text:", await app.locator("body").innerText()); await browser.close(); throw error; }
  return { browser, page, app, errors, requests };
}

for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
  test(`${name}: light widget selects open pins and sends them with one click`, async () => {
    const { browser, page, app, errors, requests } = await host(engine);
    try {
      await page.emulateMedia({ colorScheme: "dark" });
      assert.equal(await app.locator("iframe").count(), 0, "no embedded localhost lesson");
      assert.equal(await app.locator("main").evaluate(el => getComputedStyle(el).backgroundColor), "rgb(255, 255, 255)", "stays light in a dark host");
      assert.equal(await app.locator("article").count(), 2, "resolved pins are excluded");
      assert.equal(await app.getByRole("checkbox").count(), 2, "one checkbox per pin");
      assert.equal(await app.getByRole("textbox").count(), 0, "no search or request editor for a short list");
      assert.equal(await app.getByRole("button", { name: /Prepare|Verify|Edit/ }).count(), 0);
      assert.equal(await app.getByRole("button", { name: "Send to agent", exact: true }).isDisabled(), true);
      assert.equal(await app.locator("main").evaluate(el => el.getBoundingClientRect().height <= 520), true);
      if (name === "chromium") {
        const output = path.resolve("../../artifacts/releases");
        fs.mkdirSync(output, { recursive: true });
        await app.locator("main").screenshot({ path: path.join(output, "pin-widget-simple-light.png") });
      }
      await app.getByRole("checkbox", { name: "Include pin 1 in request", exact: true }).check();
      if (name === "chromium") await app.locator("main").screenshot({ path: path.resolve("../../artifacts/releases/pin-widget-simple-light-selected.png") });
      assert.equal(await page.evaluate(() => window.calls.some(call => call.method === "ui/message" || call.params?.name === "scormplayer_update_pin")), false, "selection neither sends nor resolves");
      await app.getByRole("button", { name: "Details for pin 1", exact: true }).click();
      await app.getByRole("button", { name: "View screenshot", exact: true }).click();
      await app.getByRole("img", { name: "Saved screenshot for pin 1" }).waitFor();
      await app.getByRole("button", { name: "Details for pin 1", exact: true }).click();
      await app.getByRole("button", { name: "Send to agent", exact: true }).click();
      await app.getByRole("status").filter({ hasText: "Sent to agent." }).waitFor();
      const calls = await page.evaluate(() => window.calls);
      const handoff = calls.find(call => call.params?.name === "scormplayer_get_handoff");
      assert.deepEqual(handoff.params.arguments, { playerId: snapshot.playerId, revision: "r1", ids: ["p1"] });
      const messages = calls.filter(call => call.method === "ui/message");
      assert.equal(messages.length, 1);
      assert.match(messages[0].params.content[0].text, /The diagram label overlaps/);
      assert.doesNotMatch(messages[0].params.content[0].text, /Clarify the completion|Increase the contrast/);
      assert.equal(await page.evaluate(() => window.review.pins[0].status), "open", "send leaves completion to verified agent work");
      assert.equal(await app.getByRole("checkbox", { name: "Include pin 1 in request", exact: true }).isChecked(), false, "selection clears after success");
      await app.getByRole("button", { name: "Open player", exact: true }).click();
      await app.getByRole("status").filter({ hasText: "Player opened in your browser." }).waitFor();
      assert.equal(await page.evaluate(() => window.calls.some(call => call.method === "ui/open-link")), false);
      await page.setViewportSize({ width: 420, height: 520 });
      assert.equal(await app.locator("main").evaluate(el => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().height <= 520), true);
      assert.deepEqual(errors, []);
      assert.deepEqual(requests.filter(url => !url.startsWith("data:")), ["http://127.0.0.1:49999/"], "assets and screenshots remain inline");
    } finally { await browser.close(); }
  });
}

test("one-click send rejects changed evidence, resolved selections and switched lessons", async () => {
  const { browser, page, app } = await host(chromium);
  try {
    await app.getByRole("checkbox", { name: "Include pin 1 in request", exact: true }).check();
    await page.evaluate(() => { window.review.lastChangeAt = "2026-10-05T12:00:00Z"; });
    await app.getByRole("button", { name: "Send to agent", exact: true }).click();
    await app.getByRole("status").filter({ hasText: "Pins or source changed." }).waitFor();
    assert.equal(await page.evaluate(() => window.calls.some(call => call.method === "ui/message")), false);
    await page.evaluate(() => { window.review.pins[0].status = "resolved"; });
    await app.getByRole("button", { name: "Send to agent", exact: true }).click();
    await app.getByRole("status").filter({ hasText: "A selected pin is no longer open." }).waitFor();
    assert.equal(await app.getByRole("checkbox").count(), 1);
    assert.equal(await app.getByRole("button", { name: "Send to agent", exact: true }).isDisabled(), true);
    await page.evaluate(() => { window.review.revision = "r2"; });
    await app.getByRole("button", { name: "Refresh pins", exact: true }).click();
    await app.getByRole("alert").filter({ hasText: "Its actions are paused." }).waitFor();
    assert.equal(await app.getByRole("button", { name: "Open player", exact: true }).isDisabled(), true);
    assert.equal(await page.evaluate(() => window.calls.some(call => call.method === "ui/message" || call.params?.name === "scormplayer_list_players")), false, "never retargets another lesson");
  } finally { await browser.close(); }
});

test("sending rechecks evidence after building the handoff", async () => {
  const { browser, page, app } = await host(chromium);
  try {
    await app.getByRole("checkbox", { name: "Include pin 1 in request", exact: true }).check();
    await page.evaluate(() => { window.changeDuringHandoff = true; });
    await app.getByRole("button", { name: "Send to agent", exact: true }).click();
    await app.getByRole("status").filter({ hasText: "Pins or source changed." }).waitFor();
    assert.equal(await page.evaluate(() => window.calls.some(call => call.method === "ui/message")), false);
  } finally { await browser.close(); }
});

test("missing messaging and rejected sends provide copyable requests", async () => {
  for (const capabilities of [{ serverTools: {} }, { serverTools: {}, message: {} }]) {
    const { browser, app, page } = await host(chromium, capabilities);
    try {
      await app.getByRole("checkbox", { name: "Include pin 1 in request", exact: true }).check();
      if (capabilities.message) await page.evaluate(() => { window.rejectMessage = true; });
      await app.getByRole("button", { name: capabilities.message ? "Send to agent" : "Get request to copy", exact: true }).click();
      await app.getByRole("textbox", { name: "Request to copy", exact: true }).waitFor();
      assert.match(await app.getByRole("textbox", { name: "Request to copy", exact: true }).inputValue(), /The diagram label overlaps/);
      assert.equal(await page.evaluate(() => window.calls.some(call => call.params?.name === "scormplayer_update_pin")), false);
      await app.getByRole("checkbox", { name: "Include pin 2 in request", exact: true }).check();
      await app.getByRole("textbox", { name: "Request to copy", exact: true }).waitFor({ state: "detached" });
    } finally { await browser.close(); }
  }
});

test("hosts without tool calls keep a readable list without sending", async () => {
  const { browser, app, page } = await host(chromium, {});
  try {
    await app.getByRole("checkbox", { name: "Include pin 1 in request", exact: true }).check();
    assert.equal(await app.getByRole("button", { name: "Refresh pins", exact: true }).isDisabled(), true);
    assert.equal(await app.getByRole("button", { name: "Get request to copy", exact: true }).isDisabled(), true);
    assert.equal(await page.evaluate(() => window.calls.some(call => call.method === "tools/call" || call.method === "ui/message")), false);
    assert.match(await app.locator("body").innerText(), /Sending isn't available here/);
  } finally { await browser.close(); }
});

test("a retired player pauses sending without adopting another session", async () => {
  const { browser, page, app } = await host(chromium);
  try {
    await app.getByRole("checkbox", { name: "Include pin 1 in request", exact: true }).check();
    await page.evaluate(() => { window.retiredPlayer = true; });
    await app.getByRole("button", { name: "Send to agent", exact: true }).click();
    await app.getByRole("status").filter({ hasText: "This player session ended." }).waitFor();
    assert.equal(await app.getByRole("button", { name: "Refresh pins", exact: true }).isDisabled(), true);
    assert.equal(await page.evaluate(() => window.calls.some(call => call.method === "ui/message" || call.params?.name === "scormplayer_list_players")), false);
  } finally { await browser.close(); }
});

for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
  test(`${name}: long lists stay bounded and selected pins survive pagination`, async () => {
    const initial = { ...snapshot, pins: Array.from({ length: 41 }, (_, index) => ({ ...snapshot.pins[0], id: `long-${index}`, number: index + 1, status: "open", note: `Review item ${index + 1}: ${"Long pin evidence. ".repeat(30)}` })) };
    const { browser, page, app } = await host(engine, { serverTools: {}, message: {} }, initial);
    try {
      await page.setViewportSize({ width: 420, height: 520 });
      assert.equal(await app.locator("article").count(), 4);
      assert.equal(await app.locator("main").evaluate(el => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().height <= 520), true);
      assert.equal(await app.locator(".pin-note").first().evaluate(el => el.getBoundingClientRect().height <= 39), true);
      assert.equal(await app.getByRole("img").count(), 0);
      await app.getByRole("checkbox", { name: "Include pin 1 in request", exact: true }).check();
      await app.getByRole("button", { name: "Next pins", exact: true }).click();
      await app.getByRole("checkbox", { name: "Include pin 5 in request", exact: true }).check();
      await app.getByRole("button", { name: "Previous pins", exact: true }).click();
      assert.equal(await app.getByRole("checkbox", { name: "Include pin 1 in request", exact: true }).isChecked(), true);
      await app.getByRole("textbox", { name: "Search pins", exact: true }).fill("Review item 40:");
      assert.equal(await app.locator("article").count(), 1);
      await app.getByRole("button", { name: "Details for pin 40", exact: true }).click();
      assert.equal(await app.locator(".full-note").innerText(), initial.pins[39].note);
      await app.getByRole("button", { name: "Details for pin 40", exact: true }).click();
      await app.getByRole("button", { name: "Send to agent", exact: true }).click();
      await app.getByRole("status").filter({ hasText: "Sent to agent." }).waitFor();
      const handoff = await page.evaluate(() => window.calls.find(call => call.params?.name === "scormplayer_get_handoff"));
      assert.deepEqual(handoff.params.arguments.ids, ["long-0", "long-4"]);
      await app.getByRole("textbox", { name: "Search pins", exact: true }).fill("");
      await app.getByRole("button", { name: "Select all", exact: true }).click();
      assert.match(await app.locator(".request-controls").innerText(), /41 selected/);
      await app.getByRole("button", { name: "Clear selection", exact: true }).click();
      assert.equal(await app.getByRole("button", { name: "Send to agent", exact: true }).isDisabled(), true);
    } finally { await browser.close(); }
  });
}

test("completed pin lists show an empty state without a send action", async () => {
  const initial = { ...snapshot, pins: snapshot.pins.map(pin => ({ ...pin, status: "resolved" })) };
  const { browser, app } = await host(chromium, { serverTools: {}, message: {} }, initial);
  try {
    assert.equal(await app.getByRole("checkbox").count(), 0);
    assert.equal(await app.getByRole("button", { name: "Send to agent", exact: true }).count(), 0);
    assert.match(await app.locator("body").innerText(), /No pins left/);
  } finally { await browser.close(); }
});

test("refresh drops completed selections and reveals remaining pins when search is no longer needed", async () => {
  const initial = { ...snapshot, pins: Array.from({ length: 5 }, (_, index) => ({ ...snapshot.pins[1], id: `refresh-${index}`, number: index + 1, note: `Task ${index + 1}`, status: "open" })) };
  const { browser, app, page } = await host(chromium, { serverTools: {}, message: {} }, initial);
  try {
    await app.getByRole("textbox", { name: "Search pins", exact: true }).fill("Task 1");
    await app.getByRole("checkbox", { name: "Include pin 1 in request", exact: true }).check();
    await page.evaluate(() => { window.review.pins.slice(0, 3).forEach(pin => { pin.status = "resolved"; }); });
    await app.getByRole("button", { name: "Refresh pins", exact: true }).click();
    await app.getByRole("status").filter({ hasText: "Pins updated." }).waitFor();
    assert.equal(await app.getByRole("textbox", { name: "Search pins", exact: true }).count(), 0);
    assert.equal(await app.locator("article").count(), 2);
    assert.equal(await app.getByRole("button", { name: "Send to agent", exact: true }).isDisabled(), true);
  } finally { await browser.close(); }
});
