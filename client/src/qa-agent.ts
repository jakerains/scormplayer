import { toCanvas } from "html-to-image";
import { describeElement, visibleText } from "./picker";

/**
 * What an agent doing a QA pass reads from the page on screen: its text, headings, images,
 * controls and media, each with a selector it can pin. Only visible content, in reading order,
 * bounded so a long page stays a reasonable size.
 */

export type SnapshotItem = { selector: string; text: string };
export type PageSnapshot = {
  title: string;
  url: string;
  lang: string | null;
  headings: (SnapshotItem & { level: number })[];
  text: (SnapshotItem & { tag: string })[];
  images: { selector: string; src: string; alt: string | null; role: string | null; width: number; height: number }[];
  controls: (SnapshotItem & { tag: string; role: string | null; disabled: boolean; type?: string })[];
  media: { selector: string; kind: "audio" | "video"; src: string; captions: boolean; controls: boolean; duration: number | null }[];
  truncated: boolean;
};

const TEXT_TAGS = new Set(["P", "LI", "TD", "TH", "LABEL", "FIGCAPTION", "BLOCKQUOTE", "DT", "DD", "LEGEND", "CAPTION", "SUMMARY", "PRE"]);
const CONTROL_SELECTOR = "button, a[href], input, select, textarea, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=menuitem], [tabindex]:not([tabindex='-1'])";
const MAX_ITEMS = 150;
const MAX_TEXT = 600;

function visible(element: Element) {
  const view = element.ownerDocument.defaultView;
  if (!view) return false;
  const box = element.getBoundingClientRect();
  if (box.width < 1 || box.height < 1) return false;
  const style = view.getComputedStyle(element);
  return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.01;
}

/** Text an element holds directly (not inside a child element that is captured on its own). */
function ownText(element: Element) {
  let text = "";
  for (const node of Array.from(element.childNodes)) if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? "";
  return text.replace(/\s+/g, " ").trim();
}

const clip = (value: string) => (value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT - 1)}…` : value);
const selectorOf = (element: Element) => describeElement(element).selector;

export function pageSnapshot(doc: Document): PageSnapshot {
  const all = Array.from(doc.body?.querySelectorAll("*") ?? []).filter(visible);
  let truncated = false;
  const take = <T,>(items: T[]) => { if (items.length > MAX_ITEMS) truncated = true; return items.slice(0, MAX_ITEMS); };

  const headings = take(all.filter((element) => /^H[1-6]$/.test(element.tagName) || element.getAttribute("role") === "heading")
    .map((element) => ({ level: Number(element.tagName[1]) || Number(element.getAttribute("aria-level")) || 2, text: clip(visibleText(element)), selector: selectorOf(element) }))
    .filter((item) => item.text));

  // Blocks of reading text: text elements, and any other element that holds text of its own.
  const blocks = all.filter((element) => {
    if (/^H[1-6]$/.test(element.tagName) || element.matches(CONTROL_SELECTOR) || element.closest("script, style, noscript, template, svg")) return false;
    if (TEXT_TAGS.has(element.tagName)) return !element.parentElement?.closest(Array.from(TEXT_TAGS).join(","));
    return ownText(element).length > 1 && !element.parentElement?.closest(Array.from(TEXT_TAGS).join(","));
  });
  const text = take(blocks.map((element) => ({ tag: element.tagName.toLowerCase(), text: clip(TEXT_TAGS.has(element.tagName) ? visibleText(element) : ownText(element)), selector: selectorOf(element) }))
    .filter((item) => item.text));

  const images = take(all.filter((element) => element.tagName === "IMG" || element.getAttribute("role") === "img" || element.tagName === "svg" && !element.parentElement?.closest("svg"))
    .map((element) => {
      const box = element.getBoundingClientRect();
      return {
        selector: selectorOf(element),
        src: (element as HTMLImageElement).currentSrc || element.getAttribute("src") || "",
        alt: element.getAttribute("alt") ?? element.getAttribute("aria-label"),
        role: element.getAttribute("role"),
        width: Math.round(box.width),
        height: Math.round(box.height),
      };
    }));

  const controls = take(all.filter((element) => element.matches(CONTROL_SELECTOR))
    .map((element) => ({
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role"),
      text: clip(element.getAttribute("aria-label") || visibleText(element) || (element as HTMLInputElement).value || element.getAttribute("title") || element.getAttribute("placeholder") || ""),
      disabled: (element as HTMLButtonElement).disabled === true || element.getAttribute("aria-disabled") === "true",
      ...(element.tagName === "INPUT" ? { type: (element as HTMLInputElement).type } : {}),
      selector: selectorOf(element),
    })));

  const media = take(Array.from(doc.querySelectorAll("audio, video")).map((element) => {
    const player = element as HTMLMediaElement;
    return {
      selector: selectorOf(element),
      kind: element.tagName === "VIDEO" ? "video" as const : "audio" as const,
      src: player.currentSrc || player.getAttribute("src") || "",
      captions: Boolean(element.querySelector("track[kind=captions], track[kind=subtitles]")),
      controls: player.controls,
      duration: Number.isFinite(player.duration) ? Math.round(player.duration) : null,
    };
  }));

  return {
    title: doc.title,
    url: `${doc.location.pathname.replace(/^\/course\//, "")}${doc.location.search ? "?…" : ""}${doc.location.hash}`,
    lang: doc.documentElement.getAttribute("lang"),
    headings, text, images, controls, media, truncated,
  };
}

/** A JPEG of what is on screen in the course frame, as a data URL (for an agent to look at). */
export async function captureViewport(doc: Document): Promise<string | null> {
  const view = doc.defaultView;
  if (!view || !doc.body) return null;
  try {
    const canvas = await toCanvas(doc.documentElement, {
      pixelRatio: 1,
      backgroundColor: "#ffffff",
      filter: (node) => !(node instanceof view.HTMLIFrameElement),
      imagePlaceholder: "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
    });
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.min(view.innerWidth, 1600));
    out.height = Math.max(1, Math.min(view.innerHeight, 1200));
    out.getContext("2d")!.drawImage(canvas, view.scrollX, view.scrollY, out.width, out.height, 0, 0, out.width, out.height);
    return out.toDataURL("image/jpeg", 0.72);
  } catch {
    return null;
  }
}

/** Wait until `ready()` holds, up to `timeout` ms. */
export async function waitFor(ready: () => boolean, timeout = 15_000, step = 150) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (ready()) return true;
    await new Promise((resolve) => setTimeout(resolve, step));
  }
  return ready();
}
