/** Explicit course opt-in only: never simulate learner controls to get around a gate. */
export async function skipForReview(frame: HTMLIFrameElement | null, kind: "page" | "guide") {
  try {
    const bridge = (frame?.contentWindow as (Window & {
      __SCORMPLAYER_REVIEW__?: { skip: (kind: "page" | "guide") => Promise<boolean> };
    }) | null)?.__SCORMPLAYER_REVIEW__;
    return await bridge?.skip(kind) === true;
  } catch { return false; }
}
