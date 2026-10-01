import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import express from "express";
import { resolveCourse, isInside, UserError } from "./course.mjs";
import { createPinStore } from "./pins.mjs";
import { findSourceText } from "./source-match.mjs";
import { startLiveCourse, LIVE_BASE } from "./live.mjs";
import { pruneCache } from "./cache.mjs";
import { defaultUnzipFolder, existingUnzip, unzipCourse } from "./unzip.mjs";

export { resolveCourse, UserError } from "./course.mjs";
export { createPinStore } from "./pins.mjs";
export { createDashboard, openBrowser, copyToClipboard } from "./tui.mjs";
export { cacheEntries, clearCache, pruneCache } from "./cache.mjs";
export { checkForUpdate } from "./update.mjs";
export { defaultUnzipFolder, unzipCourse } from "./unzip.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.resolve(HERE, "../dist/client");

/**
 * Start the player. With `input` it opens that course; without one it starts empty and the page
 * offers a drop zone. Either way a SCORM zip can be dropped or chosen in the browser to switch
 * courses while it runs.
 *
 * @param {{ input?: string | null, cacheDir: string, host?: string, port?: number, live?: boolean,
 *   pinsFile?: string | null, pinsDir?: string, clientDir?: string }} options
 */
export async function startPlayer({ input = null, cacheDir, host = "127.0.0.1", port = 4620, live = false, pinsFile = null, pinsDir = process.cwd(), clientDir = CLIENT_DIR }) {
  // What the terminal dashboard shows: pins, source changes, SCORM progress, browser visits.
  const events = new EventEmitter();
  let progress = null;
  let current = null;
  const app = express();
  const httpServer = createServer(app);

  async function open(target, options = {}) {
    const course = resolveCourse(target, { cacheDir, live: options.live ?? false, pinsFile: options.pinsFile ?? null });
    // Keep the cache small; never remove what is being opened.
    try { pruneCache(cacheDir, { keep: [course.root, target] }); } catch { /* best effort */ }
    if (options.displayName) course.displayName = options.displayName;
    const pins = createPinStore(course.pinsFile, course);
    const liveCourse = course.kind === "live"
      ? await startLiveCourse({ root: course.root, viteConfig: course.viteConfig, httpServer, onChange: (change) => events.emit("source", change) })
      : null;
    const previous = current;
    // Pins kept somewhere chosen on purpose (--pins, a project config) stay there after unzipping.
    current = { course, pins, liveCourse, keepPinsFile: Boolean(options.keepPinsFile) };
    progress = null;
    await previous?.liveCourse?.close();
    if (started) events.emit("course", course);
    return course;
  }

  let started = false;
  if (input) await open(input, { live, pinsFile, keepPinsFile: Boolean(pinsFile) });

  /** Unzip the open zip to a folder (beside it by default) and reopen the player on that folder. */
  async function unzip(folder) {
    const { course, keepPinsFile } = requireCourse();
    const result = unzipCourse(course, { folder: folder || defaultUnzipFolder(course), keepPinsFile });
    await open(result.folder, { pinsFile: result.pinsFile, keepPinsFile });
    events.emit("unzipped", result);
    return result;
  }
  started = true;

  const requireCourse = () => {
    if (!current) throw Object.assign(new Error("No course is open."), { statusCode: 409 });
    return current;
  };

  app.use(express.json({ limit: "1mb" }));
  app.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

  app.get("/api/course", (_req, res) => {
    events.emit("browser");
    if (!current) return res.json({ empty: true });
    const { course } = current;
    res.json({
      title: course.title,
      kind: course.kind,
      scormVersion: course.scormVersion,
      source: course.displayName ?? course.source,
      launchUrl: course.kind === "live" ? LIVE_BASE : `/course/${encodePath(course.launch)}`,
      courseKey: course.sha256 ?? course.source,
      pinsFile: course.pinsFile,
      // A zip plays from a copy in the cache, so it can't be edited until it is unzipped.
      editable: course.kind !== "package",
      ...(course.kind === "package" ? { unzip: { folder: defaultUnzipFolder(course), existing: existingUnzip(course) } } : {}),
      // Packages with several SCOs: each one, in manifest order, to switch between.
      ...(course.scos?.length > 1 ? { scos: course.scos.map((sco) => ({ id: sco.id, title: sco.title, launchUrl: `/course/${encodePath(sco.launch)}` })) } : {}),
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
    const course = await open(file, { pinsFile: path.join(pinsDir, name.replace(/\.zip$/i, ".pins.json")), displayName: name });
    res.json({ ok: true, title: course.title });
  }));

  app.post("/api/unzip", handle(async (req, res) => {
    const folder = typeof req.body?.folder === "string" && req.body.folder.trim() ? path.resolve(req.body.folder.trim().replace(/^~(?=$|[\\/])/, os.homedir())) : null;
    res.json({ ok: true, ...(await unzip(folder)) });
  }));

  app.get("/api/status", (_req, res) => res.json(current?.liveCourse?.status() ?? { lastChangeAt: null }));

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

  app.get("/api/pins", (req, res) => res.json({ pins: current ? current.pins.list({ status: String(req.query.status ?? "all") }) : [] }));

  app.post("/api/pins", handle(async (req, res) => {
    const { course, pins } = requireCourse();
    const input = req.body ?? {};
    // Point the pin at its source text where the course files contain it. Read-only search.
    const text = input.target?.text || input.target?.name;
    const source = text ? findSourceText(course.root, String(text)) : [];
    const pin = pins.create({ ...input, source });
    events.emit("pin", { type: "created", pin });
    res.status(201).json(pin);
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
    res.type("png").sendFile(file);
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
  app.use(express.static(clientDir, { index: "index.html" }));
  app.use((req, res, next) => (req.method === "GET" ? res.sendFile(path.join(clientDir, "index.html")) : next()));

  const actualPort = await listen(httpServer, host, port);
  const url = `http://${host === "0.0.0.0" ? "localhost" : host}:${actualPort}/`;
  return {
    url,
    get course() { return current?.course ?? null; },
    get pins() { return current?.pins ?? null; },
    events,
    open,
    unzip,
    progress: () => progress,
    liveStatus: () => current?.liveCourse?.status() ?? null,
    async close() {
      await current?.liveCourse?.close();
      httpServer.closeAllConnections?.();
      await new Promise((resolve) => httpServer.close(resolve));
    },
  };
}

function safeZipName(value) {
  const base = path.basename(decodeURIComponentSafe(String(value ?? "course.zip"))).replace(/[^\w.\- ()]+/g, "_").slice(0, 120) || "course.zip";
  return /\.zip$/i.test(base) ? base : `${base}.zip`;
}

/** Listen on the requested port, or the next free one (up to 20 tries). Port 0 picks any. */
async function listen(server, host, port) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
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
  throw new Error(`Ports ${port}–${port + 19} are all in use. Pass --port to choose another.`);
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
