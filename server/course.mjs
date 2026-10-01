import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import AdmZip from "adm-zip";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { touchCacheEntry } from "./cache.mjs";

const VITE_CONFIGS = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs", "vite.config.cjs"];

/**
 * Resolve what the user pointed at into something the player can serve.
 *
 * - a `.zip`: extracted once into the cache (keyed by its SHA-256), then served as a package
 *
 * A zip or folder may hold several packages (several imsmanifest.xml files below its root):
 * `pkg` picks one by folder or title, otherwise the first is opened, and `packages` lists them all.
 * - a folder with `imsmanifest.xml` (at its root or inside one wrapper folder): served as is
 * - a Vite project (or any folder with `--live`): served from source through the project's own
 *   Vite, with hot reload
 *
 * @param {string} input
 * @param {{ cacheDir: string, live?: boolean, pinsFile?: string | null, pkg?: string | null }} options
 */
export function resolveCourse(input, { cacheDir, live = false, pinsFile = null, pkg = null }) {
  const target = path.resolve(input);
  if (!fs.existsSync(target)) throw new UserError(`Nothing found at ${target}.`);
  const stat = fs.statSync(target);

  if (stat.isFile()) {
    if (!/\.zip$/i.test(target)) throw new UserError(`${path.basename(target)} is not a .zip. Point scormplayer at a SCORM zip or a folder.`);
    const bytes = fs.readFileSync(target);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const root = path.join(cacheDir, "packages", sha256.slice(0, 16));
    if (!fs.existsSync(path.join(root, ".extracted"))) {
      fs.rmSync(root, { recursive: true, force: true });
      extractZip(bytes, root);
      fs.writeFileSync(path.join(root, ".extracted"), `${target}\n`);
    }
    touchCacheEntry(root);
    const chosen = choosePackage(root, { pkg });
    if (!chosen) throw new UserError(`No imsmanifest.xml in ${path.basename(target)}. A SCORM zip has one at its root or in a folder inside.`);
    return {
      kind: "package",
      source: target,
      ...readManifest(root, chosen.manifestPath),
      ...packageFields(chosen),
      sha256,
      pinsFile: pinsFile ? path.resolve(pinsFile) : siblingPinsFile(target, chosen),
    };
  }

  if (!stat.isDirectory()) throw new UserError(`${target} is neither a file nor a folder.`);
  const chosen = choosePackage(target, { pkg });
  const manifestPath = chosen?.manifestPath ?? null;
  const viteConfig = VITE_CONFIGS.find((name) => fs.existsSync(path.join(target, name))) ?? null;

  if (live || (!manifestPath && viteConfig)) {
    if (!fs.existsSync(path.join(target, "index.html"))) {
      throw new UserError(`Live mode needs an index.html in ${target}.`);
    }
    const manifest = manifestPath ? readManifest(target, manifestPath) : null;
    return {
      kind: "live",
      source: target,
      root: target,
      viteConfig: viteConfig ? path.join(target, viteConfig) : null,
      title: manifest?.title || readHtmlTitle(path.join(target, "index.html")) || path.basename(target),
      scormVersion: manifest?.scormVersion || detectVersionFromSource(target),
      launch: "",
      pinsFile: pinsFile ? path.resolve(pinsFile) : path.join(target, ".scormplayer", "pins.json"),
    };
  }

  if (!manifestPath) {
    throw new UserError(`No imsmanifest.xml in ${target}. Point scormplayer at a SCORM package, or add --live for a Vite project.`);
  }
  return {
    kind: "folder",
    source: target,
    ...readManifest(target, manifestPath),
    ...packageFields(chosen),
    pinsFile: pinsFile ? path.resolve(pinsFile) : siblingPinsFile(target, chosen),
  };
}

/** For a zip or folder holding several packages: which one is open, and all of them. */
function packageFields(chosen) {
  return chosen.packages.length > 1 ? { package: chosen.name, packages: chosen.packages } : {};
}

export class UserError extends Error {}

/**
 * `course.zip` → `course.pins.json`; `course/` → `course.pins.json` beside it. When it holds
 * several packages, each keeps its own pins: `bundle.lesson-2.pins.json`.
 */
export function siblingPinsFile(target, chosen = null) {
  const parsed = path.parse(target);
  const name = parsed.ext.toLowerCase() === ".zip" ? parsed.name : parsed.base;
  const part = chosen && chosen.packages.length > 1 ? `.${chosen.name.replace(/[^\w.-]+/g, "-")}` : "";
  return path.join(parsed.dir, `${name}${part}.pins.json`);
}

