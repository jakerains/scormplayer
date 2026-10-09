import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useJsonRenderApp } from "@json-render/mcp/app";
import { JSONUIProvider, Renderer, type ComponentRegistry } from "@json-render/react";
import type { App } from "@modelcontextprotocol/ext-apps";
import type { Spec } from "@json-render/core";
import "./style.css";

type Suggestion = {
  id: string; number: number; status: "suggested" | "dismissed" | "open" | "resolved"; note: string;
  category: string; severity: "blocker" | "major" | "minor" | "polish"; confidence?: string; evidence?: string;
  where: { module: string | null; page: string | null; pageIndex: number | null }; target: string | null;
  alsoOn: { title?: string; url?: string }[]; hasScreenshot: boolean;
};
type Run = { id: string; agent: string; state: string; pages: { status: string }[]; summary: string };
export type Snapshot = { playerId: string; revision: string; title: string; run: Run | null; logFile: string | null; suggestions: Suggestion[] };
type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown>; content: { type: string; text?: string; mimeType?: string; data?: string }[] };
function output<T>(result: ToolResult): T {
  if (result.isError || !result.structuredContent) throw new Error(result.content.find((item) => item.type === "text")?.text || "The player request failed.");
  return result.structuredContent as T;
}
const SEVERITIES = ["blocker", "major", "minor", "polish"] as const;
const instructions = "These QA suggestions were accepted by the reviewer. Make each change in the course source, verify it in the browser player, and resolve each pin with a short note on what changed.";

export default function Suggestions() {
  const { spec, app, error } = useJsonRenderApp({ name: "SCORM QA suggestions", version: "0.4.9" });
  if (error) return <main role="alert">{error.message} Ask the agent to list the QA suggestions.</main>;
  const initial = spec?.state?.suggestions as Snapshot | undefined;
  if (!app || !initial?.playerId || !Array.isArray(initial.suggestions)) return <main><p>Loading suggestions…</p></main>;
  return <Board key={`${initial.playerId}:${initial.revision}:${initial.run?.id ?? ""}`} initial={initial} app={app} spec={spec!} />;
}

