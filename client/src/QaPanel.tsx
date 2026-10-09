import { useMemo, useState } from "react";
import type { Pin, QaCategory, QaSeverity, QaStatus } from "./api";
import { Icon } from "./icons";

/**
 * An agent's QA suggestions, waiting for the reviewer: grouped by module and page, filtered by
 * severity and category. Accepting turns a suggestion into an ordinary open pin (it joins the
 * hand-off); dismissing keeps it from being suggested again; Clear removes what wasn't accepted.
 */

const SEVERITIES: QaSeverity[] = ["blocker", "major", "minor", "polish"];
const CATEGORIES: QaCategory[] = ["copy", "content", "accessibility", "scorm", "layout", "interaction", "media"];

export function QaSuggestions({ pins, qa, activePin, onOpen, onTriage, onClear, onCopyLog }: {
  pins: Pin[];
  qa: QaStatus | null;
  activePin: string | null;
  onOpen: (pin: Pin) => void;
  onTriage: (pins: Pin[], action: "accept" | "dismiss" | "restore") => Promise<void>;
  onClear: () => Promise<void>;
  onCopyLog: () => void;
}) {
  const [severity, setSeverity] = useState<QaSeverity | "all">("all");
  const [category, setCategory] = useState<QaCategory | "all">("all");
  const [showDismissed, setShowDismissed] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const all = pins.filter((pin) => pin.origin?.kind === "agent" && (pin.status === "suggested" || pin.status === "dismissed"));
  const waiting = all.filter((pin) => pin.status === "suggested");
  const shown = all.filter((pin) => (showDismissed || pin.status === "suggested")
    && (severity === "all" || pin.severity === severity) && (category === "all" || pin.category === category));

  // Module → page, in the order the agent went through them.
  const groups = useMemo(() => {
    const out = new Map<string, { module: string; page: string; pins: Pin[] }>();
    for (const pin of [...shown].sort((a, b) => a.number - b.number)) {
      const module = pin.page?.scoTitle ?? "";
      const page = pin.page?.title || pin.page?.url || "Page";
      const key = `${module}|${pin.page?.navIndex ?? ""}|${page}`;
      if (!out.has(key)) out.set(key, { module, page, pins: [] });
      out.get(key)!.pins.push(pin);
    }
    return [...out.values()];
  }, [shown]);

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError("");
    try { await action(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };

  const active = qa?.active;
  const last = qa?.last;

  return (
    <div className="sp-qa">
      <div className="sp-qa__summary">
        {active
          ? <span>{active.agent} is reviewing: {active.pages.length} page{active.pages.length === 1 ? "" : "s"} logged, {active.suggestions.length} suggestion{active.suggestions.length === 1 ? "" : "s"} so far.</span>
          : last
            ? <span>Last QA pass by {last.agent}: {last.pages.filter((page) => page.status === "reviewed").length} pages reviewed{last.pages.some((page) => page.status !== "reviewed") ? `, ${last.pages.filter((page) => page.status !== "reviewed").length} not` : ""}. Accepted suggestions move to Pins and join Copy.</span>
            : <span>Ask your AI app to "QA this course" while this player is open. Its suggestions appear here for you to accept or dismiss.</span>}
        {qa?.logFile ? <button type="button" onClick={onCopyLog}><Icon name="file" size={13} /> Copy log path</button> : null}
      </div>
      <div className="sp-qa__filters">
        <select aria-label="Severity" value={severity} onChange={(event) => setSeverity(event.target.value as QaSeverity | "all")}>
          <option value="all">All severities</option>
          {SEVERITIES.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
        <select aria-label="Category" value={category} onChange={(event) => setCategory(event.target.value as QaCategory | "all")}>
          <option value="all">All categories</option>
          {CATEGORIES.map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
        <label><input type="checkbox" checked={showDismissed} onChange={(event) => setShowDismissed(event.target.checked)} /> Dismissed</label>
      </div>
      <div className="sp-panel__tools">
        <button type="button" className="sp-button sp-button--primary" disabled={busy || !shown.some((pin) => pin.status === "suggested")}
          onClick={() => void run(() => onTriage(shown.filter((pin) => pin.status === "suggested"), "accept"))}>
          <Icon name="check" size={15} /> Accept {shown.filter((pin) => pin.status === "suggested").length || ""} shown
        </button>
        <button type="button" className={`sp-button ${confirmClear ? "is-danger" : ""}`} disabled={busy || !all.length}
          onClick={() => (confirmClear ? void run(async () => { await onClear(); setConfirmClear(false); }) : setConfirmClear(true))} onBlur={() => setConfirmClear(false)}>
          <Icon name="trash" size={15} /> {confirmClear ? `Clear ${all.length}? Click again` : "Clear QA pins"}
        </button>
      </div>
      {error ? <p className="sp-pin__error" role="alert">{error}</p> : null}
      {groups.length ? (
        <div className="sp-qa__list">
          {groups.map((group) => (
            <section key={`${group.module}|${group.page}`}>
              <h3>{group.module ? <span>{group.module} ›</span> : null} {group.page}</h3>
              <ol className="sp-pin-list">
                {group.pins.map((pin) => (
                  <li key={pin.id} className={`sp-pin sp-suggestion ${activePin === pin.id ? "is-active" : ""} ${pin.status === "dismissed" ? "is-resolved" : ""}`}>
                    <button type="button" className="sp-pin__main" onClick={() => onOpen(pin)} title="Show it in the course">
                      <span className="sp-pin__number">{pin.number}</span>
                      <span className="sp-pin__body">
                        <span className="sp-suggestion__tags">
                          <em className={`sp-severity sp-severity--${pin.severity}`}>{pin.severity}</em>
                          <em>{pin.category}</em>
                          {pin.confidence === "low" ? <em>low confidence</em> : null}
                        </span>
                        <span className="sp-pin__note">{pin.note}</span>
                        {pin.evidence ? <q className="sp-suggestion__evidence">{pin.evidence}</q> : null}
                        <small>{[pin.target?.name, pin.alsoOn?.length ? `also on ${pin.alsoOn.map((page) => page.title || page.url).join(", ")}` : null].filter(Boolean).join(" · ")}</small>
                      </span>
                      {pin.frame ? <img src={`/api/pins/${pin.id}/frame?v=${encodeURIComponent(pin.updatedAt)}`} alt="" /> : null}
                    </button>
                    <div className="sp-pin__actions">
                      {pin.status === "suggested" ? <>
                        <button type="button" disabled={busy} onClick={() => void run(() => onTriage([pin], "accept"))}><Icon name="check" size={14} /> Accept</button>
                        <button type="button" disabled={busy} onClick={() => void run(() => onTriage([pin], "dismiss"))}><Icon name="close" size={14} /> Dismiss</button>
                      </> : <button type="button" disabled={busy} onClick={() => void run(() => onTriage([pin], "restore"))}><Icon name="undo" size={14} /> Restore</button>}
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      ) : (
        <p className="sp-empty">{all.length ? "Nothing matches the filters." : waiting.length ? "" : "No suggestions waiting."}</p>
      )}
    </div>
  );
}

/** While an agent QA pass runs: where it is and how many suggestions so far, with Stop. */
export function QaBanner({ qa, where, onStop, onEnd, onReview }: {
  qa: QaStatus;
  where: string;
  onStop: () => void;
  onEnd: () => void;
  onReview: () => void;
}) {
  const run = qa.active!;
  const stopping = run.state === "stopping";
  return (
    <div className="sp-qa-banner" role="status">
      <span className="sp-qa-banner__pulse" aria-hidden="true" />
      <span><strong>{run.agent} is reviewing</strong>{where ? ` · ${where}` : ""} · {run.suggestions.length} suggestion{run.suggestions.length === 1 ? "" : "s"}</span>
      <button type="button" onClick={onReview}>Review</button>
      {stopping
        ? <button type="button" onClick={onEnd} title="End the pass now and write its log">Stopping… End now</button>
        : <button type="button" onClick={onStop} title="Ask the agent to stop after its current step">Stop</button>}
    </div>
  );
}
