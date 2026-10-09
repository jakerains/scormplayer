import fs from "node:fs";
import path from "node:path";
import { XMLParser } from "fast-xml-parser";
import { findManifests, isInside } from "./course.mjs";

/**
 * Package checks: problems an LMS upload or launch is likely to hit, found by reading the
 * package without running it. Each finding has a severity (error: an LMS will likely fail;
 * warning: some LMSs or learners will have trouble; info: worth knowing) and, where it applies,
 * the file it is about. This complements the runtime issues the player records while the course
 * runs; neither is LMS conformance certification.
 *
 * @param {{ kind: string, root: string, package?: string, sha256?: string, standard?: string }} course
 * @returns {{ ok: boolean, counts: { error: number, warning: number, info: number }, files: number, bytes: number, findings: Finding[] }}
 *
 * @typedef {{ severity: "error" | "warning" | "info", code: string, message: string, file?: string, examples?: string[] }} Finding
 */
export function checkPackage(course) {
  /** @type {Finding[]} */
  const findings = [];
  const add = (severity, code, message, extra = {}) => findings.push({ severity, code, message, ...extra });
  const root = path.resolve(course.root);
  const files = listFiles(root);
  const lower = new Map(files.map((file) => [file.toLowerCase(), file]));
  const bytes = files.reduce((sum, file) => sum + size(path.join(root, file)), 0);

  if (course.kind === "live") {
    add("info", "live-source", "This is a live course served from source. Package checks look at a packaged SCORM, xAPI or cmi5 course; package it and open the zip to check it.");
    return result(findings, files, bytes);
  }

  // Where the course description sits: an LMS needs it at the root of the zip it is given.
  const manifests = findManifests(root);
  const manifestPath = manifests.find((file) => path.relative(root, path.dirname(file)).split(path.sep).join("/") === (course.package && course.package !== "." ? course.package : "")) ?? manifests[0];
  if (!manifestPath) {
    add("error", "no-manifest", "No imsmanifest.xml, cmi5.xml or tincan.xml was found.");
    return result(findings, files, bytes);
  }
  const base = path.dirname(manifestPath);
  const manifestName = path.relative(root, manifestPath).split(path.sep).join("/");
  if (base !== root && course.kind === "package" && manifests.length === 1) {
    add("error", "manifest-not-at-root", `${path.basename(manifestPath)} is inside ${path.dirname(manifestName)}/, not at the root of the zip. Most LMSs reject the upload; zip the contents of that folder instead.`, { file: manifestName });
  }

  /** Does the package hold this path (relative to the manifest's folder)? Reports case-only mismatches. */
  const resolveRef = (href, from) => {
    const clean = stripQuery(href);
    if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean)) return { external: true };
    let decoded;
    try { decoded = decodeURIComponent(clean); } catch { decoded = clean; }
    const full = path.resolve(base, decoded);
    if (!isInside(root, full)) return { outside: true };
    const relative = path.relative(root, full).split(path.sep).join("/");
    if (files.includes(relative)) return { file: relative };
    const other = lower.get(relative.toLowerCase());
    if (other) return { caseOnly: other, file: relative };
    return { missing: relative, from };
  };
  const reportRef = (href, what) => {
    const found = resolveRef(href, what);
    if (found.outside) add("error", "outside-package", `${what} points outside the package: ${href}`, { file: manifestName });
    else if (found.caseOnly) add("error", "case-mismatch", `${what} is ${found.file}, but the file is named ${found.caseOnly}. That works on Windows and macOS but fails on LMSs that run on Linux.`, { file: found.caseOnly });
    else if (found.missing) add("error", "missing-file", `${what} is ${found.missing}, which isn't in the package.`, { file: found.missing });
    return found;
  };

  const xml = fs.readFileSync(manifestPath, "utf8");
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true });
  let doc;
  try { doc = parser.parse(xml); }
  catch (error) {
    add("error", "manifest-xml", `${manifestName} isn't valid XML: ${error.message}`, { file: manifestName });
    return result(findings, files, bytes);
  }

  const kind = path.basename(manifestPath).toLowerCase();
  const referenced = new Set([manifestName]);
  if (kind === "imsmanifest.xml") checkScorm(doc, { add, reportRef, referenced, manifestName, xml });
  else if (kind === "cmi5.xml") checkCmi5(doc, { add, reportRef, referenced, manifestName });
  else if (kind === "tincan.xml") checkTincan(doc, { add, reportRef, referenced, manifestName });

  checkFiles(root, files, { add, bytes, referenced, kind, base });
  return result(findings, files, bytes);
}

