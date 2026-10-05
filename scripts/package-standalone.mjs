import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { build } from "../integrations/agent/node_modules/esbuild/lib/main.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const out = path.join(root, "artifacts", "standalone");
fs.mkdirSync(out, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), "scormplayer-standalone-"));
try {
  const bundle = path.join(work, "scormplayer");
  fs.mkdirSync(path.join(bundle, "bin"), { recursive: true });
  for (const name of ["dist", "skills"]) fs.cpSync(path.join(root, name), path.join(bundle, name), { recursive: true });
  for (const name of ["package.json", "LICENSE", "README.md"]) fs.copyFileSync(path.join(root, name), path.join(bundle, name));
  const options = { bundle: true, platform: "node", format: "esm", target: "node20", banner: { js: 'import { createRequire as standaloneRequire } from "node:module"; const require = standaloneRequire(import.meta.url);' } };
  await build({ ...options, entryPoints: [path.join(root, "bin/scormplayer.mjs")], outfile: path.join(bundle, "bin/scormplayer.mjs") });
  await build({ ...options, entryPoints: [path.join(root, "server/source-worker.mjs")], outfile: path.join(bundle, "bin/source-worker.mjs") });
  const installer = fs.readFileSync(path.join(root, "install.sh"), "utf8").replace('DEFAULT_VERSION="latest"', `DEFAULT_VERSION="v${version}"`);
  fs.writeFileSync(path.join(out, "install.sh"), installer, { mode: 0o755 });
  fs.writeFileSync(path.join(bundle, "install.sh"), installer, { mode: 0o755 });
  const archive = `scormplayer-${version}-standalone.tar.gz`;
  execFileSync("tar", ["-czf", path.join(out, archive), "-C", work, "scormplayer"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const digest = createHash("sha256").update(fs.readFileSync(path.join(out, archive))).digest("hex");
  fs.writeFileSync(path.join(out, "SHA256SUMS"), `${digest}  ${archive}\n`);
  console.log(`Built ${archive} with browser CLI, MCP and bundled guides; no npm dependencies required at runtime.`);
} finally { fs.rmSync(work, { recursive: true, force: true }); }
