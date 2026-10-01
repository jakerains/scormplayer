/**
 * Page navigation for review, from whatever the course already offers, best first:
 *
 * 1. A same-origin review bridge on the course window (`__SCORM_REVIEW__`, or the older
 *    `__ACADEMY_SCORM_REVIEW__` name): getScenes / getCurrentIndex / goToScene.
 * 2. The scorm-review message handshake: the player posts `scorm-review:host`, the course answers
 *    with `scorm-review:nav` { pages, index } after every move, and the player posts
 *    `scorm-review:goto` { index } to jump.
 * 3. The course's own page menu: a nav/list containing `aria-current="step"`, whose buttons are
 *    clicked to move (only when nothing better exists, since a learner control can record progress).
 *
 * Review jumps never unlock, score or complete anything themselves; that's the course's business.
 */

export type NavPage = { id: string; title: string };
export type NavState = { source: "bridge" | "message" | "menu"; pages: NavPage[]; index: number } | null;

type Bridge = {
  getScenes?: () => readonly { id: string; title: string }[];
  getCurrentIndex?: () => number;
  goToScene?: (index: number) => boolean | void | Promise<boolean | void>;
};

export function createNavigator(frame: HTMLIFrameElement, onChange: (state: NavState) => void) {
  let message: { pages: NavPage[]; index: number } | null = null;
  let last = "";

  const win = () => {
    try { return frame.contentWindow as (Window & { __SCORM_REVIEW__?: Bridge; __ACADEMY_SCORM_REVIEW__?: Bridge }) | null; } catch { return null; }
  };
  const doc = () => {
    try { return frame.contentDocument; } catch { return null; }
  };

  const read = (): NavState => {
    const bridge = bridgeOf(win());
    try {
      const scenes = bridge?.getScenes?.();
      if (scenes?.length) {
        return { source: "bridge", pages: scenes.map(clean), index: clampIndex(bridge?.getCurrentIndex?.() ?? 0, scenes.length) };
      }
    } catch { /* fall through */ }
    if (message?.pages.length) return { source: "message", pages: message.pages, index: message.index };
    const menu = readMenu(doc());
    return menu.pages.length >= 2 ? { source: "menu", pages: menu.pages, index: menu.index } : null;
  };

  const refresh = () => {
    const state = read();
    const key = JSON.stringify(state);
    if (key !== last) {
      last = key;
      onChange(state);
    }
    return state;
  };

  const onMessage = (event: MessageEvent) => {
    if (event.source !== win()) return;
    const data = event.data as { type?: string; version?: number; pages?: unknown; index?: unknown } | null;
    if (!data || data.type !== "scorm-review:nav" || data.version !== 1 || !Array.isArray(data.pages)) return;
    const pages = data.pages.slice(0, 500).map((page: any, i: number) => clean({ id: page?.id ?? `page-${i + 1}`, title: page?.title ?? "" }));
    message = { pages, index: clampIndex(Number(data.index), pages.length) };
    refresh();
  };
  window.addEventListener("message", onMessage);

  const announce = () => {
    message = null;
    try { win()?.postMessage({ type: "scorm-review:host", version: 1 }, "*"); } catch { /* frame gone */ }
    refresh();
  };
  frame.addEventListener("load", announce);
  announce();
  const timer = window.setInterval(refresh, 300);

  return {
    refresh,
    async goTo(index: number): Promise<boolean> {
      const state = read();
      if (!state || index < 0 || index >= state.pages.length) return false;
      if (state.source === "bridge") {
        const result = await bridgeOf(win())?.goToScene?.(index);
        if (result === false) return false;
      } else if (state.source === "message") {
        win()?.postMessage({ type: "scorm-review:goto", version: 1, index, target: "package" }, "*");
      } else {
        const button = readMenu(doc()).buttons[index];
        if (!button || button.disabled) return false;
        button.click();
      }
      // Wait for the course to report the move.
      for (let i = 0; i < 25; i += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 80));
        if (refresh()?.index === index) return true;
      }
      return refresh()?.index === index;
    },
    dispose() {
      window.clearInterval(timer);
      window.removeEventListener("message", onMessage);
      frame.removeEventListener("load", announce);
    },
  };
}

function bridgeOf(target: (Window & { __SCORM_REVIEW__?: Bridge; __ACADEMY_SCORM_REVIEW__?: Bridge }) | null) {
  try { return target?.__SCORM_REVIEW__ ?? target?.__ACADEMY_SCORM_REVIEW__; } catch { return undefined; }
}

function readMenu(document: Document | null): { pages: NavPage[]; index: number; buttons: HTMLButtonElement[] } {
  const empty = { pages: [], index: 0, buttons: [] };
  if (!document) return empty;
  const current = document.querySelector<HTMLElement>('[aria-current="step"], [aria-current="page"]');
  const container = current?.closest<HTMLElement>("nav, ol, ul, aside");
  if (!container) return empty;
  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button, a[href]")) as HTMLButtonElement[];
  if (buttons.length < 2) return empty;
  const pages = buttons.map((button, i) => clean({ id: button.id || `page-${i + 1}`, title: button.innerText || button.textContent || "" }));
  const index = Math.max(0, buttons.findIndex((button) => button === current || button.contains(current!) || current!.contains(button)));
  return { pages, index, buttons };
}

function clean(page: { id: string; title: string }): NavPage {
  const title = String(page.title ?? "").replace(/\s+/g, " ").replace(/^\d{1,2}\s+/, "").trim().slice(0, 140);
  return { id: String(page.id ?? "").slice(0, 200), title: title || String(page.id ?? "") };
}

function clampIndex(value: number, length: number) {
  return Number.isInteger(value) ? Math.min(Math.max(value, 0), Math.max(0, length - 1)) : 0;
}
