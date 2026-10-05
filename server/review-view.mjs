/** Injected before course scripts in live mode only. Keep this function self-contained. */
export function installReviewView() {
  const scope = window.frameElement?.getAttribute("data-review-scope");
  if (!scope || window.__SCORMPLAYER_REVIEW__) return;
  const key = `scormplayer:review:v1:${scope}`;
  const adapters = new Map();
  let navigation = null;
  let snapshot = null;
  let disabled = false;
  let suspended = false;
  let pending = null;
  let timer = 0;
  let saveTimer = 0;
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) || "null");
    if (saved?.version === 1 && saved.scope === scope && saved.dom && saved.adapters) snapshot = saved;
  } catch { /* unavailable storage or obsolete snapshot */ }

  // Only stable, unique keys: positional selectors can target a different control after an edit.
  const selectorOf = (element) => {
    if (!(element instanceof HTMLElement)) return null;
    const selector = element.id ? `#${CSS.escape(element.id)}` : element.hasAttribute("data-review-key")
      ? `[data-review-key="${CSS.escape(element.getAttribute("data-review-key"))}"]` : null;
    return selector && document.querySelectorAll(selector).length === 1 ? selector : null;
  };
  const find = (selector) => {
    try {
      const matches = typeof selector === "string" ? document.querySelectorAll(selector) : [];
      return matches.length === 1 ? matches[0] : null;
    } catch { return null; }
  };
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const save = () => {
    if (disabled || suspended || pending) return;
    const values = { ...snapshot?.adapters };
    for (const [id, adapter] of adapters) {
      try { values[id] = { version: adapter.version, data: copy(adapter.capture()) }; } catch { /* one adapter cannot block the rest */ }
    }
    const elements = Array.from(document.querySelectorAll("[id], [data-review-key]"));
    snapshot = {
      version: 1, scope,
      url: `${location.pathname}${location.search}${location.hash}`,
      adapters: values,
      dom: {
        x: scrollX, y: scrollY,
        focus: document.hasFocus() ? selectorOf(document.activeElement) : null,
        details: elements.filter((element) => element instanceof HTMLDetailsElement)
          .map((element) => ({ selector: selectorOf(element), open: element.open })).filter((item) => item.selector),
        scroll: elements.filter((element) => element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth)
          .map((element) => ({ selector: selectorOf(element), x: element.scrollLeft, y: element.scrollTop })).filter((item) => item.selector),
      },
    };
    try {
      const serialized = JSON.stringify(snapshot);
      if (serialized.length <= 256_000) sessionStorage.setItem(key, serialized);
      else sessionStorage.removeItem(key);
    } catch { /* storage blocked/full: retain the in-document snapshot for HMR */ }
  };
  const queueSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 80);
  };
  const stopRestore = () => {
    clearTimeout(timer);
    pending = null;
  };
  const restoreDom = () => {
    if (!pending || disabled) return;
    const dom = pending.dom;
    for (const item of Array.isArray(dom.details) ? dom.details : []) {
      const element = find(item.selector);
      if (element instanceof HTMLDetailsElement && typeof item.open === "boolean") element.open = item.open;
    }
    for (const item of Array.isArray(dom.scroll) ? dom.scroll : []) {
      const element = find(item.selector);
      if (element instanceof HTMLElement && Number.isFinite(item.x) && Number.isFinite(item.y)) {
        element.scrollTo({ left: item.x, top: item.y, behavior: "instant" });
      }
    }
    if (Number.isFinite(dom.x) && Number.isFinite(dom.y)) window.scrollTo({ left: dom.x, top: dom.y, behavior: "instant" });
    const focus = find(dom.focus);
    // Do not take focus from a note or a control in the player chrome.
    if (!pending.focused && focus instanceof HTMLElement && focus.getClientRects().length
      && (parent.document.activeElement === window.frameElement || parent.document.activeElement === parent.document.body)) {
      focus.focus({ preventScroll: true });
      pending.focused = true;
    }
    if (performance.now() < pending.until) timer = setTimeout(restoreDom, 100);
    else { stopRestore(); save(); }
  };
  const restore = () => {
    suspended = false;
    stopRestore();
    if (!snapshot || disabled) return queueSave();
    pending = { dom: snapshot.dom, until: performance.now() + 3000, focused: false };
    restoreDom();
  };
  const read = (id, version) => {
    const value = snapshot?.adapters?.[id];
    try { return value?.version === version ? copy(value.data) : undefined; } catch { return undefined; }
  };
  window.__SCORMPLAYER_REVIEW__ = {
    version: 1,
    read,
    register(adapter) {
      if (!adapter || typeof adapter.id !== "string" || !Number.isInteger(adapter.version)
        || typeof adapter.capture !== "function" || typeof adapter.restore !== "function") return () => {};
      adapters.set(adapter.id, adapter);
      const value = read(adapter.id, adapter.version);
      try { if (value !== undefined) adapter.restore(value); } catch { /* incompatible course state */ }
      return () => { if (adapters.get(adapter.id) === adapter) adapters.delete(adapter.id); };
    },
    checkpoint(leaving = false) {
      if (!suspended) { stopRestore(); save(); }
      // Firefox clears scroll offsets while an iframe is detached. Keep the earlier checkpoint.
      if (leaving) suspended = true;
    },
    registerNavigation(adapter) {
      navigation = adapter;
      return () => { if (navigation === adapter) navigation = null; };
    },
    async skip(kind) {
      const action = kind === "page" ? navigation?.nextPage : kind === "guide" ? navigation?.nextGuideStep : null;
      if (typeof action !== "function") return false;
      stopRestore();
      const result = await action();
      // Give the course's state update a chance to commit before retaining the new view.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      save();
      return result === true;
    },
    // Course calls after its restored React state has committed. Also useful for delayed mounts.
    ready: restore,
    beforeUpdate() { save(); suspended = true; stopRestore(); },
    afterUpdate: restore,
    clear() {
      disabled = true;
      snapshot = null;
      stopRestore();
      clearTimeout(saveTimer);
      try { sessionStorage.removeItem(key); } catch { /* storage blocked */ }
    },
  };
  // A saved view must survive early mounts until the course has committed its restored state.
  if (snapshot) suspended = true;
  for (const name of ["scroll", "focusin", "focusout", "toggle"]) document.addEventListener(name, queueSave, true);
  for (const name of ["pointerdown", "keydown", "wheel", "touchstart"]) {
    document.addEventListener(name, (event) => {
      if (!event.isTrusted || suspended) return;
      stopRestore();
      queueSave();
    }, { capture: true, passive: true });
  }
  window.addEventListener("pagehide", save);
  window.addEventListener("beforeunload", save);
  window.addEventListener("hashchange", queueSave);
  window.addEventListener("popstate", queueSave);
  new MutationObserver(queueSave).observe(document.documentElement, { childList: true, subtree: true });
  if (document.readyState === "complete") restore();
  else window.addEventListener("load", restore, { once: true });
}

export const reviewViewTags = [
  { tag: "script", injectTo: "head-prepend", children: `(${installReviewView.toString()})();` },
  {
    tag: "script", attrs: { type: "module" }, injectTo: "head-prepend",
    children: `import { createHotContext } from "/course/@vite/client";
const hot = createHotContext("/course/@scormplayer/review-view");
hot.on("vite:beforeUpdate", () => window.__SCORMPLAYER_REVIEW__?.beforeUpdate());
hot.on("vite:beforeFullReload", () => window.__SCORMPLAYER_REVIEW__?.beforeUpdate());
hot.on("vite:afterUpdate", () => window.__SCORMPLAYER_REVIEW__?.afterUpdate());`,
  },
];
