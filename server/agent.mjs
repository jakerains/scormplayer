import path from "node:path";

/**
 * Agent mode (--json): everything an agent needs as JSON on stdout, nothing else. One-shot
 * commands print one object; the player prints one event per line (NDJSON), starting with
 * "ready", so an agent can start it in the background and read the URL from the first line.
 * No colours, prompts, tips or update notices.
 */

/** What the pins command prints: the course, where pins live, counts, and each pin with its screenshot path. */
export function pinsReport(store, course, { status = "open" } = {}) {
  const all = store.list({ status: "all" });
  const pins = status === "all" ? all : all.filter((pin) => pin.status === status);
  return {
    ok: true,
    course: describeCourse(course),
    pinsFile: store.pinsFile,
    counts: countPins(all),
    pins: pins.map((pin) => withScreenshot(pin, store.pinsFile)),
  };
}

/**
 * Report a running player as NDJSON events: ready, browser, progress, source, pin, course,
 * unzipped, log, stopped. Pins are watched on disk too, so changes from the CLI (an agent resolving them) show up.
 *
 * @param {{ player: any, stdout?: NodeJS.WritableStream, onQuit: () => void | Promise<void> }} options
 */
export function createJsonReporter({ player, stdout = process.stdout, onQuit }) {
  const emit = (event, data = {}) => stdout.write(`${JSON.stringify({ event, at: new Date().toISOString(), ...data })}\n`);
  let known = list(player);
  let closed = false;

  function pollPins() {
    const next = list(player);
    const before = new Map(known.map((pin) => [pin.id, pin]));
    for (const pin of next) {
      const old = before.get(pin.id);
      const change = !old ? (pin.status === "suggested" ? "suggested" : "created")
        : old.status !== pin.status ? statusChange(old.status, pin.status)
        : old.note !== pin.note || (old.alsoOn?.length ?? 0) !== (pin.alsoOn?.length ?? 0) ? "edited"
        : null;
      if (change) emit("pin", { change, pin: withScreenshot(pin, player.pins.pinsFile) });
      before.delete(pin.id);
    }
    for (const pin of before.values()) emit("pin", { change: "deleted", pin: { id: pin.id, number: pin.number } });
    known = next;
  }

  const { events } = player;
  let browser = false;
  events.on("browser", () => { if (!browser) emit("browser"); browser = true; });
  events.on("source", ({ file }) => emit("source", { file }));
  events.on("progress", (progress) => emit("progress", { progress }));
  events.on("pin", pollPins);
  events.on("qa", ({ type, run, runId, logFile }) => {
    if (type === "suggested" || type === "page" || type === "logged") return;
    emit("qa", { change: type, runId: run?.id ?? runId, ...(run ? { state: run.state } : {}), ...(logFile ? { logFile } : {}) });
  });
  events.on("unzipped", ({ folder, pinsFile, reused, movedPins }) => emit("unzipped", { folder, pinsFile, reused, movedPins }));
  events.on("course", () => { known = list(player); emit("course", courseState(player)); });
  const timer = setInterval(pollPins, 1500);

  emit("ready", { url: player.url, pid: process.pid, ...courseState(player) });

  async function quit(reason = "stopped") {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    emit("stopped", { reason, counts: countPins(list(player)) });
    await onQuit();
  }
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, () => void quit(`received ${signal}`));

  return { log: (message) => emit("log", { message }), quit };
}

/** Errors in agent mode: one JSON object, exit code 1. */
export function jsonError(message, code = "error") {
  return `${JSON.stringify({ ok: false, error: message, code })}\n`;
}

function courseState(player) {
  const { course } = player;
  if (!course) return { course: null, pinsFile: null, counts: countPins([]) };
  return { course: describeCourse(course), pinsFile: course.pinsFile, counts: countPins(list(player)) };
}

function list(player) {
  try { return player.pins?.list({ status: "all" }) ?? []; } catch { return []; }
}

function describeCourse(course) {
  return {
    title: course.title,
    kind: course.kind,
    scormVersion: course.scormVersion ?? null,
    standard: course.standard ?? "scorm",
    source: course.displayName ?? course.source,
    // A zip plays from a copy in the cache: unzip it (scormplayer unzip) before editing.
    editable: course.kind !== "package",
    ...(course.scos?.length > 1 ? { scos: course.scos.map((sco) => ({ id: sco.id, title: sco.title })) } : {}),
    // A zip or folder holding several courses: the one open, and all of them (open another with --package).
    ...(course.packages ? { package: course.package, packages: course.packages } : {}),
  };
}

function countPins(pins) {
  return {
    open: pins.filter((pin) => pin.status === "open").length,
    resolved: pins.filter((pin) => pin.status === "resolved").length,
    suggested: pins.filter((pin) => pin.status === "suggested").length,
  };
}

/** What a status change means: an accepted or dismissed suggestion, or a resolved or reopened pin. */
function statusChange(before, after) {
  if (before === "suggested" || before === "dismissed") return after === "open" ? "accepted" : after === "dismissed" ? "dismissed" : "restored";
  return after === "resolved" ? "resolved" : "reopened";
}

function withScreenshot(pin, pinsFile) {
  return pin.frame ? { ...pin, screenshot: path.join(path.dirname(pinsFile), pin.frame) } : pin;
}