function checkScorm(doc, { add, reportRef, referenced, manifestName, xml }) {
  const manifest = doc.manifest;
  if (!manifest) { add("error", "manifest-root", `${manifestName} has no <manifest> element.`, { file: manifestName }); return; }
  const schemaVersion = text(manifest.metadata?.schemaversion);
  if (!schemaVersion) add("warning", "schema-version", "The manifest doesn't give a <schemaversion> (1.2 or 2004 …). LMSs guess the SCORM version from it.", { file: manifestName });
  const is2004 = /2004|cam 1\.3/i.test(schemaVersion) || /adlcp_v1p3/i.test(xml);

  const identifiers = new Map();
  const remember = (id, what) => {
    if (!id) return;
    if (identifiers.has(id)) add("error", "duplicate-identifier", `The identifier "${id}" is used by both ${identifiers.get(id)} and ${what}. Identifiers must be unique in a manifest.`, { file: manifestName });
    else identifiers.set(id, what);
  };
  if (/\s/.test(String(manifest["@_identifier"] ?? ""))) add("warning", "identifier-spaces", `The manifest identifier "${manifest["@_identifier"]}" contains spaces; some LMSs reject it.`, { file: manifestName });

  const organizations = list(manifest.organizations?.organization);
  const wanted = manifest.organizations?.["@_default"];
  if (!organizations.length) add("warning", "no-organization", "The manifest has no <organization>, so an LMS has no course structure to show.", { file: manifestName });
  if (wanted && !organizations.some((org) => org["@_identifier"] === wanted)) add("error", "default-organization", `The default organization "${wanted}" doesn't exist.`, { file: manifestName });

  const resources = list(manifest.resources?.resource);
  const byId = new Map(resources.map((resource) => [resource["@_identifier"], resource]));
  for (const resource of resources) {
    const id = resource["@_identifier"];
    remember(id, `resource ${id}`);
    const scormType = resource["@_scormType"] ?? resource["@_scormtype"] ?? resource["@_SCORMTYPE"];
    if (resource["@_href"]) {
      const found = reportRef(String(resource["@_href"]).trim(), `Resource ${id} launches`);
      if (found.file) referenced.add(found.caseOnly ?? found.file);
      if (!scormType) add("warning", "scorm-type", `Resource ${id} has no adlcp:${is2004 ? "scormType" : "scormtype"}, so LMSs treat it as an asset and give it no SCORM API.`, { file: manifestName });
    }
    for (const file of list(resource.file)) {
      if (!file?.["@_href"]) continue;
      const found = reportRef(String(file["@_href"]).trim(), `Resource ${id} lists a file that`);
      if (found.file) referenced.add(found.caseOnly ?? found.file);
    }
    for (const dependency of list(resource.dependency)) {
      if (!byId.has(dependency["@_identifierref"])) add("error", "missing-dependency", `Resource ${id} depends on "${dependency["@_identifierref"]}", which isn't a resource in the manifest.`, { file: manifestName });
    }
  }

  const walk = (items) => {
    for (const item of items) {
      remember(item["@_identifier"], `item ${item["@_identifier"]}`);
      const ref = item["@_identifierref"];
      if (ref && !byId.has(ref)) add("error", "missing-resource", `Item "${text(item.title) || item["@_identifier"]}" refers to resource "${ref}", which isn't in the manifest.`, { file: manifestName });
      if (ref) {
        const resource = byId.get(ref);
        const scormType = resource?.["@_scormType"] ?? resource?.["@_scormtype"];
        if (resource && !resource["@_href"]) add("error", "resource-href", `Item "${text(item.title) || item["@_identifier"]}" launches resource "${ref}", which has no href.`, { file: manifestName });
        else if (scormType && String(scormType).toLowerCase() === "asset") add("info", "asset-item", `Item "${text(item.title) || item["@_identifier"]}" launches an asset; the LMS won't track it with SCORM.`, { file: manifestName });
      }
      const mastery = list(item.masteryscore)[0];
      if (mastery !== undefined && (Number.isNaN(Number(text(mastery))) || Number(text(mastery)) < 0 || Number(text(mastery)) > 100))
        add("error", "mastery-score", `Item "${text(item.title)}" has mastery score "${text(mastery)}"; it must be a number from 0 to 100.`, { file: manifestName });
      walk(list(item.item));
    }
  };
  for (const organization of organizations) {
    remember(organization["@_identifier"], `organization ${organization["@_identifier"]}`);
    walk(list(organization.item));
  }
}

