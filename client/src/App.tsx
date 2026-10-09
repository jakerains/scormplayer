import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, copyText, type Course, type Pin, type PinPage, type QaStatus, type XapiSummary } from "./api";
import { captureElement, captureRegion } from "./capture";
import { connectReviewBrowser } from "./browser-bridge";
import { Icon } from "./icons";
import { chooseTarget, describeElement, describeGroup, describeRegion, describeTextSelection, locateTarget, resolveTarget, visibleTargetRect, type TargetResolution, visibleText, elementFor, widenTarget, type PinTarget, type Rect } from "./picker";
import { installScormApis, progressOf, type NavRequest, type ScormData, type ScormIssue } from "./scorm-api";
import { LaunchSettingsDialog, loadLaunchSettings, saveLaunchSettings } from "./LaunchSettings";
import { createNavigator, type NavState } from "./nav";
import { checkpointReview, clearCourseReview, reviewLaunchUrl, reviewScope } from "./review-view";
import { ScormPersistence } from "./scorm-state";
import { skipForReview } from "./review-navigation";
import { activeMedia, skipMedia, tourState, watchMedia } from "./media";
import { DropHome, UploadStatus, ZipInput, useZipOpener } from "./DropHome";
import { Inspector } from "./Inspector";
import { Checks } from "./Checks";
import { QaBanner, QaSuggestions } from "./QaPanel";
import { captureViewport, pageSnapshot, waitFor } from "./qa-agent";
import { scanAccessibility } from "./a11y";
import { UnzipDialog, UnzipNotice, useUnzipNotice } from "./Unzip";
import { ClosedScreen, StillThereCard, useStillThere } from "./StillThere";
import { SkillCard, useAgentSkill } from "./SkillOffer";
import { pollWhileVisible } from "./polling";
import { CourseSwitcher } from "./CourseSwitcher";
import { registerWebMcpTools, type PlayerActions } from "./webmcp";
import type { ScormCall } from "./scorm-api";

type Selection = { element: Element; target: PinTarget; elements?: Element[] };
type Marker = { id: string; number: number; rect: Rect; status: string; suggestion: boolean; ai: boolean };

