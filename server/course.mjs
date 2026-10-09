import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import AdmZip from "adm-zip";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { touchCacheEntry, withCacheLock } from "./cache.mjs";

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
export function resolveCourse(input, options) {
  return withCacheLock(options.cacheDir, () => resolveUnlocked(input, options));
}

function resolveUnlocked(input, { cacheDir, live = false, pinsFile = null, pkg = null }) {
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
    if (!chosen) throw new UserError(`No imsmanifest.xml (nor cmi5.xml or tincan.xml) in ${path.basename(target)}. A SCORM zip has one at its root or in a folder inside.`);
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
    throw new UserError(`No imsmanifest.xml (nor cmi5.xml or tincan.xml) in ${target}. Point scormplayer at a SCORM, cmi5 or xAPI package, or add --live for a Vite project.`);
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
/** What describes a course in its folder: a SCORM manifest, a cmi5 course structure, or an xAPI (Tin Can) package. */
export const DESCRIPTORS = ["imsmanifest.xml", "cmi5.xml", "tincan.xml"];

/** The course descriptor in this folder, SCORM first, or null. */
export function descriptorIn(dir) {
  for (const name of DESCRIPTORS) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/**
 * Every package here: the imsmanifest.xml at the root, or else each one found in the folders up to
 * three levels down (exports often nest the package in a folder or two). A folder holding a
 * manifest is a package, so its own subfolders aren't searched.
 */
export function findManifests(dir, depth = 3) {
  const atRoot = descriptorIn(dir);
  if (atRoot) return [atRoot];
  const found = [];
  const walk = (folder, left) => {
    let entries = [];
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || MANIFEST_SKIP.has(entry.name)) continue;
      const child = path.join(folder, entry.name);
      const manifest = descriptorIn(child);
      if (manifest) found.push(manifest);
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
  if (!manifest && required) throw new UserError(`No imsmanifest.xml (nor cmi5.xml or tincan.xml) in ${dir}.`);
  return manifest;
}

function quickTitle(file) {
  try { return parseDescriptor(file, fs.readFileSync(file, "utf8")).title; }
  catch { return path.basename(path.dirname(file)); }
}

/** Title, SCORM version and launch path (relative to the served root) from the manifest. */
export function readManifest(root, manifestPath = findManifest(root)) {
  const xml = fs.readFileSync(manifestPath, "utf8");
  const parsed = parseDescriptor(manifestPath, xml);
  const wrapper = path.relative(root, path.dirname(manifestPath)).split(path.sep).join("/");
  const launch = [wrapper, parsed.href].filter(Boolean).join("/");
  const launchFile = path.resolve(root, decodeLaunch(launch));
  if (!isInside(root, launchFile) || !fs.existsSync(launchFile)) {
    throw new UserError(`The manifest launches ${parsed.href}, but that file is not in the package.`);
  }
  // Every launchable item, for packages with more than one SCO.
  const scos = parsed.items
    .map((item) => ({ ...item, launch: [wrapper, item.href].filter(Boolean).join("/") }))
    .filter((item) => {
      const file = path.resolve(root, decodeLaunch(item.launch));
      return isInside(root, file) && fs.existsSync(file);
    });
  return { root, title: parsed.title, scormVersion: parsed.scormVersion, standard: parsed.standard, launch, identifier: parsed.identifier, scos };
}

/** Parse whichever course descriptor this is. */
function parseDescriptor(file, xml) {
  const name = path.basename(file).toLowerCase();
  if (name === "cmi5.xml") return parseCmi5Xml(xml);
  if (name === "tincan.xml") return parseTincanXml(xml);
  return { ...parseManifestXml(xml), standard: "scorm" };
}

function parseXml(xml, name) {
  const validation = XMLValidator.validate(xml);
  if (validation !== true) throw new UserError(`${name} is not valid XML: ${validation.err?.msg ?? "unknown error"}`);
  return new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true }).parse(xml);
}

/**
 * A cmi5 course structure: each assignable unit (AU) in a local file becomes a module, with
 * what the LMS needs to launch it (its activity id, moveOn, mastery score, launch parameters).
 */
