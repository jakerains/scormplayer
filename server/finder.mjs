import fs from "node:fs";
import path from "node:path";
import { CONFIG_FILE, configuredCourses, findConfig } from "./config.mjs";
import { findManifests } from "./course.mjs";

const VITE_CONFIGS = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs", "vite.config.cjs"];
const SKIP = new Set(["node_modules", "dist-scorm", ".git", ".cache", "coverage", "__MACOSX"]);

/**
 * What can be opened from here: SCORM zips, SCORM folders and Vite course projects, from the
 * project's scormplayer.config.json `courses` when there is one, otherwise from this folder and
 * the two levels below it.
 *
 * @returns {{ path: string, kind: "zip" | "folder" | "live", title: string }[]}
 */
export function findCourses(cwd = process.cwd()) {
  const config = findConfig(cwd);
  // A project below here that declares its courses wins over a blind scan (which would also find
  // unrelated Vite apps).
  const configs = config ? [config] : nestedConfigs(cwd, 2);
  const configured = configs.flatMap(configuredCourses);
  const candidates = configured.length ? configured : scan(cwd, 2);
  return candidates.map(describe).filter(Boolean);
}

/** Is this folder itself something scormplayer opens directly? */
export function isCourseFolder(dir) {
  const course = describe(dir);
  if (!course) return false;
  if (course.kind !== "folder" || fs.existsSync(path.join(dir, "imsmanifest.xml"))) return true;
  // A wrapper with one manifest can also hold other course ZIPs or live projects.
  // Keep the picker in that case instead of silently opening only the manifest.
  return scan(dir, 2).map(describe).filter(Boolean).length <= 1;
}

function nestedConfigs(dir, depth) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
    const child = path.join(dir, entry.name);
    if (fs.existsSync(path.join(child, CONFIG_FILE))) out.push(findConfig(child));
    else if (depth > 1) out.push(...nestedConfigs(child, depth - 1));
  }
  return out;
}

function scan(dir, depth) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isFile() && /\.zip$/i.test(entry.name)) out.push(full);
    if (!entry.isDirectory()) continue;
    if (describe(full)) out.push(full);
    else if (depth > 1) out.push(...scan(full, depth - 1));
  }
  return out.slice(0, 200);
}

function describe(target) {
  let stat;
  try { stat = fs.statSync(target); } catch { return null; }
  if (stat.isFile()) {
    return /\.zip$/i.test(target) && zipHasManifest(target)
      ? { path: target, kind: "zip", title: path.basename(target) }
      : null;
  }
  // One package (at the root or in a wrapper folder or two) is a course. Several mean this is a
  // folder of courses: not one itself, so the scan goes on into it and lists each.
  const manifests = findManifests(target, 2);
  if (manifests.length === 1) return { path: target, kind: "folder", title: manifestTitle(manifests[0]) || path.basename(target) };
  if (manifests.length > 1) return null;
  const vite = VITE_CONFIGS.some((name) => fs.existsSync(path.join(target, name)));
  const html = path.join(target, "index.html");
  if (vite && fs.existsSync(html)) return { path: target, kind: "live", title: htmlTitle(html) || path.basename(target) };
  return null;
}

/** Look for imsmanifest.xml in the zip's central directory (the end of the file) without unpacking. */
function zipHasManifest(file) {
  try {
    const size = fs.statSync(file).size;
    const length = Math.min(size, 4 * 1024 * 1024);
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(file, "r");
    fs.readSync(fd, buffer, 0, length, size - length);
    fs.closeSync(fd);
    return /imsmanifest\.xml/i.test(buffer.toString("latin1"));
  } catch {
    return false;
  }
}

function manifestTitle(file) {
  const xml = fs.readFileSync(file, "utf8");
  const organization = /<organization\b[\s\S]*?<title>([^<]+)<\/title>/i.exec(xml);
  return organization?.[1]?.trim() || null;
}

function htmlTitle(file) {
  return /<title>([^<]*)<\/title>/i.exec(fs.readFileSync(file, "utf8"))?.[1]?.trim() || null;
}
