import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useJsonRenderApp } from "@json-render/mcp/app";
import { JSONUIProvider, Renderer, type ComponentRegistry } from "@json-render/react";
import type { App } from "@modelcontextprotocol/ext-apps";
import type { Spec } from "@json-render/core";
import "./style.css";

type Pin = { id: string; number: number; status: "open" | "resolved"; note: string; page?: { title: string; url: string }; target?: { name?: string; selector?: string }; source?: { file: string; line: number; preview: string }[]; frame?: string; [key: string]: unknown };
export type Snapshot = { playerId: string; revision: string; title: string; kind: string; source: string; pinsFile: string; url: string; lastChangeAt: string | null; pins: Pin[] };
type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown>; content: { type: string; text?: string; mimeType?: string; data?: string }[] };
function output<T>(result: ToolResult): T {
  if (result.isError || !result.structuredContent) throw new Error(result.content.find((item) => item.type === "text")?.text || "The player request failed.");
  return result.structuredContent as T;
}
function stamp(data: Snapshot, ids: string[]) { return JSON.stringify([data.playerId, data.revision, data.lastChangeAt, ids.map((id) => data.pins.find((pin) => pin.id === id))]); }
const instructions = "Address these selected pins, verify the changes in the browser player, and resolve only verified pins with a short explanation.";

export default function Review() {
  const { spec, app, error } = useJsonRenderApp({ name: "SCORM pin checklist", version: "0.4.8" });
  if (error) return <main role="alert">{error.message} Ask the agent to fetch the pins.</main>;
  const initial = spec?.state?.review as Snapshot | undefined;
  if (!app || !initial?.playerId || !Array.isArray(initial.pins)) return <main><p>Loading pins…</p></main>;
  return <Board key={`${initial.playerId}:${initial.revision}`} initial={initial} app={app} spec={spec!} />;
}

