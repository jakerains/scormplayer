import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithOxc } from "vite";

// The client modules import each other, so compile them side by side into a temporary folder.
const out = fs.mkdtempSync(path.join(os.tmpdir(), "scormplayer-api-"));
for (const name of ["scorm-model", "scorm-api"]) {
  const source = fs.readFileSync(new URL(`../client/src/${name}.ts`, import.meta.url), "utf8");
  const { code } = await transformWithOxc(source, `${name}.ts`);
  fs.writeFileSync(path.join(out, `${name}.mjs`), code.replace(/from "\.\/([\w-]+)"/g, 'from "./$1.mjs"'));
}
const { installScormApis } = await import(pathToFileURL(path.join(out, "scorm-api.mjs")).href);
const { parseDuration, formatDuration, parseTimespan, formatTimespan } = await import(pathToFileURL(path.join(out, "scorm-model.mjs")).href);

function launch(options = {}) {
  const timers = [];
  const win = { setTimeout: (fn) => timers.push(fn) };
  const lms = installScormApis(win, "test", { initialData: {}, ...options });
  return { lms, api12: win.API, api2004: win.API_1484_11, flush: () => timers.splice(0).forEach((fn) => fn()) };
}

test("forgiving mode accepts spec departures but reports each one as an issue", () => {
  const { lms, api12 } = launch();
  assert.equal(api12.LMSSetValue("cmi.core.lesson_status", "completed"), "true", "before Initialize still stores");
  api12.LMSInitialize("");
  assert.equal(api12.LMSSetValue("cmi.core.student_name", "Someone"), "true");
  assert.equal(api12.LMSSetValue("cmi.core.lesson_status", "done"), "true");
  assert.equal(api12.LMSSetValue("cmi.completion_status", "completed"), "true");
  assert.equal(api12.LMSSetValue("cmi.suspend_data", "x".repeat(5000)), "true");
  const messages = lms.issues().map((issue) => issue.message).join("\n");
  assert.match(messages, /before Initialize/);
  assert.match(messages, /read-only/);
  assert.match(messages, /"done" isn't one of/);
  assert.match(messages, /SCORM 2004 element; this call went to the SCORM 1\.2 API/);
  assert.match(messages, /5,000 characters, over the 4,096 allowed/);
  assert.ok(lms.issues().every((issue) => !issue.rejected));
});

test("strict mode fails bad calls with the spec's error codes", () => {
  const { api12, api2004 } = launch({ settings: { learnerId: "u1", learnerName: "Doe, Jo", mode: "normal", credit: "credit", strict: true } });
  assert.equal(api2004.GetValue("cmi.location"), "");
  assert.equal(api2004.GetLastError(), "122");
  assert.equal(api2004.Initialize(""), "true");
  assert.equal(api2004.Initialize(""), "false");
  assert.equal(api2004.GetLastError(), "103");
  assert.equal(api2004.GetValue("cmi.learner_name"), "Doe, Jo");
  assert.equal(api2004.SetValue("cmi.learner_id", "x"), "false");
  assert.equal(api2004.GetLastError(), "404");
  assert.equal(api2004.SetValue("cmi.score.scaled", "1.5"), "false");
  assert.equal(api2004.GetLastError(), "407");
  assert.equal(api2004.SetValue("cmi.success_status", "done"), "false");
  assert.equal(api2004.GetLastError(), "406");
  assert.equal(api2004.SetValue("cmi.interactions.1.id", "q2"), "false");
  assert.equal(api2004.GetLastError(), "351");
  assert.equal(api2004.SetValue("cmi.interactions.0.result", "correct"), "false");
  assert.equal(api2004.GetLastError(), "408");
  assert.equal(api2004.SetValue("cmi.interactions.0.id", "q1"), "true");
  assert.equal(api2004.SetValue("cmi.interactions.0.result", "correct"), "true");
  assert.equal(api2004.GetValue("cmi.interactions._count"), "1");
  assert.equal(api2004.GetValue("cmi.session_time"), "");
  assert.equal(api2004.GetLastError(), "405");
  assert.match(api2004.GetDiagnostic(""), /write-only/);
  assert.equal(api2004.GetValue("cmi.core.lesson_status"), "");
  assert.equal(api2004.GetLastError(), "401");
  assert.equal(api2004.GetValue("cmi.suspend_data"), "");
  assert.equal(api2004.GetLastError(), "403");
  assert.equal(api2004.Terminate(""), "true");
  assert.equal(api2004.SetValue("cmi.location", "p2"), "false");
  assert.equal(api2004.GetLastError(), "133");
  assert.equal(api12.LMSGetValue("cmi.core.lesson_status"), "");
  assert.equal(api12.LMSGetLastError(), "301");
  assert.equal(api12.LMSGetErrorString("301"), "Not initialized");
});

test("the LMS applies manifest thresholds, adds session time and decides entry from exit", () => {
  const runtime = { masteryScore: "80", dataFromLms: "lang=fr" };
  const first = launch({ runtime });
  first.api12.LMSInitialize("");
  assert.equal(first.api12.LMSGetValue("cmi.core.entry"), "ab-initio");
  assert.equal(first.api12.LMSGetValue("cmi.launch_data"), "lang=fr");
  assert.equal(first.api12.LMSGetValue("cmi.student_data.mastery_score"), "80");
  first.api12.LMSSetValue("cmi.core.lesson_status", "completed");
  first.api12.LMSSetValue("cmi.core.score.raw", "72");
  first.api12.LMSSetValue("cmi.core.session_time", "0000:10:30");
  first.api12.LMSSetValue("cmi.core.exit", "suspend");
  first.api12.LMSSetValue("cmi.suspend_data", "page=3");
  first.api12.LMSFinish("");
  const saved = first.lms.data();
  assert.equal(saved["cmi.core.lesson_status"], "failed");
  assert.equal(saved["cmi.core.total_time"], "0000:10:30");
  assert.ok(first.lms.calls().some((call) => call.method === "LMS" && /mastery score 80/.test(call.result)));

  const second = launch({ runtime, initialData: saved });
  second.api12.LMSInitialize("");
  assert.equal(second.api12.LMSGetValue("cmi.core.entry"), "resume");
  second.api12.LMSSetValue("cmi.core.session_time", "00:05:00");
  second.api12.LMSFinish("");
  assert.equal(second.lms.data()["cmi.core.total_time"], "0000:15:30");

  const third = launch({ runtime, initialData: second.lms.data() });
  third.api12.LMSInitialize("");
  // The second session didn't suspend, so a real LMS wouldn't resume; the forgiving player does and says so.
  assert.equal(third.api12.LMSGetValue("cmi.core.entry"), "resume");
  assert.ok(third.lms.issues().some((issue) => /didn't set cmi\.core\.exit to "suspend"/.test(issue.message)));
});

test("SCORM 2004 thresholds decide completion and success, and strict mode starts new attempts", () => {
  const runtime = { completionThreshold: "0.8", scaledPassingScore: "0.7" };
  const strict = { learnerId: "a", learnerName: "b", mode: "normal", credit: "credit", strict: true };
  const { lms, api2004 } = launch({ runtime, settings: strict });
  api2004.Initialize("");
  api2004.SetValue("cmi.completion_status", "completed");
  assert.equal(api2004.GetValue("cmi.completion_status"), "unknown");
  api2004.SetValue("cmi.progress_measure", "0.5");
  assert.equal(api2004.GetValue("cmi.completion_status"), "incomplete");
  api2004.SetValue("cmi.score.scaled", "0.75");
  assert.equal(api2004.GetValue("cmi.success_status"), "passed");
  api2004.SetValue("cmi.location", "p4");
  api2004.SetValue("cmi.session_time", "PT1M30S");
  api2004.Terminate("");
  assert.equal(lms.data()["cmi.completion_status"], "incomplete");
  assert.equal(lms.data()["cmi.total_time"], "PT0H1M30S");

  const next = launch({ runtime, settings: strict, initialData: lms.data() });
  next.api2004.Initialize("");
  assert.equal(next.api2004.GetValue("cmi.entry"), "ab-initio");
  assert.equal(next.api2004.GetValue("cmi.location"), "");
  assert.ok(next.lms.issues().some((issue) => /Started a new attempt/.test(issue.message)));
});

test("adl.nav.request moves between SCOs after Terminate", () => {
  const requests = [];
  const { api2004, flush } = launch({ navigation: { ids: ["a", "b", "c"], index: 1 }, onNavRequest: (request) => requests.push(request) });
  api2004.Initialize("");
  assert.equal(api2004.GetValue("adl.nav.request_valid.continue"), "true");
  assert.equal(api2004.GetValue("adl.nav.request_valid.previous"), "true");
  assert.equal(api2004.GetValue("adl.nav.request_valid.choice.{target=c}"), "true");
  assert.equal(api2004.GetValue("adl.nav.request_valid.choice.{target=z}"), "false");
  api2004.SetValue("adl.nav.request", "{target=c}choice");
  api2004.Terminate("");
  assert.deepEqual(requests, []);
  flush();
  assert.deepEqual(requests, [{ request: "{target=c}choice", index: 2 }]);
});

test("time formats round-trip", () => {
  assert.equal(parseDuration("PT1H2M3.5S"), 3723.5);
  assert.equal(parseDuration("P1DT1S"), 86401);
  assert.equal(parseDuration("PT"), null);
  assert.equal(formatDuration(3723.5), "PT1H2M3.5S");
  assert.equal(parseTimespan("0001:02:03.50"), 3723.5);
  assert.equal(formatTimespan(3723.5), "0001:02:03.50");
});