export function App() {
  const [course, setCourse] = useState<Course | null>(null);
  const [empty, setEmpty] = useState(false);
  const [scoIndex, setScoIndex] = useState(0);
  const [scosOpen, setScosOpen] = useState(false);
  const [calls, setCalls] = useState<ScormCall[]>([]);
  const [issues, setIssues] = useState<ScormIssue[]>([]);
  const [launchSettings, setLaunchSettings] = useState(loadLaunchSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [checksOpen, setChecksOpen] = useState(false);
  // The agent QA run in progress, when there is one (the course runs on a throwaway attempt).
  const [qaRunId, setQaRunId] = useState<string | null>(null);
  const [qaStatus, setQaStatus] = useState<QaStatus | null>(null);
  const [qaDone, setQaDone] = useState<number | null>(null);
  const [panelTab, setPanelTab] = useState<"pins" | "suggestions">("pins");
  const navRequestRef = useRef<(request: NavRequest) => void>(() => {});
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const pendingPinRef = useRef<Pin | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const zipInputRef = useRef<HTMLInputElement | null>(null);
  const zip = useZipOpener();
  const [loadError, setLoadError] = useState("");
  const [scorm, setScorm] = useState<ReturnType<typeof installScormApis> | null>(null);
  const [scormData, setScormData] = useState<ScormData>({});
  const [persistence, setPersistence] = useState<ScormPersistence | null>(null);
  const [progressError, setProgressError] = useState("");
  const [resetting, setResetting] = useState(false);
  const [frameKey, setFrameKey] = useState(0);
  const [frameLoads, setFrameLoads] = useState(0);
  const reloadPending = useRef(false);
  const [pins, setPins] = useState<Pin[]>([]);
  const [pinMode, setPinMode] = useState(false);
  const [passthrough, setPassthrough] = useState(false);
  const [hover, setHover] = useState<Rect | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [selectionRect, setSelectionRect] = useState<Rect | null>(null);
  const [groupRects, setGroupRects] = useState<Rect[]>([]);
  const [band, setBand] = useState<Rect | null>(null);
  const selectionRef = useRef<Selection | null>(null);
  const [draft, setDraft] = useState("");
  const [reattaching, setReattaching] = useState<Pin | null>(null);
  const [attachments, setAttachments] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [activePin, setActivePin] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [toast, setToast] = useState("");
  const [unzipOpen, setUnzipOpen] = useState(false);
  const skillOffer = useAgentSkill();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  // Make a server-confirmed update visible without requiring the reviewer to open More.
  const [update, setUpdate] = useState<{ latest: string; command: string } | null>(null);
  useEffect(() => pollWhileVisible(() => api.update().then(setUpdate), 5000, 60_000), []);
  useEffect(() => { if (menuOpen) api.update().then(setUpdate, () => {}); }, [menuOpen]);
  const unzipNotice = useUnzipNotice(course);
  const [nav, setNav] = useState<NavState>(null);
  const [pagesOpen, setPagesOpen] = useState(false);
  const [navBusy, setNavBusy] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [tour, setTour] = useState<{ title: string; progress: string; canNext: boolean; canPrev: boolean } | null>(null);
  const [mediaPlaying, setMediaPlaying] = useState(false);
  const [mediaAvailable, setMediaAvailable] = useState(false);
  const navigatorRef = useRef<ReturnType<typeof createNavigator> | null>(null);
  const [lastChangeAt, setLastChangeAt] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const deviceRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState<Viewport>(() => {
    try { const saved = localStorage.getItem("scormplayer:viewport"); return saved === "tablet" || saved === "phone" ? saved : "desktop"; } catch { return "desktop"; }
  });
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    try { localStorage.setItem("scormplayer:viewport", viewport); } catch { /* storage blocked */ }
  }, [viewport]);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(() => setStageSize({ width: stage.clientWidth, height: stage.clientHeight }));
    observer.observe(stage);
    return () => observer.disconnect();
  }, [course]);

  const say = useCallback((message: string) => setToast(message), []);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // Course, then the SCORM APIs, then the frame: a course looks for its API as it loads.
  useEffect(() => {
    api.course().then(async (result) => {
      if ("empty" in result) { setEmpty(true); return; }
      const state = await api.scormState();
      if (!state.saved) {
        try {
          const ids = result.scos?.map((sco) => sco.id) ?? [""];
          for (const id of ids) {
            const data = JSON.parse(localStorage.getItem(`scormplayer:${result.courseKey}${id ? `:${id}` : ""}`) || "null");
            if (data && typeof data === "object" && !Array.isArray(data)) state.modules[id] = Object.fromEntries(Object.entries(data).filter(([, value]) => typeof value === "string")) as ScormData;
          }
          const saved = Number(localStorage.getItem(`scormplayer:sco:${result.courseKey}`));
          if (Number.isInteger(saved) && ids[saved]) state.selectedSco = ids[saved];
        } catch { /* storage blocked */ }
      }
      if (result.scos) setScoIndex(Math.max(0, result.scos.findIndex((sco) => sco.id === state.selectedSco)));
      setPersistence(new ScormPersistence(state, api.saveScormState, setProgressError));
      setCourse(result);
    }).catch((error) => setLoadError(error.message));
  }, []);
  useEffect(() => {
    if (!persistence) return;
    const flush = () => { void persistence.flush(true); };
    window.addEventListener("pagehide", flush);
    return () => { window.removeEventListener("pagehide", flush); void persistence.flush(); };
  }, [persistence]);
  // Each SCO keeps its own SCORM data, as it would in an LMS.
  const sco = course?.scos?.[scoIndex] ?? null;
  const launchUrl = sco?.launchUrl ?? course?.launchUrl ?? "";
  const viewScope = course?.kind === "live" ? reviewScope(course.courseKey, sco?.id ?? "", launchUrl) : "";
  const xapiCourse = course?.standard === "xapi" || course?.standard === "cmi5";
  const frameUrl = useMemo(() => {
    if (viewScope) return reviewLaunchUrl(viewScope, launchUrl);
    // xAPI and cmi5 launches carry the learner from Launch settings, as an LMS would.
    if (xapiCourse) return `${launchUrl}&${new URLSearchParams({ learnerName: launchSettings.learnerName, learnerId: launchSettings.learnerId, mode: launchSettings.mode })}`;
    return launchUrl;
  }, [viewScope, launchUrl, frameKey, xapiCourse, launchSettings]);
  // xAPI and cmi5: what the local LRS has recorded, refreshed while the page is visible.
  const [xapi, setXapi] = useState<XapiSummary | null>(null);
  useEffect(() => {
    if (!xapiCourse) { setXapi(null); return; }
    return pollWhileVisible(() => api.xapi().then(setXapi).catch(() => {}), 2000, 10_000);
  }, [xapiCourse, frameKey]);
  const courseProgress = useMemo(() => {
    if (!xapiCourse) return progressOf(scormData);
    const module = xapi?.modules[sco?.id ?? course?.scos?.[0]?.id ?? Object.keys(xapi?.modules ?? {})[0] ?? ""];
    return { completion: module?.completion ?? "", success: module?.success ?? "", score: module?.score ?? "", location: "", progressMeasure: "" };
  }, [xapiCourse, xapi, scormData, sco, course]);
  useEffect(() => {
    const save = () => checkpointReview(frameRef.current, false, true);
    window.addEventListener("beforeunload", save);
    return () => window.removeEventListener("beforeunload", save);
  }, []);
  useEffect(() => {
    if (!course || !persistence) return;
    const id = sco?.id ?? "";
    persistence.select(id);
    const installed = installScormApis(window, `scormplayer:${course.courseKey}${sco ? `:${sco.id}` : ""}`, {
      initialData: persistence.state.modules[id] ?? {}, commit: () => { void persistence.flush(); },
      settings: launchSettings,
      runtime: sco?.runtime ?? course.runtime ?? {},
      navigation: { ids: course.scos?.map((item) => item.id) ?? [id], index: scoIndex },
      onNavRequest: (request) => navRequestRef.current(request),
    });
    setScorm(installed);
    const unsubscribe = installed.subscribe((data) => { setScormData(data); persistence.update(id, data); });
    const unsubscribeCalls = installed.subscribeCalls(setCalls);
    const unsubscribeIssues = installed.subscribeIssues(setIssues);
    document.title = `${course.title} · scormplayer`;
    try { if (course.scos) localStorage.setItem(`scormplayer:sco:${course.courseKey}`, String(scoIndex)); } catch { /* storage blocked */ }
    return () => { unsubscribe(); unsubscribeCalls(); unsubscribeIssues(); installed.uninstall(); };
  }, [course, scoIndex, persistence, frameKey, launchSettings]);

  // Tell the terminal how the course is doing (completion, success, score, location).
  useEffect(() => {
    if (!course) return;
    const timer = window.setTimeout(() => void api.reportProgress(courseProgress), 400);
    return () => window.clearTimeout(timer);
  }, [course, courseProgress]);

  const refreshPins = useCallback(() => api.pins().then(setPins).catch(() => {}), []);

  // An agent's QA pass: its banner, and a notice with the suggestion count once it ends.
  const qaWasActive = useRef<string | null>(null);
  useEffect(() => {
    if (!course) return;
    return pollWhileVisible(() => api.qa().then((status) => {
      setQaStatus(status);
      const before = qaWasActive.current;
      qaWasActive.current = status.active?.id ?? null;
      if (before && !status.active && status.last?.id === before) { setQaDone(status.counts.suggested); void refreshPins(); }
    }).catch(() => {}), 2000, 10_000);
  }, [course?.revision, qaRunId, refreshPins]);
  useEffect(() => {
    return pollWhileVisible(refreshPins, 4000, 15_000);
  }, [refreshPins]);

  useEffect(() => {
    if (course?.kind !== "live") return;
    const poll = () => api.status().then((status) => setLastChangeAt(status.lastChangeAt)).catch(() => {});
    return pollWhileVisible(async () => { await poll(); setNow(Date.now()); }, 2000, 10_000);
  }, [course?.kind]);

  const frameDoc = () => {
    try { return frameRef.current?.contentDocument ?? null; } catch { return null; }
  };

  const { presence, stillHere } = useStillThere({ course, mediaPlaying, frameDoc, frameLoads });

  const currentPage = useCallback((): PinPage => {
    const doc = frameDoc();
    const location = courseProgress.location || undefined;
    if (!doc) return { url: "", title: "", location };
    const heading = Array.from(doc.querySelectorAll("h1, h2"))
      .find((element) => (element as HTMLElement).offsetParent !== null && visibleText(element));
    const navPage = nav?.pages[nav.index];
    return {
      url: `${doc.location.pathname.replace(/^\/course\//, "")}${doc.location.search}${doc.location.hash}`,
      title: (navPage?.title || (heading ? visibleText(heading) : doc.title)).slice(0, 120),
      location,
      ...(navPage ? { navId: navPage.id, navIndex: nav!.index } : {}),
      ...(sco ? { scoId: sco.id, scoTitle: sco.title } : {}),
    };
  }, [courseProgress, nav, sco]);

  const qaActionRef = useRef<(action: string, request: Record<string, any>) => Promise<object>>(async () => ({ error: "The player is still loading." }));
  const browserContext = useRef(() => ({ doc: frameDoc(), page: currentPage(), busy: navBusy || reloadPending.current, reload: async () => { await persistence?.flush(); reloadCourse(); }, qa: (action: string, request: Record<string, any>) => qaActionRef.current(action, request) }));
  browserContext.current = () => ({ doc: frameDoc(), page: currentPage(), busy: navBusy || reloadPending.current, reload: async () => { await persistence?.flush(); reloadCourse(); }, qa: (action: string, request: Record<string, any>) => qaActionRef.current(action, request) });
  useEffect(() => {
    if (course) return connectReviewBrowser(course.revision, () => browserContext.current());
  }, [course?.revision]);

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
      const media = activeMedia(frame);
      setMediaAvailable(Boolean(media));
      const playing = Boolean(media && !media.paused);
      setMediaPlaying((previous) => (previous === playing ? previous : playing));
    }, 250);
    return () => window.clearInterval(timer);
  }, []);

  const openComposer = useCallback((element: Element, target: PinTarget, elements?: Element[]) => {
    const next = { element, target, elements };
    selectionRef.current = next;
    setSelection(next);
    setSelectionRect(target.rect);
    setHover(null);
    setActivePin(null);
  }, []);

  const closeComposer = useCallback(() => {
    selectionRef.current = null;
    setGroupRects([]);
    setSelection(null);
    setSelectionRect(null);
    setDraft("");
    setReattaching(null);
  }, []);

  // Picking happens inside the course frame (same origin), so the course itself is untouched.
  // One gesture does everything: click pins the highlighted element, dragging draws a box around
  // an area, and dragging that starts on text selects a phrase (⌥/Alt-drag always draws a box).
  useEffect(() => {
    const doc = frameDoc();
    if (!doc || !pinMode) { setHover(null); return; }
    let frame = 0;
    let suppressClick = false;
    // Where a box drag started; `drawing` once it has moved far enough to be a drag, not a click.
    let start: { x: number; y: number } | null = null;
    let drawing = false;
    const active = () => !passthrough;
    const bandFrom = (event: MouseEvent): Rect => ({
      x: Math.min(start!.x, event.clientX),
      y: Math.min(start!.y, event.clientY),
      width: Math.abs(event.clientX - start!.x),
      height: Math.abs(event.clientY - start!.y),
    });

    const onMouseDown = (event: MouseEvent) => {
      if (!active()) return;
      event.stopPropagation();
      if (event.button !== 0) return;
      // On text, let the browser select it (a phrase pin); anywhere else, a drag draws a box.
      if (!event.altKey && startsOnText(doc, event.clientX, event.clientY)) return;
      event.preventDefault();
      start = { x: event.clientX, y: event.clientY };
      drawing = false;
    };

    const onMove = (event: MouseEvent) => {
      if (!active()) return;
      if (start) {
        if (!drawing && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5) return;
        drawing = true;
        setHover(null);
        setBand(bandFrom(event));
        return;
      }
      if (event.buttons & 1) return setHover(null);
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
      const box = start && drawing ? bandFrom(event) : null;
      start = null;
      drawing = false;
      if (box) {
        const region = describeRegion(doc, box);
        setBand(null);
        suppressClick = true;
        if (region) openComposer(region.element, region.target);
        event.stopPropagation();
        return;
      }
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
      if (!element) return;
      // Shift (or ⌘/Ctrl) adds the element to the current selection: one note for several things.
      const current = selectionRef.current;
      if ((event.shiftKey || event.metaKey || event.ctrlKey) && current && (current.target.kind === "element" || current.target.kind === "group")) {
        const existing = current.elements ?? [current.element];
        const elements = existing.includes(element) ? existing.filter((item) => item !== element) : [...existing, element];
        if (elements.length === 0) return;
        if (elements.length === 1) openComposer(elements[0], describeElement(elements[0]));
        else openComposer(elements[0], describeGroup(elements), elements);
        return;
      }
      const target = describeElement(element);
      if (event.target !== element && (event.target as Node)?.nodeType === 1) target.clicked = describeElement(event.target as Element);
      openComposer(element, target);
    };

    const options = { capture: true } as const;
    doc.addEventListener("mousemove", onMove, options);
    doc.addEventListener("mouseleave", onLeave, options);
    for (const type of ["pointerdown", "pointerup", "touchstart", "dblclick", "submit"]) doc.addEventListener(type, block, options);
    doc.addEventListener("mousedown", onMouseDown, options);
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
      for (const type of ["pointerdown", "pointerup", "touchstart", "dblclick", "submit"]) doc.removeEventListener(type, block, options);
      doc.removeEventListener("mousedown", onMouseDown, options);
      setBand(null);
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
        else if (selection || reattaching) closeComposer();
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
        if (reattaching) closeComposer();
        setPinMode((value) => !value);
      } else if (event.key === "[" || event.key === "]") {
        event.preventDefault();
        void stepPage(event.key === "]" ? 1 : -1);
      } else if (event.key === ".") {
        event.preventDefault();
        skipAhead();
      } else if (event.key.toLowerCase() === "i") {
        event.preventDefault();
        setInspectorOpen((open) => { if (!open) { setPanelOpen(false); setChecksOpen(false); } return !open; });
      }
    };
    const onKeyUp = (event: KeyboardEvent) => { if (event.code === "Space") setPassthrough(false); };
    docs.forEach((doc) => { doc.addEventListener("keydown", onKeyDown, true); doc.addEventListener("keyup", onKeyUp, true); });
    return () => docs.forEach((doc) => { doc.removeEventListener("keydown", onKeyDown, true); doc.removeEventListener("keyup", onKeyUp, true); });
  }, [pinMode, selection, reattaching, menuOpen, panelOpen, pagesOpen, frameLoads, closeComposer, nav, navBusy]);

  const targetCache = useRef<{ doc: Document; elements: Map<PinTarget, TargetResolution>; observer: MutationObserver } | null>(null);
  useEffect(() => {
    targetCache.current?.observer.disconnect();
    targetCache.current = null;
    return () => { targetCache.current?.observer.disconnect(); targetCache.current = null; };
  }, [frameLoads]);
  const cachedResolution = (doc: Document, target: PinTarget) => {
    if (targetCache.current?.doc !== doc) {
      targetCache.current?.observer.disconnect();
      const elements = new Map<PinTarget, TargetResolution>();
      const observer = new MutationObserver(() => elements.clear());
      observer.observe(doc, { subtree: true, childList: true, attributes: true, characterData: true });
      targetCache.current = { doc, elements, observer };
    }
    const cache = targetCache.current.elements;
    const existing = cache.get(target);
    if (existing && (!existing.element || existing.element.isConnected)) return existing;
    const found = resolveTarget(doc, target);
    cache.set(target, found);
    return found;
  };

  // Keep pin markers and the selection box on their elements as the course scrolls and changes.
  useEffect(() => {
    const tick = () => {
      // Closing the editor clears this ref immediately. A queued tick from the
      // previous effect must not restore that selection's rectangle afterward.
      const selected = selectionRef.current;
      if (document.hidden || (!pins.length && !selected)) return;
      const doc = frameDoc();
      if (!doc || reloadPending.current || navBusy) { setMarkers([]); setAttachments({}); return; }
      const page = currentPage();
      const next: Marker[] = [];
      const states: Record<string, string> = {};
      for (const pin of pins) {
        if (!pin.target) { states[pin.id] = "Target missing"; continue; }
        states[pin.id] = "Other page";
        if (pin.page?.url && pin.page.url !== page.url) continue;
        if (["navId", "scoId", "location"].some((key) => {
          const saved = pin.page?.[key as keyof PinPage];
          return saved !== undefined && saved !== page[key as keyof PinPage];
        })) continue;
        const parts = pin.target.kind === "group" ? pin.target.targets ?? [] : [pin.target];
        const results = parts.map((target) => cachedResolution(doc, target));
        const result = results[0];
        const label = !results.length || results.some((r) => r.status === "missing" || r.status === "identity-changed") ? "Target missing"
          : results.some((r) => r.status === "ambiguous") ? "Multiple matches"
          : results.every((r) => r.status === "attached") ? "Attached" : "Possible match";
        states[pin.id] = label;
        if (!result?.element || results.some((r) => !r.element)) continue;
        const raw = locateTarget(doc, pin.target, result.element);
        const rect = raw && visibleTargetRect(doc, result.element, raw);
        if (!rect) { states[pin.id] = `${label} · out of view`; continue; }
        if (pin.status === "open" || pin.status === "suggested") next.push({ id: pin.id, number: pin.number, rect, status: label, suggestion: pin.status === "suggested", ai: pin.origin?.kind === "agent" });
      }
      setAttachments((previous) => JSON.stringify(previous) === JSON.stringify(states) ? previous : states);
      setMarkers((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
      if (selected?.elements && selected.elements.length > 1) {
        const rects = selected.elements.filter((element) => element.isConnected).map((element) => {
          const box = element.getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height };
        });
        setGroupRects((previous) => (JSON.stringify(previous) === JSON.stringify(rects) ? previous : rects));
      }
      if (selected) {
        const box = selected.target.kind === "text" || selected.target.kind === "region" ? locateTarget(doc, selected.target) : selected.element.isConnected ? selected.element.getBoundingClientRect() : null;
        const rect = box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
        setSelectionRect((previous) => (JSON.stringify(previous) === JSON.stringify(rect) ? previous : rect));
      }
    };
    tick();
    let frame = 0;
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(() => { frame = 0; tick(); });
    };
    const doc = frameDoc();
    // Scroll events on an inner panel do not bubble. Capture them from the whole lesson.
    doc?.addEventListener("scroll", schedule, true);
    doc?.defaultView?.addEventListener("resize", schedule);
    const timer = window.setInterval(tick, 200);
    return () => {
      window.clearInterval(timer);
      window.cancelAnimationFrame(frame);
      doc?.removeEventListener("scroll", schedule, true);
      doc?.defaultView?.removeEventListener("resize", schedule);
    };
  }, [pins, selection, frameLoads, currentPage, navBusy]);

  async function savePin() {
    if (!selection || !draft.trim() || saving) return;
    setSaving(true);
    try {
      const replacing = reattaching;
      const pin = replacing
        ? await api.reattachPin(replacing.id, { target: selection.target, page: currentPage(), expectedUpdatedAt: replacing.updatedAt })
        : await api.createPin({ note: draft.trim(), page: currentPage(), target: selection.target });
      setPins((previous) => replacing ? previous.map((item) => item.id === pin.id ? pin : item) : [...previous, pin]);
      const element = selection.element;
      closeComposer();
      say(`Pin ${pin.number} ${replacing ? "reattached" : "saved"}${pin.source?.length ? ` · ${pin.source[0].provenance === "content-binding" ? "mapped to" : "possible match in"} ${pin.source[0].file}` : ""}`);
      if (replacing) return; // Keep the original screenshot as capture-time evidence.
      const shot = selection.target.kind === "region" && selection.target.offset
        ? captureRegion(element, selection.target.offset, selection.target.rect)
        : captureElement(element);
      void shot.then((png) => (png ? api.saveFrame(pin.id, png).then(refreshPins) : undefined)).catch(() => {});
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

  // The latest request wins, so quick presses of ] or [ are never dropped.
  const navRequest = useRef(0);
  async function goToPage(index: number) {
    const navigator = navigatorRef.current;
    if (!navigator) return false;
    const request = ++navRequest.current;
    setNavBusy(true);
    setPagesOpen(false);
    try {
      const reached = await navigator.goTo(index);
      if (!reached && request === navRequest.current) say("The course didn't move to that page");
      return reached;
    } finally {
      if (request === navRequest.current) setNavBusy(false);
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

  // After switching SCO for a pin, finish the jump once the new module has loaded.
  useEffect(() => {
    const pending = pendingPinRef.current;
    if (!pending) return;
    pendingPinRef.current = null;
    const timer = window.setTimeout(() => void goToPin(pending), 700);
    return () => window.clearTimeout(timer);
  }, [frameLoads]);

  // A SCORM 2004 course asked the LMS to go somewhere when it ended its session.
  navRequestRef.current = ({ request, index }) => {
    if (index !== null) {
      say(`The course asked for ${request}: opening module ${index + 1}`);
      switchSco(index);
    } else if (/^(exit|exitAll|suspendAll|abandon|abandonAll)$/.test(request)) {
      say(`The course asked the LMS to ${request}; an LMS would close it now`);
    } else {
      say(`The course asked for ${request}, but there is no module to go to`);
    }
  };

  function applyLaunchSettings(next: typeof launchSettings) {
    saveLaunchSettings(next);
    setSettingsOpen(false);
    setLaunchSettings(next);
    reloadCourse();
    say(next.strict ? "Restarted in strict mode" : "Restarted with the new launch settings");
  }

  function switchSco(index: number) {
    if (!course?.scos || index === scoIndex || index < 0 || index >= course.scos.length) return;
    checkpointReview(frameRef.current, false, true);
    setScosOpen(false);
    setNav(null);
    setScoIndex(index);
  }

  async function goToPin(pin: Pin) {
    if (course?.scos && pin.page?.scoId && pin.page.scoId !== sco?.id) {
      const index = course.scos.findIndex((item) => item.id === pin.page?.scoId);
      if (index >= 0) {
        pendingPinRef.current = pin;
        switchSco(index);
        return;
      }
    }
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

  async function resetProgress() {
    if (resetting || !course || !persistence) return;
    if (!confirmReset) { setConfirmReset(true); return; }
    setResetting(true);
    try {
      await persistence.reset(course.scos?.[0]?.id ?? "");
      scorm?.reset();
      try {
        for (const id of course.scos?.map((sco) => sco.id) ?? [""]) localStorage.removeItem(`scormplayer:${course.courseKey}${id ? `:${id}` : ""}`);
        localStorage.removeItem(`scormplayer:sco:${course.courseKey}`);
      } catch { /* storage blocked */ }
      checkpointReview(frameRef.current, true);
      clearCourseReview(course.courseKey);
      setScoIndex(0);
      setConfirmReset(false);
      setMenuOpen(false);
      setFrameKey((key) => key + 1);
      say("Progress cleared for every module; the course restarted");
    } catch (error) { say(error instanceof Error ? error.message : "Could not reset progress."); }
    finally { setResetting(false); }
  }

  function reloadCourse() {
    reloadPending.current = true;
    checkpointReview(frameRef.current, false, true);
    setFrameKey((key) => key + 1);
  }

  async function reviewSkip(kind: "page" | "guide") {
    if (reviewBusy) return;
    setReviewBusy(true);
    setMenuOpen(false);
    if (await skipForReview(frameRef.current, kind)) {
      navigatorRef.current?.refresh();
      say(kind === "page" ? "Moved to the next page for review" : "Moved to the next guide step for review");
    } else {
      say(kind === "page" ? "This course doesn't support skipping pages for review" : "This course doesn't support skipping guide steps for review");
    }
    setReviewBusy(false);
  }

  const openPins = pins.filter((pin) => pin.status === "open");
  // Suggestions wait in their own tab until accepted.
  const reviewPins = pins.filter((pin) => pin.status === "open" || pin.status === "resolved");
  const listedPins = showResolved ? reviewPins : openPins;
  const suggestedPins = pins.filter((pin) => pin.status === "suggested");
  const progress = courseProgress;
  const progressLabel = describeProgress(progress);
  const kindLabel = course ? describeKind(course, lastChangeAt, now) : "";

  const composerStyle = useMemo(() => composerPosition(selectionRect, deviceRef.current), [selectionRect, viewport, stageSize]);
  const deviceStyle = deviceLayout(viewport, stageSize);

  // Dropping a zip anywhere on the player (including over the course) opens it instead.
  useEffect(() => {
    if (empty) return;
    const isFileDrag = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const onDragOver = (event: DragEvent) => { if (isFileDrag(event)) { event.preventDefault(); setDragOver(true); } };
    const targets: (Window | Document)[] = [window];
    const doc = frameDoc();
    if (doc) targets.push(doc);
    targets.forEach((target) => { target.addEventListener("dragenter", onDragOver as EventListener); target.addEventListener("dragover", onDragOver as EventListener); });
    return () => targets.forEach((target) => { target.removeEventListener("dragenter", onDragOver as EventListener); target.removeEventListener("dragover", onDragOver as EventListener); });
  }, [empty, frameLoads]);

  useEffect(() => { if (zip.error) say(zip.error); }, [zip.error, say]);

  // WebMCP: the same actions as the buttons, for an AI agent in the browser. Read through a ref
  // so the registered tools always see the current state.
  async function freshPins() {
    const current = await api.pins();
    setPins(current);
    return current;
  }
  async function findPin(number: number) {
    const pin = (await freshPins()).find((item) => item.number === number);
    if (!pin) throw new Error(`No pin ${number} in this course.`);
    return pin;
  }
  function namedIndex(items: { title: string }[], value: number | string, kind: string) {
    const matches = typeof value === "number" ? [value - 1] : items.map((item, index) => item.title.toLowerCase().includes(value.toLowerCase()) ? index : -1).filter((index) => index >= 0);
    if (matches.length !== 1 || !items[matches[0]]) throw new Error(`Choose a unique ${kind} number or title. Available: ${items.map((item, index) => `${index + 1}. ${item.title}`).join("; ")}`);
    return matches[0];
  }
  const actionsRef = useRef<PlayerActions | null>(null);
  actionsRef.current = {
    activity: async () => {
      const player = await api.player();
      if (course && player.revision !== course.revision) throw new Error("The course changed. Reload the player and rediscover tools before continuing.");
      stillHere();
    },
    courses: () => api.courses(),
    switchCourse: async (path) => {
      const result = await api.switchCourse(path);
      window.setTimeout(() => window.location.reload(), 300);
      return `Opened ${result.title} on the server; the browser is reloading. Rediscover tools and check status.`;
    },
    packages: () => ({ current: course?.package, packages: course?.packages ?? [] }),
    openPackage: async (name) => {
      if (!course?.packages?.some((item) => item.name === name)) throw new Error("Choose an exact name returned by list_packages.");
      const result = await api.openPackage(name);
      window.setTimeout(() => window.location.reload(), 300);
      return `Opened ${result.title} on the server; the browser is reloading. Rediscover tools and check status.`;
    },
    reload: () => { reloadCourse(); return "Course reload requested. Check status and the rendered page after loading."; },
    editPin: async (number, note) => { const pin = await findPin(number); const updated = await api.updatePin(pin.id, { note: note.trim() }); await freshPins(); return updated; },
    reopenPin: async (number) => { const pin = await findPin(number); const updated = await api.updatePin(pin.id, { status: "open" }); await freshPins(); return updated; },
    openPin: async (number) => { const pin = await findPin(number); await goToPin(pin); return `Navigation to pin ${number} requested. Check the page and target to confirm arrival.`; },
    status: async () => ({
      course: course ? { title: course.title, scormVersion: course.scormVersion, standard: course.standard ?? "scorm", kind: course.kind, source: course.source, editable: course.editable, revision: course.revision, pinsFile: course.pinsFile, ...(course.unzip ? { unzipTo: course.unzip.existing ?? course.unzip.folder } : {}) } : null,
      module: sco ? { number: scoIndex + 1, of: course?.scos?.length, title: sco.title } : null,
      page: nav ? { number: nav.index + 1, of: nav.pages.length, title: nav.pages[nav.index]?.title, pages: nav.pages.map((item) => item.title) } : null,
      tour,
      narrationPlaying: mediaPlaying,
      scorm: courseProgress,
      screen: viewport,
      viewport: { width: frameRef.current?.clientWidth, height: frameRef.current?.clientHeight },
      readiness: { frameLoaded: Boolean(frameDoc()?.body), navigationAvailable: Boolean(nav), navigationBusy: navBusy },
      live: { enabled: course?.kind === "live", ...(await api.status()) },
      openPins: (await freshPins()).filter((pin) => pin.status === "open").length,
    }),
    goToPage: async (page) => {
      if (!nav) throw new Error("This course doesn't offer a page list.");
      const index = namedIndex(nav.pages, page, "page");
      if (index < 0 || index >= nav.pages.length) throw new Error(`No page ${page}. Pages: ${nav.pages.map((item, i) => `${i + 1}. ${item.title}`).join("; ")}`);
      const reached = await goToPage(index);
      if (!reached) throw new Error("The course did not move to that page. Check the rendered page before continuing.");
      return `Showing page ${index + 1}: ${nav.pages[index].title}`;
    },
    switchModule: (module) => {
      if (!course?.scos) throw new Error("This course has a single module.");
      const index = namedIndex(course.scos, module, "module");
      if (index < 0 || index >= course.scos.length) throw new Error(`No module ${module}.`);
      switchSco(index);
      return `Opening module ${index + 1}: ${course.scos[index].title}`;
    },
    skip: () => {
      const frame = frameRef.current;
      return frame && skipMedia(frame) ? "Skipped to the end of the narration." : "Nothing is playing.";
    },
    tourStep: (direction) => {
      const frame = frameRef.current;
      const current = frame ? tourState(frame) : null;
      if (!current) return "No guided tour is open.";
      tourStep(direction === "back" ? "prev" : "next");
      return direction === "back" ? "Moved back." : current.canNext ? "Moved to the next step." : "Skipped the narration; the tour can now continue.";
    },
    listPins: async (status) => (await freshPins()).filter((pin) => status === "all" || pin.status === status),
    addPin: async ({ note, selector, text, selectors, region, suggestion }) => {
      const doc = frameDoc();
      if (!doc) throw new Error("No course is showing.");
      if ([selector, text, selectors, region].filter((value) => value !== undefined).length !== 1) throw new Error("Provide exactly one selector, text, selectors group, or region.");
      const visible = (candidate: Element) => {
        const rect = candidate.getBoundingClientRect();
        const style = doc.defaultView!.getComputedStyle(candidate);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const select = (query: string) => {
        let matches: Element[];
        try { matches = Array.from(doc.querySelectorAll(query)).filter(visible); } catch { throw new Error(`Not a valid CSS selector: ${query}`); }
        if (matches.length !== 1) throw new Error(`Selector must identify one visible element: ${query} (${matches.length} matches).`);
        return chooseTarget(matches[0]) ?? matches[0];
      };
      let element: Element;
      let target: PinTarget;
      if (region) {
        if (region.x < 0 || region.y < 0 || region.width < 8 || region.height < 8 || region.x + region.width > doc.defaultView!.innerWidth || region.y + region.height > doc.defaultView!.innerHeight) throw new Error("Region must fit inside the course viewport and be at least 8×8 pixels.");
        const area = describeRegion(doc, region);
        if (!area) throw new Error("Could not describe that region.");
        ({ element, target } = area);
      } else if (selectors) {
        const elements = Array.from(new Set(selectors.map(select)));
        if (elements.length < 2) throw new Error("A group needs at least two distinct visible elements.");
        element = elements[0];
        target = describeGroup(elements);
      } else {
        if (selector) element = select(selector);
        else {
          const wanted = text!.replace(/\s+/g, " ").trim().toLowerCase();
          const matches = Array.from(doc.body.querySelectorAll("*")).filter((candidate) => visible(candidate) && visibleText(candidate).toLowerCase().includes(wanted));
          const smallest = matches.filter((candidate) => !matches.some((other) => other !== candidate && candidate.contains(other)));
          if (smallest.length !== 1) throw new Error(`Text must identify one visible element (${smallest.length} matches). Use a precise selector.`);
          element = chooseTarget(smallest[0]) ?? smallest[0];
        }
        target = describeElement(element);
      }
      const created = await api.createPin({ note: note.trim(), page: currentPage(), target, ...(suggestion ? { qa: suggestion } : {}) });
      let pin: Pin = created;
      let screenshot = "unavailable";
      // A repeated suggestion joins the pin it repeats, which already has its screenshot.
      if (!created.outcome || created.outcome === "created") {
        try {
          const png = region && target.offset ? await captureRegion(element, target.offset, target.rect) : await captureElement(element);
          if (png) { pin = await api.saveFrame(pin.id, png); screenshot = "saved"; }
        } catch { /* The durable note survives optional screenshot capture failure. */ }
      } else screenshot = "existing";
      await freshPins();
      return { ...pin, screenshot, ...(created.outcome ? { outcome: created.outcome, stop: created.stop === true } : {}) };
    },
    resolvePin: async (number, note) => {
      const pin = await findPin(number);
      await api.updatePin(pin.id, { status: "resolved", ...(note ? { resolution: note } : {}) });
      await freshPins();
      return `Pin ${number} resolved.`;
    },
    handOff: () => api.brief("open"),
    unzip: async (folder) => {
      if (course?.kind !== "package") throw new Error("This course is already a folder; there's nothing to unzip.");
      const result = await api.unzip(folder ?? course.unzip?.existing ?? course.unzip?.folder ?? "");
      window.setTimeout(() => window.location.reload(), 300);
      return `${result.reused ? "Reopened the folder it was unzipped to before" : "Unzipped"}: ${result.folder}. Pins are in ${result.pinsFile}. The player is reopening it now.`;
    },
    setScreen: (size) => { setViewport(size); return `Showing the course at ${size} size.`; },
    scormData: (includeCalls) => ({ data: scormData, ...(includeCalls ? { calls: calls.slice(-100) } : {}) }),
  };
  useEffect(() => registerWebMcpTools(() => actionsRef.current!), []);

  // An agent's QA pass drives this tab through the browser bridge. Waits read the latest state from
  // this ref, since the course reloads and moves between pages while a request is in flight.
  const qaLive = useRef({ nav, scoIndex, course, busy: false, tour, mediaPlaying, frameLoads, issues, courseProgress, currentPage });
  qaLive.current = { nav, scoIndex, course, busy: navBusy || reloadPending.current, tour, mediaPlaying, frameLoads, issues, courseProgress, currentPage };

  /** Load progress again from the server (the QA attempt, or back to the reviewer's) and restart the course. */
  async function reloadProgress() {
    const state = await api.scormState();
    if (course?.scos) setScoIndex(Math.max(0, course.scos.findIndex((item) => item.id === state.selectedSco)));
    setNav(null);
    setPersistence(new ScormPersistence(state, api.saveScormState, setProgressError));
    reloadCourse();
  }

  const qaSettled = () => waitFor(() => {
    const doc = frameDoc();
    return Boolean(doc?.body) && doc!.readyState === "complete" && doc!.URL !== "about:blank" && !qaLive.current.busy;
  }, 20_000);
  /** After the frame reloads: wait for it, then give the course a moment to announce its pages. */
  async function qaAfterLoad(loads: number) {
    await waitFor(() => qaLive.current.frameLoads > loads, 20_000);
    await qaSettled();
    await waitFor(() => qaLive.current.nav !== null, 2500);
  }
  const qaPosition = () => {
    const live = qaLive.current;
    const module = live.course?.scos?.[live.scoIndex];
    return {
      module: module ? { index: live.scoIndex, of: live.course!.scos!.length, title: module.title } : null,
      page: { ...(live.nav ? { index: live.nav.index, of: live.nav.pages.length } : {}), title: live.currentPage().title },
    };
  };
  const qaOutline = () => ({
    position: qaPosition(),
    pages: qaLive.current.nav?.pages.map((item) => item.title) ?? null,
    modules: qaLive.current.course?.scos?.map((item) => item.title) ?? null,
  });

  qaActionRef.current = async (action, request) => {
    if (action === "qa-freeze") {
      await persistence?.flush();
      persistence?.freeze();
      return { ok: true };
    }
    if (action === "qa-restart" || action === "qa-end") {
      const loads = qaLive.current.frameLoads;
      setQaRunId(action === "qa-restart" ? String(request.runId) : null);
      await reloadProgress();
      if (action === "qa-end") return { ok: true };
      await qaAfterLoad(loads);
      return qaOutline();
    }
    await qaSettled();
    if (action === "qa-position") return qaPosition();
    if (action === "qa-snapshot") {
      const doc = frameDoc();
      if (!doc?.body) throw new Error("The course page isn't showing yet. Try again in a moment.");
      const live = qaLive.current;
      const result: Record<string, unknown> = {
        ...qaOutline(),
        gates: {
          narrationPlaying: live.mediaPlaying,
          tour: live.tour ? { title: live.tour.title, progress: live.tour.progress, canNext: live.tour.canNext } : null,
          pageList: Boolean(live.nav),
        },
        progress: live.courseProgress,
        page: pageSnapshot(doc),
      };
      if (request.checks) {
        try {
          const scan = await scanAccessibility(frameRef.current);
          result.accessibility = scan.violations.map((violation) => ({ id: violation.id, impact: violation.impact, help: violation.help, elements: violation.nodes.length, selectors: violation.nodes.slice(0, 3).map((node) => node.selector) }));
        } catch (error) { result.accessibility = { error: error instanceof Error ? error.message : String(error) }; }
        result.scormIssues = live.issues.slice(-30).map((issue) => ({ severity: issue.severity, code: issue.code, method: issue.method, element: issue.element, message: issue.message, count: issue.count }));
      }
      if (request.screenshot) result.screenshot = await captureViewport(doc);
      return result;
    }
    if (action === "qa-navigate") {
      const live = qaLive.current;
      const scos = live.course?.scos;
      const toModule = async (index: number) => {
        const loads = qaLive.current.frameLoads;
        switchSco(index);
        await qaAfterLoad(loads);
      };
      if (request.module !== null && request.module !== undefined) {
        if (!scos) throw new Error("This course has a single module.");
        const index = namedIndex(scos, request.module, "module");
        if (index !== live.scoIndex) await toModule(index);
      }
      if (request.page !== null && request.page !== undefined) {
        const current = qaLive.current.nav;
        if (!current) return { reached: false, reason: "This course doesn't offer a page list; move with next (modules) or review what is on screen.", ...qaOutline() };
        const index = namedIndex(current.pages, request.page, "page");
        if (index !== current.index && !(await goToPage(index))) return { reached: false, reason: "The course did not move to that page; it may be locked until an activity is done.", ...qaOutline() };
      }
      if (request.next) {
        const current = qaLive.current.nav;
        if (current && current.index < current.pages.length - 1) {
          if (!(await goToPage(current.index + 1))) return { reached: false, reason: "The course did not move to the next page; it may be locked until an activity, narration or tour step is done.", ...qaOutline() };
        } else if (scos && qaLive.current.scoIndex < scos.length - 1) await toModule(qaLive.current.scoIndex + 1);
        else return { reached: false, done: true, reason: "This is the last page of the last module.", ...qaOutline() };
      }
      await qaSettled();
      return { reached: true, ...qaOutline() };
    }
    if (action === "qa-pin") {
      const input = Object.fromEntries(Object.entries(request.input ?? {}).filter(([, value]) => value !== undefined && value !== null));
      return await actionsRef.current!.addPin({ ...(input as { note: string }), suggestion: request.qa }) as object;
    }
    throw new Error(`Unknown QA action ${action}.`);
  };

  if (presence.state === "closed") return <ClosedScreen course={course} why={presence.why} />;

  if (empty) return <DropHome />;

  if (loadError) return <div className="sp-fatal"><strong>scormplayer could not load the course.</strong><p>{loadError}</p></div>;

  return (
    <div className={`sp-app ${panelOpen || inspectorOpen || checksOpen ? "has-panel" : ""}`}>
      <div className="sp-main">
        {qaStatus?.active ? (
          <QaBanner qa={qaStatus} where={[sco?.title, nav ? `page ${nav.index + 1}/${nav.pages.length}` : null].filter(Boolean).join(" · ")}
            onReview={() => { setPanelOpen(true); setPanelTab("suggestions"); setInspectorOpen(false); setChecksOpen(false); }}
            onStop={() => void api.stopQa(qaStatus.active!.id).then(() => api.qa().then(setQaStatus), (error) => say(error.message))}
            onEnd={() => void api.finishQa(qaStatus.active!.id, "Ended by the reviewer before the agent finished.").then(() => api.qa().then(setQaStatus), (error) => say(error.message))} />
        ) : qaDone !== null ? (
          <div className="sp-qa-banner is-done" role="status">
            <span><strong>QA pass finished</strong> · {qaDone} suggestion{qaDone === 1 ? "" : "s"} to review</span>
            <button type="button" onClick={() => { setQaDone(null); setPanelOpen(true); setPanelTab("suggestions"); setInspectorOpen(false); setChecksOpen(false); }}>Review</button>
            <button type="button" onClick={() => setQaDone(null)} aria-label="Dismiss">×</button>
          </div>
        ) : null}
        {progressError && <div className="sp-save-error" role="alert"><span>Progress could not be saved: {progressError}</span><button type="button" onClick={() => void persistence?.flush()}>Retry</button></div>}
        <div className={`sp-stage ${pinMode && !passthrough ? "is-picking" : ""}`} ref={stageRef}>
          <div className={`sp-device sp-device--${viewport}`} ref={deviceRef} style={deviceStyle}>
          {course && scorm ? (
            <iframe
              key={`${frameKey}-${scoIndex}`}
              ref={frameRef}
              className="sp-frame"
              title={course.title}
              src={frameUrl}
              data-review-scope={viewScope || undefined}
              allow="autoplay; fullscreen; microphone; camera; clipboard-write"
              onLoad={() => { reloadPending.current = false; setFrameLoads((count) => count + 1); }}
            />
          ) : <div className="sp-loading">Opening course…</div>}

          <div className="sp-overlay" aria-hidden={!markers.length}>
            {hover && !selection ? <div className="sp-box sp-box--hover" style={boxStyle(hover)} /> : null}
            {selection && selectionRect ? <div className={`sp-box sp-box--selected ${selection.target.kind === "region" ? "is-region" : ""}`} style={boxStyle(selectionRect)} /> : null}
            {groupRects.slice(1).map((rect, index) => <div key={index} className="sp-box sp-box--also" style={boxStyle(rect)} />)}
            {band ? <div className="sp-box sp-box--band" style={boxStyle(band)} /> : null}
            {markers.map((marker) => (
              <button
                key={marker.id}
                type="button"
                className={`sp-marker ${marker.status === "Possible match" ? "is-approximate" : ""} ${marker.suggestion ? "is-suggestion" : ""} ${marker.ai ? "is-ai" : ""} ${activePin === marker.id ? "is-active" : ""}`}
                style={{ left: marker.rect.x + marker.rect.width - 11, top: marker.rect.y }}
                onClick={() => { setPanelOpen(true); setPanelTab(marker.suggestion ? "suggestions" : "pins"); setInspectorOpen(false); setChecksOpen(false); setActivePin(marker.id); }}
                title={`${marker.suggestion ? "QA suggestion · " : marker.ai ? "From a QA suggestion · " : ""}${marker.status}: ${pins.find((pin) => pin.id === marker.id)?.note ?? ""}`}
              >
                {marker.number}
              </button>
            ))}
            {activePin ? markers.filter((marker) => marker.id === activePin).map((marker) => <div key={marker.id} className="sp-box sp-box--flash" style={boxStyle(marker.rect)} />) : null}
          </div>

          {selection ? (
            <div className="sp-composer" style={composerStyle} role="dialog" aria-label={reattaching ? `Reattach pin ${reattaching.number}` : "New pin"} onKeyDown={(event) => {
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
                readOnly={Boolean(reattaching)}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="What should change here?"
              />
              <div className="sp-composer__actions">
                <small>{navigator.platform.includes("Mac") ? "⌘" : "Ctrl"} + Enter to save</small>
                <button type="button" className="sp-button sp-button--primary" disabled={!draft.trim() || saving} onClick={() => void savePin()}>
                  {saving ? "Saving…" : reattaching ? "Confirm reattachment" : "Save pin"}
                </button>
              </div>
            </div>
          ) : null}
          </div>

          {pinMode && !selection ? (
            <div className="sp-hint" role="status">
              <span>
                {reattaching ? <>Select the new target for pin {reattaching.number} · <button type="button" onClick={closeComposer}>Cancel reattachment</button></> : passthrough
                  ? "Using the course · release Space to keep pinning"
                  : <>Click to pin · drag for an area · drag across text for a phrase · <kbd>Shift</kbd>-click to add more · hold <kbd>Space</kbd> to use the course</>}
              </span>
            </div>
          ) : null}

          {dragOver ? (
            <div
              className="sp-dropzone"
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => { if (event.currentTarget === event.target) setDragOver(false); }}
              onDrop={(event) => { event.preventDefault(); setDragOver(false); void zip.open(event.dataTransfer.files?.[0]); }}
            >
              <div><Icon name="file" size={28} /><strong>Drop to open this SCORM zip</strong><span>The current course closes; its pins stay saved.</span></div>
            </div>
          ) : null}
          {zip.upload ? <div className="sp-dropzone is-busy"><UploadStatus upload={zip.upload} /></div> : null}
          <ZipInput inputRef={zipInputRef} onFile={(file) => void zip.open(file)} />

          {course && unzipNotice.show && !pinMode ? <UnzipNotice course={course} onUnzip={() => setUnzipOpen(true)} onDismiss={unzipNotice.dismiss} /> : null}
          {course && unzipOpen ? <UnzipDialog course={course} onClose={() => setUnzipOpen(false)} /> : null}
          {course && settingsOpen ? (
            <LaunchSettingsDialog settings={launchSettings} runtime={sco?.runtime ?? course.runtime ?? {}} onSave={applyLaunchSettings} onClose={() => setSettingsOpen(false)} />
          ) : null}
          {switcherOpen ? <CourseSwitcher onClose={() => setSwitcherOpen(false)} /> : null}
          {presence.state === "asking" ? <StillThereCard closesAt={presence.closesAt} onStay={stillHere} /> : null}
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

          {course?.scos && sco ? (
            <div className="sp-nav sp-scos" aria-label="Modules">
              <button type="button" className="sp-nav__step" disabled={scoIndex === 0} onClick={() => switchSco(scoIndex - 1)} aria-label="Previous module" title="Previous module"><Icon name="chevronLeft" /></button>
              <div className="sp-menu-anchor">
                <button type="button" className="sp-nav__page" aria-expanded={scosOpen} onClick={() => { setScosOpen((value) => !value); setPagesOpen(false); setMenuOpen(false); }} title="Switch module (SCO)">
                  <span className="sp-scos__label">Module</span><b>{scoIndex + 1}</b><span className="sp-nav__of">/ {course.scos.length}</span>
                  <span className="sp-nav__title">{sco.title}</span>
                  <Icon name="chevronUp" size={14} />
                </button>
                {scosOpen ? (
                  <div className="sp-menu sp-pages" role="menu">
                    {course.scos.map((item, index) => (
                      <button key={item.id} type="button" role="menuitem" aria-current={index === scoIndex ? "page" : undefined} onClick={() => switchSco(index)}>
                        <span className="sp-pages__number">{index + 1}</span>
                        <span className="sp-pages__title">{item.title}</span>
                        {pins.some((pin) => pin.status === "open" && pin.page?.scoId === item.id) ? <span className="sp-pages__pin" title="Has open pins" /> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <button type="button" className="sp-nav__step" disabled={scoIndex >= course.scos.length - 1} onClick={() => switchSco(scoIndex + 1)} aria-label="Next module" title="Next module"><Icon name="chevronRight" /></button>
            </div>
          ) : null}

          {nav ? (
            <div className="sp-nav" aria-label="Pages" aria-busy={navBusy}>
              <button type="button" className="sp-nav__step" disabled={nav.index === 0} onClick={() => void stepPage(-1)} title="Previous page ( [ )" aria-label="Previous page">
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
              <button type="button" className="sp-nav__step" disabled={nav.index >= nav.pages.length - 1} onClick={() => void stepPage(1)} title="Next page ( ] )" aria-label="Next page">
                <Icon name="chevronRight" />
              </button>
            </div>
          ) : null}

          {tour ? (
            <div className="sp-tour" aria-label="Guided tour">
              <span className="sp-tour__label" title={tour.title}>Tour{tour.progress ? ` · ${tour.progress}` : ""}</span>
              <button type="button" className="sp-nav__step" disabled={!tour.canPrev} onClick={() => tourStep("prev")} title="Previous tour step" aria-label="Previous tour step"><Icon name="chevronLeft" /></button>
              <button type="button" className="sp-skip" disabled={!mediaAvailable && !tour.canNext} onClick={() => tourStep("next")} title={mediaAvailable && !tour.canNext ? "Skip the narration (.)" : "Next tour step (.)"}>
                {mediaAvailable && !tour.canNext ? <><Icon name="skip" size={16} /> Skip</> : <>Next <Icon name="chevronRight" size={16} /></>}
              </button>
            </div>
          ) : mediaAvailable ? (
            <button type="button" className="sp-skip" onClick={skipAhead} title="Skip to the end of the playing audio or video (.)"><Icon name="skip" size={16} /> Skip media</button>
          ) : null}

          <span className={`sp-progress sp-progress--${progressLabel.tone}`} title={progress.location ? `SCORM location: ${progress.location}` : undefined}>
            {progressLabel.text}
          </span>

          <div className="sp-views" role="group" aria-label="Screen size">
            {(["desktop", "tablet", "phone"] as const).map((size) => (
              <button key={size} type="button" aria-pressed={viewport === size} onClick={() => setViewport(size)} title={`${VIEWPORT_LABEL[size]}${size === "desktop" ? "" : ` (${VIEWPORTS[size].width}×${VIEWPORTS[size].height})`}`} aria-label={VIEWPORT_LABEL[size]}>
                <Icon name={size} size={17} />
              </button>
            ))}
          </div>

          <nav className="sp-bar__actions" aria-label="Player">
            <button type="button" className="sp-tab" aria-pressed={pinMode} onClick={() => { if (reattaching) closeComposer(); setPinMode((value) => !value); setMenuOpen(false); }} title="Pin mode (P)">
              <Icon name="pin" /><span>{pinMode ? "Pinning" : "Pin"}</span>
            </button>
            <button type="button" className="sp-tab" aria-pressed={panelOpen} onClick={() => { setPanelOpen((value) => !value); setInspectorOpen(false); setChecksOpen(false); setMenuOpen(false); }} title="Saved pins">
              <Icon name="list" /><span>Pins</span>{openPins.length ? <em>{openPins.length}</em> : null}{suggestedPins.length ? <em className="is-suggested" title={`${suggestedPins.length} QA suggestions to review`}>{suggestedPins.length}</em> : null}
            </button>
            <button type="button" className="sp-tab" onClick={() => void copyPins()} disabled={!openPins.length} title="Copy all open pins as a hand-off for an agent">
              <Icon name="copy" /><span>Copy</span>
            </button>
            <div className="sp-menu-anchor">
              <button type="button" className="sp-tab" aria-expanded={menuOpen} onClick={() => { setMenuOpen((value) => !value); setConfirmReset(false); }} title="More">
                <Icon name="more" /><span>More</span>{update ? <em title={`scormplayer ${update.latest} is available`}>Update</em> : null}
              </button>
              {menuOpen ? (
                <div className="sp-menu" role="menu">
                  {update ? (
                    <button type="button" role="menuitem" className="sp-menu__update" title={`Copies: ${update.command}`}
                      onClick={() => { void copyText(update.command).then(() => say(`Copied. Run ${update.command} in your terminal`), () => say(`Run ${update.command} in your terminal`)); setMenuOpen(false); }}>
                      <Icon name="arrowUp" size={16} /> scormplayer {update.latest} is available
                    </button>
                  ) : null}
                  <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setPanelOpen(false); setChecksOpen(false); setInspectorOpen(true); }}>
                    <Icon name="code" size={16} /> {xapiCourse ? (course?.standard === "cmi5" ? "cmi5" : "xAPI") : "SCORM"} inspector <kbd>I</kbd>
                  </button>
                  <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setPanelOpen(false); setInspectorOpen(false); setChecksOpen(true); }}>
                    <Icon name="check" size={16} /> Checks: package and accessibility…
                  </button>
                  <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setPanelOpen(true); setPanelTab("suggestions"); setInspectorOpen(false); setChecksOpen(false); }}>
                    <Icon name="list" size={16} /> QA suggestions{suggestedPins.length ? <em className="sp-menu__tag">{suggestedPins.length}</em> : null}
                  </button>
                  <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setSettingsOpen(true); }}>
                    <Icon name="edit" size={16} /> Launch settings…{launchSettings.strict ? <em className="sp-menu__tag">Strict</em> : null}
                  </button>
                  {course?.packages ? (
                    <>
                      <p className="sp-menu__meta">{course.packages.length} courses in this {course.kind === "package" ? "zip" : "folder"}</p>
                      {course.packages.map((item) => (
                        <button key={item.name} type="button" role="menuitem" aria-current={item.name === course.package ? "true" : undefined}
                          className={item.name === course.package ? "is-current" : ""} title={item.name}
                          onClick={() => { setMenuOpen(false); if (item.name !== course.package) void api.openPackage(item.name).then(() => window.location.reload(), (error) => say(error.message)); }}>
                          <Icon name={item.name === course.package ? "check" : "file"} size={16} /> {item.title}
                        </button>
                      ))}
                      <hr className="sp-menu__rule" />
                    </>
                  ) : null}
                  {course?.kind === "package" ? (
                    <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setUnzipOpen(true); }}>
                      <Icon name="folder" size={16} /> Unzip to edit…
                    </button>
                  ) : null}
                  <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setSwitcherOpen(true); }}>
                    <Icon name="list" size={16} /> Switch course…
                  </button>
                  <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); zipInputRef.current?.click(); }}>
                    <Icon name="file" size={16} /> Open another course…
                  </button>
                  <button type="button" role="menuitem" onClick={() => { reloadCourse(); setMenuOpen(false); }}>
                    <Icon name="reload" size={16} /> Reload course
                  </button>
                  {course?.kind === "live" ? <>
                    <button type="button" role="menuitem" disabled={reviewBusy} onClick={() => void reviewSkip("guide")}>
                      <Icon name="chevronRight" size={16} /> Skip to next guide step for review
                    </button>
                    <button type="button" role="menuitem" disabled={reviewBusy} onClick={() => void reviewSkip("page")}>
                      <Icon name="chevronRight" size={16} /> Skip to next page for review
                    </button>
                  </> : null}
                  <button type="button" role="menuitem" disabled={resetting} className={confirmReset ? "is-danger" : ""} onClick={() => void resetProgress()}>
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

      {inspectorOpen ? (
        <Inspector data={scormData} calls={calls} issues={issues} strict={launchSettings.strict} xapi={xapi} progress={courseProgress} onSettings={() => setSettingsOpen(true)}
          onClear={() => scorm?.clearCalls()} onClose={() => setInspectorOpen(false)}
          onCopy={(text) => void copyText(text).then(() => say("SCORM data and calls copied"), () => say("Couldn't reach the clipboard"))} />
      ) : null}

      {checksOpen ? (
        <Checks frame={() => frameRef.current} onClose={() => setChecksOpen(false)}
          onCopy={(text) => void copyText(text).then(() => say("Checks copied"), () => say("Couldn't reach the clipboard"))}
          onShow={(element) => {
            element.scrollIntoView({ block: "center" });
            const box = element.getBoundingClientRect();
            setHover({ x: box.x, y: box.y, width: box.width, height: box.height });
            window.setTimeout(() => setHover(null), 2000);
          }}
          onPin={(element, note) => {
            if (reattaching) closeComposer();
            element.scrollIntoView({ block: "center" });
            openComposer(element, describeElement(element));
            setDraft(note);
          }} />
      ) : null}

      {panelOpen ? (
        <aside className="sp-panel" aria-label="Pins">
          <header>
            <div>
              <strong>Pins</strong>
              <span>{openPins.length} open{reviewPins.length - openPins.length ? ` · ${reviewPins.length - openPins.length} resolved` : ""}{suggestedPins.length ? ` · ${suggestedPins.length} suggested` : ""}</span>
            </div>
            <button type="button" className="sp-icon-button" onClick={() => setPanelOpen(false)} aria-label="Close pins"><Icon name="close" /></button>
          </header>
          <div className="sp-inspector__tools">
            <div className="sp-segmented" role="tablist">
              <button type="button" role="tab" aria-selected={panelTab === "pins"} onClick={() => setPanelTab("pins")}>Pins <em>{openPins.length}</em></button>
              <button type="button" role="tab" aria-selected={panelTab === "suggestions"} onClick={() => setPanelTab("suggestions")}>Suggestions <em className={suggestedPins.length ? "is-bad" : ""}>{suggestedPins.length}</em></button>
            </div>
          </div>
          {panelTab === "suggestions" ? (
            <QaSuggestions pins={pins} qa={qaStatus} activePin={activePin} onOpen={(pin) => void goToPin(pin)}
              onTriage={async (selected, action) => {
                await api.triage(selected.map((pin) => pin.id), action);
                await refreshPins();
                say(action === "accept" ? `Accepted ${selected.length}: now in Pins and the hand-off` : action === "dismiss" ? "Dismissed; a later QA pass won't suggest it again" : "Restored");
              }}
              onClear={async () => { const { removed } = await api.clearQa(); await refreshPins(); say(`Cleared ${removed} QA suggestion${removed === 1 ? "" : "s"}`); }}
              onCopyLog={() => { if (qaStatus?.logFile) void copyText(qaStatus.logFile).then(() => say("QA log path copied")); }} />
          ) : <>
          <div className="sp-panel__tools">
            <button type="button" className="sp-button sp-button--primary" disabled={!openPins.length} onClick={() => void copyPins()}>
              <Icon name="copy" size={15} /> Copy {openPins.length || ""} for agent
            </button>
            <label><input type="checkbox" checked={showResolved} onChange={(event) => setShowResolved(event.target.checked)} /> Show resolved</label>
          </div>
          <SkillCard offer={skillOffer} />
          {listedPins.length ? (
            <ol className="sp-pin-list">
              {listedPins.map((pin) => (
                <PinRow key={pin.id} pin={pin} active={activePin === pin.id} attachment={attachments[pin.id] ?? "Checking target…"}
                  onReattach={() => { closeComposer(); setReattaching(pin); setDraft(pin.note); setPinMode(true); setPanelOpen(false); say(`Select a replacement for pin ${pin.number}, then confirm.`); }}
                  onOpen={() => void goToPin(pin)} onStatus={(status) => setStatus(pin, status)} onDelete={() => removePin(pin)}
                  onEdit={async (note) => { const updated = await api.updatePin(pin.id, { note }); setPins((previous) => previous.map((item) => (item.id === pin.id ? updated : item))); }} />
              ))}
            </ol>
          ) : (
            <p className="sp-empty">{reviewPins.length ? "Every pin is resolved." : <>No pins yet. Press <kbd>P</kbd> or <strong>Pin</strong>, click something in the course, and write what should change.</>}</p>
          )}
          </>}
        </aside>
      ) : null}
    </div>
  );
}

