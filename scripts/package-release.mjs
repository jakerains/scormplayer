import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, "artifacts", "standalone");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const packed = JSON.parse(execFileSync(npm, ["pack", "--ignore-scripts", "--pack-destination", out, "--json"], { cwd: root, encoding: "utf8", shell: process.platform === "win32" }));
// npm 12 returns an object keyed by package name; earlier npm returns an array.
const packages = Array.isArray(packed) ? packed : Object.values(packed);
const filename = packages.find((item) => item.name === "@jakerains/scormplayer" && item.version === version)?.filename;
if (filename !== `jakerains-scormplayer-${version}.tgz`) throw new Error("npm pack did not return the expected SCORM Player package.");
const names = [`scormplayer-${version}-standalone.tar.gz`, filename];
const checksums = names.map((name) => `${createHash("sha256").update(fs.readFileSync(path.join(out, name))).digest("hex")}  ${name}\n`).join("");
fs.writeFileSync(path.join(out, "SHA256SUMS"), checksums);
console.log(`Packed ${filename}; GitHub and npm publish this exact file. Checksums include both installation formats.`);
