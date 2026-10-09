import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { validateTarget } from "./pin-target.mjs";
import { withFileLock } from "./file-lock.mjs";

/** What an agent's QA suggestion may be about, and how much it matters. */
export const QA_CATEGORIES = ["copy", "content", "accessibility", "scorm", "layout", "interaction", "media"];
export const QA_SEVERITIES = ["blocker", "major", "minor", "polish"];
export const QA_CONFIDENCE = ["high", "medium", "low"];
export const PIN_STATUSES = ["open", "resolved", "suggested", "dismissed"];

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

  /** The pin record for new input: a person's open pin, or an agent's suggestion with its (checked) QA fields. */
  function build(data, input) {
    const note = String(input?.note ?? "").trim();
    if (!note) throw Object.assign(new Error("A pin needs a note."), { statusCode: 400 });
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      number: data.pins.reduce((max, item) => Math.max(max, item.number || 0), 0) + 1,
      status: input.qa ? "suggested" : "open",
      note,
      page: clean(input.page),
      target: validateTarget(input.target),
      capture: clean(input.capture),
      source: Array.isArray(input.source) ? input.source.slice(0, 100) : undefined,
      sourceSearch: clean(input.sourceSearch),
      ...(input.qa ?? {}),
      createdAt: now,
      updatedAt: now,
    };
  }

  const touch = (pin) => { pin.updatedAt = new Date(Math.max(Date.now(), Date.parse(pin.updatedAt) + 1)).toISOString(); };
  const removeFrame = (pin) => { if (pin.frame) fs.rmSync(path.join(path.dirname(pinsFile), pin.frame), { force: true }); };

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
      return transaction(() => {
        const data = read();
        const pin = build(data, { ...input, qa: undefined });
        data.pins.push(pin);
        write(data);
        return pin;
      });
    },

    /**
     * An agent's QA suggestion. The same problem (category and quoted evidence) already
     * suggested or accepted is not pinned again: this page is added to that pin's `alsoOn`.
     * One the reviewer dismissed before is refused, so a re-run doesn't bring it back.
     *
     * @returns {{ pin: object, outcome: "created" | "merged" | "duplicate" }}
     */
    suggest(input) {
      const qa = qaFields(input?.qa ?? {});
      return transaction(() => {
        const data = read();
        const key = dedupeKey(qa);
        const same = data.pins.find((pin) => pin.origin?.kind === "agent" && dedupeKey(pin) === key && pin.status !== "resolved");
        if (same?.status === "dismissed") {
          throw Object.assign(new Error(`The reviewer dismissed this before (pin ${same.number}); don't suggest it again.`), { statusCode: 409, pin: same });
        }
        if (same) {
          const page = pageRef(input.page);
          if (samePage(same.page, page) || (same.alsoOn ?? []).some((other) => samePage(other, page))) return { pin: same, outcome: "duplicate" };
          same.alsoOn = [...(same.alsoOn ?? []), page].slice(0, 50);
          touch(same);
          write(data);
          return { pin: same, outcome: "merged" };
        }
        const pin = build(data, { ...input, qa });
        data.pins.push(pin);
        write(data);
        return { pin, outcome: "created" };
      });
    },

    /** Accept (it becomes an open pin), dismiss, or restore agent suggestions. */
    triage(ids, action) {
      const next = { accept: "open", dismiss: "dismissed", restore: "suggested" }[action];
      if (!next) throw Object.assign(new Error("Action must be accept, dismiss or restore."), { statusCode: 400 });
      if (!Array.isArray(ids) || !ids.length) throw Object.assign(new Error("Name the suggestions to triage."), { statusCode: 400 });
      return transaction(() => {
        const data = read();
        const pins = ids.map((id) => find(data, id));
        for (const pin of pins) {
          if (pin.origin?.kind !== "agent") throw Object.assign(new Error(`Pin ${pin.number} isn't a QA suggestion.`), { statusCode: 400 });
          if (!["suggested", "dismissed", "open"].includes(pin.status)) throw Object.assign(new Error(`Pin ${pin.number} is ${pin.status}.`), { statusCode: 409 });
        }
        for (const pin of pins) {
          pin.status = next;
          pin.triagedAt = new Date().toISOString();
          touch(pin);
        }
        write(data);
        return pins;
      });
    },

    /** Delete QA suggestions not accepted (suggested and dismissed), from one run or all. */
    clearQa({ runId = null } = {}) {
      return transaction(() => {
        const data = read();
        const removed = data.pins.filter((pin) => pin.origin?.kind === "agent" && ["suggested", "dismissed"].includes(pin.status) && (!runId || pin.origin.runId === runId));
        data.pins = data.pins.filter((pin) => !removed.includes(pin));
        write(data);
        removed.forEach(removeFrame);
        return removed;
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
          if (!PIN_STATUSES.includes(changes.status)) throw Object.assign(new Error(`Status must be ${PIN_STATUSES.join(", ")}.`), { statusCode: 400 });
          if (["suggested", "dismissed"].includes(changes.status) && pin.origin?.kind !== "agent") throw Object.assign(new Error("Only QA suggestions can be suggested or dismissed."), { statusCode: 400 });
          pin.status = changes.status;
          if (changes.resolution) pin.resolution = String(changes.resolution).slice(0, 2000);
        }
        touch(pin);
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
        removeFrame(pin);
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
    const state = { resolved: " (resolved)", suggested: " (QA suggestion, not accepted)", dismissed: " (QA suggestion, dismissed)" }[pin.status] ?? "";
    lines.push("", `## Pin ${pin.number}${page ? ` · ${page}` : ""}${state}`, "", pin.note, "");
    const target = pin.target ?? {};
    if (pin.origin?.kind === "agent") {
      const accepted = pin.status === "open" || pin.status === "resolved" ? ", accepted by the reviewer" : "";
      lines.push(`- Origin: agent QA suggestion${pin.origin.agent ? ` by ${pin.origin.agent}` : ""}${pin.origin.runId ? ` (run ${pin.origin.runId})` : ""}${accepted} · ${pin.category} · ${pin.severity}${pin.confidence ? ` · ${pin.confidence} confidence` : ""}`);
      if (pin.evidence) lines.push(`- Evidence: ${truncate(pin.evidence, 400)}`);
      if (pin.alsoOn?.length) lines.push(`- Also on: ${pin.alsoOn.map((other) => other.title || other.url).join("; ")}`);
    }
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

/** The QA fields of an agent suggestion, checked. */
function qaFields(qa) {
  const fail = (message) => { throw Object.assign(new Error(message), { statusCode: 400 }); };
  const category = String(qa.category ?? "");
  const severity = String(qa.severity ?? "");
  const evidence = String(qa.evidence ?? "").trim();
  if (!QA_CATEGORIES.includes(category)) fail(`category must be one of ${QA_CATEGORIES.join(", ")}.`);
  if (!QA_SEVERITIES.includes(severity)) fail(`severity must be one of ${QA_SEVERITIES.join(", ")}.`);
  if (!evidence) fail("A QA suggestion needs evidence: the exact text, value or rule it is about.");
  if (qa.confidence !== undefined && !QA_CONFIDENCE.includes(qa.confidence)) fail(`confidence must be one of ${QA_CONFIDENCE.join(", ")}.`);
  return {
    origin: { kind: "agent", agent: String(qa.agent ?? "agent").slice(0, 80), ...(qa.runId ? { runId: String(qa.runId).slice(0, 80) } : {}) },
    category,
    severity,
    ...(qa.confidence ? { confidence: qa.confidence } : {}),
    evidence: evidence.slice(0, 1000),
  };
}

/** Category and normalised evidence: what makes two suggestions the same problem. */
function dedupeKey(pin) {
  return `${pin.category}|${String(pin.evidence ?? "").toLowerCase().replace(/[\s"“”'‘’.,;:!?…]+/g, " ").trim()}`;
}

/** Where a suggestion was seen, compactly, for `alsoOn`. */
function pageRef(page = {}) {
  return Object.fromEntries(Object.entries({ title: page.title, url: page.url, navIndex: page.navIndex, scoId: page.scoId, scoTitle: page.scoTitle }).filter(([, value]) => value !== undefined && value !== ""));
}

function samePage(a = {}, b = {}) {
  return (a.url ?? "") === (b.url ?? "") && (a.title ?? "") === (b.title ?? "") && (a.scoId ?? "") === (b.scoId ?? "") && (a.navIndex ?? null) === (b.navIndex ?? null);
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
