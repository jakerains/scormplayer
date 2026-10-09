import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CONFIG_FILE, findConfig } from "./config.mjs";

/**
 * The QA standard: the house rules an agent's QA pass reviews against (audience, reading
 * level, spelling, voice, terms, custom rules, what not to flag).
 *
 * A project keeps its standard in scormplayer.config.json under "qa". Standards shared between
 * projects live in the user's config folder (or any JSON file) and a project uses one with
 * `"extends": "<name or path>"`, overriding only what differs. With no project standard, a
 * shared standard named "default" applies.
 */

export const STANDARD_KEYS = ["name", "description", "extends", "focus", "audience", "readingLevel", "language", "spelling", "voice", "headingCase", "tone", "accessibility", "terms", "rules", "ignore", "severityFloor", "maxPinsPerPage", "styleGuide"];
const CATEGORIES = ["copy", "content", "accessibility", "scorm", "layout", "interaction", "media"];
const SEVERITIES = ["blocker", "major", "minor", "polish"];

/** Where shared standards live: SCORMPLAYER_STANDARDS_DIR, else the platform's config folder. */
export function standardsDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.SCORMPLAYER_STANDARDS_DIR) return path.resolve(env.SCORMPLAYER_STANDARDS_DIR);
  const base = platform === "darwin" ? path.join(home, "Library", "Application Support")
    : platform === "win32" ? env.APPDATA || path.join(home, "AppData", "Roaming")
      : env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(base, "scormplayer", "qa-standards");
}

const fail = (message) => { throw Object.assign(new Error(message), { statusCode: 400 }); };

