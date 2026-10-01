// Browser tests: the player page itself, driven in headless Chromium against real servers.
// Needs the built UI (npm run build) and a Chromium for Playwright (npx playwright install chromium).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { startPlayer } from "../server/index.mjs";
import { multiScoZip, scorm12Zip } from "./fixtures.mjs";

let browser;
before(async () => { browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] }); });
after(async () => { await browser?.close(); });

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "scormplayer-e2e-"));
}

/** A SCORM 2004 folder with three pages (scorm-review handshake), a narrated tour step, and content to pin. */
function navCourse() {
  const dir = path.join(tempDir(), "course");
  fs.mkdirSync(dir);
  const rate = 8000;
  const samples = rate * 6;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(36 + samples * 2, 4); wav.write("WAVE", 8); wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
  fs.writeFileSync(path.join(dir, "narration.wav"), wav);
  fs.writeFileSync(path.join(dir, "imsmanifest.xml"), `<?xml version="1.0"?><manifest identifier="nav" xmlns="http://www.imsglobal.org/xsd/imscp_v1p1" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3"><metadata><schema>ADL SCORM</schema><schemaversion>2004 4th Edition</schemaversion></metadata><organizations default="o"><organization identifier="o"><title>Nav course</title><item identifier="i" identifierref="r"><title>x</title></item></organization></organizations><resources><resource identifier="r" type="webcontent" adlcp:scormType="sco" href="index.html"/></resources></manifest>`);
  fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html><title>Nav course</title><body style="font-family:sans-serif;margin:40px">
<h1 id="title"></h1><p id="intro">Spot the three most common hazards before your first shift.</p>
<div style="display:flex;gap:20px;margin-top:40px"><button id="a">First card</button><button id="b">Second card</button></div>
<div class="driver-popover" style="position:fixed;bottom:20px;right:20px;background:#fff;border:1px solid #999;padding:10px">
  <div class="driver-popover-title">Listen first</div><div class="driver-popover-progress-text">1 of 2</div>
  <button class="driver-popover-prev-btn" disabled>Back</button><button class="driver-popover-next-btn" disabled>Next</button></div>
<script>
const pages=[{id:'intro',title:'Introduction'},{id:'hazards',title:'Spot the hazards'},{id:'quiz',title:'Quick check'}];
let index=0;
const show=()=>{document.getElementById('title').textContent=pages[index].title;parent.postMessage({type:'scorm-review:nav',version:1,pages,index},'*');};
addEventListener('message',e=>{const d=e.data||{};if(d.version!==1)return;if(d.type==='scorm-review:host')show();if(d.type==='scorm-review:goto'){index=d.index;show();}});
show();
const next=document.querySelector('.driver-popover-next-btn');
next.onclick=()=>{document.querySelector('.driver-popover-progress-text').textContent='2 of 2';};
const audio=new Audio('narration.wav');
audio.addEventListener('ended',()=>{next.disabled=false;});
window.startNarration=()=>audio.play();
</script></body>`);
  return dir;
}

async function open(options) {
  const dir = tempDir();
  const player = await startPlayer({ cacheDir: path.join(dir, "cache"), port: 0, pinsDir: dir, ...options });
  const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
  await page.goto(player.url);
  return { player, page, dir };
}

test("pages, tour steps and narration skip", async () => {
  const { player, page } = await open({ input: navCourse() });
  try {
    const nav = page.locator(".sp-nav__page");
    await nav.waitFor();
    assert.match(await nav.innerText(), /1\s*\/ 3\s*Introduction/);
    await page.locator(".sp-nav__step[aria-label='Next page']").click();
    await page.waitForFunction(() => document.querySelector(".sp-nav__page")?.textContent?.includes("Spot the hazards"));
    await page.keyboard.press("BracketRight");
    await page.waitForFunction(() => document.querySelector(".sp-nav__page")?.textContent?.includes("Quick check"));
    await nav.click();
    await page.locator(".sp-pages button", { hasText: "Introduction" }).click();
    await page.waitForFunction(() => document.querySelector(".sp-nav__page")?.textContent?.includes("Introduction"));
    assert.equal(await page.frameLocator("iframe.sp-frame").locator("#title").innerText(), "Introduction");

    await page.frames()[1].evaluate(() => window.startNarration());
    const tourButton = page.locator(".sp-tour .sp-skip");
    await page.waitForFunction(() => document.querySelector(".sp-tour .sp-skip")?.textContent?.includes("Skip"));
    await tourButton.click();
    await page.waitForFunction(() => document.querySelector(".sp-tour .sp-skip")?.textContent?.includes("Next"), null, { timeout: 4000 });
    await tourButton.click();
    await page.waitForFunction(() => document.querySelector(".sp-tour__label")?.textContent?.includes("2 of 2"));
  } finally {
    await page.close();
    await player.close();
  }
});

test("element, area and multi-element pins, and editing a note", async () => {
  const { player, page } = await open({ input: navCourse() });
  try {
    await page.locator(".sp-nav__page").waitFor();
    const frame = page.frameLocator("iframe.sp-frame");
    const box = async (selector) => frame.locator(selector).boundingBox();

    // Element
    await page.keyboard.press("p");
    await frame.locator("#intro").click();
    await page.locator(".sp-composer textarea").fill("Make the intro friendlier");
    await page.keyboard.press("ControlOrMeta+Enter");
    await page.waitForFunction(() => document.querySelectorAll(".sp-marker").length === 1);

    // Several elements with one note
    await frame.locator("#a").click();
    await frame.locator("#b").click({ modifiers: ["Shift"] });
    assert.match(await page.locator(".sp-composer__target span").innerText(), /^2 elements/);
    await page.locator(".sp-composer textarea").fill("Make these cards the same width");
    await page.locator(".sp-composer button", { hasText: "Save pin" }).click();
    await page.locator(".sp-composer").waitFor({ state: "detached" });

    // A drawn area: a drag that starts off text draws a box, no mode to switch
    const a = await box("#a");
    const b = await box("#b");
    await page.mouse.move(a.x - 10, a.y - 10);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width + 10, b.y + b.height + 10, { steps: 5 });
    await page.mouse.up();
    assert.match(await page.locator(".sp-composer__target span").innerText(), /^Area \d+×\d+/);
    await page.locator(".sp-composer textarea").fill("Too much space around the buttons");
    await page.locator(".sp-composer button", { hasText: "Save pin" }).click();

    await page.waitForFunction(() => document.querySelectorAll(".sp-marker").length === 3);

    // A drag across text still pins the phrase; with ⌥/Alt held it draws a box instead
    const intro = await box("#intro");
    await page.mouse.move(intro.x + 4, intro.y + intro.height / 2);
    await page.mouse.down();
    await page.mouse.move(intro.x + 120, intro.y + intro.height / 2, { steps: 5 });
    await page.mouse.up();
    assert.match(await page.locator(".sp-composer__target span").innerText(), /^.?Spot the/);
    await page.locator(".sp-composer textarea").fill("Reword the opening");
    await page.locator(".sp-composer button", { hasText: "Save pin" }).click();
    await page.locator(".sp-composer").waitFor({ state: "detached" });
    await page.keyboard.down("Alt");
    await page.mouse.move(intro.x + 4, intro.y + intro.height / 2);
    await page.mouse.down();
    await page.mouse.move(intro.x + 200, intro.y + intro.height + 30, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.up("Alt");
    assert.match(await page.locator(".sp-composer__target span").innerText(), /^Area \d+×\d+/);
    await page.locator(".sp-composer textarea").fill("Tighten this block");
    await page.locator(".sp-composer button", { hasText: "Save pin" }).click();

    await page.waitForFunction(() => document.querySelectorAll(".sp-marker").length === 5);
    const pins = player.pins.list();
    assert.deepEqual(pins.map((pin) => pin.target.kind), ["element", "group", "region", "text", "region"]);
    assert.equal(pins[1].target.targets.length, 2);
    assert.equal(pins[0].source?.[0]?.file, "index.html");

    // Edit a note from the panel
    await page.keyboard.press("Escape");
    await page.locator(".sp-tab", { hasText: "Pins" }).click();
    await page.locator(".sp-pin").first().locator("button", { hasText: "Edit" }).click();
    await page.locator(".sp-pin__edit textarea").fill("Make the intro warmer and shorter");
    await page.locator(".sp-pin__actions button", { hasText: "Save" }).click();
    await page.waitForFunction(() => document.querySelector(".sp-pin__note")?.textContent === "Make the intro warmer and shorter");
    assert.equal(player.pins.list()[0].note, "Make the intro warmer and shorter");
  } finally {
    await page.close();
    await player.close();
  }
});

test("tablet and phone views resize the course", async () => {
  const { player, page } = await open({ input: navCourse() });
  try {
    await page.locator(".sp-views").waitFor();
    const width = () => page.frames()[1].evaluate(() => window.innerWidth);
    await page.locator(".sp-views button[aria-label='Tablet']").click();
    await page.waitForFunction(() => document.querySelector(".sp-device--tablet"));
    assert.equal(await width(), 1024);
    await page.locator(".sp-views button[aria-label='Phone']").click();
    assert.equal(await width(), 390);
    await page.locator(".sp-views button[aria-label='Desktop']").click();
    assert.ok((await width()) > 1000);
  } finally {
    await page.close();
    await player.close();
  }
});

test("an empty player opens a chosen zip and switches to another", async () => {
  const { player, page, dir } = await open({});
  try {
    await page.locator(".sp-home h1").waitFor();
    const first = path.join(dir, "Safety.zip");
    fs.writeFileSync(first, scorm12Zip({ title: "Safety Basics" }));
    await page.locator(".sp-home input[type=file]").setInputFiles(first);
    await page.waitForFunction(() => document.querySelector(".sp-bar__titles strong")?.textContent === "Safety Basics", null, { timeout: 15000 });
    assert.match(await page.locator(".sp-progress").innerText(), /Completed/);

    const second = path.join(dir, "Fire.zip");
    fs.writeFileSync(second, scorm12Zip({ title: "Fire Drill" }));
    await page.locator("input[type=file]").last().setInputFiles(second);
    await page.waitForFunction(() => document.querySelector(".sp-bar__titles strong")?.textContent === "Fire Drill", null, { timeout: 15000 });
    assert.equal(player.course.title, "Fire Drill");
  } finally {
    await page.close();
    await player.close();
  }
});

test("modules of a multi-SCO package keep their own SCORM data; the inspector shows it", async () => {
  const dir = tempDir();
  const zip = path.join(dir, "multi.zip");
  fs.writeFileSync(zip, multiScoZip());
  const { player, page } = await open({ input: zip });
  try {
    const label = page.locator(".sp-scos .sp-nav__page");
    await label.waitFor();
    assert.match(await label.innerText(), /1\s*\/ 3\s*Module 1/);
    await page.waitForFunction(() => document.querySelector(".sp-progress")?.textContent?.includes("Completed"));
    await page.locator(".sp-scos .sp-nav__step[aria-label='Next module']").click();
    await page.waitForFunction(() => document.querySelector(".sp-scos .sp-nav__page")?.textContent?.includes("Module 2"));
    assert.equal(await page.frameLocator("iframe.sp-frame").locator("h1").innerText(), "Module 2");
    await page.waitForFunction(() => document.querySelector(".sp-progress")?.textContent?.includes("In progress"));

    await page.keyboard.press("i");
    const inspector = page.locator(".sp-inspector");
    await inspector.waitFor();
    assert.match(await inspector.locator("table").innerText(), /cmi\.location\s+module-2/);
    await inspector.locator("[role=tab]", { hasText: "Calls" }).click();
    assert.match(await inspector.locator(".sp-calls").innerText(), /SetValue[\s\S]*cmi\.completion_status, incomplete/);

    await page.locator(".sp-scos .sp-nav__step[aria-label='Previous module']").click();
    await page.waitForFunction(() => document.querySelector(".sp-progress")?.textContent?.includes("Completed"));
  } finally {
    await page.close();
    await player.close();
  }
});

test("WebMCP tools drive the player for a browser agent", async () => {
  const dir = tempDir();
  const { player } = await open({ input: navCourse() }).then(async (opened) => { await opened.page.close(); return opened; });
  const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
  // A stand-in for the browser's WebMCP API, recording what the page registers.
  await page.addInitScript(() => {
    window.__tools = {};
    document.modelContext = { registerTool: (tool) => { window.__tools[tool.name] = tool; return { unregister() {} }; } };
  });
  try {
    await page.goto(player.url);
    await page.locator(".sp-nav__page").waitFor();
    const names = await page.evaluate(() => Object.keys(window.__tools).sort());
    assert.ok(names.includes("scormplayer_add_pin") && names.includes("scormplayer_go_to_page") && names.length >= 10);
    const call = (name, input = {}) => page.evaluate(async ([tool, args]) => {
      const result = await window.__tools[tool].execute(args);
      return { error: Boolean(result.isError), text: result.content[0].text };
    }, [name, input]);

    const status = JSON.parse((await call("scormplayer_status")).text);
    assert.equal(status.page.of, 3);
    assert.match((await call("scormplayer_go_to_page", { page: "hazards" })).text, /page 2: Spot the hazards/);
    assert.equal(await page.frameLocator("iframe.sp-frame").locator("#title").innerText(), "Spot the hazards");

    const added = JSON.parse((await call("scormplayer_add_pin", { note: "Shorten this", text: "three most common hazards" })).text);
    assert.equal(added.number, 1);
    assert.equal(player.pins.list()[0].page.title, "Spot the hazards");
    assert.match((await call("scormplayer_get_handoff")).text, /Shorten this/);
    assert.match((await call("scormplayer_resolve_pin", { number: 1, note: "Shortened" })).text, /resolved/);
    assert.equal(player.pins.list()[0].status, "resolved");
    assert.equal((await call("scormplayer_add_pin", { note: "x", selector: "#missing" })).error, true);
    assert.match((await call("scormplayer_set_screen_size", { size: "phone" })).text, /phone/);
    assert.equal(await page.frames()[1].evaluate(() => window.innerWidth), 390);
  } finally {
    await page.close();
    await player.close();
  }
});

test("an idle player asks \"Still there?\", stays when answered and closes when not", async () => {
  const { player, page } = await open({ input: navCourse(), idleMinutes: 0.05, registryDir: null });
  let closeAsked = 0;
  player.events.on("idle-close", () => { closeAsked += 1; });
  try {
    const prompt = page.getByRole("alertdialog", { name: "Still there?" });
    await prompt.waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: "I'm still here" }).click();
    await prompt.waitFor({ state: "hidden" });
    assert.equal(closeAsked, 0);
    // Nobody answers the next one: the player is asked to close and the tab says so.
    await prompt.waitFor({ timeout: 10_000 });
    await page.getByText("This player has closed").waitFor({ timeout: 10_000 });
    assert.equal(closeAsked, 1);
    assert.match(await page.locator(".sp-closed__command code").innerText(), /^scormplayer /);
  } finally {
    await page.close();
    await player.close();
  }
});
