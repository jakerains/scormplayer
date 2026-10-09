import type { Pin, PinPage } from "./api";
import { describeElement, resolveTarget, visibleTargetRect, locateTarget, type PinTarget } from "./picker";

type Context = {
  doc: Document | null;
  page: PinPage;
  busy: boolean;
  reload: () => Promise<void>;
  /** An agent's QA pass: snapshot, navigate, pin, and switching to the QA attempt and back. */
  qa: (action: string, request: Record<string, any>) => Promise<object>;
};

/** Ordinary HTTP + SSE works in desktop and external browsers on every supported OS. */
export function connectReviewBrowser(revision: string, context: () => Context) {
  const events = new EventSource(`/api/browser/events?revision=${encodeURIComponent(revision)}`);
  let sessionId = "";
  let stopped = false;
  let reporting = false;
  const post = async (path: string, body: unknown) => {
    const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-Scormplayer-Revision": revision }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`Browser bridge request failed (${response.status}).`);
  };
  const report = async () => {
    if (!sessionId || stopped || reporting) return;
    reporting = true;
    try {
      const current = context();
      await post(`/api/browser/${sessionId}/state`, { page: current.page, ready: Boolean(current.doc?.body) && current.doc?.readyState === "complete" && current.doc?.URL !== "about:blank" && !current.busy, visible: !document.hidden });
    } catch { /* A disconnected/replaced course re-registers through EventSource. */ }
    finally { reporting = false; }
  };
  events.onmessage = async (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "connected") { sessionId = message.sessionId; void report(); return; }
    if (message.type !== "request" || message.revision !== revision || stopped) return;
    const responseSession = sessionId;
    let observation: object;
    try {
      const current = context();
      if (message.action === "reload") {
        await current.reload();
        await report();
        observation = { status: "reload-requested", page: current.page, advice: "Wait for readiness, then verify the pin. Reload does not imply acceptance." };
      } else if (String(message.action).startsWith("qa-")) {
        try { observation = await current.qa(message.action, message); }
        catch (error) { observation = { error: error instanceof Error ? error.message : String(error), ...(typeof (error as any)?.statusCode === "number" ? { statusCode: (error as any).statusCode } : {}) }; }
      } else observation = observePin(current, message.pin);
    } catch (error) { observation = { status: "unavailable", reason: String(error) }; }
    if (!stopped) await post(`/api/browser/${responseSession}/answer/${encodeURIComponent(message.id)}`, observation).catch(() => {});
    void report();
  };
  const timer = window.setInterval(() => void report(), 3000);
  document.addEventListener("visibilitychange", report);
  return () => { stopped = true; window.clearInterval(timer); events.close(); document.removeEventListener("visibilitychange", report); };
}

function observePin(current: Context, pin: Pin) {
  const { doc, page } = current;
  const base = { observedAt: new Date().toISOString(), page };
  if (!doc?.body || doc.readyState === "loading" || current.busy) return { ...base, status: "not-ready", reason: current.busy ? "Navigation or reload is pending." : "The course document is still loading." };
  if (!pin.page?.url || pin.page.url !== page.url || ["navId", "scoId", "location"].some((key) => {
    const saved = pin.page?.[key as keyof PinPage];
    return saved !== undefined && saved !== page[key as keyof PinPage];
  })) return { ...base, status: "wrong-page", reason: "Navigate to the pin's original page in this tab, then retry." };
  if (!pin.target?.selector || pin.target.kind === "region") return { ...base, status: "visual-review-required", reason: "This pin has no single DOM target to verify." };
  const targets = pin.target.kind === "group" ? pin.target.targets ?? [] : [pin.target];
  const observations = targets.slice(0, 20).map((target) => observeTarget(doc, target));
  return { ...base, truncated: targets.length > 20, status: targets.length <= 20 && observations.length && observations.every((item) => item.status === "observed") ? "observed" : "target-unconfirmed", targets: observations,
    coverage: "Current page only. DOM observations do not prove all visual requirements or all course-wide uses of a field." };
}

function observeTarget(doc: Document, target: PinTarget) {
  const resolution = resolveTarget(doc, target);
  const element = resolution.element;
  if (!element) return { status: resolution.status, selector: target.selector, matches: resolution.matches, attachment: resolution.status, method: resolution.method };
  const uniqueIdentity = resolution.status === "attached";
  const current = describeElement(element);
  const peers: { selector: string; text: string }[] = [];
  for (const name of ["data-content-id"]) {
    const value = element.getAttribute(name);
    if (!value) continue;
    for (const peer of Array.from(doc.querySelectorAll(`[${name}="${CSS.escape(value)}"]`)).slice(0, 20)) {
      if (peer !== element) { const evidence = describeElement(peer); peers.push({ selector: evidence.selector, text: evidence.text }); }
    }
  }
  return { status: uniqueIdentity ? "observed" : "identity-unconfirmed", target: current,
    attachment: resolution.status, method: resolution.method,
    visible: Boolean(visibleTargetRect(doc, element, locateTarget(doc, target, element) ?? { x: 0, y: 0, width: 0, height: 0 })),
    ...(uniqueIdentity ? {} : { reason: "Only a structural or text match is available. Confirm this target visually before resolving." }),
    sameContentIdOnCurrentPage: peers,
  };
}
