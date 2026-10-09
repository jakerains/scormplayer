import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import express from "express";
import { resolveCourse, isInside, siblingPinsFile, UserError } from "./course.mjs";
import { createBrowserBridge } from "./browser-bridge.mjs";
import { validateTarget } from "./pin-target.mjs";
import { createPinStore } from "./pins.mjs";
import { createSourceSearch } from "./source-search.mjs";
import { startLiveCourse, LIVE_BASE } from "./live.mjs";
import { pruneCache, createCacheLease, withCacheLock } from "./cache.mjs";
import { defaultUnzipFolder, existingUnzip, unzipCourse } from "./unzip.mjs";
import { defaultRegistryDir, registerPlayer } from "./registry.mjs";
import { skillStatus } from "./skill.mjs";
import { courseKey, createScormStore } from "./scorm-state.mjs";
import { checkPackage } from "./package-check.mjs";
import { createXapiRoutes, createXapiStore } from "./xapi.mjs";
import { createQaStore, pinPlace } from "./qa.mjs";
import { findConfig } from "./config.mjs";

export { resolveCourse, UserError } from "./course.mjs";
export { createPinStore } from "./pins.mjs";
export { createDashboard, openBrowser, copyToClipboard } from "./tui.mjs";
export { cacheEntries, clearCache, pruneCache } from "./cache.mjs";
export { checkForUpdate } from "./update.mjs";
export { defaultUnzipFolder, unzipCourse } from "./unzip.mjs";
export { checkPackage, formatCheck } from "./package-check.mjs";
export { defaultRegistryDir, listPlayers, findPlayer, stopPlayer } from "./registry.mjs";

/** Players use one of 20 ports from 4620 up, so a machine never fills with them unnoticed. */
export const PORT_RANGE = 20;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.resolve(HERE, "../dist/client");

/**
 * Start the player. With `input` it opens that course; without one it starts empty and the page
 * offers a drop zone. Either way a SCORM zip can be dropped or chosen in the browser to switch
 * courses while it runs.
 *
 * It records itself in the registry of running players (`registryDir`; null to skip), so
 * `scormplayer ps` and `stop` can find it, and keeps the time anything last talked to it
 * (`idleFor()`), so a player nobody is looking at can be stopped.
 *
 * @param {{ input?: string | null, cacheDir: string, host?: string, port?: number, live?: boolean,
 *   pinsFile?: string | null, pinsDir?: string, clientDir?: string, registryDir?: string | null,
 *   mode?: "dashboard" | "background" | "library", idleMinutes?: number | null, pkg?: string | null,
 *   courseList?: (() => { path: string, kind: string, title: string }[]) | null,
 *   pinsFor?: ((course: string) => string | null) | null }} options
 *
 * `courseList` lists the courses the page may switch to (More → Switch course) and `pinsFor`
 * says where a course's pins go when switched to (a project config's rule, say).
 */
