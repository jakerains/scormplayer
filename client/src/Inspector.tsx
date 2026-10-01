import { useMemo, useState } from "react";
import { Icon } from "./icons";
import { progressOf, type ScormCall, type ScormData } from "./scorm-api";

/**
 * What the course has told the LMS: its current SCORM data and every API call, newest first.
 * The quickest way to see why a course doesn't complete, score or resume.
 */
export function Inspector({ data, calls, onClear, onCopy, onClose }: {
  data: ScormData;
  calls: ScormCall[];
  onClear: () => void;
  onCopy: (text: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"data" | "calls">("data");
  const [filter, setFilter] = useState("");
  const [writesOnly, setWritesOnly] = useState(false);
  const progress = progressOf(data);
  const needle = filter.trim().toLowerCase();

  const rows = useMemo(() => Object.entries(data)
    .filter(([key, value]) => !needle || key.toLowerCase().includes(needle) || value.toLowerCase().includes(needle))
    .sort(([a], [b]) => a.localeCompare(b)), [data, needle]);

  const callRows = useMemo(() => [...calls].reverse().filter((call) => {
    if (writesOnly && !/SetValue|Commit|Initialize|Finish|Terminate/.test(call.method)) return false;
    if (!needle) return true;
    return `${call.method} ${call.args.join(" ")} ${call.result}`.toLowerCase().includes(needle);
  }), [calls, needle, writesOnly]);

  const errors = calls.filter((call) => call.error && call.error !== "0").length;

  const copy = () => onCopy(JSON.stringify({ data, calls }, null, 2));

  return (
    <aside className="sp-panel sp-inspector" aria-label="SCORM inspector">
      <header>
        <div><strong>SCORM</strong><span>{calls.length} calls{errors ? ` · ${errors} with errors` : ""}</span></div>
        <button type="button" className="sp-icon-button" onClick={onClose} aria-label="Close inspector"><Icon name="close" /></button>
      </header>
      <dl className="sp-inspector__summary">
        <div><dt>Completion</dt><dd>{progress.completion || "—"}</dd></div>
        <div><dt>Success</dt><dd>{progress.success || "—"}</dd></div>
        <div><dt>Score</dt><dd>{progress.score || "—"}</dd></div>
        <div><dt>Location</dt><dd title={progress.location}>{progress.location || "—"}</dd></div>
      </dl>
      <div className="sp-inspector__tools">
        <div className="sp-segmented" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "data"} onClick={() => setTab("data")}>Data <em>{Object.keys(data).length}</em></button>
          <button type="button" role="tab" aria-selected={tab === "calls"} onClick={() => setTab("calls")}>Calls <em>{calls.length}</em></button>
        </div>
        <input type="search" placeholder="Filter" value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Filter" />
      </div>
      {tab === "calls" ? (
        <div className="sp-inspector__subtools">
          <label><input type="checkbox" checked={writesOnly} onChange={(event) => setWritesOnly(event.target.checked)} /> Writes only</label>
          <span>
            <button type="button" onClick={copy}><Icon name="copy" size={13} /> Copy JSON</button>
            <button type="button" onClick={onClear}><Icon name="trash" size={13} /> Clear</button>
          </span>
        </div>
      ) : (
        <div className="sp-inspector__subtools"><span />
          <span><button type="button" onClick={copy}><Icon name="copy" size={13} /> Copy JSON</button></span>
        </div>
      )}
      <div className="sp-inspector__body">
        {tab === "data" ? (
          rows.length ? (
            <table>
              <tbody>
                {rows.map(([key, value]) => (
                  <tr key={key}><th>{key}</th><td title={value}>{value === "" ? <span className="is-empty">empty</span> : value}</td></tr>
                ))}
              </tbody>
            </table>
          ) : <p className="sp-empty">{Object.keys(data).length ? "Nothing matches the filter." : "The course hasn't talked to the LMS yet."}</p>
        ) : callRows.length ? (
          <ol className="sp-calls">
            {callRows.map((call, index) => (
              <li key={`${call.at}-${index}`} className={call.error && call.error !== "0" ? "has-error" : ""}>
                <time>{new Date(call.at).toLocaleTimeString([], { hour12: false })}</time>
                <code className={`sp-calls__method ${/Set|Commit|Initialize|Finish|Terminate/.test(call.method) ? "is-write" : ""}`}>{call.method}</code>
                <code className="sp-calls__args">{call.args.filter(Boolean).join(", ")}</code>
                <code className="sp-calls__result">→ {call.result === "" ? "\"\"" : call.result}{call.error && call.error !== "0" ? ` · error ${call.error}` : ""}</code>
              </li>
            ))}
          </ol>
        ) : <p className="sp-empty">{calls.length ? "Nothing matches the filter." : "No calls yet."}</p>}
      </div>
    </aside>
  );
}
