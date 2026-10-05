/** Transient live-review memory is separate from learner/LMS progress and scoped to this tab. */
export function reviewScope(courseKey: string, scoId: string, launchUrl: string) {
  return JSON.stringify([courseKey, scoId, launchUrl]);
}

export function reviewLaunchUrl(scope: string, launchUrl: string) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(`scormplayer:review:v1:${scope}`) || "null");
    if (saved?.version !== 1 || saved.scope !== scope || typeof saved.url !== "string") return launchUrl;
    const url = new URL(saved.url, window.location.origin);
    // Never use a snapshot as a cross-origin or out-of-course navigation instruction.
    if (url.origin === window.location.origin && url.pathname.startsWith("/course/")) {
      return `${url.pathname}${url.search}${url.hash}`;
    }
  } catch { /* storage blocked or obsolete snapshot */ }
  return launchUrl;
}

export function checkpointReview(frame: HTMLIFrameElement | null, clear = false, leaving = false) {
  try {
    const bridge = (frame?.contentWindow as (Window & {
      __SCORMPLAYER_REVIEW__?: { checkpoint: (leaving?: boolean) => void; clear: () => void };
    }) | null)?.__SCORMPLAYER_REVIEW__;
    if (clear) bridge?.clear();
    else bridge?.checkpoint(leaving);
  } catch { /* frame gone or cross origin */ }
}

export function clearCourseReview(courseKey: string) {
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (!key.startsWith("scormplayer:review:v1:")) continue;
      try { if (JSON.parse(key.slice("scormplayer:review:v1:".length))[0] === courseKey) sessionStorage.removeItem(key); }
      catch { /* one obsolete key cannot prevent clearing the other modules */ }
    }
  } catch { /* storage blocked */ }
}
