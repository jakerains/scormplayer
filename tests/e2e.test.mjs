// Browser tests against real servers and normal browser autoplay rules.
// Build first; SCORMPLAYER_BROWSER selects chromium (default), firefox or webkit.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, firefox, webkit } from "playwright";
import { startPlayer } from "../server/index.mjs";
import { multiScoZip, scorm12Zip, scorm2004Zip } from "./fixtures.mjs";

let browser;
before(async () => {
  const name = process.env.SCORMPLAYER_BROWSER ?? "chromium";
  const engine = { chromium, firefox, webkit }[name];
  if (!engine) throw new Error(`Unknown browser: ${name}`);
  browser = await engine.launch();
});
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
<button id="startNarration">Start narration</button>
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
document.getElementById('startNarration').onclick=window.startNarration;
</script></body>`);
  return dir;
}

async function open(options, context = null) {
  const dir = tempDir();
  const player = await startPlayer({ cacheDir: path.join(dir, "cache"), port: 0, pinsDir: dir, ...options });
  const page = context ? await context.newPage() : await browser.newPage({ viewport: { width: 1400, height: 820 } });
  await page.goto(player.url);
  return { player, page, dir };
}

test("a confirmed update is visible without opening More and offers the update command", async () => {
  const { player, page } = await open({ input: navCourse() });
  try {
    assert.equal(await page.getByTitle("More", { exact: true }).getByText("Update", { exact: true }).count(), 0);
    player.setUpdate({ latest: "9.0.0", command: "scormplayer update" });
    await page.getByTitle("More", { exact: true }).getByText("Update", { exact: true }).waitFor();
    await page.getByTitle("More", { exact: true }).click();
    const advice = page.getByRole("menuitem", { name: "scormplayer 9.0.0 is available" });
    assert.equal(await advice.getAttribute("title"), "Copies: scormplayer update");
    await advice.click();
    await page.getByRole("status").filter({ hasText: "Run scormplayer update in your terminal" }).waitFor();
  } finally { await page.close(); await player.close(); }
});

test("SCORM 1.2 and 2004 resume on another port", async () => {
  for (const version of ["1.2", "2004"]) {
    const input = path.join(tempDir(), "resume.zip");
    fs.writeFileSync(input, version === "1.2" ? scorm12Zip() : scorm2004Zip());
    const context = await browser.newContext();
    const { player, page, dir } = await open({ input, registryDir: null }, context);
    let next;
    try {
      await page.frameLocator("iframe.sp-frame").locator("h1").waitFor();
      await page.evaluate((version) => {
        const api = version === "1.2" ? window.API : window.API_1484_11;
        api[version === "1.2" ? "LMSInitialize" : "Initialize"]("");
        api[version === "1.2" ? "LMSSetValue" : "SetValue"]("cmi.suspend_data", "saved-review");
        api[version === "1.2" ? "LMSSetValue" : "SetValue"](version === "1.2" ? "cmi.core.lesson_location" : "cmi.location", "page-3");
        api[version === "1.2" ? "LMSCommit" : "Commit"]("");
      }, version);
      await page.waitForTimeout(300);
      next = await startPlayer({ input, cacheDir: path.join(dir, "cache"), port: 0, registryDir: null });
      await page.goto(next.url);
      await page.frameLocator("iframe.sp-frame").locator("h1").waitFor();
      const state = await page.evaluate((version) => {
        const api = version === "1.2" ? window.API : window.API_1484_11;
        api[version === "1.2" ? "LMSInitialize" : "Initialize"]("");
        const get = (key) => api[version === "1.2" ? "LMSGetValue" : "GetValue"](key);
        return { data: get("cmi.suspend_data"), entry: get(version === "1.2" ? "cmi.core.entry" : "cmi.entry") };
      }, version);
      assert.deepEqual(state, { data: "saved-review", entry: "resume" });
    } finally { await context.close(); await next?.close(); await player.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test("legacy module progress migrates once and cannot return after reset", async () => {
  const dir = tempDir();
  const input = path.join(dir, "legacy.zip");
  fs.writeFileSync(input, multiScoZip());
  const player = await startPlayer({ input, cacheDir: path.join(dir, "cache"), port: 0, registryDir: null });
  const course = await (await fetch(`${player.url}api/course`)).json();
  const context = await browser.newContext();
  await context.addInitScript(({ key, ids }) => {
    ids.forEach((id, index) => localStorage.setItem(`scormplayer:${key}:${id}`, JSON.stringify({ "cmi.suspend_data": `legacy-${index}` })));
    localStorage.setItem(`scormplayer:sco:${key}`, "1");
  }, { key: course.courseKey, ids: course.scos.map((sco) => sco.id) });
  const page = await context.newPage();
  try {
    await page.goto(player.url);
    await page.frameLocator("iframe.sp-frame").locator("h1").filter({ hasText: "Module 2" }).waitFor();
    assert.equal(await page.evaluate(() => window.API_1484_11.GetValue("cmi.suspend_data")), "legacy-1");
    await page.waitForFunction(async () => (await (await fetch("/api/scorm")).json()).saved);
    const saved = await (await fetch(`${player.url}api/scorm`)).json();
    assert.equal(saved.modules[course.scos[0].id]["cmi.suspend_data"], "legacy-0");
    await page.locator(".sp-tab").filter({ hasText: "More" }).click();
    await page.getByRole("menuitem", { name: "Reset progress", exact: true }).click();
    await page.getByRole("menuitem", { name: "Click again to clear progress", exact: true }).click();
    await page.frameLocator("iframe.sp-frame").locator("h1").filter({ hasText: "Module 1" }).waitFor();
    await page.reload(); // The init script deliberately recreates the old browser cache.
    await page.frameLocator("iframe.sp-frame").locator("h1").filter({ hasText: "Module 1" }).waitFor();
    assert.equal(await page.evaluate(() => window.API_1484_11.GetValue("cmi.suspend_data")), "");
  } finally { await context.close(); await player.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("failed progress writes keep the learner state and offer a working retry", async () => {
  const { player, page } = await open({ input: navCourse(), registryDir: null });
  try {
    await page.frameLocator("iframe.sp-frame").locator("h1").waitFor();
    await page.route("**/api/scorm", (route) => route.request().method() === "PUT"
      ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Progress disk unavailable" }) }) : route.continue());
    await page.evaluate(() => { window.API_1484_11.SetValue("cmi.suspend_data", "retry-me"); window.API_1484_11.Commit(""); });
    const alert = page.locator(".sp-save-error");
    await alert.filter({ hasText: "Progress disk unavailable" }).waitFor();
    assert.equal(await page.evaluate(() => window.API_1484_11.GetValue("cmi.suspend_data")), "retry-me");
    await page.unroute("**/api/scorm");
    await alert.getByRole("button", { name: "Retry", exact: true }).click();
    await alert.waitFor({ state: "detached" });
    const saved = await (await fetch(`${player.url}api/scorm`)).json();
    assert.equal(saved.modules[""]["cmi.suspend_data"], "retry-me");
  } finally { await page.close(); await player.close(); }
});

test("reset progress clears every SCO and restarts at the first module", async () => {
  const input = path.join(tempDir(), "modules.zip");
  fs.writeFileSync(input, multiScoZip());
  const { player, page } = await open({ input, registryDir: null });
  try {
    await page.frameLocator("iframe.sp-frame").locator("h1").waitFor();
    await page.evaluate(() => { window.API_1484_11.SetValue("cmi.suspend_data", "module-one-saved"); window.API_1484_11.Commit(""); });
    await page.getByRole("button", { name: "Next module", exact: true }).click();
    await page.frameLocator("iframe.sp-frame").locator("h1").filter({ hasText: "Module 2" }).waitFor();
    await page.evaluate(() => { window.API_1484_11.SetValue("cmi.suspend_data", "module-two-saved"); window.API_1484_11.Commit(""); });
    await page.locator(".sp-tab").filter({ hasText: "More" }).click();
    await page.getByRole("menuitem", { name: "Reset progress", exact: true }).click();
    await page.getByRole("menuitem", { name: "Click again to clear progress", exact: true }).click();
    await page.frameLocator("iframe.sp-frame").locator("h1").filter({ hasText: "Module 1" }).waitFor({ timeout: 3000 });
    assert.equal(await page.evaluate(() => window.API_1484_11.GetValue("cmi.suspend_data")), "");
    await page.getByRole("button", { name: "Next module", exact: true }).click();
    await page.frameLocator("iframe.sp-frame").locator("h1").filter({ hasText: "Module 2" }).waitFor();
    assert.equal(await page.evaluate(() => window.API_1484_11.GetValue("cmi.suspend_data")), "");
  } finally { await page.close(); await player.close(); }
});

test("a course's unload save cannot bring progress back after Reset", async () => {
  const input = navCourse();
  fs.appendFileSync(path.join(input, "index.html"), `<script>