function PinRow({ pin, active, attachment, onReattach, onOpen, onStatus, onDelete, onEdit }: {
  pin: Pin; active: boolean; attachment: string; onReattach: () => void;
  onOpen: () => void; onStatus: (status: Pin["status"]) => Promise<void>; onDelete: () => Promise<void>; onEdit: (note: string) => Promise<void>;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(pin.note);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError("");
    try { await action(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "The pin could not be updated. Try again."); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (!text.trim() || text.trim() === pin.note) { setEditing(false); return; }
    await run(async () => { await onEdit(text.trim()); setEditing(false); });
  };
  if (editing) {
    return (
      <li className="sp-pin is-active">
        <div className="sp-pin__edit">
          <span className="sp-pin__number">{pin.number}</span>
          <textarea autoFocus rows={3} value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void save(); }
            if (event.key === "Escape") { event.stopPropagation(); setText(pin.note); setEditing(false); }
          }} />
        </div>
        {error && <p className="sp-pin__error" role="alert">{error}</p>}
        <div className="sp-pin__actions">
          <button type="button" disabled={busy} onClick={() => void save()}><Icon name="check" size={14} /> Save</button>
          <button type="button" disabled={busy} onClick={() => { setText(pin.note); setEditing(false); setError(""); }}>Cancel</button>
        </div>
      </li>
    );
  }
  return (
    <li className={`sp-pin ${active ? "is-active" : ""} ${pin.status === "resolved" ? "is-resolved" : ""}`}>
      <button type="button" className="sp-pin__main" onClick={onOpen}>
        <span className="sp-pin__number">{pin.number}</span>
        <span className="sp-pin__body">
          <span className="sp-pin__note">{pin.note}</span>
          <small>
            {pin.origin?.kind === "agent" ? <em className="sp-pin__ai" title={`Accepted QA suggestion from ${pin.origin.agent} · ${pin.category} · ${pin.severity}`}>AI</em> : null}
            {[pin.page?.title, pin.target?.name].filter(Boolean).join(" · ")}
          </small>
          <small className="sp-pin__attachment" title="Target attachment describes the DOM element, not confidence in a source file.">{attachment}</small>
          {pin.source?.[0] ? <code title={pin.source[0].provenance === "content-binding" ? "Course-declared binding; file hashes checked at capture" : "Text match only; confirm the rendering field before editing"}>{pin.source[0].provenance === "content-binding" ? "Mapped: " : "Possible: "}{pin.source[0].file}:{pin.source[0].line}</code> : null}
        </span>
        {pin.frame ? <img src={`/api/pins/${pin.id}/frame?v=${encodeURIComponent(pin.updatedAt)}`} alt="" title={pin.attachmentHistory?.length ? "Original screenshot, captured before reattachment" : "Screenshot at capture"} /> : null}
      </button>
      {error && <p className="sp-pin__error" role="alert">{error}</p>}
      <div className="sp-pin__actions">
        {pin.status === "open"
          ? <button type="button" disabled={busy} onClick={() => void run(() => onStatus("resolved"))}><Icon name="check" size={14} /> Resolve</button>
          : <button type="button" disabled={busy} onClick={() => void run(() => onStatus("open"))}><Icon name="undo" size={14} /> Reopen</button>}
        <button type="button" disabled={busy} onClick={() => { setText(pin.note); setEditing(true); setError(""); }}><Icon name="edit" size={14} /> Edit</button>
        <button type="button" disabled={busy} onClick={onReattach}>Reattach</button>
        <button type="button" disabled={busy} className={confirmDelete ? "is-danger" : ""} onClick={() => (confirmDelete ? void run(onDelete) : setConfirmDelete(true))} onBlur={() => setConfirmDelete(false)}>
          <Icon name="trash" size={14} /> {confirmDelete ? "Confirm delete" : "Delete"}
        </button>
      </div>
    </li>
  );
}

