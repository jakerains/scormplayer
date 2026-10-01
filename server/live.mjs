import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export const LIVE_BASE = "/course/";

/**
 * Serve a Vite project from source under /course/ with hot reload, using the project's own
 * Vite, plugins and config. The project's hot-reload socket shares the player's HTTP server on
 * the /course/ path, so the course stays same-origin with the player (pins can read the page).
 */
export async function startLiveCourse({ root, viteConfig, httpServer }) {
  let vitePackagePath;
  try {
    vitePackagePath = createRequire(path.join(root, "package.json")).resolve("vite/package.json");
  } catch {
    throw new Error(`Live mode uses the project's own Vite, and none is installed in ${root}. Run your package manager's install there first.`);
  }
  const vitePackage = JSON.parse(fs.readFileSync(vitePackagePath, "utf8"));
  const major = Number(String(vitePackage.version).split(".")[0]);
  if (major < 5) throw new Error(`Live mode needs Vite 5 or newer; ${root} has Vite ${vitePackage.version}.`);
  const { createServer } = await import(pathToFileURL(path.join(path.dirname(vitePackagePath), "dist/node/index.js")).href);

  // Vite 8 names the shared socket server `server.ws`; earlier majors use `server.hmr.server`.
  const socket = { server: httpServer };
  const vite = await createServer({
    root,
    configFile: viteConfig ?? false,
    appType: "custom",
    clearScreen: false,
    logLevel: "warn",
    server: {
      middlewareMode: true,
      ...(major >= 8 ? { ws: socket } : { hmr: socket }),
    },
    plugins: [{
      // Runs after the project's plugins, so a plugin that forces `base: './'` for packaging
      // doesn't stop module URLs resolving under /course/. Dev only; builds never see it.
      name: "scormplayer-live-base",
      enforce: "post",
      config: () => ({ base: LIVE_BASE }),
    }],
  });

  let lastChangeAt = null;
  const noteChange = () => { lastChangeAt = Date.now(); };
  vite.watcher.on("change", noteChange);
  vite.watcher.on("add", noteChange);
  vite.watcher.on("unlink", noteChange);

  async function middleware(req, res, next) {
    if (!req.url.startsWith(LIVE_BASE) && req.url !== "/course") return next();
    const pathname = req.path.slice(LIVE_BASE.length - 1) || "/";
    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      try {
        const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
        res.set("Cache-Control", "no-store");
        return res.type("html").send(await vite.transformIndexHtml(req.originalUrl, html));
      } catch (error) {
        return res.status(500).type("text").send(`Could not render ${root}/index.html: ${error?.message ?? error}`);
      }
    }
    vite.middlewares(req, res, () => res.status(404).end());
  }

  return {
    middleware,
    status: () => ({ lastChangeAt: lastChangeAt ? new Date(lastChangeAt).toISOString() : null }),
    close: () => vite.close(),
  };
}