function checkCmi5(doc, { add, reportRef, referenced, manifestName }) {
  const structure = doc.courseStructure;
  if (!structure) { add("error", "cmi5-root", `${manifestName} has no <courseStructure> element.`, { file: manifestName }); return; }
  if (!structure.course?.["@_id"]) add("error", "cmi5-course-id", "The cmi5 course has no id; it must be an IRI.", { file: manifestName });
  const aus = [];
  const collect = (node) => { aus.push(...list(node?.au)); for (const block of list(node?.block)) collect(block); };
  collect(structure);
  if (!aus.length) add("error", "cmi5-no-au", "The cmi5 course has no assignable units (<au>).", { file: manifestName });
  const ids = new Set();
  for (const au of aus) {
    const id = au["@_id"];
    const title = text(au.title?.langstring ?? au.title) || id;
    if (!id) add("error", "cmi5-au-id", `AU "${title}" has no id.`, { file: manifestName });
    else if (ids.has(id)) add("error", "duplicate-identifier", `AU id "${id}" is used twice.`, { file: manifestName });
    else ids.add(id);
    const url = text(au.url);
    if (!url) { add("error", "cmi5-au-url", `AU "${title}" has no <url>.`, { file: manifestName }); continue; }
    if (/^https?:/i.test(url)) { add("info", "cmi5-remote-au", `AU "${title}" is hosted elsewhere (${url}); the player can't launch it from the package.`, { file: manifestName }); continue; }
    const found = reportRef(url, `AU "${title}" launches`);
    if (found.file) referenced.add(found.caseOnly ?? found.file);
    const moveOn = au["@_moveOn"];
    if (moveOn && !["Passed", "Completed", "CompletedAndPassed", "CompletedOrPassed", "NotApplicable"].includes(moveOn)) add("error", "cmi5-move-on", `AU "${title}" has moveOn "${moveOn}", which isn't a cmi5 value.`, { file: manifestName });
    const mastery = au["@_masteryScore"];
    if (mastery !== undefined && !(Number(mastery) >= 0 && Number(mastery) <= 1)) add("error", "cmi5-mastery", `AU "${title}" has masteryScore "${mastery}"; it must be from 0 to 1.`, { file: manifestName });
  }
}

function checkTincan(doc, { add, reportRef, referenced, manifestName }) {
  const activities = list(doc.tincan?.activities?.activity);
  if (!activities.length) { add("error", "tincan-no-activity", `${manifestName} lists no activities.`, { file: manifestName }); return; }
  const launchable = activities.filter((activity) => text(activity.launch));
  if (!launchable.length) add("error", "tincan-no-launch", "No activity in tincan.xml has a <launch> file.", { file: manifestName });
  for (const activity of launchable) {
    if (!activity["@_id"]) add("error", "tincan-activity-id", "A launchable activity has no id; xAPI statements need one.", { file: manifestName });
    const found = reportRef(text(activity.launch), `Activity "${text(activity.name) || activity["@_id"]}" launches`);
    if (found.file) referenced.add(found.caseOnly ?? found.file);
  }
}