/**
 * Whether a press lands on readable, selectable text (so a drag from there selects a phrase)
 * rather than on empty space, an image, or text the course made unselectable.
 */
function startsOnText(doc: Document, x: number, y: number) {
  const caret = (doc as any).caretPositionFromPoint?.(x, y) ?? null;
  const range: Range | null = caret ? doc.createRange() : (doc as any).caretRangeFromPoint?.(x, y) ?? null;
  if (caret && range) { range.setStart(caret.offsetNode, caret.offset); range.collapse(true); }
  const node = range?.startContainer;
  if (!node || node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) return false;
  const parent = node.parentElement;
  if (!parent || doc.defaultView?.getComputedStyle(parent).userSelect === "none") return false;
  // The caret snaps to the nearest text even from blank space beside it, so check the press is on the glyphs.
  const glyphs = doc.createRange();
  glyphs.selectNodeContents(node);
  return Array.from(glyphs.getClientRects()).some((rect) => x >= rect.left - 2 && x <= rect.right + 2 && y >= rect.top - 2 && y <= rect.bottom + 2);
}


function boxStyle(rect: Rect) {
  return { left: rect.x, top: rect.y, width: rect.width, height: rect.height };
}

type Viewport = "desktop" | "tablet" | "phone";
const VIEWPORTS = { tablet: { width: 1024, height: 768 }, phone: { width: 390, height: 844 } } as const;
const VIEWPORT_LABEL: Record<Viewport, string> = { desktop: "Desktop", tablet: "Tablet", phone: "Phone" };

