/**
 * Choosing what a pin points at, from what is already on the page. Nothing is added to the
 * course: the picker reads its structure and any labels it already has.
 */

export type Rect = { x: number; y: number; width: number; height: number };

export type PinTarget = {
  kind: "element" | "text";
  name: string;
  tag: string;
  selector: string;
  text: string;
  rect: Rect;
  viewport: { width: number; height: number };
  attributes?: Record<string, string>;
};

/** Elements that are worth pinning on their own. */
const MEANINGFUL = [
  "button", "a[href]", "input", "select", "textarea", "label", "img", "video", "audio", "svg", "canvas", "iframe",
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "figure", "blockquote", "pre", "table", "tr", "td", "th", "summary", "dt", "dd",
  "[role=button]", "[role=tab]", "[role=link]", "[role=img]", "[role=checkbox]", "[role=radio]", "[role=option]",
  "[role=dialog]", "[role=listitem]", "[aria-label]", "[data-testid]", "[oai-annotatable]",
].join(",");

/** Attributes worth carrying into a pin when a course already has them. */
const READ_ATTRIBUTES = ["aria-label", "alt", "title", "data-testid", "oai-annotatable", "href", "src", "role"];

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

/** The current on-screen box for a saved pin's target, if it is on this page and visible. */
export function locateTarget(doc: Document, target: PinTarget): Rect | null {
  let element: Element | null = null;
  try { element = doc.querySelector(target.selector); } catch { return null; }
  if (!element) return null;
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

export function elementFor(doc: Document, target: PinTarget): Element | null {
  try { return doc.querySelector(target.selector); } catch { return null; }
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
  const metadata = element.closest("[oai-annotation-metadata]")?.getAttribute("oai-annotation-metadata");
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
    const testId = current.getAttribute("data-testid");
    if (testId && unique(`[data-testid="${CSS.escape(testId)}"]`)) {
      steps.unshift(`[data-testid="${CSS.escape(testId)}"]`);
      break;
    }
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
