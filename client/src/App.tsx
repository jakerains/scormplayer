import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, copyText, type Course, type Pin, type PinPage } from "./api";
import { captureElement } from "./capture";
import { Icon } from "./icons";
import { chooseTarget, describeElement, describeTextSelection, locateTarget, visibleText, elementFor, widenTarget, type PinTarget, type Rect } from "./picker";
import { installScormApis, progressOf, type ScormData } from "./scorm-api";
import { createNavigator, type NavState } from "./nav";
import { activeMedia, skipMedia, tourState, watchMedia } from "./media";

type Selection = { element: Element; target: PinTarget };
type Marker = { id: string; number: number; rect: Rect };

export function App() {
  const [course, setCourse] = useState<Course | null>(null);
  const [loadError, setLoadError] = useState("");
  const [scorm, setScorm] = useState<ReturnType<typeof installScormApis> | null>(null);
  const [scormData, setScormData] = useState<ScormData>({});
  const [frameKey, setFrameKey] = useState(0);
  const [frameLoads, setFrameLoads] = useState(0);
  const [pins, setPins] = useState<Pin[]>([]);
  const [pinMode, setPinMode] = useState(false);
  const [passthrough, setPassthrough] = useState(false);
  const [hover, setHover] = useState<Rect | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [selectionRect, setSelectionRect] = useState<Rect | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [activePin, setActivePin] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [toast, setToast] = useState("");
  const [nav, setNav] = useState<NavState>(null);
  const [pagesOpen, setPagesOpen] = useState(false);
  const [navBusy, setNavBusy] = useState(false);
  const [tour, setTour] = useState<{ title: string; progress: string; canNext: boolean; canPrev: boolean } | null>(null);
  const [mediaPlaying, setMediaPlaying] = useState(false);
  const navigatorRef = useRef<ReturnType<typeof createNavigator> | null>(null);
  const [lastChangeAt, setLastChangeAt] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const say = useCallback((message: string) => setToast(message), []);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // Course, then the SCORM APIs, then the frame: a course looks for its API as it loads.
  useEffect(() => {
    api.course().then(setCourse, (error) => setLoadError(error.message));
  }, []);
  useEffect(() => {
    if (!course) return;
    const installed = installScormApis(window, `scormplayer:${course.courseKey}`);
    setScorm(installed);
    const unsubscribe = installed.subscribe(setScormData);
    document.title = `${course.title} · scormplayer`;
    return () => { unsubscribe(); installed.uninstall(); };
  }, [course]);

  // Tell the terminal how the course is doing (completion, success, score, location).
  useEffect(() => {
    if (!course) return;
    const timer = window.setTimeout(() => void api.reportProgress(progressOf(scormData)), 400);
    return () => window.clearTimeout(timer);
  }, [course, scormData]);

  const refreshPins = useCallback(() => api.pins().then(setPins).catch(() => {}), []);
  useEffect(() => {
    void refreshPins();
    // Pins can change from the command line (an agent resolving one); keep the list current.
    const timer = window.setInterval(() => void refreshPins(), 4000);
    return () => window.clearInterval(timer);
  }, [refreshPins]);

  useEffect(() => {
    if (course?.kind !== "live") return;
    const poll = () => api.status().then((status) => setLastChangeAt(status.lastChangeAt)).catch(() => {});
    poll();
    const timer = window.setInterval(() => { poll(); setNow(Date.now()); }, 2000);
    return () => window.clearInterval(timer);
  }, [course?.kind]);

  const frameDoc = () => {
    try { return frameRef.current?.contentDocument ?? null; } catch { return null; }
  };

  const currentPage = useCallback((): PinPage => {
    const doc = frameDoc();
    const location = progressOf(scormData).location || undefined;
    if (!doc) return { url: "", title: "", location };
    const heading = Array.from(doc.querySelectorAll("h1, h2"))
      .find((element) => (element as HTMLElement).offsetParent !== null && visibleText(element));
    const navPage = nav?.pages[nav.index];
    return {
      url: `${doc.location.pathname.replace(/^\/course\//, "")}${doc.location.search}${doc.location.hash}`,
      title: (navPage?.title || (heading ? visibleText(heading) : doc.title)).slice(0, 120),
      location,
      ...(navPage ? { navId: navPage.id, navIndex: nav!.index } : {}),
    };
  }, [scormData, nav]);

  // Page navigation and the tour/narration shortcuts follow the course frame.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !scorm) return;
    const navigator = createNavigator(frame, setNav);
    navigatorRef.current = navigator;
    return () => { navigator.dispose(); navigatorRef.current = null; setNav(null); };
  }, [scorm, frameKey]);
  useEffect(() => {
    const frame = frameRef.current;
    if (frame) watchMedia(frame);
  }, [frameLoads]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const frame = frameRef.current;
      if (!frame) return;
      const next = tourState(frame);
      const summary = next ? { title: next.title, progress: next.progress, canNext: next.canNext, canPrev: next.canPrev } : null;
      setTour((previous) => (JSON.stringify(previous) === JSON.stringify(summary) ? previous : summary));
      const playing = Boolean(activeMedia(frame));
      setMediaPlaying((previous) => (previous === playing ? previous : playing));
    }, 250);
    return () => window.clearInterval(timer);
  }, []);

  const openComposer = useCallback((element: Element, target: PinTarget) => {
    setSelection({ element, target });
    setSelectionRect(target.rect);
    setHover(null);
    setActivePin(null);
  }, []);

  const closeComposer = useCallback(() => {
    setSelection(null);
    setSelectionRect(null);
    setDraft("");
  }, []);

  // Picking happens inside the course frame (same origin), so the course itself is untouched.
  useEffect(() => {
    const doc = frameDoc();
    if (!doc || !pinMode) { setHover(null); return; }
    let frame = 0;
    let suppressClick = false;
    const active = () => !passthrough;

    const onMove = (event: MouseEvent) => {
      if (!active()) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const target = chooseTarget(event.target as Element);
        if (!target) return setHover(null);
        const box = target.getBoundingClientRect();
        setHover({ x: box.x, y: box.y, width: box.width, height: box.height });
      });
    };
    const onLeave = () => setHover(null);
    const block = (event: Event) => { if (active()) event.stopPropagation(); };
    const onMouseUp = (event: MouseEvent) => {
      if (!active()) return;
      const selected = doc.getSelection();
      if (selected && !selected.isCollapsed && selected.toString().trim()) {
        const target = describeTextSelection(selected);
        const element = (event.target as Element).closest("*");
        if (target && element) {
          suppressClick = true;
          openComposer(element, target);
        }
      }
      event.stopPropagation();
    };
    const onClick = (event: MouseEvent) => {
      if (!active()) return;
      event.preventDefault();
      event.stopPropagation();
      if (suppressClick) { suppressClick = false; return; }
      const element = chooseTarget(event.target as Element);
      if (element) openComposer(element, describeElement(element));
    };

    const options = { capture: true } as const;
    doc.addEventListener("mousemove", onMove, options);
    doc.addEventListener("mouseleave", onLeave, options);
    for (const type of ["pointerdown", "mousedown", "pointerup", "touchstart", "dblclick", "submit"]) doc.addEventListener(type, block, options);
    doc.addEventListener("mouseup", onMouseUp, options);
    doc.addEventListener("click", onClick, options);
    // A crosshair while picking; removed as soon as pin mode ends. Runtime only.
    const cursor = doc.createElement("style");
    cursor.textContent = "*, *::before, *::after { cursor: crosshair !important; }";
    if (!passthrough) doc.head?.append(cursor);
    return () => {
      cancelAnimationFrame(frame);
      doc.removeEventListener("mousemove", onMove, options);
      doc.removeEventListener("mouseleave", onLeave, options);
      for (const type of ["pointerdown", "mousedown", "pointerup", "touchstart", "dblclick", "submit"]) doc.removeEventListener(type, block, options);
      doc.removeEventListener("mouseup", onMouseUp, options);
      doc.removeEventListener("click", onClick, options);
      cursor.remove();
    };
  }, [pinMode, passthrough, frameLoads, openComposer]);

  // Keyboard: P toggles pin mode, Esc backs out, hold Space to use the course while pinning.
  useEffect(() => {
    const docs = [document, frameDoc()].filter(Boolean) as Document[];
    const editing = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      return Boolean(target?.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true']"));
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (pagesOpen) setPagesOpen(false);
        else if (selection) closeComposer();
        else if (menuOpen) setMenuOpen(false);
        else if (panelOpen) setPanelOpen(false);
        else if (pinMode) setPinMode(false);
        return;
      }
      if (editing(event) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.code === "Space" && pinMode) {
        event.preventDefault();
        if (!event.repeat) { setPassthrough(true); setHover(null); }
      } else if (event.key.toLowerCase() === "p" && !selection) {
        event.preventDefault();
        setPinMode((value) => !value);
      } else if (event.key === "[" || event.key === "]") {
        event.preventDefault();
        void stepPage(event.key === "]" ? 1 : -1);
      } else if (event.key === ".") {
        event.preventDefault();
        skipAhead();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => { if (event.code === "Space") setPassthrough(false); };
    docs.forEach((doc) => { doc.addEventListener("keydown", onKeyDown, true); doc.addEventListener("keyup", onKeyUp, true); });
    return () => docs.forEach((doc) => { doc.removeEventListener("keydown", onKeyDown, true); doc.removeEventListener("keyup", onKeyUp, true); });
  }, [pinMode, selection, menuOpen, panelOpen, pagesOpen, frameLoads, closeComposer, nav, navBusy]);

  // Keep pin markers and the selection box on their elements as the course scrolls and changes.
  useEffect(() => {
    const tick = () => {
      const doc = frameDoc();
      if (!doc) return;
      const page = currentPage();
      const next: Marker[] = [];
      for (const pin of pins) {
        if (pin.status !== "open" || !pin.target || (pin.page?.url && pin.page.url !== page.url)) continue;
        const pinNav = (pin.page as { navId?: string } | undefined)?.navId;
        if (pinNav && page.navId && pinNav !== page.navId) continue;
        const rect = locateTarget(doc, pin.target);
        if (!rect || !sameText(doc, pin.target)) continue;
        next.push({ id: pin.id, number: pin.number, rect });
      }
      setMarkers((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
      if (selection) {
        const box = selection.target.kind === "text" ? locateTarget(doc, selection.target) : selection.element.isConnected ? selection.element.getBoundingClientRect() : null;
        const rect = box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
        setSelectionRect((previous) => (JSON.stringify(previous) === JSON.stringify(rect) ? previous : rect));
      }
    };
    tick();
    const timer = window.setInterval(tick, 200);
    return () => window.clearInterval(timer);
  }, [pins, selection, frameLoads, currentPage]);

  async function savePin() {
    if (!selection || !draft.trim() || saving) return;
    setSaving(true);
    try {
      const pin = await api.createPin({ note: draft.trim(), page: currentPage(), target: selection.target });
      setPins((previous) => [...previous, pin]);
      const element = selection.element;
      closeComposer();
      say(`Pin ${pin.number} saved${pin.source?.length ? ` · found in ${pin.source[0].file}` : ""}`);
      void captureElement(element).then((png) => (png ? api.saveFrame(pin.id, png).then(refreshPins) : undefined)).catch(() => {});
    } catch (error) {
      say(error instanceof Error ? error.message : "Could not save the pin.");
    } finally {
      setSaving(false);
    }
  }

  async function copyPins() {
    const open = pins.filter((pin) => pin.status === "open").length;
    if (!open) return say("No open pins to copy.");
    try {
      await copyText(await api.brief("open"));
      say(`Copied ${open} ${open === 1 ? "pin" : "pins"} for your agent`);
    } catch (error) {
      say(error instanceof Error ? error.message : "Could not copy.");
    }
  }

  async function setStatus(pin: Pin, status: Pin["status"]) {
    const updated = await api.updatePin(pin.id, { status });
    setPins((previous) => previous.map((item) => (item.id === pin.id ? updated : item)));
  }

  async function removePin(pin: Pin) {
    await api.deletePin(pin.id);
    setPins((previous) => previous.filter((item) => item.id !== pin.id));
    say(`Pin ${pin.number} deleted`);
  }

  async function goToPage(index: number) {
    const navigator = navigatorRef.current;
    if (!navigator || navBusy) return false;
    setNavBusy(true);
    setPagesOpen(false);
    try {
      const reached = await navigator.goTo(index);
      if (!reached) say("The course didn't move to that page");
      return reached;
    } finally {
      setNavBusy(false);
    }
  }

  async function stepPage(delta: number) {
    if (!nav) return;
    const target = nav.index + delta;
    if (target >= 0 && target < nav.pages.length) await goToPage(target);
  }

  function skipAhead() {
    const frame = frameRef.current;
    if (!frame) return;
    if (skipMedia(frame)) { say("Skipped to the end of the narration"); return; }
    const current = tourState(frame);
    if (current?.canNext) current.next();
  }

  function tourStep(direction: "next" | "prev") {
    const frame = frameRef.current;
    const current = frame ? tourState(frame) : null;
    if (!current) return;
    if (direction === "next") {
      if (current.canNext) current.next();
      else if (frame && skipMedia(frame)) say("Skipped the narration; Next is unlocking");
    } else if (current.canPrev) current.prev();
  }

  async function goToPin(pin: Pin) {
    const scrollTo = () => {
      const doc = frameDoc();
      const element = doc && pin.target ? elementFor(doc, pin.target) : null;
      if (!element) return false;
      element.scrollIntoView({ block: "center", behavior: "smooth" });
      setActivePin(pin.id);
      window.setTimeout(() => setActivePin((current) => (current === pin.id ? null : current)), 2400);
      return true;
    };
    if (markers.some((marker) => marker.id === pin.id) && scrollTo()) return;
    const page = pin.page as (PinPage & { navId?: string; navIndex?: number }) | undefined;
    if (nav && page) {
      const index = nav.pages.findIndex((item) => item.id === page.navId);
      const target = index >= 0 ? index : nav.pages.findIndex((item) => item.title === page.title);
      if (target >= 0 && target !== nav.index && await goToPage(target)) {
        window.setTimeout(scrollTo, 350);
        return;
      }
    }
    say(page?.title ? `Pin ${pin.number} is on “${page.title}”` : `Pin ${pin.number} isn't on this page`);
  }

  function widen() {
    if (!selection) return;
    const wider = widenTarget(selection.element);
    if (wider) openComposer(wider, describeElement(wider));
  }

  function resetProgress() {
    if (!confirmReset) { setConfirmReset(true); return; }
    scorm?.reset();
    setConfirmReset(false);
    setMenuOpen(false);
    setFrameKey((key) => key + 1);
    say("Progress cleared; the course restarted");
  }

  const openPins = pins.filter((pin) => pin.status === "open");
  const listedPins = showResolved ? pins : openPins;
  const progress = progressOf(scormData);
  const progressLabel = describeProgress(progress);
  const kindLabel = course ? describeKind(course, lastChangeAt, now) : "";

  const composerStyle = useMemo(() => composerPosition(selectionRect, stageRef.current), [selectionRect]);

  if (loadError) return <div className="sp-fatal"><strong>scormplayer could not load the course.</strong><p>{loadError}</p></div>;

  return (
    <div className={`sp-app ${panelOpen ? "has-panel" : ""}`}>
      <div className="sp-main">
        <div className={`sp-stage ${pinMode && !passthrough ? "is-picking" : ""}`} ref={stageRef}>
          {course && scorm ? (
            <iframe
              key={frameKey}
              ref={frameRef}
              className="sp-frame"
              title={course.title}
              src={course.launchUrl}
              allow="autoplay; fullscreen; microphone; camera; clipboard-write"
              onLoad={() => setFrameLoads((count) => count + 1)}
            />
          ) : <div className="sp-loading">Opening course…</div>}

          <div className="sp-overlay" aria-hidden={!markers.length}>
            {hover && !selection ? <div className="sp-box sp-box--hover" style={boxStyle(hover)} /> : null}
            {selectionRect ? <div className="sp-box sp-box--selected" style={boxStyle(selectionRect)} /> : null}
            {markers.map((marker) => (
              <button
                key={marker.id}
                type="button"
                className={`sp-marker ${activePin === marker.id ? "is-active" : ""}`}
                style={{ left: marker.rect.x + marker.rect.width - 11, top: Math.max(4, marker.rect.y - 11) }}
                onClick={() => { setPanelOpen(true); setActivePin(marker.id); }}
                title={pins.find((pin) => pin.id === marker.id)?.note}
              >
                {marker.number}
              </button>
            ))}
            {activePin ? markers.filter((marker) => marker.id === activePin).map((marker) => <div key={marker.id} className="sp-box sp-box--flash" style={boxStyle(marker.rect)} />) : null}
          </div>

          {pinMode && !selection ? (
            <div className="sp-hint" role="status">
              {passthrough ? "Using the course · release Space to keep pinning" : <>Click anything to pin it · drag across text to pin a phrase · hold <kbd>Space</kbd> to use the course · <kbd>Esc</kbd> to stop</>}
            </div>
          ) : null}

          {selection ? (
            <div className="sp-composer" style={composerStyle} role="dialog" aria-label="New pin" onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void savePin(); }
            }}>
              <div className="sp-composer__target">
                <span title={selection.target.selector}>{selection.target.name}</span>
                {selection.target.kind === "element" ? (
                  <button type="button" className="sp-icon-button" onClick={widen} title="Select the larger area around this">
                    <Icon name="expand" size={15} />
                  </button>
                ) : null}
                <button type="button" className="sp-icon-button" onClick={closeComposer} aria-label="Cancel"><Icon name="close" size={15} /></button>
              </div>
              <textarea
                autoFocus
                rows={3}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="What should change here?"
              />
              <div className="sp-composer__actions">
                <small>{navigator.platform.includes("Mac") ? "⌘" : "Ctrl"} + Enter to save</small>
                <button type="button" className="sp-button sp-button--primary" disabled={!draft.trim() || saving} onClick={() => void savePin()}>
                  {saving ? "Saving…" : "Save pin"}
                </button>
              </div>
            </div>
          ) : null}

          {toast ? <div className="sp-toast" role="status">{toast}</div> : null}
        </div>

        <footer className="sp-bar">
          <div className="sp-bar__identity">
            <span className={`sp-dot sp-dot--${course?.kind ?? "package"}`} aria-hidden="true" />
            <div className="sp-bar__titles">
              <strong title={course?.source}>{course?.title ?? "Loading…"}</strong>
              <span>{kindLabel}</span>
            </div>
          </div>

          {nav ? (
            <div className="sp-nav" aria-label="Pages">
              <button type="button" className="sp-nav__step" disabled={navBusy || nav.index === 0} onClick={() => void stepPage(-1)} title="Previous page ( [ )" aria-label="Previous page">
                <Icon name="chevronLeft" />
              </button>
              <div className="sp-menu-anchor">
                <button type="button" className="sp-nav__page" aria-expanded={pagesOpen} onClick={() => { setPagesOpen((value) => !value); setMenuOpen(false); }} title="Jump to a page">
                  <b>{nav.index + 1}</b><span className="sp-nav__of">/ {nav.pages.length}</span>
                  <span className="sp-nav__title">{nav.pages[nav.index]?.title}</span>
                  <Icon name="chevronUp" size={14} />
                </button>
                {pagesOpen ? (
                  <div className="sp-menu sp-pages" role="menu">
                    {nav.pages.map((page, index) => (
                      <button key={`${page.id}-${index}`} type="button" role="menuitem" aria-current={index === nav.index ? "page" : undefined} onClick={() => void goToPage(index)}>
                        <span className="sp-pages__number">{index + 1}</span>
                        <span className="sp-pages__title">{page.title}</span>
                        {pins.some((pin) => pin.status === "open" && (pin.page as { navId?: string } | undefined)?.navId === page.id) ? <span className="sp-pages__pin" title="Has open pins" /> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <button type="button" className="sp-nav__step" disabled={navBusy || nav.index >= nav.pages.length - 1} onClick={() => void stepPage(1)} title="Next page ( ] )" aria-label="Next page">
                <Icon name="chevronRight" />
              </button>
            </div>
          ) : null}

          {tour ? (
            <div className="sp-tour" aria-label="Guided tour">
              <span className="sp-tour__label" title={tour.title}>Tour{tour.progress ? ` · ${tour.progress}` : ""}</span>
              <button type="button" className="sp-nav__step" disabled={!tour.canPrev} onClick={() => tourStep("prev")} title="Previous tour step" aria-label="Previous tour step"><Icon name="chevronLeft" /></button>
              <button type="button" className="sp-skip" disabled={!mediaPlaying && !tour.canNext} onClick={() => tourStep("next")} title={mediaPlaying && !tour.canNext ? "Skip the narration (.)" : "Next tour step (.)"}>
                {mediaPlaying && !tour.canNext ? <><Icon name="skip" size={16} /> Skip</> : <>Next <Icon name="chevronRight" size={16} /></>}
              </button>
            </div>
          ) : mediaPlaying ? (
            <button type="button" className="sp-skip" onClick={skipAhead} title="Skip to the end of the playing audio or video (.)"><Icon name="skip" size={16} /> Skip media</button>
          ) : null}

          <span className={`sp-progress sp-progress--${progressLabel.tone}`} title={progress.location ? `SCORM location: ${progress.location}` : undefined}>
            {progressLabel.text}
          </span>

          <nav className="sp-bar__actions" aria-label="Player">
            <button type="button" className="sp-tab" aria-pressed={pinMode} onClick={() => { setPinMode((value) => !value); setMenuOpen(false); }} title="Pin mode (P)">
              <Icon name="pin" /><span>{pinMode ? "Pinning" : "Pin"}</span>
            </button>
            <button type="button" className="sp-tab" aria-pressed={panelOpen} onClick={() => { setPanelOpen((value) => !value); setMenuOpen(false); }} title="Saved pins">
              <Icon name="list" /><span>Pins</span>{openPins.length ? <em>{openPins.length}</em> : null}
            </button>
            <button type="button" className="sp-tab" onClick={() => void copyPins()} disabled={!openPins.length} title="Copy all open pins as a hand-off for an agent">
              <Icon name="copy" /><span>Copy</span>
            </button>
            <div className="sp-menu-anchor">
              <button type="button" className="sp-tab" aria-expanded={menuOpen} onClick={() => { setMenuOpen((value) => !value); setConfirmReset(false); }} title="More">
                <Icon name="more" /><span>More</span>
              </button>
              {menuOpen ? (
                <div className="sp-menu" role="menu">
                  <button type="button" role="menuitem" onClick={() => { setFrameKey((key) => key + 1); setMenuOpen(false); }}>
                    <Icon name="reload" size={16} /> Reload course
                  </button>
                  <button type="button" role="menuitem" className={confirmReset ? "is-danger" : ""} onClick={resetProgress}>
                    <Icon name="reset" size={16} /> {confirmReset ? "Click again to clear progress" : "Reset progress"}
                  </button>
                  <button type="button" role="menuitem" onClick={() => { if (course) void copyText(course.pinsFile).then(() => say("Pins file path copied")); setMenuOpen(false); }}>
                    <Icon name="file" size={16} /> Copy pins file path
                  </button>
                  <p className="sp-menu__meta">{progressLabel.text}{progress.location ? ` · location ${progress.location}` : ""}</p>
                </div>
              ) : null}
            </div>
          </nav>
        </footer>
      </div>

      {panelOpen ? (
        <aside className="sp-panel" aria-label="Pins">
          <header>
            <div>
              <strong>Pins</strong>
              <span>{openPins.length} open{pins.length - openPins.length ? ` · ${pins.length - openPins.length} resolved` : ""}</span>
            </div>
            <button type="button" className="sp-icon-button" onClick={() => setPanelOpen(false)} aria-label="Close pins"><Icon name="close" /></button>
          </header>
          <div className="sp-panel__tools">
            <button type="button" className="sp-button sp-button--primary" disabled={!openPins.length} onClick={() => void copyPins()}>
              <Icon name="copy" size={15} /> Copy {openPins.length || ""} for agent
            </button>
            <label><input type="checkbox" checked={showResolved} onChange={(event) => setShowResolved(event.target.checked)} /> Show resolved</label>
          </div>
          {listedPins.length ? (
            <ol className="sp-pin-list">
              {listedPins.map((pin) => (
                <PinRow key={pin.id} pin={pin} active={activePin === pin.id} onPage={markers.some((marker) => marker.id === pin.id)}
                  onOpen={() => goToPin(pin)} onStatus={(status) => void setStatus(pin, status)} onDelete={() => void removePin(pin)} />
              ))}
            </ol>
          ) : (
            <p className="sp-empty">{pins.length ? "Every pin is resolved." : <>No pins yet. Press <kbd>P</kbd> or <strong>Pin</strong>, click something in the course, and write what should change.</>}</p>
          )}
        </aside>
      ) : null}
    </div>
  );
}

function PinRow({ pin, active, onPage, onOpen, onStatus, onDelete }: {
  pin: Pin; active: boolean; onPage: boolean;
  onOpen: () => void; onStatus: (status: Pin["status"]) => void; onDelete: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <li className={`sp-pin ${active ? "is-active" : ""} ${pin.status === "resolved" ? "is-resolved" : ""}`}>
      <button type="button" className="sp-pin__main" onClick={onOpen}>
        <span className="sp-pin__number">{pin.number}</span>
        <span className="sp-pin__body">
          <span className="sp-pin__note">{pin.note}</span>
          <small>
            {[pin.page?.title, pin.target?.name].filter(Boolean).join(" · ")}
            {onPage ? " · on this page" : ""}
          </small>
          {pin.source?.[0] ? <code>{pin.source[0].file}:{pin.source[0].line}</code> : null}
        </span>
        {pin.frame ? <img src={`/api/pins/${pin.id}/frame?v=${encodeURIComponent(pin.updatedAt)}`} alt="" /> : null}
      </button>
      <div className="sp-pin__actions">
        {pin.status === "open"
          ? <button type="button" onClick={() => onStatus("resolved")}><Icon name="check" size={14} /> Resolve</button>
          : <button type="button" onClick={() => onStatus("open")}><Icon name="undo" size={14} /> Reopen</button>}
        <button type="button" className={confirmDelete ? "is-danger" : ""} onClick={() => (confirmDelete ? onDelete() : setConfirmDelete(true))} onBlur={() => setConfirmDelete(false)}>
          <Icon name="trash" size={14} /> {confirmDelete ? "Confirm delete" : "Delete"}
        </button>
      </div>
    </li>
  );
}

function sameText(doc: Document, target: PinTarget) {
  if (!target.text) return true;
  const element = elementFor(doc, target);
  if (!element) return false;
  const fold = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 40);
  return visibleText(element).toLowerCase().replace(/\s+/g, " ").includes(fold(target.text));
}

function boxStyle(rect: Rect) {
  return { left: rect.x, top: rect.y, width: rect.width, height: rect.height };
}

function composerPosition(rect: Rect | null, stage: HTMLElement | null) {
  if (!rect || !stage) return {};
  const width = Math.min(360, stage.clientWidth - 24);
  const left = Math.min(Math.max(12, rect.x), stage.clientWidth - width - 12);
  const below = rect.y + rect.height + 10;
  const fitsBelow = below + 190 < stage.clientHeight;
  const top = fitsBelow ? below : Math.max(12, rect.y - 200);
  return { left, top, width };
}

function describeProgress(progress: ReturnType<typeof progressOf>) {
  if (progress.success === "passed") return { text: `Passed${progress.score ? ` · ${progress.score}` : ""}`, tone: "good" };
  if (progress.success === "failed") return { text: `Failed${progress.score ? ` · ${progress.score}` : ""}`, tone: "bad" };
  if (progress.completion === "completed") return { text: `Completed${progress.score ? ` · ${progress.score}` : ""}`, tone: "good" };
  if (progress.completion === "incomplete") return { text: "In progress", tone: "neutral" };
  return { text: "Not started", tone: "muted" };
}

function describeKind(course: Course, lastChangeAt: string | null, now: number) {
  const version = course.scormVersion && course.scormVersion !== "both" ? `SCORM ${course.scormVersion}` : "SCORM";
  if (course.kind === "live") {
    if (!lastChangeAt) return `Live source · ${version} · watching for edits`;
    const seconds = Math.max(0, Math.round((now - Date.parse(lastChangeAt)) / 1000));
    const ago = seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.round(seconds / 60)}m` : `${Math.round(seconds / 3600)}h`;
    return `Live source · ${version} · updated ${ago} ago`;
  }
  return `${version} · ${course.kind === "package" ? "zip" : "folder"}`;
}
