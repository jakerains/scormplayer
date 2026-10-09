/**
 * Choosing what a pin points at, from what is already on the page. Nothing is added to the
 * course: the picker reads its structure and any labels it already has.
 */

export type Rect = { x: number; y: number; width: number; height: number };

export type PinTarget = {
  anchorVersion?: 1;
  /** Fractions of the containing element; legacy pixel offsets remain readable. */
  normalizedRegion?: Rect;
  kind: "element" | "text" | "region" | "group";
  name: string;
  tag: string;
  selector: string;
  text: string;
  clicked?: PinTarget;
  rawText?: string;
  textTransform?: string;
  ancestors?: { selector: string; tag: string; attributes: Record<string, string> }[];
  scroll?: { x: number; y: number };
  scrollContainers?: { selector: string; x: number; y: number }[];
  selectorUnique?: boolean;
  rect: Rect;
  viewport: { width: number; height: number };
  attributes?: Record<string, string>;
  /** Region pins: where the box sits relative to the element that contains it. */
  offset?: { x: number; y: number };
  /** Group pins: each selected element. */
  targets?: PinTarget[];
};

/** Elements that are worth pinning on their own. */
const MEANINGFUL = [
  "button", "a[href]", "input", "select", "textarea", "label", "img", "video", "audio", "svg", "canvas", "iframe",
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "figure", "blockquote", "pre", "table", "tr", "td", "th", "summary", "dt", "dd",
  "[role=button]", "[role=tab]", "[role=link]", "[role=img]", "[role=checkbox]", "[role=radio]", "[role=option]",
  "[data-component-id]", "[data-review-id]", "[data-content-id]", "[data-content-component-id]", "[data-tour-id]", "[role=dialog]", "[role=listitem]", "[aria-label]", "[data-testid]", "[oai-annotatable]",
].join(",");

/** Attributes worth carrying into a pin when a course already has them. */
export const IDENTITY_ATTRIBUTES = ["id", "data-content-id", "data-content-component-id", "data-component-id", "data-review-id", "data-tour-id", "data-testid"];
const READ_ATTRIBUTES = [...IDENTITY_ATTRIBUTES, "aria-labelledby", "aria-describedby", "aria-label", "alt", "title", "oai-annotatable", "href", "src", "role"];

/** The element a pointer over `element` should select. */
export function chooseTarget(element: Element | null): Element | null {
  if (!element || isRoot(element)) return null;
  // A course that already marks objects for ChatGPT's annotations gets the same grouping here.
  const marked = element.closest("[oai-annotation-container] [oai-annotatable]");
  if (marked) return marked;
  const svgRoot = element.closest("svg");
  if (svgRoot) return outermost(svgRoot, "svg");
  const meaningful = element.closest(MEANINGFUL);
  if (meaningful && !isRoot(meaningful)) return meaningful;
  return element;
}

/** One step wider: the next meaningful ancestor. */
export function widenTarget(element: Element): Element | null {
  let parent = element.parentElement;
  while (parent && !isRoot(parent)) {
    const box = parent.getBoundingClientRect();
    const own = element.getBoundingClientRect();
    // Skip wrappers that are the same size as what is already selected.
    if (Math.abs(box.width - own.width) > 2 || Math.abs(box.height - own.height) > 2) return parent;
    parent = parent.parentElement;
  }
  return null;
}

export function describeElement(element: Element): PinTarget {
  const win = element.ownerDocument.defaultView!;
  const box = element.getBoundingClientRect();
  return {
    ...evidenceOf(element),
    anchorVersion: 1,
    kind: "element",
    name: nameOf(element),
    tag: element.tagName.toLowerCase(),
    selector: cssPath(element),
    text: visibleText(element).slice(0, 600),
    rect: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) },
    viewport: { width: win.innerWidth, height: win.innerHeight },
    attributes: attributesOf(element),
  };
}

export function describeTextSelection(selection: Selection): PinTarget | null {
  const text = selection.toString().replace(/\s+/g, " ").trim();
  if (!text || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const container = range.commonAncestorContainer;
  const element = container.nodeType === 1 ? (container as Element) : container.parentElement;
  if (!element) return null;
  const win = element.ownerDocument.defaultView!;
  const box = range.getBoundingClientRect();
  return {
    ...evidenceOf(element),
    anchorVersion: 1,
    kind: "text",
    name: `“${text.length > 60 ? `${text.slice(0, 59)}…` : text}”`,
    tag: element.tagName.toLowerCase(),
    selector: cssPath(element),
    text: text.slice(0, 600),
    rect: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) },
    viewport: { width: win.innerWidth, height: win.innerHeight },
    attributes: attributesOf(element),
  };
}