export async function startPlayer({ input = null, cacheDir, host = "127.0.0.1", port = 4620, live = false, pinsFile = null, pinsDir = process.cwd(), clientDir = CLIENT_DIR, registryDir = defaultRegistryDir(), mode = "library", idleMinutes = null, pkg = null, courseList = null, pinsFor = null }) {
  // What the terminal dashboard shows: pins, source changes, SCORM progress, browser visits.
  const events = new EventEmitter();
  let progress = null;
  let current = null;
  let lastActivity = Date.now();
  // Goes up each time another course opens, so an open page can tell it should reload.
  let courseVersion = 0;
  const instance = randomUUID();
  const revision = () => `${instance}:${courseVersion}`;
  const lease = createCacheLease(cacheDir);
  const search = createSourceSearch();
  const browserBridge = createBrowserBridge(revision);
  let opening = Promise.resolve();
  let closing = false;
  // When a person last did something in an open page (clicked, typed, scrolled, listened). The
  // page's own polling keeps lastActivity fresh, so a forgotten tab is told apart by this.
  let lastInteraction = Date.now();
  let registration = null;
  // A newer published scormplayer, when the CLI finds one, for the page's More menu.
  let update = null;
  const app = express();
  const httpServer = createServer(app);
  // Node's closeAllConnections excludes upgraded sockets, including stale Vite
  // reconnects after a course switch. Keep those sockets in shutdown cleanup too.
  const sockets = new Set();
  httpServer.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  const closeSockets = () => { for (const socket of sockets) socket.destroy(); };
  let started = false;

  function registryFields(source) {
    const course = current?.course;
    return {
      input: source ? path.resolve(source) : null,
      title: course?.title ?? null,
      kind: course?.kind ?? null,
      source: course ? course.displayName ?? course.source : null,
      pinsFile: course?.pinsFile ?? null,
      package: course?.package ?? null,
    };
  }

  function open(target, options = {}) {
    const task = opening.then(() => {
      if (closing) throw new Error("The player is closing.");
      if (options.revision && options.revision !== revision()) throw Object.assign(new Error("The course changed. Reload before trying again."), { statusCode: 409 });
      return doOpen(target, options);
    });
    opening = task.catch(() => {});
    return task;
  }

  async function doOpen(target, options = {}) {
    const course = withCacheLock(cacheDir, () => {
      const resolved = resolveCourse(target, { cacheDir, live: options.live ?? false, pinsFile: options.pinsFile ?? null, pkg: options.pkg ?? null });
      lease.update([resolved.root, target, current?.course.root, current?.target]);
      try { pruneCache(cacheDir); } catch { /* best effort */ }
      return resolved;
    });
    if (options.displayName) course.displayName = options.displayName;
    // A zip dropped in the browser keeps its pins where scormplayer started, named after the zip
    // (and after the package, when it holds several).
    if (options.pinsBeside) {
      const chosen = course.packages ? { name: course.package, packages: course.packages } : null;
      const name = (course.displayName ?? path.basename(target)).replace(/\.zip$/i, `-${course.sha256.slice(0, 12)}.zip`);
      course.pinsFile = siblingPinsFile(path.join(options.pinsBeside, name), chosen);
    }
    const pins = createPinStore(course.pinsFile, course);
    let liveCourse;
    try {
      liveCourse = course.kind === "live"
        ? await startLiveCourse({ root: course.root, viteConfig: course.viteConfig, httpServer, onChange: (change) => events.emit("source", change) })
        : null;
    }
    catch (error) { lease.update([current?.course.root, current?.target]); throw error; }
    const previous = current;
    // Pins kept somewhere chosen on purpose (--pins, a project config) stay there after unzipping.
    current = { course, pins, qa: createQaStore(course.pinsFile), qaScorm: null, scorm: createScormStore(cacheDir, course), xapi: isXapi(course) ? createXapiStore(cacheDir, course) : null, liveCourse, keepPinsFile: Boolean(options.keepPinsFile), target, options };
    progress = null;
    courseVersion += 1;
    browserBridge.close();
    await previous?.liveCourse?.close();
    registration?.update(registryFields(target));
    lease.update([course.root, target]);
    if (started) events.emit("course", course);
    return course;
  }

  try {
    if (input) await open(input, { live, pinsFile, keepPinsFile: Boolean(pinsFile), pkg });

    /** Switch to another course (from the course list), its pins where `pinsFor` says. */
    async function switchCourse(target, expectedRevision) {
      const file = path.resolve(target);
      const pins = pinsFor?.(file) ?? null;
      return open(file, { pinsFile: pins, keepPinsFile: Boolean(pins), revision: expectedRevision });
    }

    /** Switch to another package in the same zip or folder. */
    async function openPackage(name, expectedRevision) {
      const { target, options, keepPinsFile, course } = requireCourse();
      if (!course.packages) throw new UserError("This course is a single package.");
      return open(target, { ...options, revision: expectedRevision, pkg: name, pinsFile: keepPinsFile ? course.pinsFile : null });
    }

    /** Unzip the open zip to a folder (beside it by default) and reopen the player on that folder. */
    async function unzip(folder, expectedRevision) {
      const { course, keepPinsFile } = requireCourse();
      const result = unzipCourse(course, { folder: folder || defaultUnzipFolder(course), keepPinsFile });
      await open(result.folder, { revision: expectedRevision, pinsFile: result.pinsFile, keepPinsFile, pkg: course.package ?? null });
      events.emit("unzipped", result);
      return result;
    }
    started = true;

    const requireCourse = () => {
      if (!current) throw Object.assign(new Error("No course is open."), { statusCode: 409 });
      return current;
    };

    // Any request counts as someone using the player: the open page asks for its pins every few seconds.
    app.use((req, _res, next) => {
      // ps asking about a player (or the page checking it's still up) isn't someone using it.
      if (req.path !== "/api/player") lastActivity = Date.now();
      next();
    });
    // Changes only from the player's own page. A browser names the page a request comes from, so
    // another website can't use this local server to save pins or unzip files.
    app.use((req, res, next) => {
      if (req.method === "GET" || req.method === "HEAD") return next();
      const origin = req.get("origin");
      if (origin && origin !== "null") {
        let host = null;
        try { host = new URL(origin).host; } catch { /* malformed */ }
        if (host !== req.get("host")) return res.status(403).json({ error: "Requests from other sites aren't allowed." });
      }
      next();
    });
    // xAPI and cmi5 courses talk to a local LRS. It reads its own bodies (documents needn't be JSON).
    const xapiRoutes = createXapiRoutes(() => (current?.xapi ? { course: current.course, xapi: current.xapi } : null), (type, detail) => events.emit("xapi", { type, ...detail }));
    app.use("/xapi", xapiRoutes.router);
    // A review tab's answers can carry a page screenshot for an agent's QA pass.
    const json = express.json({ limit: "1mb" });
    const largeJson = express.json({ limit: "8mb" });
    app.use((req, res, next) => (/^\/api\/browser\/[^/]+\/answer\//.test(req.path) ? largeJson : json)(req, res, next));
    app.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

    const scoped = /^\/api\/(browser(?:\/|$)|verify-pin$|reload$|pins(?:\/|$)|brief$|progress$|scorm$|open$|switch$|package$|unzip$|qa(?:\/|$))/;
    function checkRevision(req) {
      const expected = req.get("x-scormplayer-revision");
      if (expected && expected !== revision()) throw Object.assign(new Error("The course changed in another tab. Reload before saving this note."), { statusCode: 409 });
      if (!expected && req.get("origin") && !["GET", "HEAD"].includes(req.method)) throw Object.assign(new Error("Reload the player before trying again."), { statusCode: 428 });
    }
    app.use((req, res, next) => {
      if (!scoped.test(req.path)) return next();
      try { checkRevision(req); next(); }
      catch (error) { res.status(error.statusCode).json({ error: error.message }); }
    });

    app.get("/api/course", (_req, res) => {
      events.emit("browser");
      lastInteraction = Date.now();
      if (!current) return res.json({ empty: true, revision: revision() });
      const { course } = current;
      res.json({
        revision: revision(),
        title: course.title,
        kind: course.kind,
        scormVersion: course.scormVersion,
        source: course.displayName ?? course.source,
        // SCORM, or an xAPI or cmi5 package launched through the local LRS.
        standard: course.standard ?? "scorm",
        launchUrl: course.kind === "live" ? LIVE_BASE : isXapi(course) ? xapiLaunchUrl(course.scos[0]) : `/course/${encodePath(course.launch)}`,
        // Each package keeps its own durable SCORM progress.
        courseKey: courseKey(course),
        ...(course.packages ? { package: course.package, packages: course.packages } : {}),
        pinsFile: course.pinsFile,
        // After this many minutes without anyone using the page it asks "Still there?" (null: never).
        idleMinutes,
        // A zip plays from a copy in the cache, so it can't be edited until it is unzipped.
        editable: course.kind !== "package",
        ...(course.kind === "package" ? { unzip: { folder: defaultUnzipFolder(course), existing: existingUnzip(course) } } : {}),
        // Packages with several SCOs: each one, in manifest order, to switch between.
        ...(course.scos?.length > 1 ? { scos: course.scos.map((sco) => ({ id: sco.id, title: sco.title, launchUrl: isXapi(course) ? xapiLaunchUrl(sco) : `/course/${encodePath(sco.launch)}`, runtime: sco.runtime ?? {} })) } : {}),
        // What the manifest tells the LMS to hand the course at launch (mastery score, thresholds, launch data).
        runtime: course.scos?.[0]?.runtime ?? {},
      });
    });

    // Open a SCORM zip dropped or chosen in the browser. It is kept in the cache; its pins go
    // beside where scormplayer was started, named after the zip.
    app.post("/api/open", express.raw({ type: () => true, limit: "1gb" }), handle(async (req, res) => {
      const name = safeZipName(req.get("x-file-name"));
      if (!req.body?.length) throw new UserError("The upload was empty.");
      const uploads = path.join(cacheDir, "uploads");
      fs.mkdirSync(uploads, { recursive: true });
      const digest = createHash("sha256").update(req.body).digest("hex").slice(0, 8);
      let file = path.join(uploads, name);
      if (fs.existsSync(file) && !fs.readFileSync(file).equals(req.body)) file = path.join(uploads, name.replace(/\.zip$/i, `-${digest}.zip`));
      fs.writeFileSync(file, req.body);
      const course = await open(file, { revision: req.get("x-scormplayer-revision"), pinsBeside: pinsDir, displayName: name });
      res.json({ ok: true, title: course.title });
    }));

    app.post("/api/unzip", handle(async (req, res) => {
      const folder = typeof req.body?.folder === "string" && req.body.folder.trim() ? path.resolve(req.body.folder.trim().replace(/^~(?=$|[\\/])/, os.homedir())) : null;
      res.json({ ok: true, ...(await unzip(folder, req.get("x-scormplayer-revision"))) });
    }));

    app.get("/api/update", (_req, res) => res.json({ update }));

    // The page reports a person using it (throttled), and, when nobody answered "Still there?",
    // asks to close. The close is refused if anyone used any tab of this player in the meantime.
    app.post("/api/active", (_req, res) => { lastInteraction = Date.now(); res.status(204).end(); });
    app.post("/api/idle-close", (_req, res) => {
      const quiet = Date.now() - lastInteraction;
      // A little slack for the page's clock and throttling: 5 s, or a tenth of very short idle times.
      if (!idleMinutes || quiet < idleMinutes * 60_000 - Math.min(5_000, idleMinutes * 6_000)) return res.json({ closed: false });
      res.json({ closed: true });
      events.emit("idle-close");
    });

    // For `scormplayer ps`: who this is and how long since a browser last asked for anything.
    app.get("/api/player", (_req, res) => res.json({ pid: process.pid, mode, idleMinutes, idleSeconds: Math.round((Date.now() - lastActivity) / 1000), courseVersion, revision: revision(), browserBridgeVersion: 1 }));

    // The courses the page can switch to, and switching. Only listed courses can be opened this way.
    app.get("/api/courses", (_req, res) => {
      const source = current?.course?.source ?? null;
      res.json({ courses: (courseList?.() ?? []).map((course) => ({ ...course, current: course.path === source })) });
    });
    app.post("/api/switch", handle(async (req, res) => {
      const target = String(req.body?.path ?? "");
      if (!(courseList?.() ?? []).some((course) => course.path === target)) throw new UserError("That course isn't in the list.");
      const course = await switchCourse(target, req.get("x-scormplayer-revision"));
      res.json({ ok: true, title: course.title });
    }));

    app.post("/api/package", handle(async (req, res) => {
      const course = await openPackage(String(req.body?.name ?? ""), req.get("x-scormplayer-revision"));
      res.json({ ok: true, title: course.title, package: course.package });
    }));

    // The agent skill: whether coding agents have it and whether it matches this version. The page
    // only points to the terminal (`scormplayer skill`); it never installs anything itself.
    app.get("/api/skill", (_req, res) => {
      let status = { state: "unknown", version: null, installed: [] };
      try { status = skillStatus(); } catch { /* no skill file to compare */ }
      res.json({ state: status.state, version: status.version, installedVersion: status.installed.map((copy) => copy.version).find(Boolean) ?? null });
    });

    // Package checks: what an LMS upload or launch is likely to trip on, read from the files.
    app.get("/api/check", handle(async (_req, res) => res.json(checkPackage(requireCourse().course))));

    app.get("/api/status", (_req, res) => res.json(current?.liveCourse?.status() ?? { lastChangeAt: null }));

    // During an agent's QA pass the course runs on a throwaway attempt, so the reviewer's progress is untouched.
    const progressStore = (opened) => (opened.qaScorm && opened.qa.active() ? opened.qaScorm : opened.scorm);
    app.get("/api/scorm", handle(async (_req, res) => res.json(progressStore(requireCourse()).read())));
    app.put("/api/scorm", handle(async (req, res) => {
      const opened = requireCourse();
      const { xapi } = opened;
      const state = progressStore(opened).update(req.body ?? {});
      // Resetting progress also starts a new xAPI registration.
      if (req.body?.reset === true) xapi?.reset();
      res.json(state);
    }));

    // The frame opens this to launch an xAPI or cmi5 module; it redirects to the course with its launch parameters.
    app.get("/api/xapi/launch", (req, res) => {
      if (!current?.xapi) return res.status(404).type("text").send("No xAPI or cmi5 course is open.");
      xapiRoutes.launch(req, res);
    });
    app.get("/api/xapi", handle(async (_req, res) => {
      if (!requireCourse().xapi) throw Object.assign(new Error("This course doesn't use xAPI."), { statusCode: 404 });
      res.json(xapiRoutes.summary());
    }));

    // The player page reports the course's SCORM status so the terminal can show it.
    app.post("/api/progress", (req, res) => {
      const body = req.body ?? {};
      const next = {
        completion: String(body.completion ?? "").slice(0, 40),
        success: String(body.success ?? "").slice(0, 40),
        score: String(body.score ?? "").slice(0, 20),
        location: String(body.location ?? "").slice(0, 200),
        progressMeasure: String(body.progressMeasure ?? "").slice(0, 20),
      };
      if (JSON.stringify(next) !== JSON.stringify(progress)) {
        const previous = progress;
        progress = next;
        events.emit("progress", next, previous);
      }
      res.status(204).end();
    });

    app.get("/api/browser/events", handle(async (req, res) => browserBridge.attach(req, res)));
    app.get("/api/browser/sessions", (_req, res) => res.json({ sessions: browserBridge.list() }));
    app.post("/api/browser/:sessionId/state", handle(async (req, res) => {
      browserBridge.state(req.params.sessionId, req.body); res.json({ ok: true });
    }));
    app.post("/api/browser/:sessionId/answer/:id", handle(async (req, res) => {
      browserBridge.answer(req.params.sessionId, req.params.id, req.body); res.json({ ok: true });
    }));
    app.post("/api/verify-pin", handle(async (req, res) => {
      const { pins } = requireCourse();
      const pin = pins.list().find((item) => item.id === req.body?.id || String(item.number) === String(req.body?.id));
      if (!pin) throw Object.assign(new Error("Pin not found."), { statusCode: 404 });
      const result = await browserBridge.request("verify", { pin }, req.body?.sessionId);
      checkRevision(req);
      if (pins.list().find((item) => item.id === pin.id)?.updatedAt !== pin.updatedAt) throw Object.assign(new Error("The pin changed during verification. Read it again."), { statusCode: 409 });
      res.json({ ...result, pinId: pin.id, meaning: "Current DOM observation only; compare with the requested change before resolving." });
    }));
    app.post("/api/reload", handle(async (req, res) => {
      const result = await browserBridge.request("reload", {}, req.body?.sessionId);
      checkRevision(req); res.json(result);
    }));

    app.get("/api/pins", (req, res) => {
      let stamp = "empty";
      try { const stat = fs.statSync(current.pins.pinsFile); stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`; } catch { /* no pins yet */ }
      const etag = `"${revision()}:${stamp}:${String(req.query.status ?? "all")}"`;
      res.set("ETag", etag);
      if (req.get("if-none-match") === etag) return res.status(304).end();
      res.json({ pins: current ? current.pins.list({ status: String(req.query.status ?? "all") }) : [] });
    });

    app.post("/api/pins", handle(async (req, res) => {
      const { course, pins } = requireCourse();
      const input = { ...req.body, target: validateTarget(req.body?.target) };
      // Read-only evidence distinguishes declared bindings from search candidates.
      const before = revision();
      let evidence = {};
      try { evidence = await search.find(course.root, input.target ?? {}); } catch { /* a note must survive optional enrichment failures */ }
      if (closing || before !== revision()) throw Object.assign(new Error("The course changed. Reload before saving this note."), { statusCode: 409 });
      checkRevision(req);
      const record = { ...input, capture: { at: new Date().toISOString(), sessionRevision: before, ...(course.sha256 ? { packageSha256: course.sha256 } : {}) }, source: [], sourceSearch: undefined, ...evidence };
      if (!req.body?.qa) {
        const pin = pins.create(record);
        events.emit("pin", { type: "created", pin });
        return res.status(201).json(pin);
      }
      // An agent's QA suggestion: kept apart until the reviewer accepts it, merged when it repeats.
      const { pin, outcome } = pins.suggest(record);
      const runId = req.body.qa.runId;
      let stop = false;
      if (runId && current.qa.active()?.id === runId) ({ stop } = current.qa.noteSuggestion(runId, pin, outcome, pinPlace(pin.page)));
      events.emit("pin", { type: outcome === "created" ? "suggested" : "edited", pin });
      if (outcome === "created") events.emit("qa", { type: "suggested", runId, pin });
      res.status(outcome === "created" ? 201 : 200).json({ ...pin, outcome, stop });
    }));

    // Triage of agent suggestions: accept (they become ordinary open pins), dismiss, or restore.
    app.post("/api/pins/triage", handle(async (req, res) => {
      const action = String(req.body?.action ?? "");
      const changed = requireCourse().pins.triage(req.body?.ids, action);
      for (const pin of changed) events.emit("pin", { type: action === "accept" ? "accepted" : action === "dismiss" ? "dismissed" : "edited", pin });
      res.json({ ok: true, pins: changed });
    }));

    app.post("/api/pins/:id/reattach", handle(async (req, res) => {
      const { course, pins } = requireCourse();
      const target = validateTarget(req.body?.target);
      const before = revision();
      let evidence = {};
      try { evidence = await search.find(course.root, target ?? {}); } catch { /* Retain the attachment even when source search is unavailable. */ }
      if (closing || before !== revision()) throw Object.assign(new Error("The course changed. Reload before reattaching."), { statusCode: 409 });
      checkRevision(req);
      const pin = pins.reattach(req.params.id, { ...req.body, target, source: [], sourceSearch: undefined, ...evidence,
        capture: { at: new Date().toISOString(), sessionRevision: before, ...(course.sha256 ? { packageSha256: course.sha256 } : {}) } });
      events.emit("pin", { type: "edited", pin });
      res.json(pin);
    }));

    app.patch("/api/pins/:id", handle(async (req, res) => {
      const pin = requireCourse().pins.update(req.params.id, req.body ?? {});
      events.emit("pin", { type: req.body?.status ? (pin.status === "resolved" ? "resolved" : "reopened") : "edited", pin });
      res.json(pin);
    }));
    app.delete("/api/pins/:id", handle(async (req, res) => {
      const pin = requireCourse().pins.remove(req.params.id);
      events.emit("pin", { type: "deleted", pin });
      res.json(pin);
    }));

    app.put("/api/pins/:id/frame", express.raw({ type: "image/png", limit: "15mb" }), handle(async (req, res) => {
      res.json(requireCourse().pins.saveFrame(req.params.id, req.body));
    }));

    app.get("/api/pins/:id/frame", handle(async (req, res) => {
      const file = requireCourse().pins.frameFile(req.params.id);
      if (!file || !fs.existsSync(file)) return res.status(404).end();
      // Live-course screenshots live inside .scormplayer; this route serves only the
      // exact frame belonging to a saved pin, including when a parent is hidden.
      res.type("png").sendFile(file, { dotfiles: "allow" });
    }));

    // Agent QA pass. The agent drives the reviewer's open tab through the browser bridge; the
    // server keeps the run, its log, and the suggestions.
    const QA_TIMEOUT = 30_000;
    const qaRun = (id) => {
      const opened = requireCourse();
      const run = opened.qa.active();
      if (!run || (id && run.id !== id)) throw Object.assign(new Error(id ? `QA run ${id} isn't in progress.` : "No QA run is in progress. Start one with scormplayer_qa_start."), { statusCode: 409 });
      return { opened, run };
    };
    const ask = async (action, payload, req, timeout = QA_TIMEOUT) => {
      const answer = await browserBridge.request(action, payload, req.body?.sessionId, timeout);
      checkRevision(req);
      const observation = answer.observation ?? {};
      if (observation.error) throw Object.assign(new Error(observation.error), { statusCode: observation.statusCode ?? 409 });
      return observation;
    };
    const qaRubric = (course) => {
      let config = null;
      try { config = findConfig(course.source); } catch { /* an invalid config gives no rubric */ }
      const qa = config?.data?.qa;
      if (!qa || typeof qa !== "object") return null;
      const rubric = { ...qa };
      if (typeof qa.styleGuide === "string") {
        try { rubric.styleGuideText = fs.readFileSync(path.resolve(config.root, qa.styleGuide), "utf8").slice(0, 20_000); }
        catch { rubric.styleGuideText = null; }
      }
      return rubric;
    };
    const qaSummary = (opened, run) => ({
      run,
      logFile: opened.qa.logFile,
      suggestions: opened.pins.list().filter((pin) => pin.origin?.kind === "agent" && (!run || pin.origin.runId === run.id)),
    });

    app.get("/api/qa", handle(async (_req, res) => {
      const opened = requireCourse();
      const active = opened.qa.active();
      const runs = opened.qa.list();
      const pins = opened.pins.list();
      res.json({
        active,
        last: runs.at(-1) ?? null,
        logFile: fs.existsSync(opened.qa.logFile) ? opened.qa.logFile : null,
        counts: { suggested: pins.filter((pin) => pin.status === "suggested").length, dismissed: pins.filter((pin) => pin.status === "dismissed").length },
      });
    }));
    app.get("/api/qa/runs/:id", handle(async (req, res) => res.json(qaSummary(requireCourse(), requireCourse().qa.get(req.params.id)))));

    app.post("/api/qa/runs", handle(async (req, res) => {
      const opened = requireCourse();
      if (!browserBridge.list().length) throw Object.assign(new Error("No review tab is connected. Open the player (scormplayer_open_browser) and wait for the course to load, then start the QA pass."), { statusCode: 409 });
      const rubric = qaRubric(opened.course);
      const run = opened.qa.start({ agent: req.body?.agent, focus: req.body?.focus, modules: req.body?.modules, rubric, replace: req.body?.replace === true });
      try {
        // The tab saves the reviewer's progress first; then the course restarts on a fresh QA attempt.
        await ask("qa-freeze", { runId: run.id }, req);
        opened.qaScorm = createScormStore(cacheDir, opened.course, { scope: "qa" });
        opened.qaScorm.discard();
        const outline = await ask("qa-restart", { runId: run.id }, req);
        events.emit("qa", { type: "started", run });
        const pins = opened.pins.list();
        res.status(201).json({
          run,
          rubric,
          course: { title: opened.course.title, standard: opened.course.standard ?? "scorm", modules: (opened.course.scos ?? []).map((sco, index) => ({ index, title: sco.title })) },
          position: outline.position,
          pages: outline.pages,
          known: pins.filter((pin) => pin.status !== "resolved").map((pin) => ({ number: pin.number, status: pin.status, note: pin.note, page: pin.page?.title, ...(pin.origin ? { category: pin.category, evidence: pin.evidence } : {}) })),
          logFile: opened.qa.logFile,
        });
      } catch (error) {
        try { opened.qa.finish(run.id, { summary: `The run could not start: ${error.message}` }, { course: opened.course, pins: [] }); } catch { /* already ended */ }
        throw error;
      }
    }));

    app.post("/api/qa/snapshot", handle(async (req, res) => {
      const { opened, run } = qaRun(req.body?.runId);
      const snapshot = await ask("qa-snapshot", { screenshot: req.body?.screenshot === true, checks: req.body?.checks !== false }, req);
      res.json({ ...snapshot, stop: opened.qa.get(run.id).state === "stopping" });
    }));

    app.post("/api/qa/navigate", handle(async (req, res) => {
      const { opened, run } = qaRun(req.body?.runId);
      const { module = null, page = null, next = false } = req.body ?? {};
      const result = await ask("qa-navigate", { module, page, next: next === true }, req);
      events.emit("qa", { type: "page", runId: run.id, position: result.position });
      res.json({ ...result, stop: opened.qa.get(run.id).state === "stopping" });
    }));

    app.post("/api/qa/suggest", handle(async (req, res) => {
      const { run } = qaRun(req.body?.runId);
      const { note, selector, text, selectors, region, category, severity, confidence, evidence, agent } = req.body ?? {};
      const result = await ask("qa-pin", { input: { note, selector, text, selectors, region }, qa: { runId: run.id, agent: agent ?? run.agent, category, severity, confidence, evidence } }, req);
      res.json(result);
    }));

    app.post("/api/qa/page", handle(async (req, res) => {
      const { opened, run } = qaRun(req.body?.runId);
      const position = await ask("qa-position", {}, req, 6000);
      const result = opened.qa.logPage(run.id, { ...position, status: req.body?.status, notes: req.body?.notes, checks: req.body?.checks });
      events.emit("qa", { type: "logged", runId: run.id, status: req.body?.status, position });
      res.json({ ok: true, position, pages: result.run.pages.length, stop: result.stop });
    }));

    app.post("/api/qa/runs/:id/stop", handle(async (req, res) => {
      const run = requireCourse().qa.stop(req.params.id);
      events.emit("qa", { type: "stopping", run });
      res.json({ ok: true, run });
    }));

    app.post("/api/qa/runs/:id/finish", handle(async (req, res) => {
      const opened = requireCourse();
      // The tab stops saving the QA attempt before progress switches back to the reviewer's.
      try { await ask("qa-freeze", { runId: req.params.id }, req, 6000); } catch { /* no tab: nothing to save */ }
      const { run, logFile } = opened.qa.finish(req.params.id, { summary: req.body?.summary, checks: req.body?.checks }, { course: opened.course, pins: opened.pins.list() });
      // Back to the reviewer's own progress; a closed tab picks it up when it next loads.
      try { await ask("qa-end", { runId: run.id }, req); } catch { /* best effort */ }
      opened.qaScorm?.discard();
      opened.qaScorm = null;
      events.emit("qa", { type: run.state, run, logFile });
      res.json(qaSummary(opened, run));
    }));

    app.delete("/api/qa/pins", handle(async (req, res) => {
      const removed = requireCourse().pins.clearQa({ runId: typeof req.query.runId === "string" && req.query.runId ? req.query.runId : null });
      for (const pin of removed) events.emit("pin", { type: "deleted", pin });
      res.json({ ok: true, removed: removed.length });
    }));

    app.get("/api/brief", handle(async (req, res) => {
      const ids = typeof req.query.ids === "string" && req.query.ids ? req.query.ids.split(",") : null;
      res.type("text/markdown").send(requireCourse().pins.brief({ status: String(req.query.status ?? "open"), ids }));
    }));

    // The course itself: from source through the project's Vite in Live mode, otherwise its files.
    app.use((req, res, next) => {
      if (!current) return next();
      if (current.liveCourse) return void current.liveCourse.middleware(req, res, next);
      if (!req.path.startsWith("/course/")) return next();
      const { root } = current.course;
      let file;
      try { file = path.resolve(root, decodeURIComponent(req.path.slice("/course/".length))); }
      catch { return res.status(400).end(); }
      if (!isInside(root, file)) return res.status(403).end();
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return res.status(404).end();
      res.sendFile(file, { dotfiles: "allow" });
    });

    if (!fs.existsSync(path.join(clientDir, "index.html"))) {
      throw new Error(`The player UI is not built (${clientDir}). Run npm run build in the scormplayer folder.`);
    }
    app.use((req, res, next) => {
      if (!["GET", "HEAD"].includes(req.method) || !/^\/assets\/[\w.-]+[-.][\w-]{8,}\.(js|css)$/.test(req.path)) return next();
      const file = path.join(clientDir, req.path.slice(1));
      if (!fs.existsSync(file)) return res.set("Cache-Control", "no-store").status(404).type("text").send("Player asset not found. Reload the player.");
      res.vary("Accept-Encoding");
      const encoding = req.acceptsEncodings("br", "gzip", "identity");
      const suffix = encoding === "br" ? ".br" : encoding === "gzip" ? ".gz" : "";
      const compressed = suffix && fs.existsSync(file + suffix);
      if (!compressed && !req.acceptsEncodings("identity")) return res.status(406).end();
      if (compressed) res.set("Content-Encoding", encoding);
      res.set("Cache-Control", "public, max-age=31536000, immutable");
      // Installed players/plugins commonly live below .nvm or .codex. These are
      // known UI files; sendFile's default hidden-path refusal must not block them.
      res.type(path.extname(file)).sendFile(compressed ? file + suffix : file, { dotfiles: "allow" }, (error) => {
        if (!error) return;
        if (res.headersSent) return next(error);
        res.removeHeader("Content-Encoding");
        res.set("Cache-Control", "no-store").status(error.statusCode || 500).type("text").send("Player asset could not load. Reload the player.");
      });
    });
    // A missing asset must never become an HTML document cached at a CSS/JS URL.
    app.use("/assets", (req, res) => res.set("Cache-Control", "no-store").status(404).type("text").send("Player asset not found. Reload the player."));
    app.use(express.static(clientDir, { index: "index.html" }));
    app.use((req, res, next) => (req.method === "GET" ? res.set("Cache-Control", "no-store").sendFile(path.join(clientDir, "index.html"), { dotfiles: "allow" }) : next()));

    const actualPort = await listen(httpServer, host, port);
    const url = `http://${host === "0.0.0.0" ? "localhost" : host}:${actualPort}/`;
    const startedAt = new Date().toISOString();
    if (registryDir) {
      registration = registerPlayer(registryDir, { pid: process.pid, port: actualPort, url, mode, idleMinutes, startedAt, cwd: process.cwd(), ...registryFields(input) });
    }
    return {
      url,
      get course() { return current?.course ?? null; },
      get pins() { return current?.pins ?? null; },
      events,
      open,
      openPackage,
      switchCourse,
      unzip,
      /** @param {{ latest: string, command: string } | null} value */
      setUpdate(value) { update = value; },
      progress: () => progress,
      liveStatus: () => current?.liveCourse?.status() ?? null,
      /** Milliseconds since anything last asked the player for something. */
      idleFor: () => Date.now() - lastActivity,
      async close() {
        closing = true;
        await opening;
        browserBridge.close();
        search.close();
        registration?.remove();
        lease.close();
        await current?.liveCourse?.close();
        closeSockets();
        httpServer.closeAllConnections?.();
        await new Promise((resolve) => httpServer.close(resolve));
      },
    };
  } catch (error) {
    browserBridge.close();
    search.close();
    lease.close();
    registration?.remove();
    await current?.liveCourse?.close();
    closeSockets();
    httpServer.closeAllConnections?.();
    if (httpServer.listening) await new Promise((resolve) => httpServer.close(resolve));
    throw error;
  }
}

function isXapi(course) {
  return course.standard === "xapi" || course.standard === "cmi5";
}

function xapiLaunchUrl(sco) {
  return `/api/xapi/launch?au=${encodeURIComponent(sco.id)}`;
}

function safeZipName(value) {
  const base = path.basename(decodeURIComponentSafe(String(value ?? "course.zip"))).replace(/[^\w.\- ()]+/g, "_").slice(0, 120) || "course.zip";
  return /\.zip$/i.test(base) ? base : `${base}.zip`;
}

/** Listen on the requested port, or the next free one (up to 20 tries). Port 0 picks any. */
async function listen(server, host, port) {
  for (let attempt = 0; attempt < PORT_RANGE; attempt += 1) {
    const candidate = port === 0 ? 0 : port + attempt;
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => { server.off("listening", onListening); reject(error); };
        const onListening = () => { server.off("error", onError); resolve(); };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(candidate, host);
      });
      return server.address().port;
    } catch (error) {
      if (error.code !== "EADDRINUSE" || port === 0) throw error;
    }
  }
  throw Object.assign(new UserError(`Ports ${port}–${port + PORT_RANGE - 1} are all in use. Pass --port to choose another.`), { code: "PORTS_FULL", firstPort: port });
}

function handle(fn) {
  return (req, res, next) => fn(req, res, next).catch((error) => {
    const status = error.statusCode ?? (error instanceof UserError ? 400 : 500);
    res.status(status).json({ error: error.message });
  });
}

function encodePath(value) {
  const cut = value.search(/[?#]/);
  const pathname = cut < 0 ? value : value.slice(0, cut);
  const rest = cut < 0 ? "" : value.slice(cut);
  return pathname.split("/").map((part) => encodeURIComponent(decodeURIComponentSafe(part))).join("/") + rest;
}

function decodeURIComponentSafe(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}
