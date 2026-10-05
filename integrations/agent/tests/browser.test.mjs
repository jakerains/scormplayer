import assert from "node:assert/strict";
import test from "node:test";
import { launchPlayerBrowser } from "../src/browser.mjs";

test("browser launcher uses the system opener, rejects other destinations and reports failures", async () => {
  const calls = [];
  const execute = async (...args) => { calls.push(args); };
  await launchPlayerBrowser("http://127.0.0.1:4620/", { platform: "darwin", execute });
  await launchPlayerBrowser("http://127.0.0.1:4620/", { platform: "linux", execute });
  assert.deepEqual(calls.map(([command, args]) => [command, args]), [["open", ["http://127.0.0.1:4620/"]], ["xdg-open", ["http://127.0.0.1:4620/"]]]);
  for (const url of ["https://other.example/", "file:///tmp/course", "http://127.0.0.1:4620/course/", "http://user@127.0.0.1:4620/", "http://127.0.0.1:4620/?command=open"]) {
    await assert.rejects(launchPlayerBrowser(url, { execute }), /registered loopback/);
  }
  assert.equal(calls.length, 2);
  await assert.rejects(launchPlayerBrowser("http://127.0.0.1:4620/", { execute: async () => { throw new Error("No browser installed"); } }), /Copy this player address/);
});