/** A box drawn over the course: anchored to the smallest element that contains it. */
export function describeRegion(doc: Document, band: Rect): { element: Element; target: PinTarget } | null {
  if (!Object.values(band).every(Number.isFinite) || band.width < 8 || band.height < 8) return null;
  const contains = (box: Rect) => box.width > 0 && box.height > 0 && box.x <= band.x && box.y <= band.y && box.x + box.width >= band.x + band.width && box.y + box.height >= band.y + band.height;
  let element: Element | null = doc.elementFromPoint(band.x + band.width / 2, band.y + band.height / 2) ?? doc.documentElement;
  while (element) {
    if (contains(regionAnchorRect(element))) break;
    element = element.parentElement;
  }
  if (!element) return null;
  const anchor = regionAnchorRect(element);
  const inside = Array.from(element.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,button,a,label,figcaption,td,th"))
    .filter((child) => {
      const box = child.getBoundingClientRect();
      return box.width > 0 && box.x >= band.x - 2 && box.y >= band.y - 2 && box.right <= band.x + band.width + 2 && box.bottom <= band.y + band.height + 2;
    })
    .map(visibleText)
    .filter(Boolean);
  const win = doc.defaultView!;
  const rect = { x: Math.round(band.x), y: Math.round(band.y), width: Math.round(band.width), height: Math.round(band.height) };
  return {
    element,
    target: {
      ...evidenceOf(element),
      anchorVersion: 1,
      attributes: attributesOf(element),
      kind: "region",
      name: `Area ${rect.width}×${rect.height} in ${nameOf(element)}`.slice(0, 120),
      tag: element.tagName.toLowerCase(),
      selector: isRoot(element) ? element.tagName.toLowerCase() : cssPath(element),
      text: inside.join(" · ").slice(0, 600),
      rect,
      offset: { x: Math.round(band.x - anchor.x), y: Math.round(band.y - anchor.y) },
      normalizedRegion: { x: (band.x - anchor.x) / anchor.width, y: (band.y - anchor.y) / anchor.height, width: band.width / anchor.width, height: band.height / anchor.height },
      viewport: { width: win.innerWidth, height: win.innerHeight },
    },
  };
}

/** Root selections include the document canvas, which may extend beyond a short body's box. */
function regionAnchorRect(element: Element): Rect {
  const doc = element.ownerDocument;
  if (element !== doc.documentElement) return toRect(element.getBoundingClientRect());
  const win = doc.defaultView!;
  return {
    x: -win.scrollX, y: -win.scrollY,
    width: Math.max(doc.documentElement.scrollWidth, doc.documentElement.clientWidth, doc.body?.scrollWidth ?? 0),
    height: Math.max(doc.documentElement.scrollHeight, doc.documentElement.clientHeight, doc.body?.scrollHeight ?? 0),
  };
}

/** Several elements pinned with one note. The first one anchors the pin. */
export function describeGroup(elements: Element[]): PinTarget {
  const parts = elements.map(describeElement);
  const first = parts[0];
  return {
    ...first,
    kind: "group",
    name: `${parts.length} elements: ${parts.map((part) => part.name).join(" · ")}`.slice(0, 160),
    text: parts.map((part) => part.text).filter(Boolean).join(" · ").slice(0, 600),
    targets: parts,
  };
}

/** The current on-screen box for a saved pin's target, if it is on this page and visible. */
export function locateTarget(doc: Document, target: PinTarget, element = elementFor(doc, target)): Rect | null {
  if (!element) return null;
  if (target.kind === "region" && target.offset) {
    const anchor = target.normalizedRegion ? regionAnchorRect(element) : element.getBoundingClientRect();
    if (anchor.width === 0 && anchor.height === 0) return null;
    const relative = target.normalizedRegion;
    return relative
      ? { x: anchor.x + relative.x * anchor.width, y: anchor.y + relative.y * anchor.height, width: relative.width * anchor.width, height: relative.height * anchor.height }
      : { x: anchor.x + target.offset.x, y: anchor.y + target.offset.y, width: target.rect.width, height: target.rect.height };
  }
  if (target.kind === "text") {
    const found = findTextRange(element, target.text);
    if (found) return toRect(found.getBoundingClientRect());
  }
  const box = element.getBoundingClientRect();
  if (box.width === 0 && box.height === 0) return null;
  const style = doc.defaultView?.getComputedStyle(element);
  if (style && (style.visibility === "hidden" || style.display === "none")) return null;
  return toRect(box);
}

export type TargetResolution = { status: "attached" | "possible" | "ambiguous" | "missing" | "identity-changed"; element: Element | null; method: "identity" | "selector" | "text"; matches?: number };

/** Shared by markers and MCP. Candidates are never promoted to verified identity. */
export function resolveTarget(doc: Document, target: PinTarget): TargetResolution {
  if (target.kind === "group") return target.targets?.[0] ? resolveTarget(doc, target.targets[0]) : { status: "missing", element: null, method: "selector" };
  const result = (status: TargetResolution["status"], element: Element | null, method: TargetResolution["method"], matches?: number): TargetResolution => ({ status, element, method, ...(matches === undefined ? {} : { matches }) });
  const identities = IDENTITY_ATTRIBUTES.filter((name) => target.attributes?.[name] && (name !== "id" || stableToken(target.attributes[name])));
  const query = (selector: string) => { try { return Array.from(doc.querySelectorAll(selector)); } catch { return []; } };
  if (identities.length) {
    let found: Element | null = null;
    for (const name of identities) {
      const matches = query(`[${name}="${CSS.escape(target.attributes![name])}"]`);
      if (matches.length > 1) return result("ambiguous", null, "identity", matches.length);
      if (!matches.length) return result("missing", null, "identity", 0);
      if (found && found !== matches[0]) return result("identity-changed", null, "identity");
      found = matches[0];
    }
    if (!found || (target.tag && found.tagName.toLowerCase() !== target.tag)) return result("identity-changed", null, "identity");
    for (const ancestor of target.ancestors ?? []) {
      const keys = IDENTITY_ATTRIBUTES.filter((name) => ancestor.attributes?.[name]);
      if (!keys.length) continue;
      let parent = found.parentElement;
      while (parent && !keys.every((name) => parent!.getAttribute(name) === ancestor.attributes[name])) parent = parent.parentElement;
      if (!parent) return result("identity-changed", null, "identity");
    }
    return result("attached", found, "identity", 1);
  }
  const fold = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();
  const expected = fold(target.rawText ?? target.text ?? "");
  const textMatches = (element: Element) => {
    const actual = fold(target.rawText !== undefined ? (element.textContent ?? "").slice(0, 1200) : visibleText(element).slice(0, 600));
    return target.kind === "text" ? actual.includes(fold(target.text)) : actual === expected;
  };
  const matches = query(target.selector);
  if (matches.length > 1) return result("ambiguous", null, "selector", matches.length);
  const element = matches[0];
  if (element && (!target.tag || element.tagName.toLowerCase() === target.tag) && (target.kind === "region" || !expected || textMatches(element))) return result("possible", element, "selector", 1);
  // Bounded exact-text recovery. Repeated labels always require human selection.
  if (expected.length >= 3 && /^[a-z][a-z0-9-]*$/.test(target.tag ?? "")) {
    const candidates = doc.getElementsByTagName(target.tag);
    if (candidates.length <= 3000) {
      const found = Array.from(candidates).filter(textMatches);
      if (found.length === 1) return result("possible", found[0], "text", 1);
      if (found.length > 1) return result("ambiguous", null, "text", found.length);
    }
  }
  return result("missing", null, "selector", 0);
}

export function elementFor(doc: Document, target: PinTarget): Element | null {
  return resolveTarget(doc, target).element;
}

/** Intersect with the viewport and every overflow clip, including nested lesson panels. */
export function visibleTargetRect(doc: Document, element: Element, rect: Rect): Rect | null {
  const win = doc.defaultView;
  if (!win || !element.getClientRects().length) return null;
  let left = Math.max(0, rect.x), top = Math.max(0, rect.y);
  let right = Math.min(win.innerWidth, rect.x + rect.width), bottom = Math.min(win.innerHeight, rect.y + rect.height);
  for (let parent: Element | null = element; parent; parent = parent.parentElement) {
    const style = win.getComputedStyle(parent);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0) return null;
    if (parent === element) continue;
    const box = parent.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, box.left + parent.clientLeft); right = Math.min(right, box.left + parent.clientLeft + parent.clientWidth); }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, box.top + parent.clientTop); bottom = Math.min(bottom, box.top + parent.clientTop + parent.clientHeight); }
  }
  return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}

