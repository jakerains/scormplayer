import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parse } from "yaml";

// Freeze the authored bytes at build time. Runtime requests never resolve filesystem paths.
export function buildSkillCatalog(directories, serverVersion) {
  const skills = [], files = [];
  const names = new Set();
  for (const directory of directories) {
    if (!fs.lstatSync(directory).isDirectory()) throw new Error("Skill roots must be regular directories.");
    const skillFile = path.join(directory, "SKILL.md");
    if (!fs.lstatSync(skillFile).isFile()) throw new Error("SKILL.md must be a regular file.");
    const text = fs.readFileSync(skillFile, "utf8");
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!match) throw new Error(`Missing skill frontmatter: ${directory}`);
    const frontmatter = parse(match[1], { stringKeys: true });
    const name = frontmatter?.name;
    if (typeof name !== "string" || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name !== path.basename(directory) || names.has(name)) throw new Error(`Invalid or duplicate skill name: ${directory}`);
    if (typeof frontmatter.description !== "string" || !frontmatter.description.trim() || frontmatter.description.length > 1024) throw new Error(`Invalid skill description: ${directory}`);
    names.add(name);
    const resources = [];
    let total = 0;
    const visit = (folder, segments = []) => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const relative = [...segments, entry.name];
        if (entry.isDirectory()) visit(path.join(folder, entry.name), relative);
        else if (entry.isFile()) {
          const bytes = fs.readFileSync(path.join(folder, entry.name));
          total += bytes.length;
          const uri = `skill://${name}/${relative.map(encodeURIComponent).join("/")}`;
          const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
          resources.push({ uri, digest, size: bytes.length });
          const extension = path.extname(entry.name).toLowerCase();
          const mimeType = extension === ".md" ? "text/markdown" : extension === ".json" ? "application/json" : [".txt", ".mjs", ".js", ".ts", ".py", ".sh", ".yaml", ".yml"].includes(extension) ? "text/plain" : "application/octet-stream";
          files.push({ uri, digest, size: bytes.length, mimeType, blob: bytes.toString("base64") });
          if (resources.length > 512 || total > 16_777_216) throw new Error(`Skill exceeds MCP file limits: ${name}`);
        } else throw new Error(`Skill assets must be regular files and directories: ${entry.name}`);
      }
    };
    visit(directory);
    skills.push({ uri: `skill://${name}/SKILL.md`, frontmatter, resources });
  }
  return { version: 1, serverVersion, skills, files };
}
