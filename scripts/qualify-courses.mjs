import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { chromium, firefox, webkit } from "playwright";
const playerModule = process.env.SCORMPLAYER_PACKAGE_ROOT
  ? pathToFileURL(path.join(path.resolve(process.env.SCORMPLAYER_PACKAGE_ROOT), "server/index.mjs"))
  : new URL("../server/index.mjs", import.meta.url);
const { startPlayer } = await import(playerModule.href);

// Exercise exact exported packages without writing to the source course or its pins.
const inputs = process.argv.slice(2).map((input) => path.resolve(input));
if (!inputs.length) throw new Error("Usage: npm run test:courses -- /path/to/course.zip [...]");
const output = path.resolve(process.env.SCORMPLAYER_QUALIFICATION_DIR ?? "artifacts/player-qualification");
fs.mkdirSync(output, { recursive: true });
const results = [];
const engineNames = (process.env.SCORMPLAYER_BROWSERS ?? "chromium,firefox,webkit").split(",");
for (const engineName of engineNames) {
  const engine = { chromium, firefox, webkit }[engineName];
  if (!engine) throw new Error(`Unknown browser: ${engineName}`);
  const browser = await engine.launch();
  try {
    for (const input of inputs) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scormplayer-qualification-"));
      const options = { input, cacheDir: path.join(dir, "cache"), pinsFile: path.join(dir, "pins.json"), port: 0, registryDir: null };
      const player = await startPlayer(options);
      let restart;
      const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("response", (response) => {
        if (response.status() >= 400 && new URL(response.url()).origin === new URL(player.url).origin) errors.push(`${response.status()} ${new URL(response.url()).pathname}`);
      });
      try {
        await page.goto(player.url);
        const frame = page.frameLocator("iframe.sp-frame");
        await frame.locator("body").waitFor();
        await page.waitForFunction(() => document.querySelector("iframe.sp-frame")?.contentDocument?.body.innerText.trim().length > 100);
        await page.waitForFunction(async () => {
          const state = await (await fetch("/api/scorm")).json();
          return Object.values(state.modules).some((data) => data["cmi.learner_id"] || data["cmi.core.student_id"]);
        });
        const dataOf = async (url) => Object.values((await (await fetch(`${url}api/scorm`)).json()).modules)[0];
        const locationOf = (data) => data["cmi.location"] ?? data["cmi.core.lesson_location"];
        const runtimeLocation = () => page.evaluate(() => window.API_1484_11.GetValue("cmi.location") || window.API.LMSGetValue("cmi.core.lesson_location"));
        await page.waitForFunction(() => window.API_1484_11.GetValue("cmi.location") || window.API.LMSGetValue("cmi.core.lesson_location"));
        const next = page.getByRole("button", { name: "Next page", exact: true });
        let navigated = false;
        if (await next.count() && await next.isEnabled()) {
          const before = await page.locator(".sp-nav__page").innerText();
          await next.click();
          await page.waitForFunction((before) => document.querySelector(".sp-nav__page")?.innerText !== before, before);
          navigated = true;
        }
        const location = await runtimeLocation();
        await page.waitForFunction(async (expected) => Object.values((await (await fetch("/api/scorm")).json()).modules)
          .some((data) => (data["cmi.location"] ?? data["cmi.core.lesson_location"]) === expected), location);
        assert.equal(locationOf(await dataOf(player.url)), location);
        let narration = false;
        const startGuide = frame.getByRole("button", { name: "Start guide", exact: true });
        if (await startGuide.count() && await startGuide.isVisible()) {
          await startGuide.click();
          await page.waitForFunction(() => Array.from(document.querySelector("iframe.sp-frame").contentWindow.__scormplayerMedia ?? [])
            .some((media) => !media.paused && media.currentTime > 0 && Number.isFinite(media.duration)), null, { timeout: 15000 });
          const media = await page.frames()[1].evaluateHandle(() => Array.from(window.__scormplayerMedia).find((media) => !media.paused && media.currentTime > 0));
          await page.keyboard.press(".");
          await page.frames()[1].waitForFunction((media) => media.ended, media);
          await media.dispose();
          if (await frame.locator(".driver-popover-next-btn").count()) {
            await page.waitForFunction(() => !document.querySelector("iframe.sp-frame").contentDocument.querySelector(".driver-popover-next-btn").disabled);
          }
          narration = true;
        }
        for (const [name, viewport] of [["desktop", { width: 1400, height: 900 }], ["tablet", { width: 1024, height: 768 }]]) {
          await page.setViewportSize(viewport);
          const view = page.getByRole("button", { name: name === "tablet" ? "Tablet" : "Desktop", exact: true });
          if (await view.count()) await view.click();
          await page.waitForTimeout(200);
          const width = await page.evaluate(() => document.documentElement.scrollWidth);
          assert.ok(width <= viewport.width + 1, `${engineName} ${name}: player overflows horizontally`);
          await page.screenshot({ path: path.join(output, `${path.basename(input, ".zip")}-${engineName}-${name}.png`) });
        }
        restart = await startPlayer(options);
        const resumed = await context.newPage();
        await resumed.goto(restart.url);
        await resumed.frameLocator("iframe.sp-frame").locator("body").waitFor();
        await resumed.waitForFunction(async (expected) => {
          const state = await (await fetch("/api/scorm")).json();
          return Object.values(state.modules).some((data) => (data["cmi.location"] ?? data["cmi.core.lesson_location"]) === expected
            && (data["cmi.entry"] ?? data["cmi.core.entry"]) === "resume");
        }, location);
        assert.deepEqual(errors, [], "Course errors or missing local assets");
        const result = { input, sha256: createHash("sha256").update(fs.readFileSync(input)).digest("hex"), title: player.course.title, engine: engineName, navigated, location, narrationPlayedAndSkipped: narration, resumedOnAnotherPort: true, sizes: ["desktop", "tablet"], errors };
        results.push(result);
        console.log(`${engineName}: ${player.course.title} — desktop/tablet, SCORM and restart passed`);
      } finally {
        await context.close(); await restart?.close(); await player.close();
        fs.rmSync(dir, { recursive: true, force: true });
        fs.writeFileSync(path.join(output, "results.json"), `${JSON.stringify({ checkedAt: new Date().toISOString(), platform: process.platform, results }, null, 2)}\n`);
      }
    }
  } finally { await browser.close(); }
}