/** Check a standard and keep it to known keys and sensible values. */
export function validateStandard(input, { partial = true } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("A QA standard is a JSON object.");
  const unknown = Object.keys(input).filter((key) => !STANDARD_KEYS.includes(key));
  if (unknown.length) fail(`Unknown QA standard key${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}. Use: ${STANDARD_KEYS.join(", ")}.`);
  const out = {};
  const text = (key, max = 400) => {
    if (input[key] === undefined) return;
    if (typeof input[key] !== "string" || input[key].length > max) fail(`${key} must be text of up to ${max} characters.`);
    if (input[key].trim()) out[key] = input[key].trim();
  };
  const list = (key, max = 100, check = null) => {
    if (input[key] === undefined) return;
    if (!Array.isArray(input[key]) || input[key].length > max || input[key].some((item) => typeof item !== "string" || item.length > 400)) fail(`${key} must be a list of up to ${max} short texts.`);
    if (check) for (const item of input[key]) if (!check.includes(item)) fail(`${key} values must be among ${check.join(", ")}.`);
    out[key] = [...new Set(input[key].map((item) => item.trim()).filter(Boolean))];
  };
  const choice = (key, options) => {
    if (input[key] === undefined) return;
    if (!options.includes(input[key])) fail(`${key} must be one of ${options.join(", ")}.`);
    out[key] = input[key];
  };
  text("name", 80);
  if (out.name && !/^[a-z0-9][a-z0-9-]*$/.test(out.name)) fail("name must be lowercase letters, digits and hyphens (it names the shared file).");
  text("description"); text("extends", 400); text("audience"); text("readingLevel", 80); text("language", 20); text("tone"); text("accessibility", 80); text("styleGuide", 400);
  choice("spelling", ["US", "UK", "CA", "AU"]);
  choice("voice", ["second-person", "third-person", "first-person-plural", "any"]);
  choice("headingCase", ["sentence", "title", "any"]);
  choice("severityFloor", SEVERITIES);
  list("focus", 7, CATEGORIES);
  list("ignore", 100);
  if (input.maxPinsPerPage !== undefined) {
    if (!Number.isInteger(input.maxPinsPerPage) || input.maxPinsPerPage < 1 || input.maxPinsPerPage > 20) fail("maxPinsPerPage must be a whole number from 1 to 20.");
    out.maxPinsPerPage = input.maxPinsPerPage;
  }
  if (input.terms !== undefined) {
    const terms = input.terms;
    if (!terms || typeof terms !== "object" || Array.isArray(terms)) fail("terms is an object: { prefer: { variant: preferred }, avoid: [...], keep: [...] }.");
    const extra = Object.keys(terms).filter((key) => !["prefer", "avoid", "keep"].includes(key));
    if (extra.length) fail(`Unknown terms key ${extra.join(", ")}. Use prefer, avoid, keep.`);
    out.terms = {};
    if (terms.prefer !== undefined) {
      if (!terms.prefer || typeof terms.prefer !== "object" || Array.isArray(terms.prefer) || Object.keys(terms.prefer).length > 300 || Object.values(terms.prefer).some((value) => typeof value !== "string")) fail("terms.prefer maps a variant to the preferred form: { \"e-mail\": \"email\" }.");
      out.terms.prefer = Object.fromEntries(Object.entries(terms.prefer).map(([key, value]) => [key.trim(), value.trim()]).filter(([key, value]) => key && value));
    }
    for (const key of ["avoid", "keep"]) {
      if (terms[key] === undefined) continue;
      if (!Array.isArray(terms[key]) || terms[key].length > 300 || terms[key].some((item) => typeof item !== "string")) fail(`terms.${key} must be a list of texts.`);
      out.terms[key] = [...new Set(terms[key].map((item) => item.trim()).filter(Boolean))];
    }
  }
  if (input.rules !== undefined) {
    if (!Array.isArray(input.rules) || input.rules.length > 100) fail("rules must be a list of up to 100 rules.");
    out.rules = input.rules.map((rule, index) => {
      if (!rule || typeof rule !== "object" || typeof rule.rule !== "string" || !rule.rule.trim()) fail(`rules[${index}] needs a "rule": what to check, in a sentence.`);
      const id = String(rule.id ?? `rule-${index + 1}`).trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 60);
      if (rule.category !== undefined && !CATEGORIES.includes(rule.category)) fail(`rules[${index}].category must be one of ${CATEGORIES.join(", ")}.`);
      if (rule.severity !== undefined && !SEVERITIES.includes(rule.severity)) fail(`rules[${index}].severity must be one of ${SEVERITIES.join(", ")}.`);
      return { id, rule: rule.rule.trim().slice(0, 600), ...(rule.category ? { category: rule.category } : {}), ...(rule.severity ? { severity: rule.severity } : {}), ...(typeof rule.example === "string" && rule.example.trim() ? { example: rule.example.trim().slice(0, 400) } : {}) };
    });
  }
  if (!partial && !Object.keys(out).length) fail("The QA standard is empty.");
  return out;
}

/** Merge a base standard and the project's own: the project wins; lists of rules, ignores and terms add up. */
export function mergeStandards(base = {}, own = {}) {
  const merged = { ...base, ...own };
  delete merged.extends;
  delete merged.name;
  if (base.rules || own.rules) {
    const byId = new Map((base.rules ?? []).map((rule) => [rule.id, rule]));
    for (const rule of own.rules ?? []) byId.set(rule.id, rule);
    merged.rules = [...byId.values()];
  }
  if (base.ignore || own.ignore) merged.ignore = [...new Set([...(base.ignore ?? []), ...(own.ignore ?? [])])];
  if (base.terms || own.terms) {
    merged.terms = {
      prefer: { ...base.terms?.prefer, ...own.terms?.prefer },
      avoid: [...new Set([...(base.terms?.avoid ?? []), ...(own.terms?.avoid ?? [])])],
      keep: [...new Set([...(base.terms?.keep ?? []), ...(own.terms?.keep ?? [])])],
    };
  }
  return merged;
}

/** The shared standards saved for this user. */
export function listShared(dir = standardsDir()) {
  let entries = [];
  try { entries = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort(); } catch { return []; }
  return entries.map((file) => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      return { name: file.slice(0, -5), file: path.join(dir, file), description: data.description ?? null };
    } catch { return { name: file.slice(0, -5), file: path.join(dir, file), description: null, invalid: true }; }
  });
}

