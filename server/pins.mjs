import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { validateTarget } from "./pin-target.mjs";
import { withFileLock } from "./file-lock.mjs";

/**
 * Pins live in one JSON file beside the course (or inside a live project's .scormplayer/),
 * with each pin's screenshot as a PNG in a sibling folder. Plain files, so a teammate or an
 * agent can read them without this tool.
 */
export function createPinStore(pinsFile, course) {
  const framesDir = path.join(path.dirname(pinsFile), `${path.basename(pinsFile, ".json")}-frames`);

  function read() {
    if (!fs.existsSync(pinsFile)) return { version: 1, course: describe(course), pins: [] };
    const data = JSON.parse(fs.readFileSync(pinsFile, "utf8"));
    if (!Array.isArray(data.pins)) throw new Error(`${pinsFile} is not a scormplayer pins file.`);
    return data;
  }

  function write(data) {
    fs.mkdirSync(path.dirname(pinsFile), { recursive: true });
    const temp = `${pinsFile}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify({ ...data, course: describe(course) }, null, 2)}\n`);
    fs.renameSync(temp, pinsFile);
  }

  const transaction = (fn) => withFileLock(pinsFile, fn);

  function find(data, idOrNumber) {
    const key = String(idOrNumber);
    const pin = data.pins.find((item) => item.id === key || String(item.number) === key);
    if (!pin) throw Object.assign(new Error(`No pin ${key}.`), { statusCode: 404 });
    return pin;
  }

  return {
    pinsFile,
    framesDir,

    list({ status = "all" } = {}) {
      const pins = read().pins;
      return status === "all" ? pins : pins.filter((pin) => pin.status === status);
    },

    create(input) {
      const note = String(input?.note ?? "").trim();
      if (!note) throw Object.assign(new Error("A pin needs a note."), { statusCode: 400 });
      return transaction(() => {
        const data = read();
        const now = new Date().toISOString();
        const pin = {
          id: randomUUID(),
          number: data.pins.reduce((max, item) => Math.max(max, item.number || 0), 0) + 1,
          status: "open",
          note,
          page: clean(input.page),
          target: validateTarget(input.target),
          capture: clean(input.capture),
          source: Array.isArray(input.source) ? input.source.slice(0, 100) : undefined,
          sourceSearch: clean(input.sourceSearch),
          createdAt: now,
          updatedAt: now,
        };
        data.pins.push(pin);
        write(data);
        return pin;
      });
    },

    reattach(idOrNumber, input) {
      const target = validateTarget(input.target);
      if (!target?.anchorVersion) throw Object.assign(new Error("Select a new target before reattaching."), { statusCode: 400 });
      if (!input.page || typeof input.page.url !== "string" || !input.page.url) throw Object.assign(new Error("A reattachment needs a page."), { statusCode: 400 });
      return transaction(() => {
        const data = read();
        const pin = find(data, idOrNumber);
        if (!input.expectedUpdatedAt || pin.updatedAt !== input.expectedUpdatedAt) throw Object.assign(new Error("The pin changed. Read it again before reattaching."), { statusCode: 409 });
        const at = new Date(Math.max(Date.now(), Date.parse(pin.updatedAt) + 1)).toISOString();
        pin.attachmentHistory = [...(pin.attachmentHistory ?? []), { at, page: pin.page, target: pin.target, capture: pin.capture, frame: pin.frame, source: pin.source, sourceSearch: pin.sourceSearch }];
        pin.page = clean(input.page);
        pin.target = target;
        pin.capture = clean(input.capture);
        pin.source = Array.isArray(input.source) ? input.source.slice(0, 100) : [];
        pin.sourceSearch = clean(input.sourceSearch);
        pin.updatedAt = at;
        write(data);
        return pin;
      });
    },

    update(idOrNumber, changes) {
      return transaction(() => {
        const data = read();
        const pin = find(data, idOrNumber);
        if (changes.note !== undefined) {
          const note = String(changes.note).trim();
          if (!note) throw Object.assign(new Error("A pin needs a note."), { statusCode: 400 });
          pin.note = note;
        }
        if (changes.status !== undefined) {
          if (!["open", "resolved"].includes(changes.status)) throw Object.assign(new Error("Status must be open or resolved."), { statusCode: 400 });
          pin.status = changes.status;
          if (changes.resolution) pin.resolution = String(changes.resolution).slice(0, 2000);
        }
        pin.updatedAt = new Date(Math.max(Date.now(), Date.parse(pin.updatedAt) + 1)).toISOString();
        write(data);
        return pin;
      });
    },

    remove(idOrNumber) {
      return transaction(() => {
        const data = read();
        const pin = find(data, idOrNumber);
        data.pins = data.pins.filter((item) => item !== pin);
        write(data);
        if (pin.frame) fs.rmSync(path.join(path.dirname(pinsFile), pin.frame), { force: true });
        return pin;
      });
    },

    saveFrame(idOrNumber, png) {
      if (!png?.length || !png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        throw Object.assign(new Error("The screenshot must be a PNG."), { statusCode: 400 });
      }
      return transaction(() => {
        const data = read();
        const pin = find(data, idOrNumber);
        fs.mkdirSync(framesDir, { recursive: true });
        const file = path.join(framesDir, `pin-${pin.number}.png`);
        fs.writeFileSync(file, png);
        pin.frame = path.relative(path.dirname(pinsFile), file).split(path.sep).join("/");
        pin.updatedAt = new Date(Math.max(Date.now(), Date.parse(pin.updatedAt) + 1)).toISOString();
        write(data);
        return pin;
      });
    },

    frameFile(idOrNumber) {
      const pin = find(read(), idOrNumber);
      return pin.frame ? path.join(path.dirname(pinsFile), pin.frame) : null;
    },

    /** The hand-off text: what to change, where, and the evidence, for a teammate or an agent. */
    brief({ status = "open", ids = null } = {}) {
      let pins = read().pins;
      if (ids) pins = pins.filter((pin) => ids.includes(pin.id) || ids.includes(String(pin.number)));
      else if (status !== "all") pins = pins.filter((pin) => pin.status === status);
      return formatBrief(course, pins, path.dirname(pinsFile));
    },
  };
}

