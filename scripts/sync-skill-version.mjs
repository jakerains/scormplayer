// Stamp the agent skill with the package version (run by `npm version`), so scormplayer can tell
// whether an installed copy of the skill matches the player it came with.
import fs from "node:fs";

const version = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const file = new URL("../skills/scormplayer/SKILL.md", import.meta.url);
const text = fs.readFileSync(file, "utf8");
const end = text.indexOf("\n---", 4);
if (!text.startsWith("---\n") || end < 0) throw new Error("SKILL.md has no frontmatter.");
const front = text.slice(4, end);
const stamped = /^metadata:\n {2}version: .*$/m.test(front)
  ? front.replace(/^metadata:\n {2}version: .*$/m, `metadata:\n  version: "${version}"`)
  : `${front}\nmetadata:\n  version: "${version}"`;
fs.writeFileSync(file, `---\n${stamped}${text.slice(end)}`);
console.log(`Stamped the agent skill with ${version}.`);
