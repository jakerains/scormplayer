const bad = (message) => Object.assign(new Error(`Invalid pin target: ${message}`), { statusCode: 400 });
const ATTRIBUTES = new Set(["id", "data-content-id", "data-content-component-id", "data-component-id", "data-review-id", "data-tour-id", "data-testid", "aria-labelledby", "aria-describedby", "aria-label", "alt", "title", "oai-annotatable", "href", "src", "role"]);
const record = (value) => value && typeof value === "object" && !Array.isArray(value);
const text = (value, max, field) => { if (typeof value !== "string" || value.length > max) throw bad(field); return value; };
const number = (value, field) => { if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1e8) throw bad(field); return value; };
function point(value, field, dimensions = false) {
  if (!record(value)) throw bad(field);
  const out = { x: number(value.x, field), y: number(value.y, field) };
  if (dimensions) for (const key of ["width", "height"]) { out[key] = number(value[key], field); if (out[key] < 0) throw bad(field); }
  return out;
}
function attributes(value) {
  if (!record(value) || Object.keys(value).length > 32) throw bad("attributes");
  return Object.fromEntries(Object.entries(value).filter(([key]) => ATTRIBUTES.has(key)).map(([key, value]) => [key, text(value, 300, key)]));
}

/** Typed, bounded anchors; legacy partial targets remain accepted and never gain version 1. */
export function validateTarget(value, depth = 0) {
  if (value == null) return undefined;
  if (!record(value) || depth > 2) throw bad("expected an object");
  if (JSON.stringify(value).length > 20_000) throw bad("details exceed 20 KB");
  const out = {};
  for (const [key, max] of Object.entries({ selector: 2000, name: 200, tag: 80, text: 600, rawText: 1200, textTransform: 80 })) if (value[key] !== undefined) out[key] = text(value[key], max, key);
  if (out.tag && !/^[a-z][a-z0-9-]*$/.test(out.tag)) throw bad("tag");
  if (value.kind !== undefined) {
    if (!["element", "text", "region", "group"].includes(value.kind)) throw bad("kind");
    out.kind = value.kind;
  }
  if (value.anchorVersion !== undefined) {
    if (value.anchorVersion !== 1 || !out.selector || !out.tag || !out.kind || !value.rect || !value.viewport) throw bad("incomplete or unsupported anchor version");
    out.anchorVersion = 1;
  }
  for (const key of ["rect", "offset", "scroll", "normalizedRegion"]) if (value[key] !== undefined) out[key] = point(value[key], key, key === "rect" || key === "normalizedRegion");
  if (out.normalizedRegion) {
    const r = out.normalizedRegion;
    if (out.kind !== "region" || Object.values(r).some((v) => v < 0 || v > 1) || r.x + r.width > 1.001 || r.y + r.height > 1.001) throw bad("normalizedRegion must fit inside the target");
  }
  if (value.viewport !== undefined) {
    if (!record(value.viewport)) throw bad("viewport");
    out.viewport = {};
    for (const key of ["width", "height"]) { const n = number(value.viewport[key], "viewport"); if (n <= 0) throw bad("viewport"); out.viewport[key] = n; }
  }
  if (value.attributes !== undefined) out.attributes = attributes(value.attributes);
  if (value.selectorUnique !== undefined) { if (typeof value.selectorUnique !== "boolean") throw bad("selectorUnique"); out.selectorUnique = value.selectorUnique; }
  for (const key of ["ancestors", "scrollContainers"]) if (value[key] !== undefined) {
    if (!Array.isArray(value[key]) || value[key].length > 6) throw bad(key);
    out[key] = value[key].map((item) => {
      if (!record(item)) throw bad(key);
      const selector = text(item.selector, 2000, key);
      return key === "ancestors" ? { selector, tag: text(item.tag, 80, key), attributes: attributes(item.attributes) } : { selector, ...point(item, key) };
    });
  }
  if (value.clicked !== undefined) out.clicked = validateTarget(value.clicked, depth + 1);
  if (value.targets !== undefined) {
    if (!Array.isArray(value.targets) || value.targets.length < 1 || value.targets.length > 20) throw bad("group must contain 1–20 targets");
    out.targets = value.targets.map((item) => validateTarget(item, depth + 1));
    if (out.targets.some((item) => !item)) throw bad("empty group target");
  }
  if (out.anchorVersion && out.kind === "group" && !out.targets) throw bad("group targets required");
  return out;
}
