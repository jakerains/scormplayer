import { toBlob } from "html-to-image";

/**
 * A picture of the pinned element, rendered by the browser from the course's own DOM. Best
 * effort: a pin is saved first, and a failed capture leaves it without a screenshot.
 */
export async function captureElement(element: Element): Promise<Blob | null> {
  const doc = element.ownerDocument;
  const win = doc.defaultView;
  if (!win) return null;
  const box = element.getBoundingClientRect();
  if (box.width < 2 || box.height < 2) return null;
  const scale = Math.min(2, Math.max(1, 1200 / Math.max(box.width, box.height)), win.devicePixelRatio || 1);
  try {
    return await toBlob(element as HTMLElement, {
      backgroundColor: backgroundOf(element),
      pixelRatio: scale,
      cacheBust: false,
      // Media from other origins would taint the canvas; leave it out rather than fail.
      filter: (node) => !(node instanceof win.HTMLIFrameElement),
      imagePlaceholder: "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
    });
  } catch {
    return null;
  }
}

function backgroundOf(element: Element) {
  const view = element.ownerDocument.defaultView!;
  for (let current: Element | null = element; current; current = current.parentElement) {
    const color = view.getComputedStyle(current).backgroundColor;
    if (color && color !== "transparent" && !/rgba\(.*,\s*0\)$/.test(color)) return color;
  }
  return "#ffffff";
}
