import { useEffect, useRef, useState } from "react";
import { DEFAULT_SETTINGS, type LaunchSettings, type ScoRuntime } from "./scorm-api";

/**
 * How the player launches courses, as an LMS would: who the learner is, the launch mode and
 * credit, and whether spec departures fail (strict) or are only reported. Kept in this browser.
 */

const STORAGE_KEY = "scormplayer:launch";

export function loadLaunchSettings(): LaunchSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!saved || typeof saved !== "object") return DEFAULT_SETTINGS;
    return {
      learnerId: typeof saved.learnerId === "string" && saved.learnerId.trim() ? saved.learnerId : DEFAULT_SETTINGS.learnerId,
      learnerName: typeof saved.learnerName === "string" && saved.learnerName.trim() ? saved.learnerName : DEFAULT_SETTINGS.learnerName,
      mode: ["normal", "browse", "review"].includes(saved.mode) ? saved.mode : "normal",
      credit: saved.credit === "no-credit" ? "no-credit" : "credit",
      strict: saved.strict === true,
    };
  } catch { return DEFAULT_SETTINGS; }
}

export function saveLaunchSettings(settings: LaunchSettings) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* storage blocked: applies until reload */ }
}

const RUNTIME_LABELS: [keyof ScoRuntime, string][] = [
  ["masteryScore", "Mastery score"],
  ["completionThreshold", "Completion threshold"],
  ["scaledPassingScore", "Passing score (scaled)"],
  ["maxTimeAllowed", "Time allowed"],
  ["timeLimitAction", "When time runs out"],
  ["dataFromLms", "Launch data"],
];

export function LaunchSettingsDialog({ settings, runtime, onSave, onClose }: {
  settings: LaunchSettings;
  runtime: ScoRuntime;
  onSave: (settings: LaunchSettings) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(settings);
  const fieldRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { fieldRef.current?.focus(); }, []);
  const set = <K extends keyof LaunchSettings>(key: K, value: LaunchSettings[K]) => setDraft((previous) => ({ ...previous, [key]: value }));
  const fromManifest = RUNTIME_LABELS.filter(([key]) => runtime[key]);

  return (
    <div className="sp-modal" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="sp-dialog sp-launch" role="dialog" aria-modal="true" aria-labelledby="sp-launch-title"
        onSubmit={(event) => { event.preventDefault(); onSave({ ...draft, learnerId: draft.learnerId.trim() || DEFAULT_SETTINGS.learnerId, learnerName: draft.learnerName.trim() || DEFAULT_SETTINGS.learnerName }); }}
        onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
        <h2 id="sp-launch-title">Launch settings</h2>
        <p>What the course is told when it starts, as an LMS would tell it. Saving restarts the course.</p>
        <div className="sp-launch__grid">
          <div>
            <label htmlFor="sp-launch-name">Learner name</label>
            <input id="sp-launch-name" ref={fieldRef} value={draft.learnerName} onChange={(event) => set("learnerName", event.target.value)} autoComplete="off" />
          </div>
          <div>
            <label htmlFor="sp-launch-id">Learner ID</label>
            <input id="sp-launch-id" value={draft.learnerId} onChange={(event) => set("learnerId", event.target.value)} autoComplete="off" spellCheck={false} />
          </div>
          <div>
            <label htmlFor="sp-launch-mode">Mode</label>
            <select id="sp-launch-mode" value={draft.mode} onChange={(event) => set("mode", event.target.value as LaunchSettings["mode"])}>
              <option value="normal">Normal</option>
              <option value="browse">Browse</option>
              <option value="review">Review</option>
            </select>
          </div>
          <div>
            <label htmlFor="sp-launch-credit">Credit</label>
            <select id="sp-launch-credit" value={draft.credit} onChange={(event) => set("credit", event.target.value as LaunchSettings["credit"])}>
              <option value="credit">Credit</option>
              <option value="no-credit">No credit</option>
            </select>
          </div>
        </div>
        <label className="sp-launch__check">
          <input type="checkbox" checked={draft.strict} onChange={(event) => set("strict", event.target.checked)} />
          <span><strong>Strict mode</strong> Fail calls that break the SCORM spec with its error codes, and start a new attempt when a SCORM 2004 course didn't suspend. Off: the calls still work and the inspector lists each issue.</span>
        </label>
        {fromManifest.length ? (
          <dl className="sp-launch__manifest">
            <dt>From the manifest</dt>
            {fromManifest.map(([key, label]) => <dd key={key}><span>{label}</span><code>{runtime[key]}</code></dd>)}
          </dl>
        ) : null}
        <div className="sp-dialog__actions">
          <button type="button" className="sp-button" onClick={() => setDraft(DEFAULT_SETTINGS)}>Defaults</button>
          <span className="sp-launch__spacer" />
          <button type="button" className="sp-button" onClick={onClose}>Cancel</button>
          <button type="submit" className="sp-button sp-button--primary">Save and restart</button>
        </div>
      </form>
    </div>
  );
}