function findTextRange(element: Element, text: string): Range | null {
  const needle = text.slice(0, 80);
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const index = (node.textContent ?? "").indexOf(needle);
    if (index >= 0) {
      const range = element.ownerDocument.createRange();
      range.setStart(node, index);
      range.setEnd(node, Math.min(index + text.length, node.textContent!.length));
      return range;
    }
  }
  return null;
}

function nameOf(element: Element): string {
  const attr = (name: string) => element.getAttribute(name)?.trim();
  const named = attr("oai-annotatable") || attr("aria-label") || attr("alt") || attr("title");
  if (named) return named.slice(0, 80);
  const heading = element.matches("h1,h2,h3,h4,h5,h6") ? null : element.querySelector("h1,h2,h3,h4,h5,h6");
  const text = visibleText(heading ?? element);
  const tag = element.tagName.toLowerCase();
  const kind = ({ a: "Link", button: "Button", img: "Image", video: "Video", svg: "Graphic", canvas: "Canvas", input: "Field", select: "Menu", textarea: "Text box", li: "List item", p: "Paragraph" } as Record<string, string>)[tag]
    ?? (/^h[1-6]$/.test(tag) ? "Heading" : element.getAttribute("role") ? capitalize(element.getAttribute("role")!) : "Section");
  return text ? `${kind}: ${text.length > 60 ? `${text.slice(0, 59)}…` : text}` : kind;
}

