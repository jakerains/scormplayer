import { useEffect, useRef, useState } from "react";
import { api, type Course } from "./api";
import { Icon } from "./icons";

/**
 * A zip plays from a copy in scormplayer's cache, so neither the reviewer nor an agent acting on
 * pins can edit it. These offer to unzip it to a real folder (beside the zip by default) and
 * reopen the player there, with the pins carried over.
 */

const dismissedKey = (course: Course) => `scormplayer:unzip-dismissed:${course.courseKey}`;

export function useUnzipNotice(course: Course | null) {
  const [dismissed, setDismissed] = useState(true);
  useEffect(() => {
    if (course?.kind !== "package") return;
    try { setDismissed(localStorage.getItem(dismissedKey(course)) === "1"); } catch { setDismissed(false); }
  }, [course]);
  const dismiss = () => {
    setDismissed(true);
    try { if (course) localStorage.setItem(dismissedKey(course), "1"); } catch { /* storage blocked */ }
  };
  return { show: course?.kind === "package" && !dismissed, dismiss };
}

export function UnzipNotice({ course, onUnzip, onDismiss }: { course: Course; onUnzip: () => void; onDismiss: () => void }) {
  const existing = course.unzip?.existing;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function openExisting() {
    setBusy(true);
    try { await api.unzip(existing!); window.location.reload(); }
    catch (failure) { setBusy(false); setError(failure instanceof Error ? failure.message : String(failure)); }
  }
  return (
    <div className="sp-notice" role="status">
      <Icon name="lock" size={18} />
      <div className="sp-notice__text">
        <strong>This zip is read-only</strong>
        <span>
          {error || (existing
            ? <>You unzipped it before. Open that folder so you and agents can edit the course.<code title={existing}>{`\u200E${existing}`}</code></>
            : <>Pins work, but nobody can edit a zip, not even an agent. Unzip it to a folder to make the course editable.</>)}
        </span>
      </div>
      <div className="sp-notice__actions">
        {existing ? (
          <>
            <button type="button" className="sp-button sp-button--primary" disabled={busy} onClick={() => void openExisting()}><Icon name="folder" size={15} /> Open folder</button>
            <button type="button" className="sp-button" disabled={busy} onClick={onUnzip}>Unzip again…</button>
          </>
        ) : (
          <button type="button" className="sp-button sp-button--primary" onClick={onUnzip}><Icon name="folder" size={15} /> Unzip to edit…</button>
        )}
        <button type="button" className="sp-icon-button" onClick={onDismiss} aria-label="Not now" title="Not now"><Icon name="close" size={16} /></button>
      </div>
    </div>
  );
}

export function UnzipDialog({ course, onClose }: { course: Course; onClose: () => void }) {
  const suggested = course.unzip?.existing ? `${course.unzip.folder}-2` : course.unzip?.folder ?? "";
  const [folder, setFolder] = useState(suggested);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fieldRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { fieldRef.current?.focus(); fieldRef.current?.select(); }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.unzip(folder);
      window.location.reload();
    } catch (failure) {
      setBusy(false);
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }

  return (
    <div className="sp-modal" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <form className="sp-dialog" role="dialog" aria-modal="true" aria-labelledby="sp-unzip-title" onSubmit={(event) => void submit(event)}
        onKeyDown={(event) => { if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose(); } }}>
        <h2 id="sp-unzip-title">Unzip to a folder you can edit</h2>
        <p>The course is copied out of the zip into this folder, and the player reopens it from there. Your pins move with it, so an agent can edit the files they point to. The zip itself isn't changed.</p>
        <label htmlFor="sp-unzip-folder">Folder</label>
        <input id="sp-unzip-folder" ref={fieldRef} value={folder} onChange={(event) => setFolder(event.target.value)} spellCheck={false} autoComplete="off" disabled={busy} />
        <small>Beside the zip by default. Use a new or empty folder.</small>
        {error ? <p className="sp-dialog__error" role="alert">{error}</p> : null}
        <div className="sp-dialog__actions">
          <button type="button" className="sp-button" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="sp-button sp-button--primary" disabled={busy || !folder.trim()}>{busy ? "Unzipping…" : "Unzip and open"}</button>
        </div>
      </form>
    </div>
  );
}
