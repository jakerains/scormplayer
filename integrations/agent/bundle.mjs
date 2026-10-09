import { build } from "esbuild";
import { buildAppHtml } from "@json-render/mcp/build-app-html";
import fs from "node:fs";
import { buildSkillCatalog } from "./skill-catalog.mjs";

fs.rmSync("dist", { recursive: true, force: true });
await build({ entryPoints: ["views/review/main.tsx"], bundle: true, platform: "browser", format: "iife", target: "es2022", outfile: "dist/review.js", minify: true, jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } });
fs.writeFileSync("dist/review.html", buildAppHtml({ title: "SCORM pin checklist", js: fs.readFileSync("dist/review.js", "utf8"), css: fs.readFileSync("dist/review.css", "utf8") }));
fs.cpSync("../../dist/client", "dist/player-client", { recursive: true });
fs.cpSync("assets", "dist/assets", { recursive: true });
const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
fs.writeFileSync("dist/skills.json", JSON.stringify(buildSkillCatalog(["plugin/skills/scormplayer-review", "plugin/skills/scormplayer-qa", "../../skills/scormplayer"], version)) + "\n");
await build({ entryPoints: ["stdio.ts"], bundle: true, platform: "node", format: "esm", target: "node22", outfile: "dist/server.mjs", sourcemap: false,
  banner: { js: 'import { createRequire as scormBundleRequire } from "node:module"; const require = scormBundleRequire(import.meta.url);' },
});
await build({ entryPoints: ["../../server/source-worker.mjs"], bundle: true, platform: "node", format: "esm", target: "node22", outfile: "dist/source-worker.mjs" });