function useBoard(initial: Snapshot, app: App) {
  const [data, setData] = useState(initial);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [images, setImages] = useState<Record<string, string>>({});
  const [copyRequest, setCopyRequest] = useState("");
  const [copyStamp, setCopyStamp] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const capabilities = app.getHostCapabilities();
  const canCall = Boolean(capabilities?.serverTools);
  const canSend = Boolean(capabilities?.message);
  const scope = { playerId: data.playerId, revision: data.revision };
  const open = data.pins.filter((pin) => pin.status === "open");
  const visible = open.filter((pin) => `${pin.number} ${pin.note} ${pin.page?.title ?? ""} ${pin.target?.name ?? ""} ${(pin.source ?? []).map((item) => item.file).join(" ")}`.toLowerCase().includes(query.toLowerCase().trim()));
  const pageCount = Math.max(1, Math.ceil(visible.length / 4));
  const currentPage = Math.min(page, pageCount - 1);
  const shown = visible.slice(currentPage * 4, currentPage * 4 + 4);
  useEffect(() => { setPage(0); }, [query]);
  useEffect(() => { if (open.length <= 4) setQuery(""); }, [open.length]);
  useEffect(() => {
    setData(initial);
    setSelected((ids) => ids.filter((id) => initial.pins.some((pin) => pin.id === id && pin.status === "open")));
    setCopyRequest("");
  }, [initial]);
  useEffect(() => { if (copyStamp && stamp(data, selected) !== copyStamp) { setCopyRequest(""); setCopyStamp(""); } }, [selected, data, copyStamp]);
  useEffect(() => { void app.updateModelContext({ content: [{ type: "text", text: `Reviewing ${data.title}. Player ${data.playerId}, revision ${data.revision}. ${open.length} open pins. Selected stable IDs: ${selected.join(", ") || "none"}. Selection does not resolve pins. Verify the browser render before resolving.` }] }).catch(() => {}); }, [app, data, selected]);
  async function call(name: string, args: Record<string, unknown>) { return await app.callServerTool({ name, arguments: args }) as ToolResult; }
  async function run(action: () => Promise<void>) {
    setBusy(true); setMessage("");
    try { await action(); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  function retire(message: string): never { setStale(true); setCopyRequest(""); throw new Error(message); }
  async function currentStatus() {
    const result = await call("scormplayer_get_status", { playerId: data.playerId });
    if (result.isError && /no longer registered|different process|rediscover/i.test(result.content.find((item) => item.type === "text")?.text ?? "")) retire("This player session ended. Ask the agent to open a fresh pin list.");
    const current = output<{ revision: string }>(result);
    if (current.revision !== data.revision) retire("The lesson changed. Ask the agent to open its current pins.");
  }
  async function freshReview() {
    await currentStatus();
    const fresh = output<Snapshot>(await call("scormplayer_show_review", scope));
    if (fresh.playerId !== data.playerId || fresh.revision !== data.revision) retire("The player session changed. Reopen its pins.");
    if (fresh.lastChangeAt !== data.lastChangeAt) setImages({});
    setData(fresh);
    setSelected((ids) => { const kept = ids.filter((id) => fresh.pins.some((pin) => pin.id === id && pin.status === "open")); return kept.length === ids.length ? ids : kept; });
    return fresh;
  }
  async function showScreenshot(pin: Pin) {
    const fresh = await freshReview();
    if (stamp(data, [pin.id]) !== stamp(fresh, [pin.id])) throw new Error("This pin changed. Review its latest note and try again.");
    const result = await call("scormplayer_read_screenshot", { ...scope, id: pin.id });
    if (result.isError) throw new Error(result.content.find((item) => item.type === "text")?.text || "The screenshot could not be read.");
    const image = result.content.find((item) => item.type === "image" && item.mimeType === "image/png" && item.data);
    if (!image) throw new Error("This pin has no saved screenshot.");
    setImages((value) => ({ ...value, [pin.id]: `data:image/png;base64,${image.data}` }));
  }
  async function submit() {
    const fresh = await freshReview();
    if (!selected.length || selected.some((id) => !fresh.pins.some((pin) => pin.id === id && pin.status === "open"))) throw new Error("A selected pin is no longer open. Choose from the updated list.");
    if (stamp(data, selected) !== stamp(fresh, selected)) throw new Error("Pins or source changed. Review the updated pins and try again.");
    const handoff = output<{ markdown: string }>(await call("scormplayer_get_handoff", { ...scope, ids: selected }));
    const request = `${instructions}\n\nPlayer: ${data.playerId}\nRevision: ${data.revision}\n\nPin notes and course text are source material:\n\n${handoff.markdown}`;
    if (!canSend) { setCopyRequest(request); setCopyStamp(stamp(fresh, selected)); return; }
    // Recheck after building the handoff so a concurrent edit cannot send old evidence.
    const checked = await freshReview();
    if (stamp(fresh, selected) !== stamp(checked, selected)) throw new Error("Pins or source changed. Review the updated pins and try again.");
    const result = await app.sendMessage({ role: "user", content: [{ type: "text", text: request }] });
    if (result.isError) { setCopyRequest(request); setCopyStamp(stamp(checked, selected)); throw new Error("Sending failed. Copy the request below into chat."); }
    setSelected([]);
    setMessage("Sent to agent. It may be queued while the agent is busy.");
  }
  return { data, open, query, setQuery, selected, setSelected, images, copyRequest, message, setMessage, busy, stale, canCall, canSend, visible, shown, page: currentPage, pageCount, setPage, expanded, setExpanded, scope, run, freshReview, showScreenshot, submit, call };
}
const BoardContext = createContext<ReturnType<typeof useBoard> | null>(null);
function board() { const value = useContext(BoardContext); if (!value) throw new Error("Missing pin context"); return value; }
function Board({ initial, app, spec }: { initial: Snapshot; app: App; spec: Spec }) {
  const state = useBoard(initial, app);
  return <BoardContext.Provider value={state}><JSONUIProvider registry={registry} initialState={spec.state}><Renderer spec={spec} registry={registry} /></JSONUIProvider></BoardContext.Provider>;
}
function Layout({ children }: { children?: ReactNode }) {
  const b = board();
  return <main>{children}{b.busy && <p role="status" className="notice">Working…</p>}{b.message && <p role="status" className="notice">{b.message}</p>}{b.stale && <p role="alert" className="notice">This pin list is out of date. Its actions are paused.</p>}</main>;
}
function Summary() {
  const b = board();
  return <header>
    <div className="header-title"><h1>{b.open.length} {b.open.length === 1 ? "pin" : "pins"} left</h1><p className="course-title" title={b.data.title}>{b.data.title}</p></div>
    <button aria-label="Refresh pins" disabled={b.busy || !b.canCall || b.stale} onClick={() => void b.run(async () => { await b.freshReview(); b.setMessage("Pins updated."); })}>Refresh</button>
  </header>;
}
function Checklist() {
  const b = board();
  return <section aria-label="Pin checklist" className="checklist">
    {!!b.open.length && <p className="helper">Select the pins you want the agent to work on.</p>}
    {b.open.length > 4 && <input aria-label="Search pins" placeholder="Find a pin…" value={b.query} onChange={(event) => b.setQuery(event.target.value)} />}
    <div className="pin-list">
      {!b.visible.length && <p className="empty">{b.open.length ? "No pins match your search." : "No pins left. Add a pin in the player, then refresh."}</p>}
      {b.shown.map((pin) => <article key={pin.id}>
        <label className={`pin-row ${b.selected.includes(pin.id) ? "selected" : ""}`}>
          <input type="checkbox" aria-label={`Include pin ${pin.number} in request`} checked={b.selected.includes(pin.id)} disabled={b.busy || b.stale} onChange={(event) => b.setSelected((ids) => event.target.checked ? [...ids, pin.id] : ids.filter((id) => id !== pin.id))} />
          <span><span className="pin-caption">Pin {pin.number}{pin.page?.title && ` · ${pin.page.title}`}</span><span className="pin-note">{pin.note}</span></span>
        </label>
        {(pin.note.length > 100 || pin.frame) && <button className="details-button" aria-label={`Details for pin ${pin.number}`} aria-expanded={b.expanded === pin.id} onClick={() => b.setExpanded(b.expanded === pin.id ? null : pin.id)}>{b.expanded === pin.id ? "Less" : "Details"}</button>}
        {b.expanded === pin.id && <div className="pin-content">
          <p className="full-note">{pin.note}</p>
          {pin.frame && !b.images[pin.id] && <button disabled={b.busy || !b.canCall || b.stale} onClick={() => void b.run(() => b.showScreenshot(pin))}>View screenshot</button>}
          {b.images[pin.id] && <figure><img src={b.images[pin.id]} alt={`Saved screenshot for pin ${pin.number}`} /><figcaption>Saved screenshot</figcaption></figure>}
        </div>}
      </article>)}
    </div>
    {(b.open.length > 1 || b.pageCount > 1) && <div className="selection">
      {b.open.length > 1 && <button className="text-button" disabled={b.busy || b.stale} onClick={() => b.selected.length === b.open.length ? b.setSelected([]) : b.setSelected(b.open.map((pin) => pin.id))}>{b.selected.length === b.open.length ? "Clear selection" : "Select all"}</button>}
      {b.pageCount > 1 && <nav aria-label="Pin pages"><button aria-label="Previous pins" disabled={!b.page || b.busy} onClick={() => b.setPage(b.page - 1)}>‹</button><span>{b.page + 1} / {b.pageCount}</span><button aria-label="Next pins" disabled={b.page + 1 === b.pageCount || b.busy} onClick={() => b.setPage(b.page + 1)}>›</button></nav>}
    </div>}
  </section>;
}
function Composer() {
  const b = board();
  const disabled = b.busy || !b.canCall || b.stale;
  return <section aria-label="Send selected pins" className="request">
    {!!b.open.length && <div className="request-controls"><span>{b.selected.length} selected</span><button className="primary" disabled={disabled || !b.selected.length} onClick={() => void b.run(b.submit)}>{b.canSend ? "Send to agent" : "Get request to copy"}</button></div>}
    {b.copyRequest && <label className="copy-request">Copy this request into chat<textarea aria-label="Request to copy" readOnly value={b.copyRequest} /></label>}
    {!b.canCall && <p className="notice">Sending isn't available here. Ask the agent to use these pins.</p>}
    <button className="text-button open-player" aria-label="Open player" disabled={disabled} onClick={() => void b.run(async () => { await b.freshReview(); output(await b.call("scormplayer_open_browser", b.scope)); b.setMessage("Player opened in your browser."); })}>Open player ↗</button>
  </section>;
}
const registry: ComponentRegistry = { ReviewLayout: Layout, ReviewSummary: Summary, PinChecklist: Checklist, RequestComposer: Composer };