/** A shared standard by name, or a JSON file by path (relative to `root`). */
function loadBase(reference, root, dir) {
  const isPath = /[\\/]|\.json$/i.test(reference);
  const file = isPath ? path.resolve(root, reference) : path.join(dir, `${reference}.json`);
  if (!fs.existsSync(file)) fail(`The QA standard "${reference}" wasn't found (${file}).${isPath ? "" : " Save it as a shared standard first."}`);
  let data;
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { fail(`${file} is not valid JSON: ${error.message}`); }
  const standard = validateStandard(data);
  if (standard.styleGuide) standard.styleGuide = path.resolve(path.dirname(file), standard.styleGuide);
  return { standard, source: { kind: isPath ? "file" : "shared", ...(isPath ? {} : { name: reference }), file } };
}

/**
 * The standard a QA pass on this course uses, with where each part came from. `missing` means
 * nothing is set up: offer to build one.
 */
export function effectiveStandard(source, { dir = standardsDir() } = {}) {
  let config = null;
  try { config = findConfig(source); } catch (error) { fail(error.message); }
  const own = config?.data?.qa && typeof config.data.qa === "object" ? validateStandard(config.data.qa) : null;
  if (own?.styleGuide) own.styleGuide = path.resolve(config.root, own.styleGuide);
  const sources = [];
  let base = null;
  if (own?.extends) {
    const loaded = loadBase(own.extends, config.root, dir);
    base = loaded.standard;
    sources.push(loaded.source);
  } else if (!own && fs.existsSync(path.join(dir, "default.json"))) {
    const loaded = loadBase("default", "", dir);
    base = loaded.standard;
    sources.push(loaded.source);
  }
  if (own) sources.push({ kind: "project", file: config.file, ...(own.extends ? { extends: own.extends } : {}) });
  const standard = mergeStandards(base ?? {}, own ?? {});
  if (standard.styleGuide) {
    try { standard.styleGuideText = fs.readFileSync(standard.styleGuide, "utf8").slice(0, 20_000); } catch { standard.styleGuideText = null; }
  }
  return {
    standard,
    sources,
    missing: !sources.length,
    projectConfig: config?.file ?? null,
    // Where a project standard would be written when there is no config yet.
    projectTarget: config?.file ?? path.join(path.dirname(path.resolve(source)), CONFIG_FILE),
    shared: listShared(dir),
  };
}

/**
 * Save a standard. "project" writes the qa block of the project's scormplayer.config.json
 * (creating one beside the course if there is none), keeping the rest of the file. "shared"
 * writes <name>.json to the user's standards folder; with `use`, the project then extends it.
 */