export function formatBrief(course, pins, pinsDir) {
  const lines = [
    `# Pinned notes: ${course.title}`,
    "",
    `Course: ${course.source} (${describeKind(course)})`,
  ];
  if (course.kind === "package") {
    lines.push(`This is a zip, so it can't be edited in place. Edit the course's source, or unzip it to a folder first: scormplayer unzip ${quoteArg(course.source)}`);
  }
  if (!pins.length) {
    lines.push("", "No pins to hand off.");
    return `${lines.join("\n")}\n`;
  }
  lines.push(
    `Pins: ${pins.length}. Change only what each pin asks for and leave the rest of the course as it is.`,
  );
  for (const pin of pins) {
    const page = [pin.page?.title, pin.page?.location ? `SCORM location ${pin.page.location}` : null].filter(Boolean).join(" · ");
    lines.push("", `## Pin ${pin.number}${page ? ` · ${page}` : ""}${pin.status === "resolved" ? " (resolved)" : ""}`, "", pin.note, "");
    const target = pin.target ?? {};
    if (pin.capture) lines.push(`- Captured: ${JSON.stringify(pin.capture)} (session revision is not a content digest)`);
    if (pin.attachmentHistory?.length) lines.push(`- Reattached ${pin.attachmentHistory.length} time(s); original target and source evidence retained in attachmentHistory. Screenshot remains the original capture.`);
    lines.push("- Attachment: captured evidence only; use scormplayer_verify_pin for current target status.");
    if (target.normalizedRegion) lines.push(`- Relative region: ${JSON.stringify(target.normalizedRegion)}`);
    if (target.name || target.selector) lines.push(`- Target: ${target.name ?? target.tag ?? "element"}${target.selector ? ` (\`${target.selector}\`)` : ""}`);
    if (Array.isArray(target.targets) && target.targets.length > 1) {
      lines.push(`- Elements: ${target.targets.map((part) => `${part.name ?? part.tag}${part.selector ? ` (\`${part.selector}\`)` : ""}`).join("; ")}`);
    }
    if (target.kind === "region" && target.rect) lines.push(`- Area: ${target.rect.width}×${target.rect.height} px at ${target.rect.x},${target.rect.y} in the viewport`);
    if (target.text) lines.push(`- Text: "${truncate(target.text, 240)}"`);
    for (const [key, value] of Object.entries(target.attributes ?? {})) lines.push(`- ${key}: ${truncate(String(value), 240)}`);
    if (target.rawText) lines.push(`- Raw text: ${JSON.stringify(target.rawText)}`);
    if (target.textTransform) lines.push(`- CSS text-transform: ${target.textTransform}`);
    for (const ancestor of target.ancestors ?? []) lines.push(`- Ancestor ${ancestor.selector}: ${JSON.stringify(ancestor.attributes)}`);
    for (const match of pin.source ?? []) {
      lines.push(`- ${match.provenance === "content-binding" ? "Declared content binding (hash checked)" : "Text-match candidate"}: ${match.file}:${match.line ?? 1}${match.column ? `:${match.column}` : ""}${match.pointer ? ` · JSON pointer ${match.pointer}` : ""}${match.preview ? ` · ${truncate(match.preview, 120)}` : ""}`);
      if (match.consumers?.length) lines.push(`  Known consumers declared by the course: ${JSON.stringify(match.consumers)}`);
    }
    if (pin.sourceSearch) lines.push(`- Search evidence: ${JSON.stringify(pin.sourceSearch)}`);
    if (pin.page?.url) lines.push(`- Page: ${pin.page.url}`);
    if (target.viewport) lines.push(`- Viewport: ${target.viewport.width}×${target.viewport.height}`);
    if (pin.frame) lines.push(`- Screenshot: ${path.join(pinsDir, pin.frame)}`);
  }
  return `${lines.join("\n")}\n`;
}

function describe(course) {
  return { title: course.title, source: course.source, kind: course.kind, scormVersion: course.scormVersion, standard: course.standard ?? "scorm", ...(course.sha256 ? { sha256: course.sha256 } : {}) };
}

function describeKind(course) {
  const label = standardLabel(course);
  const kind = { package: `${label} zip`, folder: `${label} folder`, live: "live source" }[course.kind] ?? course.kind;
  const version = course.scormVersion && course.scormVersion !== "both" ? `, SCORM ${course.scormVersion}` : "";
  return `${kind}${version}`;
}

function truncate(value, max) {
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Keep pin fields to plain JSON of a bounded size. */
function clean(value) {
  if (value === undefined || value === null) return undefined;
  const json = JSON.stringify(value);
  if (json.length > 20_000) throw Object.assign(new Error("Pin details are too large."), { statusCode: 413 });
  return JSON.parse(json);
}

function quoteArg(value) {
  return /^[\w./~:-]+$/.test(value) ? value : JSON.stringify(value);
}

/** "SCORM", "xAPI" or "cmi5": what the course is packaged as. */
export function standardLabel(course) {
  return { xapi: "xAPI", cmi5: "cmi5" }[course.standard] ?? "SCORM";
}