const closingApi = parent.API_1484_11;
addEventListener('pagehide', () => { closingApi.SetValue('cmi.suspend_data', 'old-unload-state'); closingApi.Commit(''); });
</script>`);
  const { player, page } = await open({ input, registryDir: null });
  try {
    await page.frameLocator("iframe.sp-frame").locator("h1").waitFor();
    await page.evaluate(() => { window.API_1484_11.SetValue("cmi.suspend_data", "before-reset"); window.API_1484_11.Commit(""); });
    await page.locator(".sp-tab").filter({ hasText: "More" }).click();
    await page.getByRole("menuitem", { name: "Reset progress", exact: true }).click();
    await page.getByRole("menuitem", { name: "Click again to clear progress", exact: true }).click();
    await page.locator(".sp-toast").filter({ hasText: "Progress cleared" }).waitFor();
    await page.frameLocator("iframe.sp-frame").locator("h1").waitFor();
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.API_1484_11.GetValue("cmi.suspend_data")), "");
    const state = await (await fetch(`${player.url}api/scorm`)).json();
    assert.equal(state.modules[""]?.["cmi.suspend_data"] ?? "", "");
  } finally { await page.close(); await player.close(); }
});

test("failed pin edits, resolution and deletion show errors and permit retry", async () => {
  const { player, page } = await open({ input: navCourse() });
  try {
    player.pins.create({ note: "Original note" });
    await page.locator(".sp-tab").filter({ hasText: "Pins" }).click();
    await page.locator(".sp-pin__note").waitFor();
    await page.route("**/api/pins/*", (route) => ["PATCH", "DELETE"].includes(route.request().method())
      ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Disk is read-only" }) }) : route.continue());
    const row = page.locator(".sp-pin").first();
    await row.getByRole("button", { name: "Resolve", exact: true }).click();
    await row.getByRole("alert").filter({ hasText: "Disk is read-only" }).waitFor({ timeout: 2000 });
    assert.equal(player.pins.list()[0].status, "open");
    await row.getByRole("button", { name: "Edit", exact: true }).click();
    await row.locator("textarea").fill("Edited draft");
    await row.getByRole("button", { name: "Save", exact: true }).click();
    await row.getByRole("alert").filter({ hasText: "Disk is read-only" }).waitFor();
    assert.equal(await row.locator("textarea").inputValue(), "Edited draft");
    await row.getByRole("button", { name: "Cancel", exact: true }).click();
    await row.getByRole("button", { name: "Delete", exact: true }).click();
    await row.getByRole("button", { name: "Confirm delete", exact: true }).click();
    await row.getByRole("alert").filter({ hasText: "Disk is read-only" }).waitFor();
    assert.equal(player.pins.list().length, 1);
    await row.getByRole("button", { name: "Edit", exact: true }).click();
    await row.locator("textarea").fill("Edited draft");
    await page.unroute("**/api/pins/*");
    await row.getByRole("button", { name: "Save", exact: true }).click();
    await row.locator(".sp-pin__note").filter({ hasText: "Edited draft" }).waitFor();
    await row.getByRole("button", { name: "Resolve", exact: true }).click();
    await row.waitFor({ state: "detached" });
    await page.getByText("Show resolved", { exact: true }).click();
    await row.waitFor();
    await row.getByRole("button", { name: "Delete", exact: true }).click();
    await row.getByRole("button", { name: "Confirm delete", exact: true }).click();
    await row.waitFor({ state: "detached" });
    assert.equal(player.pins.list().length, 0);
  } finally { await page.close(); await player.close(); }
});

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
    await page.locator('.sp-nav[aria-label="Pages"][aria-busy="false"]').waitFor();
    await nav.click();
    await page.locator(".sp-pages button", { hasText: "Introduction" }).click();
    await page.waitForFunction(() => document.querySelector(".sp-nav__page")?.textContent?.includes("Introduction"));
    assert.equal(await page.frameLocator("iframe.sp-frame").locator("#title").innerText(), "Introduction");

    await page.frameLocator("iframe.sp-frame").locator("#startNarration").click();
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
    await page.locator(".sp-composer textarea").click();
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

test("a selected pin follows its element inside a scrolling lesson panel", async () => {
  const input = navCourse();
  fs.writeFileSync(path.join(input, "index.html"), `<!doctype html><title>Scrolling lesson</title>
    <body style="margin:0"><div id="pane" style="height:450px;overflow:auto">
    <div style="height:300px"></div><button id="target" style="margin-left:80px;width:300px;height:80px">Review this block</button>
    <div style="height:1400px"></div></div></body>`);
  const { player, page } = await open({ input, registryDir: null });
  try {
    await page.addInitScript(() => {
      const interval = window.setInterval;
      window.setInterval = (callback, delay, ...args) => {
        if (delay === 200) {
          window.__geometryTick = callback;
          return interval(() => { if (!window.__pauseGeometryPolling) callback(...args); }, delay);
        }
        return interval(callback, delay, ...args);
      };
    });
    await page.reload();
    const frame = page.frameLocator("iframe.sp-frame");
    await frame.locator("#target").waitFor();
    await page.getByTitle("Pin mode (P)", { exact: true }).click();
    await frame.locator("#target").click();
    const aligned = () => page.evaluate(() => {
      const box = document.querySelector(".sp-box--selected");
      const element = document.querySelector("iframe.sp-frame").contentDocument.querySelector("#target");
      return box && Math.abs(parseFloat(box.style.top) - element.getBoundingClientRect().top) < 2;
    });
    await page.waitForFunction(() => Boolean(document.querySelector(".sp-box--selected")));
    assert.equal(await aligned(), true, "highlight starts on the target");
    // Prevent the fallback timer from making a missing scroll listener pass.
    await page.evaluate(() => { window.__pauseGeometryPolling = true; });
    const before = await page.locator(".sp-box--selected").evaluate((element) => parseFloat(element.style.top));
    await frame.locator("#pane").evaluate((element) => { element.scrollTop += 120; });
    await page.waitForFunction(() => {
      const box = document.querySelector(".sp-box--selected");
      const element = document.querySelector("iframe.sp-frame").contentDocument.querySelector("#target");
      return box && Math.abs(parseFloat(box.style.top) - element.getBoundingClientRect().top) < 2;
    }, null, { timeout: 1000 });
    const after = await page.locator(".sp-box--selected").evaluate((element) => parseFloat(element.style.top));
    assert.equal(before - after, 120, "scroll listener moves the highlight with polling paused");
    // A last geometry callback can run after the editor's DOM commit and before
    // React cleans up its passive effect. Make that scheduling gap deterministic.
    await page.evaluate(() => {
      const tick = window.__geometryTick;
      const observer = new MutationObserver(() => {
        if (!document.querySelector(".sp-composer")) { observer.disconnect(); tick(); }
      });
      observer.observe(document.querySelector(".sp-device"), { childList: true });
    });
    await page.locator(".sp-composer textarea").fill("Follow nested scrolling");
    await page.locator(".sp-composer button", { hasText: "Save pin" }).click();
    await page.locator(".sp-composer").waitFor({ state: "detached" });
    await page.waitForTimeout(300);
    assert.equal(await page.locator(".sp-box--selected").count(), 0, "saving cannot leave a stationary selection box");
  } finally { await page.close(); await player.close(); fs.rmSync(path.dirname(input), { recursive: true, force: true }); }
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

    // React can paint the page label before the tool action snapshot updates.
    // Use the same readiness signal an agent should check before navigation.
    await page.waitForFunction(async () => {
      const result = await window.__tools.scormplayer_status.execute({});
      const status = JSON.parse(result.content[0].text);
      return status.readiness?.navigationAvailable && status.page?.of === 3;
    });
    const status = JSON.parse((await call("scormplayer_status")).text);
    assert.equal(status.page.of, 3);
    assert.match((await call("scormplayer_go_to_page", { page: "hazards" })).text, /page 2: Spot the hazards/);
    assert.equal(await page.frameLocator("iframe.sp-frame").locator("#title").innerText(), "Spot the hazards");

    const added = JSON.parse((await call("scormplayer_add_pin", { note: "Shorten this", text: "three most common hazards" })).text);
    assert.equal(added.number, 1);
    assert.equal(player.pins.list()[0].page.title, "Spot the hazards");
    assert.match((await call("scormplayer_get_handoff")).text, /Shorten this/);
    assert.ok(added.id && added.target.selector && added.page.title);
    await call("scormplayer_edit_pin", { number: 1, note: "Review the shorter explanation" });
    assert.equal(player.pins.list()[0].note, "Review the shorter explanation");
    assert.match((await call("scormplayer_resolve_pin", { number: 1, note: "Shortened" })).text, /resolved/);
    assert.equal(player.pins.list()[0].status, "resolved");
    await call("scormplayer_reopen_pin", { number: 1 });
    assert.equal(player.pins.list()[0].status, "open");
    player.pins.update(added.id, { note: "Edited outside this tab" });
    const fresh = JSON.parse((await call("scormplayer_list_pins")).text);
    assert.equal(fresh[0].note, "Edited outside this tab");
    assert.equal((await call("scormplayer_go_to_page", { page: " " })).error, true);
    assert.equal((await call("scormplayer_tour_step", { direction: "bad" })).error, true);
    assert.equal((await call("scormplayer_add_pin", { note: " " , selector: "#title" })).error, true);
    assert.equal((await call("scormplayer_add_pin", { note: "two targets", selector: "#title", text: "hazards" })).error, true);
    const group = JSON.parse((await call("scormplayer_add_pin", { note: "Align these", selectors: ["#title", "#intro"] })).text);
    assert.equal(group.target.kind, "group");
    assert.equal(group.target.targets.length, 2);
    assert.equal((await call("scormplayer_add_pin", { note: "x", selector: "#missing" })).error, true);
    assert.match((await call("scormplayer_set_screen_size", { size: "tablet" })).text, /tablet/);
    assert.equal(await page.frames()[1].evaluate(() => window.innerWidth), 1024);
    const current = JSON.parse((await call("scormplayer_status")).text);
    assert.equal(current.viewport.width, 1024);
    assert.ok(current.course.revision && current.course.pinsFile);
    assert.equal(current.readiness.navigationAvailable, true);
    assert.equal(current.live.enabled, false);
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

test("paused narration remains skippable but lets an idle player ask", async () => {
  const { player, page } = await open({ input: navCourse(), idleMinutes: 0.05, registryDir: null });
  try {
    await page.locator(".sp-nav__page").waitFor();
    await page.frameLocator("iframe.sp-frame").locator("#startNarration").click();
    await page.frames()[1].evaluate(() => window.startNarration());
    await page.waitForTimeout(600);
    await page.frames()[1].evaluate(() => {
      for (const media of window.__scormplayerMedia) media.pause();
    });
    await page.waitForFunction(() => document.querySelector(".sp-tour .sp-skip")?.textContent?.includes("Skip"));
    await page.getByRole("alertdialog", { name: "Still there?" }).waitFor({ timeout: 7000 });
    assert.equal(player.pins.list().length, 0);
  } finally { await page.close(); await player.close(); }
});

test("a stale browser tab cannot save its draft into the newly switched course", async () => {
  const a = navCourse();
  const b = navCourse();
  const { player, page } = await open({ input: a, registryDir: null, courseList: () => [{ path: a, kind: "folder", title: "A" }, { path: b, kind: "folder", title: "B" }] });
  const other = await browser.newPage({ viewport: { width: 1400, height: 820 } });
  try {
    await page.locator(".sp-nav__page").waitFor();
    const initial = await (await fetch(`${player.url}api/player`)).json();
    await page.route("**/api/player", (route) => route.fulfill({ json: initial }));
    await page.keyboard.press("p");
    await page.frameLocator("iframe.sp-frame").locator("#intro").click();
    await page.locator(".sp-composer textarea").fill("A draft belongs to A");
    await other.goto(player.url);
    await other.getByRole("button", { name: "More", exact: true }).click();
    await other.getByRole("menuitem", { name: "Switch course…", exact: true }).click();
    await other.locator(".sp-switcher__list button").filter({ hasText: /^B/ }).click();
    await other.locator(".sp-switcher").waitFor({ state: "detached" });
    const response = page.waitForResponse((response) => response.url().endsWith("/api/pins") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Save pin", exact: true }).click();
    assert.equal((await response).status(), 409);
    assert.equal(await page.locator(".sp-composer textarea").inputValue(), "A draft belongs to A");
    assert.equal(player.pins.list().length, 0);
    await other.getByRole("button", { name: "Tablet", exact: true }).click();
    assert.equal(await other.frames()[1].evaluate(() => innerWidth), 1024);
  } finally { await other.close(); await page.close(); await player.close(); }
});

test("live source revisions render in the player without rebuilding", async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(dir, "vite.config.mjs"), "export default {};");
  fs.writeFileSync(path.join(dir, "index.html"), '<h1 id="live">Loading</h1><script type="module" src="/lesson.js"></script>');
  fs.writeFileSync(path.join(dir, "lesson.js"), 'document.querySelector("h1").textContent="Before revision";');
  fs.symlinkSync(path.resolve("node_modules"), path.join(dir, "node_modules"), "junction");
  const { player, page } = await open({ input: dir, live: true, registryDir: null });
  try {
    const lesson = page.frameLocator("iframe.sp-frame").locator("#live");
    await lesson.filter({ hasText: "Before revision" }).waitFor();
    fs.writeFileSync(path.join(dir, "lesson.js"), 'document.querySelector("h1").textContent="After revision";');
    await lesson.filter({ hasText: "After revision" }).waitFor();
    const state = await (await fetch(`${player.url}api/status`)).json();
    assert.ok(state.lastChangeAt);
  } finally { await page.close(); await player.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// Opt-in course state plus native DOM state, deliberately remounted on every module update.
function reviewLesson(revision = "before") {
  return `