function attributesOf(element: Element): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const name of READ_ATTRIBUTES) {
    const value = element.getAttribute(name);
    if (value && value.length <= 300 && !value.startsWith("data:")) out[name] = value;
  }
  const metadata = element.getAttribute("oai-annotation-metadata");
  if (metadata) {
    try {
      const parsed = JSON.parse(metadata);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed).slice(0, 6)) out[key] = String(value).slice(0, 256);
      }
    } catch { /* invalid metadata is ignored, as in ChatGPT's browser */ }
  }
  return Object.keys(out).length ? out : undefined;
}

/** A selector that finds this element again: stable ids and test ids first, then a short path. */
export function cssPath(element: Element): string {
  const doc = element.ownerDocument;
  const unique = (selector: string) => {
    try { return doc.querySelectorAll(selector).length === 1; } catch { return false; }
  };
  const steps: string[] = [];
  let current: Element | null = element;
  while (current && !isRoot(current) && steps.length < 10) {
    const id = current.getAttribute("id");
    if (id && stableToken(id) && unique(`#${CSS.escape(id)}`)) {
      steps.unshift(`#${CSS.escape(id)}`);
      break;
    }
    const identity = IDENTITY_ATTRIBUTES.slice(1).map((name) => {
      const value = current!.getAttribute(name);
      return value ? `[${name}="${CSS.escape(value)}"]` : "";
    }).find((selector) => selector && unique(selector));
    if (identity) { steps.unshift(identity); break; }
    const tag = current.tagName.toLowerCase();
    const parent: Element | null = current.parentElement;
    const siblings = parent ? Array.from(parent.children).filter((child) => child.tagName === current!.tagName) : [];
    steps.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(current) + 1})` : tag);
    const selector = steps.join(" > ");
    if (steps.length >= 2 && unique(selector)) return selector;
    current = parent;
  }
  return steps.join(" > ");
}

export function visibleText(element: Element): string {
  const text = (element as HTMLElement).innerText ?? element.textContent ?? "";
  return text.replace(/\s+/g, " ").trim();
}

function stableToken(value: string) {
  // Generated ids (React useId, hashes, long numbers) change between builds; skip them.
  return !/^:|^r[0-9a-z]+:|[0-9a-f]{8,}|\d{4,}/i.test(value);
}

function outermost(element: Element, selector: string) {
  let found = element;
  for (let parent = element.parentElement?.closest(selector); parent; parent = parent.parentElement?.closest(selector)) found = parent;
  return found;
}

function isRoot(element: Element) {
  const tag = element.tagName.toLowerCase();
  return tag === "html" || tag === "body";
}

function toRect(box: DOMRect): Rect {
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Bounded evidence; ancestor identity stays attached to the element that owns it. */
function evidenceOf(element: Element) {
  const win = element.ownerDocument.defaultView!;
  const ancestors: NonNullable<PinTarget["ancestors"]> = [];
  const scrollContainers: NonNullable<PinTarget["scrollContainers"]> = [];
  let parent = element.parentElement;
  for (let depth = 0; parent && depth < 12; depth++, parent = parent.parentElement) {
    const attributes = attributesOf(parent);
    if (attributes && ancestors.length < 6) ancestors.push({ selector: cssPath(parent), tag: parent.tagName.toLowerCase(), attributes });
    if ((parent.scrollTop || parent.scrollLeft) && scrollContainers.length < 6) scrollContainers.push({ selector: cssPath(parent), x: parent.scrollLeft, y: parent.scrollTop });
  }
  return {
    rawText: (element.textContent ?? "").slice(0, 1200),
    textTransform: win.getComputedStyle(element).textTransform,
    ancestors,
    scroll: { x: win.scrollX, y: win.scrollY },
    scrollContainers,
    selectorUnique: element.ownerDocument.querySelectorAll(cssPath(element) || "body").length === 1,
  };
}
