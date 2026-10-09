import { useEffect, useMemo, useState } from "react";
import { Icon } from "./icons";
import { progressOf, type ScormCall, type ScormData, type ScormIssue, type ScormProgress } from "./scorm-api";
import type { XapiStatement, XapiSummary } from "./api";

/**
 * What the course has told the LMS: its current SCORM data and every API call, newest first.
 * The quickest way to see why a course doesn't complete, score or resume.
 */
export function Inspector({ data, calls, issues, strict, xapi, progress: shown, onSettings, onClear, onCopy, onClose }: {
  data: ScormData;
  /** For xAPI and cmi5 courses: what the local LRS has recorded. */
  xapi?: XapiSummary | null;
  progress?: ScormProgress;
  calls: ScormCall[];
  /** Departures from the SCORM spec, newest last. */
  issues: ScormIssue[];
  strict: boolean;
  onSettings: () => void;
  onClear: () => void;
  onCopy: (text: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"data" | "calls" | "issues" | "statements">(xapi ? "statements" : "data");
  const [filter, setFilter] = useState("");
  const [writesOnly, setWritesOnly] = useState(false);
  const progress = shown ?? progressOf(data);
  // The LRS summary arrives after the panel opens; show statements once it does.
  useEffect(() => { if (xapi && !calls.length) setTab((current) => current === "data" || current === "calls" ? "statements" : current); }, [Boolean(xapi), calls.length]);
  const needle = filter.trim().toLowerCase();

  const rows = useMemo(() => Object.entries(data)
    .filter(([key, value]) => !needle || key.toLowerCase().includes(needle) || value.toLowerCase().includes(needle))
    .sort(([a], [b]) => a.localeCompare(b)), [data, needle]);

  const callRows = useMemo(() => [...calls].reverse().filter((call) => {
    if (writesOnly && !/SetValue|Commit|Initialize|Finish|Terminate|LMS/.test(call.method)) return false;
    if (!needle) return true;
    return `${call.method} ${call.args.join(" ")} ${call.result}`.toLowerCase().includes(needle);
  }), [calls, needle, writesOnly]);

  // xAPI and cmi5 issues come from the LRS; SCORM ones from the API.
  const allIssues = useMemo(() => [
    ...issues,
    ...(xapi?.issues ?? []).map((issue) => ({ ...issue, api: xapi!.standard, method: "LRS", element: "", code: "", rejected: false })),
  ].sort((a, b) => a.at - b.at), [issues, xapi]);
  const issueRows = useMemo(() => [...allIssues].reverse().filter((issue) =>
    !needle || `${issue.method} ${issue.element} ${issue.message}`.toLowerCase().includes(needle)), [allIssues, needle]);
  const statementRows = useMemo(() => (xapi?.statements ?? []).filter((statement) =>
    !needle || JSON.stringify(statement).toLowerCase().includes(needle)), [xapi, needle]);

  const errors = calls.filter((call) => call.error && call.error !== "0").length;
  const issueErrors = allIssues.filter((issue) => issue.severity === "error").length;

  const copy = () => onCopy(JSON.stringify(xapi ? { registration: xapi.registration, modules: xapi.modules, statements: xapi.statements, issues: allIssues } : { data, calls, issues }, null, 2));

  return (
    <aside className="sp-panel sp-inspector" aria-label="SCORM inspector">
      <header>
        <div>
          <strong>{xapi ? (xapi.standard === "cmi5" ? "cmi5" : "xAPI") : "SCORM"}</strong>
          <span>{xapi ? `${xapi.count} statement${xapi.count === 1 ? "" : "s"}` : `${calls.length} calls${errors ? ` · ${errors} with errors` : ""}`}{allIssues.length ? ` · ${allIssues.length} spec issue${allIssues.length === 1 ? "" : "s"}` : ""}</span>
        </div>
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
          {xapi ? <button type="button" role="tab" aria-selected={tab === "statements"} onClick={() => setTab("statements")}>Statements <em>{xapi.count}</em></button> : null}
          {!xapi || calls.length ? <>
            <button type="button" role="tab" aria-selected={tab === "data"} onClick={() => setTab("data")}>Data <em>{Object.keys(data).length}</em></button>
            <button type="button" role="tab" aria-selected={tab === "calls"} onClick={() => setTab("calls")}>Calls <em>{calls.length}</em></button>
          </> : null}
          <button type="button" role="tab" aria-selected={tab === "issues"} onClick={() => setTab("issues")}>Issues <em className={issueErrors ? "is-bad" : ""}>{allIssues.length}</em></button>
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
      {tab === "issues" && !xapi ? (
        <p className="sp-inspector__mode">
          {strict ? "Strict mode: calls that break the spec fail, as in a conformant LMS." : "Forgiving mode: calls that break the spec still work here; an LMS may reject them."}
          <button type="button" onClick={onSettings}>Launch settings…</button>
        </p>
      ) : null}
      <div className="sp-inspector__body">
        {tab === "issues" ? (
          issueRows.length ? (
            <ol className="sp-issues">
              {issueRows.map((issue) => (
                <li key={`${issue.api}-${issue.method}-${issue.element}-${issue.message}`} className={issue.severity === "warning" ? "is-warning" : ""}>
                  <span className="sp-issues__badge">{issue.severity === "warning" ? "warn" : issue.code}</span>
                  <span>{issue.message}</span>
                  <span className="sp-issues__meta">
                    {issue.method}{issue.element ? ` ${issue.element}` : ""} · {issue.api === "1.2" || issue.api === "2004" ? `SCORM ${issue.api}` : issue.api === "cmi5" ? "cmi5" : "xAPI"}{issue.count > 1 ? ` · ${issue.count}×` : ""}{issue.rejected ? " · rejected" : ""}
                  </span>
                </li>
              ))}
            </ol>
          ) : <p className="sp-empty">{allIssues.length ? "Nothing matches the filter." : "No spec issues so far."}</p>
        ) : tab === "statements" ? (
          statementRows.length ? (
            <ol className="sp-calls sp-statements">
              {statementRows.map((statement) => (
                <li key={statement.id} title={JSON.stringify(statement, null, 2)}>
                  <time>{statement.timestamp ? new Date(statement.timestamp).toLocaleTimeString([], { hour12: false }) : ""}</time>
                  <code className="sp-calls__method is-write">{verbOf(statement)}</code>
                  <code className="sp-calls__args">{objectOf(statement)}</code>
                  {resultOf(statement) ? <code className="sp-calls__result">{resultOf(statement)}</code> : null}
                </li>
              ))}
            </ol>
          ) : <p className="sp-empty">{xapi?.count ? "Nothing matches the filter." : "The course hasn't sent any statements yet."}</p>
        ) : tab === "data" ? (
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

function verbOf(statement: XapiStatement) {
  const display = statement.verb.display ? Object.values(statement.verb.display)[0] : "";
  return display || statement.verb.id.split("/").pop() || statement.verb.id;
}

function objectOf(statement: XapiStatement) {
  const name = statement.object?.definition?.name ? Object.values(statement.object.definition.name)[0] : "";
  return name || statement.object?.id || "";
}

function resultOf(statement: XapiStatement) {
  const result = statement.result;
  if (!result) return "";
  const score = result.score?.scaled !== undefined ? `score ${Math.round(result.score.scaled * 100)}%` : result.score?.raw !== undefined ? `score ${result.score.raw}` : "";
  return [score, result.success === true ? "success" : result.success === false ? "failure" : "", result.completion ? "complete" : "",
    result.response ? `response ${result.response}` : "", result.duration ?? ""].filter(Boolean).join(" · ");
}
