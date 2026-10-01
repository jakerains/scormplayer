import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import express from "express";
import { resolveCourse, isInside, UserError } from "./course.mjs";
import { createPinStore } from "./pins.mjs";
import { findSourceText } from "./source-match.mjs";
import { startLiveCourse, LIVE_BASE } from "./live.mjs";

export { resolveCourse, UserError } from "./course.mjs";
export { createPinStore } from "./pins.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.resolve(HERE, "../dist/client");

/**
 * Start the player for one course.
 *
 * @param {{ input: string, cacheDir: string, host?: string, port?: number, live?: boolean,
 *   pinsFile?: string | null, clientDir?: string }} options
 */
export async function startPlayer({ input, cacheDir, host = "127.0.0.1", port = 4620, live = false, pinsFile = null, clientDir = CLIENT_DIR }) {
  const course = resolveCourse(input, { cacheDir, live, pinsFile });
  const pins = createPinStore(course.pinsFile, course);
  const app = express();
  const httpServer = createServer(app);
  const liveCourse = course.kind === "live"
    ? await startLiveCourse({ root: course.root, viteConfig: course.viteConfig, httpServer })
    : null;

  app.use(express.json({ limit: "1mb" }));
  app.use((_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

  app.get("/api/course", (_req, res) => {
    res.json({
      title: course.title,
      kind: course.kind,
      scormVersion: course.scormVersion,
      source: course.source,
      launchUrl: course.kind === "live" ? LIVE_BASE : `/course/${encodePath(course.launch)}`,
      courseKey: course.sha256 ?? course.source,
      pinsFile: course.pinsFile,
    });
  });

  app.get("/api/status", (_req, res) => res.json(liveCourse?.status() ?? { lastChangeAt: null }));

  app.get("/api/pins", (req, res) => res.json({ pins: pins.list({ status: String(req.query.status ?? "all") }) }));

  app.post("/api/pins", handle(async (req, res) => {
    const input = req.body ?? {};
    // Point the pin at its source text where the course files contain it. Read-only search.
    const text = input.target?.text || input.target?.name;
    const source = text ? findSourceText(course.root, String(text)) : [];
    res.status(201).json(pins.create({ ...input, source }));
  }));

  app.patch("/api/pins/:id", handle(async (req, res) => res.json(pins.update(req.params.id, req.body ?? {}))));
  app.delete("/api/pins/:id", handle(async (req, res) => res.json(pins.remove(req.params.id))));

  app.put("/api/pins/:id/frame", express.raw({ type: "image/png", limit: "15mb" }), handle(async (req, res) => {
    res.json(pins.saveFrame(req.params.id, req.body));
  }));

  app.get("/api/pins/:id/frame", handle(async (req, res) => {
    const file = pins.frameFile(req.params.id);
    if (!file || !fs.existsSync(file)) return res.status(404).end();
    res.type("png").sendFile(file);
  }));

  app.get("/api/brief", handle(async (req, res) => {
    const ids = typeof req.query.ids === "string" && req.query.ids ? req.query.ids.split(",") : null;
    res.type("text/markdown").send(pins.brief({ status: String(req.query.status ?? "open"), ids }));
  }));

  if (liveCourse) {
    app.use((req, res, next) => void liveCourse.middleware(req, res, next));
  } else {
    app.use("/course", (req, res, next) => {
      let file;
      try { file = path.resolve(course.root, decodeURIComponent(req.path).replace(/^\/+/, "")); }
      catch { return res.status(400).end(); }
      if (!isInside(course.root, file)) return res.status(403).end();
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return next();
      res.sendFile(file, { dotfiles: "allow" });
    }, (_req, res) => res.status(404).end());
  }

  if (!fs.existsSync(path.join(clientDir, "index.html"))) {
    throw new Error(`The player UI is not built (${clientDir}). Run npm run build in the scormplayer folder.`);
  }
  app.use(express.static(clientDir, { index: "index.html" }));
  app.use((req, res, next) => (req.method === "GET" ? res.sendFile(path.join(clientDir, "index.html")) : next()));

  const actualPort = await listen(httpServer, host, port);
  const url = `http://${host === "0.0.0.0" ? "localhost" : host}:${actualPort}/`;
  return {
    url,
    course,
    pins,
    async close() {
      await liveCourse?.close();
      httpServer.closeAllConnections?.();
      await new Promise((resolve) => httpServer.close(resolve));
    },
  };
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