export function parseCmi5Xml(xml) {
  const structure = parseXml(xml, "cmi5.xml").courseStructure;
  if (!structure) throw new UserError("cmi5.xml has no <courseStructure> element.");
  const aus = [];
  const collect = (node) => { aus.push(...list(node?.au)); for (const block of list(node?.block)) collect(block); };
  collect(structure);
  const items = aus
    .filter((au) => au["@_id"] && text(au.url) && !/^[a-z][a-z0-9+.-]*:/i.test(text(au.url)))
    .map((au) => ({
      id: String(au["@_id"]),
      title: text(au.title) || String(au["@_id"]),
      href: text(au.url),
      runtime: {},
      cmi5: {
        moveOn: String(au["@_moveOn"] ?? "NotApplicable"),
        ...(au["@_masteryScore"] !== undefined ? { masteryScore: Number(au["@_masteryScore"]) } : {}),
        launchMethod: String(au["@_launchMethod"] ?? "AnyWindow"),
        launchParameters: text(au.launchParameters),
        entitlementKey: text(au.entitlementKey),
      },
    }));
  if (!items.length) throw new UserError("cmi5.xml has no assignable unit (<au>) with a <url> inside the package.");
  return {
    items,
    identifier: String(structure.course?.["@_id"] ?? ""),
    title: text(structure.course?.title) || items[0].title || "Untitled course",
    scormVersion: null,
    standard: "cmi5",
    href: items[0].href,
  };
}

/** An xAPI (Tin Can) package: tincan.xml names the activity and the file that launches it. */
export function parseTincanXml(xml) {
  const activities = list(parseXml(xml, "tincan.xml").tincan?.activities?.activity);
  const launchable = activities.filter((activity) => text(activity.launch));
  if (!launchable.length) throw new UserError("tincan.xml has no activity with a <launch> file.");
  // Prefer the course activity; packages often list their modules and questions as well.
  const course = launchable.find((activity) => /\/course$/.test(String(activity["@_type"] ?? ""))) ?? launchable[0];
  const ordered = [course, ...launchable.filter((activity) => activity !== course && !/\/(course|cmi\.interaction)$/.test(String(activity["@_type"] ?? "")))];
  const items = ordered.map((activity) => ({
    id: String(activity["@_id"] ?? text(activity.launch)),
    title: text(activity.name) || String(activity["@_id"] ?? "Course"),
    href: text(activity.launch),
    runtime: {},
  }));
  return { items, identifier: String(course["@_id"] ?? ""), title: items[0].title, scormVersion: null, standard: "xapi", href: items[0].href };
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
      return { id: String(item["@_identifier"] ?? res["@_identifier"]), title: text(item.title) || String(res["@_identifier"]), href: joinParameters(String(res["@_href"]).trim(), itemParameters), runtime: itemRuntime(item) };
    })
    .filter(Boolean);

  return {
    items: launchable.length ? launchable : [{ id: String(resource["@_identifier"] ?? "sco"), title: text(organization?.title) || "Course", href, runtime: {} }],
    identifier: String(manifest["@_identifier"] ?? ""),
    title: text(organization?.title) || text(launchItem?.title) || text(manifest.metadata?.lom?.general?.title?.string) || "Untitled course",
    scormVersion: detectVersion(manifest, xml),
    href,
  };
}

/**
 * What the manifest tells the LMS to hand one SCO at launch: SCORM 1.2's mastery score and
 * launch data, SCORM 2004's completion threshold and passing score, and time limits.
 */
export function itemRuntime(item) {
  const runtime = {};
  const set = (key, value) => { const clean = text(value); if (clean) runtime[key] = clean; };
  set("masteryScore", field(item, "masteryscore"));
  set("dataFromLms", field(item, "datafromlms"));
  set("maxTimeAllowed", field(item, "maxtimeallowed"));
  set("timeLimitAction", field(item, "timelimitaction"));
  const threshold = field(item, "completionThreshold");
  if (threshold !== undefined) {
    // 2004 4th edition puts it in an attribute (completedByMeasure decides whether it applies); 3rd edition uses the text.
    const byMeasure = typeof threshold === "object" ? threshold["@_completedByMeasure"] : undefined;
    const measure = typeof threshold === "object" ? threshold["@_minProgressMeasure"] ?? threshold["#text"] : threshold;
    if (byMeasure === undefined || String(byMeasure) === "true") set("completionThreshold", measure ?? "1.0");
  }
  const sequencing = field(item, "sequencing");
  const limit = field(field(sequencing, "limitConditions"), "@_attemptAbsoluteDurationLimit");
  if (limit) set("maxTimeAllowed", limit);
  const primary = field(field(sequencing, "objectives"), "primaryObjective");
  if (primary && String(primary["@_satisfiedByMeasure"]) === "true") set("scaledPassingScore", field(primary, "minNormalizedMeasure") ?? "1.0");
  return runtime;
}

/** A child element or attribute, ignoring case (SCORM 1.2 manifests vary). */
function field(node, name) {
  if (!node || typeof node !== "object") return undefined;
  const wanted = name.toLowerCase();
  const key = Object.keys(node).find((candidate) => candidate.toLowerCase() === wanted);
  const value = key === undefined ? undefined : node[key];
  return Array.isArray(value) ? value[0] : value;
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
  if (Array.isArray(value)) return text(value[0]);
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

function decodeLaunch(launch) {
  try { return decodeURIComponent(launch.split(/[?#]/)[0]); }
  catch { throw new UserError(`Invalid encoded launch path: ${launch}`); }
}
