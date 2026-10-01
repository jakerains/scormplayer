import { toBlob, toCanvas } from "html-to-image";

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

/** A drawn area: render the element that contains it, then cut out the box. */
export async function captureRegion(element: Element, offset: { x: number; y: number }, size: { width: number; height: number }): Promise<Blob | null> {
  const view = element.ownerDocument.defaultView;
  if (!view) return null;
  const ratio = Math.min(2, view.devicePixelRatio || 1);
  try {
    const canvas = await toCanvas(element as HTMLElement, { backgroundColor: backgroundOf(element), pixelRatio: ratio, filter: (node) => !(node instanceof view.HTMLIFrameElement) });
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(size.width * ratio));
    out.height = Math.max(1, Math.round(size.height * ratio));
    out.getContext("2d")!.drawImage(canvas, offset.x * ratio, offset.y * ratio, out.width, out.height, 0, 0, out.width, out.height);
    return await new Promise((resolve) => out.toBlob(resolve, "image/png"));
  } catch {
    return null;
  }
}