const MANIFEST_SKIP = new Set(["node_modules", "__MACOSX"]);

/**
 * Every package here: the imsmanifest.xml at the root, or else each one found in the folders up to
 * three levels down (exports often nest the package in a folder or two). A folder holding a
 * manifest is a package, so its own subfolders aren't searched.
 */
export function findManifests(dir, depth = 3) {
  const atRoot = path.join(dir, "imsmanifest.xml");
  if (fs.existsSync(atRoot)) return [atRoot];
  const found = [];
  const walk = (folder, left) => {
    let entries = [];
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || MANIFEST_SKIP.has(entry.name)) continue;
      const child = path.join(folder, entry.name);
      const manifest = path.join(child, "imsmanifest.xml");
      if (fs.existsSync(manifest)) found.push(manifest);
      else if (left > 1) walk(child, left - 1);
    }
  };
  walk(dir, depth);
  return found;
}

/**
 * Which package to open: the one `pkg` names (its folder, the end of its folder path, or part of
 * its title), otherwise the first. Null when there is none.
 *
 * @returns {{ manifestPath: string, name: string, packages: { name: string, title: string }[] } | null}
 */
export function choosePackage(dir, { pkg = null } = {}) {
  const manifests = findManifests(dir);
  if (!manifests.length) return null;
  const packages = manifests.map((file) => ({
    name: path.relative(dir, path.dirname(file)).split(path.sep).join("/") || ".",
    title: quickTitle(file),
  }));
  let index = 0;
  if (pkg) {
    const wanted = String(pkg).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    index = packages.findIndex((item) => item.name.toLowerCase() === wanted);
    if (index < 0) index = packages.findIndex((item) => item.name.toLowerCase().endsWith(`/${wanted}`));
    if (index < 0) index = packages.findIndex((item) => item.title.toLowerCase().includes(wanted));
    if (index < 0) throw new UserError(`No package "${pkg}" here. It holds: ${packages.map((item) => `${item.name} (${item.title})`).join(", ")}.`);
  }
  return { manifestPath: manifests[index], name: packages[index].name, packages };
}

/** The first package's manifest (see findManifests), or null. */
export function findManifest(dir, { required = true } = {}) {
  const manifest = findManifests(dir)[0] ?? null;
  if (!manifest && required) throw new UserError(`No imsmanifest.xml in ${dir}.`);
  return manifest;
}

function quickTitle(file) {
  try { return parseManifestXml(fs.readFileSync(file, "utf8")).title; }
  catch { return path.basename(path.dirname(file)); }
}

