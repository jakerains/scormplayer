/**
 * An accessibility scan of the page the course shows, with axe-core. axe runs inside the
 * course frame (it measures colours, focus and names in that document), so it is loaded into
 * the frame's window on the first scan. Nothing is written to the course's files.
 */

export type A11yNode = { selector: string; html: string; summary: string };
export type A11yViolation = { id: string; impact: "minor" | "moderate" | "serious" | "critical" | null; help: string; helpUrl: string; description: string; nodes: A11yNode[] };
export type A11yReport = { at: number; url: string; title: string; violations: A11yViolation[]; passes: number; incomplete: number };

type AxeResult = {
  violations: { id: string; impact: A11yViolation["impact"]; help: string; helpUrl: string; description: string; nodes: { target: unknown[]; html: string; failureSummary?: string }[] }[];
  passes: unknown[];
  incomplete: unknown[];
};
type AxeWindow = Window & { axe?: { run: (context: Document, options: object) => Promise<AxeResult> } };

const IMPACT_ORDER = { critical: 0, serious: 1, moderate: 2, minor: 3 } as const;

export async function scanAccessibility(frame: HTMLIFrameElement | null): Promise<A11yReport> {
  let win: AxeWindow | null = null;
  let doc: Document | null = null;
  try { win = frame?.contentWindow as AxeWindow | null; doc = frame?.contentDocument ?? null; } catch { /* another origin */ }
  if (!win || !doc) throw new Error("The course page isn't available to scan. Wait for it to load and try again.");
  if (!win.axe) {
    // A file of its own (not inlined), fetched only when someone scans.
    const { default: url } = await import("axe-core/axe.min.js?url");
    const script = doc.createElement("script");
    script.src = url;
    await new Promise((resolve, reject) => {
      script.onload = resolve;
      script.onerror = () => reject(new Error("The accessibility checker couldn't load into the course page."));
      (doc.head ?? doc.documentElement).append(script);
    });
    script.remove();
  }
  if (!win.axe) throw new Error("The course page blocked the accessibility checker (its Content Security Policy refuses scripts).");
  const result = await win.axe.run(doc, { resultTypes: ["violations"] });
  const violations = result.violations
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      helpUrl: violation.helpUrl,
      description: violation.description,
      nodes: violation.nodes.map((node) => ({
        selector: node.target.map((part) => Array.isArray(part) ? part.join(" ") : String(part)).join(" "),
        html: node.html.slice(0, 300),
        summary: (node.failureSummary ?? "").replace(/^Fix (any|all) of the following:\s*/i, "").trim(),
      })),
    }))
    .sort((a, b) => (IMPACT_ORDER[a.impact ?? "minor"] ?? 4) - (IMPACT_ORDER[b.impact ?? "minor"] ?? 4));
  return { at: Date.now(), url: doc.location.pathname.replace(/^\/course\//, ""), title: doc.title, violations, passes: result.passes.length, incomplete: result.incomplete.length };
}

/** The element a finding is about, when it is still on the page (the first match of its selector). */
export function findingElement(frame: HTMLIFrameElement | null, selector: string): Element | null {
  try { return frame?.contentDocument?.querySelector(selector) ?? null; } catch { return null; }
}
