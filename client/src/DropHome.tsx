import { useEffect, useRef, useState } from "react";
import { openZip } from "./api";
import { Icon } from "./icons";

/** Opening a course from the browser: drop a SCORM zip, or choose one. */
export function useZipOpener() {
  const [upload, setUpload] = useState<{ name: string; progress: number } | null>(null);
  const [error, setError] = useState("");
  const open = async (file: File | undefined) => {
    if (!file) return;
    setError("");
    if (!/\.zip$/i.test(file.name)) {
      setError(`${file.name} isn't a .zip. Choose a SCORM package zip.`);
      return;
    }
    setUpload({ name: file.name, progress: 0 });
    try {
      await openZip(file, (progress) => setUpload({ name: file.name, progress }));
      window.location.reload();
    } catch (failure) {
      setUpload(null);
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };
  return { upload, error, open, clearError: () => setError("") };
}

export function ZipInput({ inputRef, onFile }: { inputRef: React.RefObject<HTMLInputElement | null>; onFile: (file: File | undefined) => void }) {
  return (
    <input
      ref={inputRef}
      type="file"
      accept=".zip,application/zip"
      hidden
      onChange={(event) => { onFile(event.target.files?.[0]); event.target.value = ""; }}
    />
  );
}

export function UploadStatus({ upload }: { upload: { name: string; progress: number } }) {
  return (
    <div className="sp-upload" role="status">
      <strong>{upload.progress < 1 ? "Opening" : "Unpacking"} {upload.name}…</strong>
      <div className="sp-upload__bar"><span style={{ width: `${Math.round(upload.progress * 100)}%` }} /></div>
    </div>
  );
}

export function DropHome() {
  const { upload, error, open } = useZipOpener();
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => { document.title = "scormplayer"; }, []);
  return (
    <div
      className={`sp-home ${over ? "is-over" : ""}`}
      onDragOver={(event) => { event.preventDefault(); setOver(true); }}
      onDragLeave={(event) => { if (event.currentTarget === event.target) setOver(false); }}
      onDrop={(event) => { event.preventDefault(); setOver(false); void open(event.dataTransfer.files?.[0]); }}
    >
      <div className="sp-home__card">
        <svg className="sp-home__logo" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 22s-7-6.3-7-12a7 7 0 0 1 14 0c0 5.7-7 12-7 12Z" fill="currentColor" />
          <circle cx="12" cy="10" r="2.6" fill="#fff" />
        </svg>
        <h1>Drop a SCORM zip here</h1>
        <p>It plays right here, the way an LMS would. Pin notes on anything you want changed.</p>
        {upload ? <UploadStatus upload={upload} /> : (
          <button type="button" className="sp-button sp-button--primary sp-home__choose" onClick={() => inputRef.current?.click()}>
            <Icon name="file" size={16} /> Choose a SCORM zip
          </button>
        )}
        {error ? <p className="sp-home__error" role="alert">{error}</p> : null}
        <small>SCORM 1.2 and 2004 · nothing leaves your computer</small>
        <ZipInput inputRef={inputRef} onFile={(file) => void open(file)} />
      </div>
    </div>
  );
}