export function saveStandard(source, { standard, target, name = null, use = false, dir = standardsDir() }) {
  const checked = validateStandard(standard ?? {}, { partial: false });
  const write = (file, data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`);
    fs.renameSync(temp, file);
  };
  const writeProject = (qa) => {
    const config = findConfig(source);
    const file = config?.file ?? path.join(path.dirname(path.resolve(source)), CONFIG_FILE);
    const data = config ? { ...config.data } : {};
    data.qa = qa;
    write(file, data);
    return file;
  };
  if (target === "shared") {
    const named = name ?? checked.name;
    if (!named || !/^[a-z0-9][a-z0-9-]*$/.test(named)) fail("A shared standard needs a name: lowercase letters, digits and hyphens.");
    const { extends: _ignored, ...rest } = checked;
    const file = path.join(dir, `${named}.json`);
    write(file, { ...rest, name: named });
    const projectFile = use ? writeProject({ extends: named }) : null;
    return { target, name: named, file, ...(projectFile ? { projectFile } : {}) };
  }
  if (target === "project") {
    const { name: _name, ...rest } = checked;
    return { target, file: writeProject(rest) };
  }
  fail("target must be project or shared.");
}

// ---- Scanning a course to propose a standard ----------------------------------------------------

const SPELLING_PAIRS = [
  ["color", "colour"], ["behavior", "behaviour"], ["center", "centre"], ["organize", "organise"], ["organization", "organisation"],
  ["analyze", "analyse"], ["favorite", "favourite"], ["honor", "honour"], ["labor", "labour"], ["catalog", "catalogue"],
  ["recognize", "recognise"], ["realize", "realise"], ["prioritize", "prioritise"], ["customize", "customise"], ["license", "licence"],
  ["defense", "defence"], ["program", "programme"], ["traveled", "travelled"], ["enrollment", "enrolment"], ["meter", "metre"],
];
const VARIANTS = [
  ["email", "e-mail"], ["login", "log-in"], ["log in", "log-in"], ["sign in", "sign-in", "signin"], ["online", "on-line"],
  ["website", "web site"], ["e-learning", "elearning", "eLearning"], ["okay", "OK"], ["checkbox", "check box"],
  ["drop-down", "dropdown", "drop down"], ["pop-up", "popup"], ["follow-up", "followup"], ["health care", "healthcare"],
];
const VAGUE_LINKS = /^(click here|here|read more|more|learn more|link|this link)$/i;

/** Text a learner would read, from the package's pages and data files. */
function courseText(root) {
  const out = { html: [], headings: [], buttons: [], langs: [], images: 0, imagesWithoutAlt: 0, videos: 0, videosWithoutCaptions: 0 };
  let budget = 3_000_000;
  const walk = (dir, depth = 0) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (budget <= 0 || entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (depth < 8) walk(full, depth + 1); continue; }
      if (!/\.(html?|json|js)$/i.test(entry.name) || /\.min\.js$|vendor|lib[\\/]|polyfill/i.test(full)) continue;
      let source;
      try { if (fs.statSync(full).size > 2_000_000) continue; source = fs.readFileSync(full, "utf8"); } catch { continue; }
      budget -= source.length;
      if (/\.html?$/i.test(entry.name)) {
        for (const match of source.matchAll(/<html[^>]*\blang=["']([^"']+)/gi)) out.langs.push(match[1]);
        for (const match of source.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)) out.headings.push(strip(match[1]));
        for (const match of source.matchAll(/<(button|a)\b[^>]*>([\s\S]*?)<\/\1>/gi)) out.buttons.push(strip(match[2]));
        for (const match of source.matchAll(/<img\b[^>]*>/gi)) { out.images += 1; if (!/\balt\s*=/.test(match[0])) out.imagesWithoutAlt += 1; }
        for (const match of source.matchAll(/<video\b[\s\S]*?<\/video>/gi)) { out.videos += 1; if (!/<track\b[^>]*kind=["']?(captions|subtitles)/i.test(match[0])) out.videosWithoutCaptions += 1; }
        out.html.push(strip(source.replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, " ")));
      } else {
        // Authored text in data and scripts: string literals that read like sentences.
        for (const match of source.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n]){12,600})\1/g)) {
          const value = match[2].replace(/\\n/g, " ").replace(/\\(["'`\\])/g, "$1");
          if (/\s\S+\s/.test(value) && /^[^{}<>=;()[\]]*$/.test(value) && /[a-z]{3}/i.test(value)) out.html.push(value);
        }
      }
    }
  };
  walk(root);
  return out;
}

function strip(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, "\"").replace(/\s+/g, " ").trim();
}

function syllables(word) {
  const clean = word.toLowerCase().replace(/[^a-z]/g, "");
  if (clean.length <= 3) return 1;
  return Math.max(1, (clean.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "").match(/[aeiouy]{1,2}/g) ?? []).length);
}

