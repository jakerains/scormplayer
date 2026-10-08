import fs from "node:fs";
import path from "node:path";
import { resolveBindings } from "./source-bindings.mjs";

const TEXT_FILES = /\.(json|html?|xml|md|mdx|txt|js|jsx|mjs|cjs|ts|tsx|mts|vue|svelte|astro|ya?ml)$/i;
const SKIP_DIRS = new Set(["node_modules", ".git", ".scormplayer", ".next", ".vite", "coverage", "__MACOSX"]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 4000;
const MAX_MATCHES = 100;

export function findSourceText(root, text) {
  return findSourceEvidence(root, { text }).source;
}

/** Search candidates never claim to prove which field renders a DOM element. */
export function findSourceEvidence(root, target = {}) {
  const needles = candidateNeedles(target.kind === "text" ? target.text : target.rawText || target.text || target.name || "");
  const groups = needles.map(() => []);
  const report = { truncated: false, filesScanned: 0, excludedPackageMetadata: true, offsetUnit: "UTF-16 code units" };
  const files = needles.length ? listFiles(root, report) : [];
  let bytes = 0;
  for (const file of files) {
    const size = safeSize(file);
    if (size > MAX_FILE_BYTES || bytes + size > MAX_BYTES) { report.truncated = true; continue; }
    bytes += size;
    let raw;
    try { raw = fs.readFileSync(file, "utf8"); } catch { report.truncated = true; continue; }
    report.filesScanned++;
    const normalized = normalize(decodeEscapes(raw));
    if (!needles.some((needle) => normalized.includes(needle))) continue;
    const indexed = indexedText(raw);
    const relative = path.relative(root, file).split(path.sep).join("/");
    const generated = /(^|\/)(assets|dist|build)\//.test(relative) || /\.min\./.test(relative) || raw.split("\n").some((line) => line.length > 1000);
    for (let i = 0; i < needles.length; i++) {
      let at = indexed.text.indexOf(needles[i]);
      while (at !== -1) {
        if (groups[i].length >= MAX_MATCHES) { report.truncated = true; break; }
        const offset = indexed.offsets[at];
        const end = indexed.offsets[at + needles[i].length] ?? raw.length;
        const prefix = raw.slice(0, offset);
        const line = prefix.split("\n").length;
        const column = offset - prefix.lastIndexOf("\n");
        groups[i].push({ file: relative, line, column, offset, endOffset: end,
          preview: raw.slice(Math.max(0, offset - 60), Math.min(raw.length, end + 60)),
          provenance: "text-match", confidence: "candidate", matchedText: needles[i],
          generated,
        });
        at = indexed.text.indexOf(needles[i], at + needles[i].length);
      }
    }
  }
  const candidates = groups.find((items) => items.length) ?? [];
  candidates.sort((a, b) => Number(a.generated) - Number(b.generated) || a.file.localeCompare(b.file) || a.offset - b.offset);
  const bindings = resolveBindings(root, target);
  return { source: [...bindings.matches, ...candidates].slice(0, MAX_MATCHES), sourceSearch: { ...report,
    truncated: report.truncated || bindings.matches.length + candidates.length > MAX_MATCHES,
    bindingStatus: bindings.status, candidateCount: candidates.length,
    advice: "Text matches are search candidates, not proof of a rendering field. Recheck bindings after edits; verify the open player before resolving.",
  } };
}

function candidateNeedles(text) {
  const clean = normalize(text);
  if (clean.length < 4) return [];
  const needles = [clean.slice(0, 160)];
  const sentence = clean.split(/(?<=[.!?])\s/)[0];
  if (sentence.length >= 12 && sentence !== needles[0]) needles.push(sentence.slice(0, 120));
  const words = clean.split(" ");
  if (words.length > 6) needles.push(words.slice(0, 6).join(" "));
  return [...new Set(needles)];
}

/** Preserve original offsets even when JSON escapes, entities or whitespace fold. */
function indexedText(raw) {
  let text = "";
  const offsets = [];
  const tokens = /\\u[0-9a-f]{4}|&(?:#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos|nbsp|rsquo|lsquo|rdquo|ldquo|mdash|ndash|hellip);|\\[n"]|[\s\S]/gi;
  for (const token of raw.matchAll(tokens)) {
    const decoded = decodeEscapes(token[0]).replace(/[‘’‛′]/g, "'").replace(/[“”″]/g, '"').replace(/[–—]/g, "-").toLowerCase();
    for (const char of decoded) {
      const value = /\s/.test(char) ? " " : char;
      if (value === " " && (!text || text.endsWith(" "))) continue;
      text += value;
      for (let i = 0; i < value.length; i++) offsets.push(token.index);
    }
  }
  return { text, offsets };
}

function listFiles(root, report) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { report.truncated = true; return; }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) { report.truncated = true; return; }
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(full); }
      else if (entry.isFile() && TEXT_FILES.test(entry.name) && !/^(imsmanifest\.xml|scormplayer\.sources\.json)$/i.test(entry.name)) out.push(full);
    }
  };
  walk(root);
  return out;
}

function decodeEscapes(value) {
  return value
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos|nbsp|rsquo|lsquo|rdquo|ldquo|mdash|ndash|hellip);/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? decodeNumeric(entity))
    .replace(/\\n/g, " ")
    .replace(/\\"/g, '"');
}

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " ", "&rsquo;": "'", "&lsquo;": "'", "&rdquo;": '"', "&ldquo;": '"', "&mdash;": "—", "&ndash;": "–", "&hellip;": "…" };

function decodeNumeric(entity) {
  const body = entity.slice(2, -1);
  const code = body.startsWith("x") || body.startsWith("X") ? parseInt(body.slice(1), 16) : parseInt(body, 10);
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
}

/** Fold the differences between rendered text and source text: quotes, dashes, spacing. */
export function normalize(value) {
  return String(value)
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function safeSize(file) {
  try { return fs.statSync(file).size; } catch { return Infinity; }
}
