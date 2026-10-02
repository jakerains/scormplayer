import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";

/**
 * Switching to another course without restarting: when the player opens a different course
 * (from this list, the terminal's l key, or a dropped zip), every open tab reloads onto it.
 */

type Course = Awaited<ReturnType<typeof api.courses>>[number];
const KIND: Record<string, string> = { zip: "SCORM zip", folder: "SCORM folder", live: "Live source" };

export function CourseSwitcher({ onClose }: { onClose: () => void }) {
  const [courses, setCourses] = useState<Course[] | null>(null);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const listRef = useRef<HTMLOListElement | null>(null);
  useEffect(() => {
    api.courses().then((found) => {
      setCourses(found);
      setIndex(Math.max(0, found.findIndex((course) => course.current)));
    }, (failure) => setError(failure.message));
  }, []);
  const shown = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (courses ?? []).filter((course) => words.every((word) => `${course.title} ${course.path}`.toLowerCase().includes(word)));
  }, [courses, query]);
  useEffect(() => { listRef.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" }); }, [index, shown]);

  async function open(course: Course | undefined) {
    if (!course || busy) return;
    if (course.current) return onClose();
    setBusy(true);
    try {
      await api.switchCourse(course.path);
      window.location.reload();
    } catch (failure) {
      setBusy(false);
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }

  return (
    <div className="sp-modal" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div className="sp-dialog sp-switcher" role="dialog" aria-modal="true" aria-labelledby="sp-switch-title">
        <h2 id="sp-switch-title">Switch course</h2>
        <input
          autoFocus
          value={query}
          placeholder={courses ? `Filter ${courses.length} ${courses.length === 1 ? "course" : "courses"}` : "Loading…"}
          onChange={(event) => { setQuery(event.target.value); setIndex(0); }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") { event.preventDefault(); setIndex((value) => Math.min(shown.length - 1, value + 1)); }
            else if (event.key === "ArrowUp") { event.preventDefault(); setIndex((value) => Math.max(0, value - 1)); }
            else if (event.key === "Enter") { event.preventDefault(); void open(shown[index]); }
            else if (event.key === "Escape") { event.stopPropagation(); if (query) setQuery(""); else onClose(); }
          }}
          spellCheck={false}
          aria-label="Filter courses"
        />
        {error ? <p className="sp-dialog__error" role="alert">{error}</p> : null}
        {courses && !courses.length ? <p>No other courses found beside this one.</p> : null}
        <ol className="sp-switcher__list" ref={listRef}>
          {shown.map((course, i) => (
            <li key={course.path}>
              <button type="button" data-index={i} className={i === index ? "is-active" : ""} aria-current={course.current ? "true" : undefined}
                onMouseEnter={() => setIndex(i)} onClick={() => void open(course)} disabled={busy}>
                <span className="sp-switcher__title">{course.title}</span>
                <span className="sp-switcher__meta">{course.current ? <b>Open now</b> : KIND[course.kind] ?? course.kind} · {course.path.split(/[\\/]/).slice(-2).join("/")}</span>
              </button>
            </li>
          ))}
        </ol>
        {courses && courses.length && !shown.length ? <p>No course matches “{query}”.</p> : null}
        <div className="sp-dialog__actions">
          <span className="sp-switcher__hint">↑ ↓ to choose · Enter to open · Esc to close</span>
          <button type="button" className="sp-button" onClick={onClose} disabled={busy}>{busy ? "Opening…" : "Cancel"}</button>
        </div>
      </div>
    </div>
  );
}