const TEXT = /\.(html?|js|mjs|css|json|xml)$/i;
const HARMLESS_HOSTS = /^(www\.)?(w3\.org|adlnet\.(org|gov)|imsglobal\.org|imsproject\.org|purl\.org|schemas\.xmlsoap\.org|ns\.adobe\.com|schema\.org|example\.(com|org)|xmlns\.com|json-schema\.org|creativecommons\.org)$/i;

function checkFiles(root, files, { add, bytes, referenced, kind, base }) {
  const big = files.filter((file) => size(path.join(root, file)) > 50 * 1024 * 1024);
  for (const file of big) add("warning", "large-file", `${file} is ${(size(path.join(root, file)) / 1024 / 1024).toFixed(0)} MB. Some LMSs cap uploads or time out serving large files; consider streaming it.`, { file });
  if (bytes > 500 * 1024 * 1024) add("warning", "large-package", `The package is ${(bytes / 1024 / 1024).toFixed(0)} MB; many LMSs limit uploads to 100–500 MB.`);

  const awkward = files.filter((file) => /[^A-Za-z0-9._\-/]/.test(file));
  if (awkward.length) add("warning", "file-names", `${awkward.length} file name${awkward.length === 1 ? " has" : "s have"} spaces or special characters, which some LMSs and servers mangle.`, { examples: awkward.slice(0, 5) });

  const junk = files.filter((file) => /(^|\/)(\.DS_Store|Thumbs\.db|__MACOSX\/)/.test(file));
  if (junk.length) add("info", "junk-files", `${junk.length} operating-system file${junk.length === 1 ? "" : "s"} (.DS_Store, Thumbs.db, __MACOSX) can be left out of the package.`, { examples: junk.slice(0, 5) });

  // SCORM packages should list their files; it's commonly skipped and rarely enforced.
  if (kind === "imsmanifest.xml" && referenced.size > 2) {
    const inPackage = files.filter((file) => isInside(base, path.join(root, file)) && !/\.xsd$|\.dtd$|(^|\/)\./.test(file));
    const unlisted = inPackage.filter((file) => !referenced.has(file));
    if (unlisted.length) add("info", "unlisted-files", `${unlisted.length} file${unlisted.length === 1 ? " isn't" : "s aren't"} listed in the manifest's <file> elements. Strict LMS imports may ignore them.`, { examples: unlisted.slice(0, 5) });
  }

  const insecure = new Map();
  const hosts = new Map();
  const rootRelative = new Map();
  const localhost = new Map();
  const broken = new Map();
  const wrongCase = new Map();
  const lower = new Map(files.map((file) => [file.toLowerCase(), file]));
  let scanned = 0;
  for (const file of files) {
    if (!TEXT.test(file) || scanned >= 3000) continue;
    const full = path.join(root, file);
    if (size(full) > 3 * 1024 * 1024) continue;
    scanned += 1;
    const source = fs.readFileSync(full, "utf8");
    for (const match of source.matchAll(/(?:src|href|action|url|poster|data)\s*[=(:]\s*["'(]?\s*(https?:\/\/[^\s"'()<>]+)/gi)) {
      let url;
      try { url = new URL(match[1]); } catch { continue; }
      if (HARMLESS_HOSTS.test(url.hostname)) continue;
      if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(url.hostname)) { push(localhost, file, match[1]); continue; }
      if (url.protocol === "http:") push(insecure, file, match[1]);
      push(hosts, url.hostname, file);
    }
    if (/\.html?$/i.test(file)) {
      for (const match of source.matchAll(/\s(?:src|href)\s*=\s*["'](\/(?!\/)[^"']*)["']/gi)) push(rootRelative, file, match[1]);
    }
    // Relative links in pages and stylesheets: missing files, and names that differ only in case.
    const links = /\.html?$/i.test(file) ? source.matchAll(/\s(?:src|href|poster)\s*=\s*["']([^"']+)["']/gi)
      : /\.css$/i.test(file) ? source.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi) : [];
    for (const match of links) {
      const ref = match[1].trim().split(/[?#]/)[0];
      if (!ref || /^([a-z][a-z0-9+.-]*:|\/|#)/i.test(ref) || /[{}$<>`]|\+/.test(ref)) continue;
      let decoded;
      try { decoded = decodeURIComponent(ref); } catch { decoded = ref; }
      const target = path.resolve(root, path.dirname(file), decoded);
      if (!isInside(root, target)) continue;
      const relative = path.relative(root, target).split(path.sep).join("/");
      if (files.includes(relative) || files.some((other) => other.startsWith(`${relative}/`))) continue;
      const other = lower.get(relative.toLowerCase());
      if (other) push(wrongCase, file, `${match[1]} → ${other}`);
      else push(broken, file, match[1]);
    }
  }
  for (const [file, refs] of wrongCase) add("error", "case-mismatch", `${file} links to ${refs[0]}${refs.length > 1 ? ` and ${refs.length - 1} more` : ""}: only the letter case differs. That works on Windows and macOS but fails on LMSs that run on Linux.`, { file, examples: refs.slice(0, 5) });
  for (const [file, refs] of broken) add("warning", "broken-link", `${file} links to ${refs[0]}${refs.length > 1 ? ` and ${refs.length - 1} more` : ""}, which ${refs.length > 1 ? "aren't" : "isn't"} in the package.`, { file, examples: refs.slice(0, 5) });
  for (const [file, urls] of localhost) add("error", "localhost-url", `${file} loads ${urls[0]}${urls.length > 1 ? ` and ${urls.length - 1} more` : ""} from this computer; learners' browsers can't reach it.`, { file, examples: urls.slice(0, 5) });
  for (const [file, urls] of insecure) add("warning", "insecure-url", `${file} loads ${urls[0]}${urls.length > 1 ? ` and ${urls.length - 1} more` : ""} over http://. LMSs serve courses over https, and browsers block insecure content there.`, { file, examples: urls.slice(0, 5) });
  for (const [file, refs] of rootRelative) add("warning", "root-relative", `${file} refers to ${refs[0]}${refs.length > 1 ? ` and ${refs.length - 1} more` : ""} from the server's root. An LMS serves the package from a subfolder, so these break; use relative paths.`, { file, examples: refs.slice(0, 5) });
  if (hosts.size) add("info", "external-hosts", `The course loads from ${hosts.size} other site${hosts.size === 1 ? "" : "s"}: ${[...hosts.keys()].slice(0, 6).join(", ")}${hosts.size > 6 ? "…" : ""}. Learners behind firewalls, or offline, may not reach ${hosts.size === 1 ? "it" : "them"}.`, { examples: [...hosts.keys()].slice(0, 20) });
}

function push(map, key, value) {
  const values = map.get(key) ?? [];
  if (!values.includes(value)) values.push(value);
  map.set(key, values);
}

function result(findings, files, bytes) {
  const order = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  const counts = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return { ok: counts.error === 0, counts, files: files.length, bytes, findings };
}

/** Every file below `root`, as forward-slash relative paths, skipping the player's own folders. */
function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === ".extracted" || entry.name === ".scormplayer" || entry.name === "node_modules" || entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(path.relative(root, full).split(path.sep).join("/"));
      if (out.length > 20000) return;
    }
  };
  walk(root);
  return out.sort();
}

function size(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

function stripQuery(href) {
  return String(href ?? "").trim().split(/[?#]/)[0];
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

/** The findings as readable lines for a terminal. */
export function formatCheck(report, title = "") {
  const symbol = { error: "✖", warning: "▲", info: "·" };
  const lines = [];
  if (title) lines.push(title);
  lines.push(`${report.files} files, ${(report.bytes / 1024 / 1024).toFixed(1)} MB · ${report.counts.error} error${report.counts.error === 1 ? "" : "s"}, ${report.counts.warning} warning${report.counts.warning === 1 ? "" : "s"}, ${report.counts.info} note${report.counts.info === 1 ? "" : "s"}`);
  if (!report.findings.length) lines.push("No problems found.");
  for (const finding of report.findings) {
    lines.push(`${symbol[finding.severity]} ${finding.message}`);
    for (const example of finding.examples ?? []) lines.push(`    ${example}`);
  }
  return `${lines.join("\n")}\n`;
}
