import { useEffect, useRef, useState } from "react";
import { api, copyText, type Course } from "./api";
import { Icon } from "./icons";

/**
 * A player left open in a forgotten tab never goes idle on its own: the page keeps asking for
 * its pins. So the page watches for a person instead (clicks, typing, scrolling, narration
 * playing). After the player's idle time without one it asks "Still there?", and if nobody
 * answers within the countdown the player closes. The tab then says so, and how to reopen it;
 * it says the same if the player stops for any other reason (an agent ran scormplayer stop).
 */

const INTERACTIONS = ["pointerdown", "keydown", "wheel", "touchstart", "pointermove", "scroll"] as const;

export type Presence =
  | { state: "here" }
  | { state: "asking"; closesAt: number }
  | { state: "closed"; why: "idle" | "stopped" };

export function useStillThere({ course, mediaPlaying, frameDoc, frameLoads }: {
  course: Course | null;
  mediaPlaying: boolean;
  frameDoc: () => Document | null;
  frameLoads: number;
}) {
  const [presence, setPresence] = useState<Presence>({ state: "here" });
  const lastInteraction = useRef(Date.now());
  const lastReported = useRef(0);
  const idleMs = course?.idleMinutes ? course.idleMinutes * 60_000 : null;
  // Two minutes to answer, or half the idle time when that's very short.
  const graceMs = idleMs ? Math.min(120_000, idleMs / 2) : 0;

  // Any sign of a person, in the player or inside the course.
  useEffect(() => {
    if (!idleMs) return;
    const onInteraction = () => {
      lastInteraction.current = Date.now();
      if (Date.now() - lastReported.current > 30_000) {
        lastReported.current = Date.now();
        void api.active();
      }
    };
    const targets: (Window | Document)[] = [window];
    const doc = frameDoc();
    if (doc) targets.push(doc);
    targets.forEach((target) => INTERACTIONS.forEach((type) => target.addEventListener(type, onInteraction, { passive: true, capture: true })));
    return () => targets.forEach((target) => INTERACTIONS.forEach((type) => target.removeEventListener(type, onInteraction, { capture: true })));
  }, [idleMs, frameLoads]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ask when it's been quiet too long; close when nobody answers.
  useEffect(() => {
    if (!idleMs) return;
    const tick = async () => {
      if (mediaPlaying) lastInteraction.current = Date.now();
      const quiet = Date.now() - lastInteraction.current;
      setPresence((current) => {
        if (current.state === "here" && quiet >= idleMs) return { state: "asking", closesAt: Date.now() + graceMs };
        if (current.state === "asking" && quiet < idleMs) return { state: "here" };
        return current;
      });
    };
    const timer = window.setInterval(() => void tick(), 1000);
    return () => window.clearInterval(timer);
  }, [idleMs, graceMs, mediaPlaying]);

  useEffect(() => {
    if (presence.state !== "asking") return;
    const timer = window.setTimeout(async () => {
      try {
        const { closed } = await api.idleClose();
        // Someone is using another tab of this player: keep it open.
        if (closed) setPresence({ state: "closed", why: "idle" });
        else { lastInteraction.current = Date.now(); setPresence({ state: "here" }); }
      } catch {
        setPresence({ state: "closed", why: "stopped" });
      }
    }, Math.max(0, presence.closesAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [presence]);

  // Notice when the player has stopped for any reason.
  useEffect(() => {
    if (!course) return;
    let misses = 0;
    const timer = window.setInterval(() => {
      api.player().then(() => { misses = 0; }, () => {
        misses += 1;
        if (misses >= 2) setPresence((current) => (current.state === "closed" ? current : { state: "closed", why: "stopped" }));
      });
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [course]);

  const stillHere = () => {
    lastInteraction.current = Date.now();
    lastReported.current = Date.now();
    void api.active();
    setPresence({ state: "here" });
  };

  return { presence, stillHere };
}

export function StillThereCard({ closesAt, onStay }: { closesAt: number; onStay: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);
  const left = Math.max(0, Math.ceil((closesAt - now) / 1000));
  return (
    <div className="sp-modal" role="presentation">
      <div className="sp-dialog sp-still" role="alertdialog" aria-modal="true" aria-labelledby="sp-still-title" aria-describedby="sp-still-text">
        <h2 id="sp-still-title">Still there?</h2>
        <p id="sp-still-text">
          Nobody has used this player for a while, so it closes in <b>{Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</b> to
          free up its port. Your pins are saved either way.
        </p>
        <div className="sp-dialog__actions">
          <button type="button" className="sp-button sp-button--primary" autoFocus onClick={onStay}>I'm still here</button>
        </div>
      </div>
    </div>
  );
}

export function ClosedScreen({ course, why }: { course: Course | null; why: "idle" | "stopped" }) {
  const [copied, setCopied] = useState(false);
  // A zip dropped in the browser is known only by its name, so reopening means dropping it again.
  const dropped = !course || !/[\\/]/.test(course.source);
  const command = dropped ? "scormplayer --drop" : `scormplayer ${quoteArg(course.source)}`;
  return (
    <div className="sp-closed" role="status">
      <div className="sp-dialog">
        <h2>This player has closed</h2>
        <p>
          {why === "idle" ? "Nobody used it for a while, so it closed to free up its port." : "It was stopped, or the terminal running it was closed."}
          {course ? <> Your pins are saved in <code>{course.pinsFile}</code>.</> : null}
        </p>
        <p>Open the course again from a terminal:</p>
        <div className="sp-closed__command">
          <code>{command}</code>
          <button type="button" className="sp-button" onClick={() => void copyText(command).then(() => setCopied(true))}>
            <Icon name="copy" size={15} /> {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
    </div>
  );
}

function quoteArg(value: string) {
  return /^[\w./~:-]+$/.test(value) ? value : JSON.stringify(value);
}
