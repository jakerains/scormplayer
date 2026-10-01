/**
 * Review shortcuts for narrated content: notice the audio and video a course plays (including
 * `new Audio()` objects that never join the page), so the reviewer can skip to the end of a clip
 * instead of waiting. Jumping to the end lets the media fire its own `ended` event, so a guided
 * tour unlocks its Next step exactly as if the narration had finished. Nothing in the course is
 * changed on disk; this only observes playback in the review player.
 */

type MediaWindow = Window & { HTMLMediaElement: typeof HTMLMediaElement; __scormplayerMedia?: Set<HTMLMediaElement> };

export function watchMedia(frame: HTMLIFrameElement) {
  let win: MediaWindow | null = null;
  try { win = frame.contentWindow as MediaWindow | null; } catch { return; }
  if (!win || win.__scormplayerMedia) return;
  const seen = new Set<HTMLMediaElement>();
  win.__scormplayerMedia = seen;
  const proto = win.HTMLMediaElement.prototype;
  const play = proto.play;
  proto.play = function patchedPlay(this: HTMLMediaElement, ...args: []) {
    seen.add(this);
    return play.apply(this, args);
  };
}

function mediaIn(frame: HTMLIFrameElement): HTMLMediaElement[] {
  try {
    const win = frame.contentWindow as MediaWindow | null;
    const doc = frame.contentDocument;
    const found = new Set<HTMLMediaElement>(win?.__scormplayerMedia ?? []);
    doc?.querySelectorAll<HTMLMediaElement>("audio, video").forEach((element) => found.add(element));
    return [...found];
  } catch {
    return [];
  }
}

/** Audio or video that is playing right now (or paused part-way through). */
export function activeMedia(frame: HTMLIFrameElement): HTMLMediaElement | null {
  const media = mediaIn(frame).filter((element) => Number.isFinite(element.duration) && element.duration > 0 && !element.ended);
  return media.find((element) => !element.paused) ?? media.find((element) => element.currentTime > 0) ?? null;
}

/** Jump the playing clip to its end so the course runs its own "finished" logic. */
export function skipMedia(frame: HTMLIFrameElement): boolean {
  const element = activeMedia(frame);
  if (!element) return false;
  const wasPlaying = !element.paused;
  element.currentTime = Math.max(0, element.duration - 0.05);
  if (!wasPlaying) void element.play().catch(() => {});
  return true;
}

/** The open driver.js tour in the course, if any. */
export function tourState(frame: HTMLIFrameElement) {
  let doc: Document | null = null;
  try { doc = frame.contentDocument; } catch { return null; }
  const popover = doc?.querySelector<HTMLElement>(".driver-popover");
  if (!doc || !popover || !popover.isConnected || popover.offsetParent === null && getComputedStyle(popover).position !== "fixed") return null;
  const next = popover.querySelector<HTMLButtonElement>(".driver-popover-next-btn");
  const prev = popover.querySelector<HTMLButtonElement>(".driver-popover-prev-btn");
  const progress = popover.querySelector<HTMLElement>(".driver-popover-progress-text")?.innerText.trim() ?? "";
  const title = popover.querySelector<HTMLElement>(".driver-popover-title")?.innerText.trim() ?? "";
  return {
    title,
    progress,
    canNext: Boolean(next && !next.disabled && next.offsetParent !== null),
    canPrev: Boolean(prev && !prev.disabled && prev.offsetParent !== null),
    next: () => next?.click(),
    prev: () => prev?.click(),
  };
}