/** Desktop fills the stage; tablet and phone are fixed sizes, scaled down to fit when needed. */
function deviceLayout(viewport: Viewport, stage: { width: number; height: number }): React.CSSProperties {
  if (viewport === "desktop" || !stage.width) return { inset: 0 };
  const size = VIEWPORTS[viewport];
  const scale = Math.min(1, (stage.width - 48) / size.width, (stage.height - 48) / size.height);
  return {
    left: "50%",
    top: "50%",
    width: size.width,
    height: size.height,
    transform: `translate(-50%, -50%) scale(${Math.max(0.2, scale)})`,
  };
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
  const version = course.standard === "xapi" ? "xAPI" : course.standard === "cmi5" ? "cmi5"
    : course.scormVersion && course.scormVersion !== "both" ? `SCORM ${course.scormVersion}` : "SCORM";
  if (course.kind === "live") {
    if (!lastChangeAt) return `Live source · ${version} · watching for edits`;
    const seconds = Math.max(0, Math.round((now - Date.parse(lastChangeAt)) / 1000));
    const ago = seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.round(seconds / 60)}m` : `${Math.round(seconds / 3600)}h`;
    return `Live source · ${version} · updated ${ago} ago`;
  }
  return `${version} · ${course.kind === "package" ? "zip · read-only" : "folder"}`;
}