export const revision = ${JSON.stringify(revision)};
const review = window.__SCORMPLAYER_REVIEW__;
let state = review?.read('lesson-view', 1) ?? { page: 0, guide: 0 };
if (state.guide === 0) sessionStorage.setItem('fixture:guideStarts', String(Number(sessionStorage.getItem('fixture:guideStarts') || 0) + 1));
window.parent.__academyLiveReviewMemory ??= new Map([['retained', true]]);
window.learnerActions = 0;
const root = document.querySelector('#root');
function render() {
  root.innerHTML = '<h1 id="revision">' + revision + '</h1><p id="state">Page ' + state.page + ', guide ' + state.guide + '</p>'
    + '<button id="continue" disabled>Required call before Continue</button>'
    + '<details id="disclosure"><summary>Reference</summary><p>Open reference</p></details>'
    + '<div id="pane" style="height:120px;overflow:auto"><div style="height:1200px">Scrollable reference</div></div>'
    + '<button id="focus">Review target</button><div style="height:2200px">Long page</div>';
  document.querySelector('#continue').onclick = () => { window.learnerActions++; };
}
render();
review?.register({ id: 'lesson-view', version: 1, capture: () => state, restore: saved => { state = saved; render(); } });
review?.registerNavigation({
  nextPage: () => { if (state.page >= 2) return false; state = { ...state, page: state.page + 1 }; render(); return true; },
  nextGuideStep: () => { if (state.guide >= 2) return false; state = { ...state, guide: state.guide + 1 }; render(); return true; }
});
if (import.meta.hot) import.meta.hot.accept();
`;
}

function liveReviewCourse() {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(dir, "vite.config.mjs"), "export default {};");
  fs.writeFileSync(path.join(dir, "index.html"), '<!doctype html><html><head><title>Review fixture</title></head><body><main id="root"></main><script type="module" src="/lesson.js"></script></body></html>');
  fs.writeFileSync(path.join(dir, "lesson.js"), reviewLesson());
  fs.symlinkSync(path.resolve("node_modules"), path.join(dir, "node_modules"), "junction");
  return dir;
}

async function reviewMenu(page, name) {
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

test("live review skips, HMR, full reload and player reload retain adapter and native view state", async () => {
  const input = liveReviewCourse();
  const { player, page } = await open({ input, live: true, registryDir: null });
  try {
    const frame = page.frameLocator("iframe.sp-frame");
    await frame.locator("#state").filter({ hasText: "Page 0, guide 0" }).waitFor();
    const progressBefore = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith("scormplayer:"))));
    await reviewMenu(page, "Skip to next guide step for review");
    await frame.locator("#state").filter({ hasText: "Page 0, guide 1" }).waitFor();
    await reviewMenu(page, "Skip to next page for review");
    await frame.locator("#state").filter({ hasText: "Page 1, guide 1" }).waitFor();
    const prepare = async () => {
      await frame.locator("#focus").click();
      await page.frames()[1].evaluate(async () => {
        document.querySelector("#disclosure").open = true;
        document.querySelector("#pane").scrollTop = 230;
        document.querySelector("#focus").focus({ preventScroll: true });
        window.scrollTo(0, 510);
        history.replaceState(null, "", "/course/preview?section=second#reference");
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        window.__SCORMPLAYER_REVIEW__.checkpoint();
      });
    };
    await prepare();
    const assertView = async (focus = false) => {
      await page.waitForFunction((focus) => {
        const win = document.querySelector("iframe.sp-frame")?.contentWindow;
        const doc = win?.document;
        return doc?.querySelector("#state")?.textContent === "Page 1, guide 1"
          && doc.querySelector("#disclosure")?.open && doc.querySelector("#pane")?.scrollTop === 230
          && Math.abs(win.scrollY - 510) <= 1 && (!focus || doc.activeElement?.id === "focus");
      }, focus);
      assert.equal(await page.frames()[1].evaluate(() => window.learnerActions), 0);
      assert.equal(await page.frames()[1].evaluate(() => sessionStorage.getItem("fixture:guideStarts")), "1");
      assert.equal(await frame.locator("#continue").isDisabled(), true);
      assert.equal(await page.evaluate(() => window.__academyLiveReviewMemory.get("retained")), true);
      assert.deepEqual(await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith("scormplayer:")))), progressBefore);
    };

    fs.writeFileSync(path.join(input, "lesson.js"), reviewLesson("after HMR"));
    await frame.locator("#revision").filter({ hasText: "after HMR" }).waitFor();
    await assertView(true);
    // A changed HTML document causes Vite's real full-reload path.
    await prepare();
    const oldDocument = await page.frames()[1].evaluate(() => { window.documentToken = Math.random(); return window.documentToken; });
    fs.appendFileSync(path.join(input, "index.html"), "<!-- full reload -->");
    await page.waitForFunction((old) => document.querySelector("iframe.sp-frame")?.contentWindow?.documentToken !== old, oldDocument);
    await assertView();
    await prepare();
    await reviewMenu(page, "Reload course");
    await assertView();
    assert.match(page.frames()[1].url(), /\/course\/preview\?section=second#reference$/);
    await prepare();
    await page.reload();
    await frame.locator("#state").waitFor();
    await assertView();
    assert.match(page.frames()[1].url(), /\/course\/preview\?section=second#reference$/);

    // Explicit reset discards review memory along with the learner restart.
    await reviewMenu(page, "Reset progress");
    await page.getByRole("menuitem", { name: "Click again to clear progress", exact: true }).click();
    await frame.locator("#state").filter({ hasText: "Page 0, guide 0" }).waitFor();
    assert.equal(await frame.locator("#disclosure").evaluate((element) => element.open), false);
    assert.equal(await page.frames()[1].evaluate(() => window.scrollY), 0);
  } finally { await page.close(); await player.close(); fs.rmSync(input, { recursive: true, force: true }); }
});

test("live review memory is isolated by tab, course and SCO; unsupported skips leave gates alone", async () => {
  const input = liveReviewCourse();
  const otherInput = liveReviewCourse();
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const { player, page } = await open({ input, live: true, registryDir: null }, context);
  let other;
  try {
    const frame = page.frameLocator("iframe.sp-frame");
    await frame.locator("#state").waitFor();
    await reviewMenu(page, "Skip to next page for review");
    await frame.locator("#state").filter({ hasText: "Page 1, guide 0" }).waitFor();
    other = await page.context().newPage();
    await other.goto(player.url);
    await other.frameLocator("iframe.sp-frame").locator("#state").filter({ hasText: "Page 0, guide 0" }).waitFor();

    // Live projects currently have one SCO; exercise the same scoped frame contract for a second SCO.
    await page.evaluate(() => {
      const original = document.querySelector("iframe.sp-frame");
      const frame = document.createElement("iframe");
      frame.id = "other-sco";
      const scope = JSON.parse(original.dataset.reviewScope);
      scope[1] = "other-sco";
      frame.dataset.reviewScope = JSON.stringify(scope);
      frame.src = "/course/";
      document.body.append(frame);
    });
    await page.frameLocator("#other-sco").locator("#state").filter({ hasText: "Page 0, guide 0" }).waitFor();
    await page.evaluate(() => document.querySelector("#other-sco").remove());

    await player.open(otherInput, { live: true });
    await page.reload();
    await frame.locator("#state").filter({ hasText: "Page 0, guide 0" }).waitFor();
    await page.frames()[1].evaluate(() => window.__SCORMPLAYER_REVIEW__.registerNavigation({}));
    await reviewMenu(page, "Skip to next guide step for review");
    await page.locator(".sp-toast").filter({ hasText: "doesn't support skipping guide steps" }).waitFor();
    assert.equal(await frame.locator("#state").innerText(), "Page 0, guide 0");
    assert.equal(await frame.locator("#continue").isDisabled(), true);
    assert.equal(await page.frames()[1].evaluate(() => window.learnerActions), 0);
    await player.open(input, { live: true });
    await page.reload();
    await frame.locator("#state").filter({ hasText: "Page 1, guide 0" }).waitFor();
  } finally {
    await other?.close(); await page.close(); await context.close(); await player.close();
    fs.rmSync(input, { recursive: true, force: true }); fs.rmSync(otherInput, { recursive: true, force: true });
  }
});

test("packaged review keeps ordinary learner requirements and receives no live review overrides", async () => {
  const input = navCourse();
  const { player, page } = await open({ input, registryDir: null });
  try {
    await page.frameLocator("iframe.sp-frame").locator("#title").waitFor();
    assert.equal(await page.frames()[1].evaluate(() => window.__SCORMPLAYER_REVIEW__), undefined);
    await page.getByRole("button", { name: "More", exact: true }).click();
    assert.equal(await page.getByRole("menuitem", { name: /Skip to next .* for review/ }).count(), 0);
    assert.equal(await page.frameLocator("iframe.sp-frame").locator(".driver-popover-next-btn").isDisabled(), true);
  } finally { await page.close(); await player.close(); fs.rmSync(path.dirname(input), { recursive: true, force: true }); }
});