const count = (text, pattern) => (text.match(pattern) ?? []).length;
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Read the course's text and report its conventions, with a drafted standard to start from.
 * Several courses can be scanned together (a project's lessons). `pins` adds what the reviewer
 * accepted and dismissed in earlier QA passes, so the draft can learn from triage.
 */
export function scanForStandard(courses, { pins = [] } = {}) {
  const parts = courses.map((course) => courseText(course.root));
  const all = parts.flatMap((part) => part.html).join("\n");
  const words = all.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
  const sentences = all.split(/(?<=[.!?])\s+/).filter((sentence) => /[a-z]{2}/i.test(sentence) && sentence.split(/\s+/).length >= 3);
  const wordCount = words.length;
  const per1000 = (n) => (wordCount ? Math.round((n / wordCount) * 10000) / 10 : 0);

  const spelling = { US: 0, UK: 0, examples: [] };
  for (const [us, uk] of SPELLING_PAIRS) {
    const a = count(all, new RegExp(`\\b${us}\\w*`, "gi"));
    const b = count(all, new RegExp(`\\b${uk}\\w*`, "gi"));
    spelling.US += a; spelling.UK += b;
    if (a && b) spelling.examples.push(`${us} ×${a} / ${uk} ×${b}`);
  }
  const variants = VARIANTS.map((forms) => ({ forms: Object.fromEntries(forms.map((form) => [form, count(all, new RegExp(`\\b${escape(form)}\\b`, form === form.toLowerCase() ? "gi" : "g"))]).filter(([, n]) => n)) }))
    .filter((item) => Object.keys(item.forms).length);

  // Terms written with capitals mid-sentence (product names, defined terms), and ones that also appear lowercase.
  const capitalised = new Map();
  for (const match of all.matchAll(/(?<=[a-z,;:]\s)((?:[A-Z][a-zA-Z0-9]+)(?:\s[A-Z][a-zA-Z0-9]+){0,2})/g)) capitalised.set(match[1], (capitalised.get(match[1]) ?? 0) + 1);
  const terms = [...capitalised.entries()].filter(([term, n]) => n >= 2 && term.length > 2).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([term, n]) => ({ term, count: n }));
  const inconsistentCase = terms.filter(({ term }) => count(all, new RegExp(`(?<=[a-z,;:]\\s)${escape(term.toLowerCase())}\\b`, "g")) > 0).map(({ term }) => term).slice(0, 15);

  const headings = parts.flatMap((part) => part.headings).filter(Boolean);
  const titleCase = headings.filter((heading) => { const long = heading.split(/\s+/).filter((word) => word.length > 3); return long.length >= 2 && long.every((word) => /^[A-Z]/.test(word)); }).length;
  const syllableCount = words.reduce((sum, word) => sum + syllables(word), 0);
  const wordsPerSentence = sentences.length ? Math.round((wordCount / sentences.length) * 10) / 10 : 0;
  const grade = sentences.length && wordCount ? Math.round((0.39 * (wordCount / sentences.length) + 11.8 * (syllableCount / wordCount) - 15.59) * 10) / 10 : null;
  const you = count(all, /\byou(r|rs|rself)?\b/gi);
  const learners = count(all, /\b(the )?(learner|learners|student|students|participant|participants|user|users|employee|employees)\b/gi);
  const buttons = parts.flatMap((part) => part.buttons).filter(Boolean);
  const vague = buttons.filter((label) => VAGUE_LINKS.test(label));
  const langs = parts.flatMap((part) => part.langs);
  const language = langs.length ? Object.entries(langs.reduce((acc, lang) => ({ ...acc, [lang]: (acc[lang] ?? 0) + 1 }), {})).sort((a, b) => b[1] - a[1])[0][0] : null;

  const agentPins = pins.filter((pin) => pin.origin?.kind === "agent");
  const triage = {};
  for (const pin of agentPins) {
    const entry = triage[pin.category] ??= { accepted: 0, dismissed: 0, waiting: 0, dismissedExamples: [] };
    if (pin.status === "dismissed") { entry.dismissed += 1; if (entry.dismissedExamples.length < 5) entry.dismissedExamples.push(pin.note.slice(0, 200)); }
    else if (pin.status === "suggested") entry.waiting += 1;
    else entry.accepted += 1;
  }

  const findings = {
    courses: courses.map((course) => ({ title: course.title, source: course.source })),
    words: wordCount,
    language,
    spelling,
    variants,
    terms,
    inconsistentCase,
    headings: { count: headings.length, titleCase, sentenceCase: headings.length - titleCase, examples: headings.slice(0, 8) },
    readability: { sentences: sentences.length, wordsPerSentence, grade },
    voice: { you, learners, secondPerson: you + learners ? Math.round((you / (you + learners)) * 100) / 100 : null },
    tone: { contractionsPer1000: per1000(count(all, /\b\w+'(s|t|re|ll|ve|d|m)\b/gi)), exclamationsPer1000: per1000(count(all, /!/g)) },
    links: { labels: buttons.length, vague: [...new Set(vague)].slice(0, 10) },
    accessibility: { images: parts.reduce((n, part) => n + part.images, 0), imagesWithoutAlt: parts.reduce((n, part) => n + part.imagesWithoutAlt, 0), videos: parts.reduce((n, part) => n + part.videos, 0), videosWithoutCaptions: parts.reduce((n, part) => n + part.videosWithoutCaptions, 0) },
    triage,
  };
  return { findings, proposal: proposeStandard(findings) };
}

/** A first draft from what the course already does: a starting point for the reviewer to edit. */
function proposeStandard(findings) {
  const proposal = { focus: [...CATEGORIES], accessibility: "WCAG 2.2 AA", maxPinsPerPage: 5 };
  if (findings.language) proposal.language = findings.language;
  if (findings.spelling.US + findings.spelling.UK >= 3) proposal.spelling = findings.spelling.UK > findings.spelling.US ? "UK" : "US";
  else if (/^en-(GB|IE|NZ)/i.test(findings.language ?? "")) proposal.spelling = "UK";
  if (findings.headings.count >= 3) proposal.headingCase = findings.headings.titleCase > findings.headings.sentenceCase ? "title" : "sentence";
  if (findings.voice.secondPerson !== null) proposal.voice = findings.voice.secondPerson >= 0.6 ? "second-person" : findings.voice.secondPerson <= 0.2 ? "third-person" : "any";
  if (findings.readability.grade !== null) proposal.readingLevel = `grade ${Math.max(6, Math.min(12, Math.round(findings.readability.grade)))} or lower`;
  const prefer = {};
  for (const { forms } of findings.variants) {
    const ranked = Object.entries(forms).sort((a, b) => b[1] - a[1]);
    if (ranked.length > 1) for (const [form] of ranked.slice(1)) prefer[form] = ranked[0][0];
  }
  const terms = { ...(Object.keys(prefer).length ? { prefer } : {}), ...(findings.terms.length ? { keep: findings.terms.slice(0, 15).map((item) => item.term) } : {}), ...(findings.links.vague.length ? { avoid: findings.links.vague.map((label) => label.toLowerCase()) } : {}) };
  if (Object.keys(terms).length) proposal.terms = terms;
  const ignore = [];
  for (const [category, entry] of Object.entries(findings.triage)) {
    if (entry.dismissed >= 3 && entry.accepted === 0) ignore.push(`${category} suggestions like: ${entry.dismissedExamples[0]}`);
  }
  if (ignore.length) proposal.ignore = ignore;
  const rules = [];
  if (findings.inconsistentCase.length) rules.push({ id: "consistent-terms", category: "copy", severity: "minor", rule: `Write these terms the same way everywhere: ${findings.inconsistentCase.join(", ")}.` });
  if (findings.tone.exclamationsPer1000 > 3) rules.push({ id: "exclamations", category: "copy", severity: "polish", rule: "Use exclamation marks sparingly: at most one per page." });
  if (rules.length) proposal.rules = rules;
  return proposal;
}
