import fs from "node:fs";
import path from "node:path";

const TEXT_FILES = /\.(json|html?|xml|md|mdx|txt|js|jsx|mjs|cjs|ts|tsx|mts|vue|svelte|astro|ya?ml)$/i;
const SKIP_DIRS = new Set(["node_modules", ".git", ".scormplayer", "dist", "build", ".next", ".vite", "coverage", "__MACOSX"]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 4000;
const MAX_LINE = 400;
/** Build output with a content hash in its name (index-0jEii_tN.js, app.3f9a1c2b.css). */
const HASHED_BUNDLE = /[-.](?=[A-Za-z0-9_]*\d)[A-Za-z0-9_]{8,}\.(m?js|cjs|css)$/;

/**
 * Find where a piece of on-page text lives in the course files, so a pin can say
 * "src/content/pages.json:212" instead of leaving the agent to search. Works on what is
 * already there; nothing is added to the course.
 *
 * @param {string} root
 * @param {string} text
 * @returns {{ file: string, line: number, preview: string }[]}
 */
export function findSourceText(root, text) {
  const needles = candidateNeedles(text);
  if (!needles.length) return [];
  const files = listFiles(root);
  for (const needle of needles) {
    const matches = [];
    for (const file of files) {
      const raw = fs.readFileSync(file, "utf8");
      const normalized = normalize(decodeEscapes(raw));
      if (!normalized.includes(needle)) continue;
      const lines = raw.split("\n");
      const lineIndex = lines.findIndex((line) => normalize(decodeEscapes(line)).includes(needle));
      // A hit on a minified line is a compiled bundle, not something a person edits.
      if (lineIndex < 0 || lines[lineIndex].length > MAX_LINE) continue;
      matches.push({
        file: path.relative(root, file).split(path.sep).join("/"),
        line: lineIndex + 1,
        preview: lines[lineIndex].trim().slice(0, 160),
      });
      if (matches.length >= 5) break;
    }
    if (matches.length) return rank(matches);
  }
  return [];
}

/** Longest first: the whole text, then its first sentence, then a distinctive run of words. */
function candidateNeedles(text) {
  const clean = normalize(text);
  if (clean.length < 4) return [];
  const needles = [clean.slice(0, 160)];
  const sentence = clean.split(/(?<=[.!?])\s/)[0];
  if (sentence && sentence.length >= 12 && sentence !== needles[0]) needles.push(sentence.slice(0, 120));
  const words = clean.split(" ");
  if (words.length > 6) needles.push(words.slice(0, 6).join(" "));
  return [...new Set(needles)].filter((needle) => needle.length >= 4);
}

/** Prefer content and markup over scripts and generated files. */
function rank(matches) {
  const score = (file) => (/\.(json|md|mdx|html?|xml|ya?ml)$/i.test(file) ? 0 : 1) + (/(^|\/)(assets|vendor|lib)\//.test(file) ? 2 : 0);
  return matches.sort((a, b) => score(a.file) - score(b.file));
}

function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    if (out.length >= MAX_FILES) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") && entry.name !== ".") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (TEXT_FILES.test(entry.name) && !HASHED_BUNDLE.test(entry.name) && !/\.min\.(js|css)$/.test(entry.name) && fs.statSync(full).size <= MAX_FILE_BYTES) {
        out.push(full);
        if (out.length >= MAX_FILES) return;
      }
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
  return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
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