/** Title, SCORM version and launch path (relative to the served root) from the manifest. */
export function readManifest(root, manifestPath = findManifest(root)) {
  const xml = fs.readFileSync(manifestPath, "utf8");
  const parsed = parseManifestXml(xml);
  const wrapper = path.relative(root, path.dirname(manifestPath)).split(path.sep).join("/");
  const launch = [wrapper, parsed.href].filter(Boolean).join("/");
  const launchFile = path.resolve(root, launch.split(/[?#]/)[0]);
  if (!isInside(root, launchFile) || !fs.existsSync(launchFile)) {
    throw new UserError(`The manifest launches ${parsed.href}, but that file is not in the package.`);
  }
  // Every launchable item, for packages with more than one SCO.
  const scos = parsed.items
    .map((item) => ({ ...item, launch: [wrapper, item.href].filter(Boolean).join("/") }))
    .filter((item) => {
      const file = path.resolve(root, item.launch.split(/[?#]/)[0]);
      return isInside(root, file) && fs.existsSync(file);
    });
  return { root, title: parsed.title, scormVersion: parsed.scormVersion, launch, identifier: parsed.identifier, scos };
}

/** Parse the parts of imsmanifest.xml the player needs. Exported for tests. */
export function parseManifestXml(xml) {
  const validation = XMLValidator.validate(xml);
  if (validation !== true) throw new UserError(`imsmanifest.xml is not valid XML: ${validation.err?.msg ?? "unknown error"}`);
  const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true }).parse(xml);
  const manifest = doc.manifest;
  if (!manifest) throw new UserError("imsmanifest.xml has no <manifest> element.");

  const resources = list(manifest.resources?.resource);
  const organizations = manifest.organizations;
  const organization = list(organizations?.organization)
    .find((org) => org["@_identifier"] === organizations?.["@_default"]) ?? list(organizations?.organization)[0];
  const items = flattenItems(list(organization?.item));
  const launchItem = items.find((item) => item["@_identifierref"] && resources.some((r) => r["@_identifier"] === item["@_identifierref"] && r["@_href"]));
  const resource = launchItem
    ? resources.find((r) => r["@_identifier"] === launchItem["@_identifierref"])
    : resources.find((r) => r["@_href"]);
  if (!resource?.["@_href"]) throw new UserError("imsmanifest.xml has no launchable resource (no resource with an href).");
  const parameters = launchItem?.["@_parameters"] ? String(launchItem["@_parameters"]).trim() : "";
  const href = joinParameters(String(resource["@_href"]).trim(), parameters);

  const launchable = items
    .map((item) => {
      const res = resources.find((r) => r["@_identifier"] === item["@_identifierref"] && r["@_href"]);
      if (!res) return null;
      const itemParameters = item["@_parameters"] ? String(item["@_parameters"]).trim() : "";
      return { id: String(item["@_identifier"] ?? res["@_identifier"]), title: text(item.title) || String(res["@_identifier"]), href: joinParameters(String(res["@_href"]).trim(), itemParameters) };
    })
    .filter(Boolean);

  return {
    items: launchable.length ? launchable : [{ id: String(resource["@_identifier"] ?? "sco"), title: text(organization?.title) || "Course", href }],
    identifier: String(manifest["@_identifier"] ?? ""),
    title: text(organization?.title) || text(launchItem?.title) || text(manifest.metadata?.lom?.general?.title?.string) || "Untitled course",
    scormVersion: detectVersion(manifest, xml),
    href,
  };
}

function detectVersion(manifest, xml) {
  const schemaVersion = text(manifest.metadata?.schemaversion).toLowerCase();
  if (schemaVersion === "1.2") return "1.2";
  if (schemaVersion.includes("2004") || schemaVersion.includes("cam 1.3")) return "2004";
  if (/adlcp_rootv1p2/i.test(xml)) return "1.2";
  if (/adlcp_v1p3|imscp_v1p1.*2004|adlseq_v1p3/i.test(xml)) return "2004";
  return "1.2";
}

/** A Vite SCORM project has no manifest until it is packaged; look for the API it expects. */
function detectVersionFromSource(root) {
  const candidates = ["course.config.ts", "course.config.js", "scorm.config.ts", "scorm.config.js", "package.json"];
  for (const name of candidates) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, "utf8");
    if (/2004/.test(source)) return "2004";
    if (/["'`]1\.2["'`]/.test(source)) return "1.2";
  }
  return "both";
}

function readHtmlTitle(file) {
  const match = /<title>([^<]*)<\/title>/i.exec(fs.readFileSync(file, "utf8"));
  return match?.[1]?.trim() || null;
}

function joinParameters(href, parameters) {
  if (!parameters) return href;
  if (parameters.startsWith("#")) return `${href}${parameters}`;
  const query = parameters.replace(/^[?&]/, "");
  return href.includes("?") ? `${href}&${query}` : `${href}?${query}`;
}

function flattenItems(items) {
  return items.flatMap((item) => [item, ...flattenItems(list(item.item))]);
}

function list(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return text(value["#text"] ?? value.langstring ?? value.string ?? "");
  return String(value).trim();
}

/** Extract a zip, refusing absolute paths and `..` traversal. */
export function extractZip(bytes, destination) {
  const zip = new AdmZip(bytes);
  const root = path.resolve(destination);
  fs.mkdirSync(root, { recursive: true });
  for (const entry of zip.getEntries()) {
    const name = entry.entryName.replace(/\\/g, "/");
    if (!name || name.startsWith("__MACOSX/") || name.endsWith(".DS_Store")) continue;
    if (name.startsWith("/") || /^[a-zA-Z]:\//.test(name) || name.split("/").includes("..")) {
      throw new UserError(`Unsafe path in zip: ${entry.entryName}`);
    }
    const target = path.resolve(root, name);
    if (!isInside(root, target)) throw new UserError(`Unsafe path in zip: ${entry.entryName}`);
    if (entry.isDirectory) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.getData());
  }
}

export function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