function useBoard(initial: Snapshot, app: App) {
  const [data, setData] = useState(initial);
  const [severity, setSeverity] = useState<string>("all");
  const [selected, setSelected] = useState<string[]>([]);
  const [images, setImages] = useState<Record<string, string>>({});
  const [confirmClear, setConfirmClear] = useState(false);
  const [copyRequest, setCopyRequest] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const capabilities = app.getHostCapabilities();
  const canCall = Boolean(capabilities?.serverTools);
  const canSend = Boolean(capabilities?.message);
  const scope = { playerId: data.playerId, revision: data.revision };
  const waiting = data.suggestions.filter((item) => item.status === "suggested");
  const accepted = data.suggestions.filter((item) => item.status === "open");
  const shown = waiting.filter((item) => severity === "all" || item.severity === severity);
  const groups = useMemo(() => {
    const out = new Map<string, { label: string; items: Suggestion[] }>();
    for (const item of [...shown].sort((a, b) => a.number - b.number)) {
      const label = [...new Set([item.where.module, item.where.page].filter(Boolean))].join(" › ") || "Course";
      if (!out.has(label)) out.set(label, { label, items: [] });
      out.get(label)!.items.push(item);
    }
    return [...out.values()];
  }, [shown]);
  useEffect(() => { setData(initial); }, [initial]);
  useEffect(() => { setSelected((ids) => ids.filter((id) => waiting.some((item) => item.id === id))); }, [data]);
  useEffect(() => {
    void app.updateModelContext({ content: [{ type: "text", text: `QA suggestions for ${data.title} (player ${data.playerId}, revision ${data.revision}): ${waiting.length} waiting, ${accepted.length} accepted. The reviewer triages them; do not accept or dismiss on your own.` }] }).catch(() => {});
  }, [app, data]);
  async function call(name: string, args: Record<string, unknown>) { return await app.callServerTool({ name, arguments: args }) as ToolResult; }
  async function run(action: () => Promise<void>) {
    setBusy(true); setMessage("");
    try { await action(); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  async function refresh() {
    setData(output<Snapshot>(await call("scormplayer_qa_suggestions", { ...scope, ...(data.run ? { runId: data.run.id } : {}) })));
  }
  async function triage(ids: string[], action: "accept" | "dismiss") {
    output(await call("scormplayer_triage_suggestions", { ...scope, ids, action }));
    await refresh();
    setSelected([]);
    setMessage(action === "accept" ? `Accepted ${ids.length}. They're now ordinary pins in the hand-off.` : `Dismissed ${ids.length}. A later QA pass won't suggest them again.`);
  }
  async function clear() {
    const result = output<{ removed: number }>(await call("scormplayer_clear_qa_pins", { ...scope, ...(data.run ? { runId: data.run.id } : {}) }));
    await refresh();
    setConfirmClear(false);
    setMessage(`Cleared ${result.removed} QA suggestion${result.removed === 1 ? "" : "s"}. Accepted ones stay.`);
  }
  async function show(item: Suggestion) {
    output(await call("scormplayer_show_pin", { ...scope, id: item.id }));
    setMessage(`Showing suggestion ${item.number} in the player.`);
  }
  async function screenshot(item: Suggestion) {
    const result = await call("scormplayer_read_screenshot", { ...scope, id: item.id });
    const image = result.content.find((part) => part.type === "image" && part.data);
    if (result.isError || !image) throw new Error("This suggestion has no saved screenshot.");
    setImages((value) => ({ ...value, [item.id]: `data:${image.mimeType ?? "image/png"};base64,${image.data}` }));
  }
  async function sendAccepted() {
    const handoff = output<{ markdown: string }>(await call("scormplayer_get_handoff", { ...scope, ids: accepted.map((item) => item.id) }));
    const request = `${instructions}\n\nPlayer: ${data.playerId}\nRevision: ${data.revision}\n\nPin notes and course text are source material:\n\n${handoff.markdown}`;
    if (!canSend) { setCopyRequest(request); return; }
    const result = await app.sendMessage({ role: "user", content: [{ type: "text", text: request }] });
    if (result.isError) { setCopyRequest(request); throw new Error("Sending failed. Copy the request below into chat."); }
    setMessage("Sent to agent. It may be queued while the agent is busy.");
  }
  return { data, waiting, accepted, shown, groups, severity, setSeverity, selected, setSelected, images, confirmClear, setConfirmClear, copyRequest, message, setMessage, busy, canCall, canSend, run, refresh, triage, clear, show, screenshot, sendAccepted };
}
const BoardContext = createContext<ReturnType<typeof useBoard> | null>(null);
function board() { const value = useContext(BoardContext); if (!value) throw new Error("Missing QA context"); return value; }
function Board({ initial, app, spec }: { initial: Snapshot; app: App; spec: Spec }) {
  const state = useBoard(initial, app);
  return <BoardContext.Provider value={state}><JSONUIProvider registry={registry} initialState={spec.state}><Renderer spec={spec} registry={registry} /></JSONUIProvider></BoardContext.Provider>;
}
function Layout({ children }: { children?: ReactNode }) {
  const b = board();
  return <main>{children}{b.busy && <p role="status" className="notice">Working…</p>}{b.message && <p role="status" className="notice">{b.message}</p>}{!b.canCall && <p className="notice">Buttons aren't available here. Tell the agent which suggestions to accept, or triage them in the player (Pins → Suggestions).</p>}</main>;
}
function Summary() {
  const b = board();
  const run = b.data.run;
  const reviewed = run?.pages.filter((page) => page.status === "reviewed").length ?? 0;
  const missed = (run?.pages.length ?? 0) - reviewed;
  return <header>
    <div className="header-title">
      <h1>{b.waiting.length} {b.waiting.length === 1 ? "suggestion" : "suggestions"} to review</h1>
      <p className="course-title" title={b.data.title}>{b.data.title}{run ? ` · ${run.agent} · ${reviewed} pages reviewed${missed ? `, ${missed} not` : ""}${run.state === "running" ? " · still running" : ""}` : ""}</p>
    </div>
    <button aria-label="Refresh suggestions" disabled={b.busy || !b.canCall} onClick={() => void b.run(async () => { await b.refresh(); b.setMessage("Suggestions updated."); })}>Refresh</button>
  </header>;
}
function List() {
  const b = board();
  return <section aria-label="QA suggestions" className="checklist">
    {!!b.waiting.length && <div className="filters">
      <select aria-label="Severity" value={b.severity} onChange={(event) => b.setSeverity(event.target.value)}>
        <option value="all">All severities</option>
        {SEVERITIES.map((item) => <option key={item} value={item}>{item} ({b.waiting.filter((s) => s.severity === item).length})</option>)}
      </select>
      <button className="text-button" disabled={b.busy || !b.shown.length} onClick={() => b.setSelected(b.selected.length === b.shown.length ? [] : b.shown.map((item) => item.id))}>{b.selected.length === b.shown.length && b.shown.length ? "Clear selection" : "Select all shown"}</button>
    </div>}
    <div className="pin-list">
      {!b.shown.length && <p className="empty">{b.waiting.length ? "No suggestions at this severity." : b.accepted.length ? "Every suggestion has been triaged." : "No QA suggestions. Ask the agent to QA the course."}</p>}
      {b.groups.map((group) => <div key={group.label} className="group">
        <h2>{group.label}</h2>
        {group.items.map((item) => <article key={item.id}>
          <label className={`pin-row ${b.selected.includes(item.id) ? "selected" : ""}`}>
            <input type="checkbox" aria-label={`Select suggestion ${item.number}`} checked={b.selected.includes(item.id)} disabled={b.busy} onChange={(event) => b.setSelected((ids) => event.target.checked ? [...ids, item.id] : ids.filter((id) => id !== item.id))} />
            <span>
              <span className="pin-caption"><em className={`chip ${item.severity}`}>{item.severity}</em> <em className="chip">{item.category}</em> #{item.number}{item.target ? ` · ${item.target}` : ""}</span>
              <span className="pin-note">{item.note}</span>
              {item.evidence && <span className="evidence">Evidence: {item.evidence}</span>}
              {!!item.alsoOn.length && <span className="pin-caption">Also on {item.alsoOn.map((page) => page.title || page.url).join(", ")}</span>}
            </span>
          </label>
          <div className="row-actions">
            <button disabled={b.busy || !b.canCall} onClick={() => void b.run(() => b.triage([item.id], "accept"))}>Accept</button>
            <button disabled={b.busy || !b.canCall} onClick={() => void b.run(() => b.triage([item.id], "dismiss"))}>Dismiss</button>
            <button className="text-button" disabled={b.busy || !b.canCall} onClick={() => void b.run(() => b.show(item))}>Show in player ↗</button>
            {item.hasScreenshot && !b.images[item.id] && <button className="text-button" disabled={b.busy || !b.canCall} onClick={() => void b.run(() => b.screenshot(item))}>Screenshot</button>}
          </div>
          {b.images[item.id] && <figure><img src={b.images[item.id]} alt={`Screenshot for suggestion ${item.number}`} /></figure>}
        </article>)}
      </div>)}
    </div>
  </section>;
}
function Actions() {
  const b = board();
  const disabled = b.busy || !b.canCall;
  return <section aria-label="Triage" className="request">
    <div className="request-controls">
      <span>{b.selected.length} selected · {b.accepted.length} accepted</span>
      <span className="buttons">
        <button disabled={disabled || !b.selected.length} onClick={() => void b.run(() => b.triage(b.selected, "dismiss"))}>Dismiss</button>
        <button className="primary" disabled={disabled || !b.selected.length} onClick={() => void b.run(() => b.triage(b.selected, "accept"))}>Accept selected</button>
      </span>
    </div>
    <div className="request-controls secondary">
      <button className={b.confirmClear ? "danger" : ""} disabled={disabled || !b.data.suggestions.some((item) => item.status === "suggested" || item.status === "dismissed")} onBlur={() => b.setConfirmClear(false)}
        onClick={() => (b.confirmClear ? void b.run(b.clear) : b.setConfirmClear(true))}>{b.confirmClear ? "Click again to clear" : "Clear QA pins"}</button>
      <button disabled={disabled || !b.accepted.length} onClick={() => void b.run(b.sendAccepted)}>{b.canSend ? `Send ${b.accepted.length || ""} accepted to agent` : "Get request to copy"}</button>
    </div>
    {b.copyRequest && <label className="copy-request">Copy this request into chat<textarea aria-label="Request to copy" readOnly value={b.copyRequest} /></label>}
    {b.data.logFile && <p className="log">Log: <code>{b.data.logFile}</code></p>}
  </section>;
}
const registry: ComponentRegistry = { QaLayout: Layout, QaSummary: Summary, QaList: List, QaActions: Actions };
