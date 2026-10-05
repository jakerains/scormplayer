import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startPlayer } from "../../../server/index.mjs";

type Player = Awaited<ReturnType<typeof startPlayer>>;
let session: Promise<Player> | null = null;

export function ensureSession() {
  if (!session) session = createSession().catch((error) => { session = null; throw error; });
  return session;
}

async function createSession() {
  const data = process.env.SCORMPLAYER_DATA_DIR || process.env.SCORMPLAYER_EXTENSION_DIR || path.join(process.env.XDG_CACHE_HOME || os.homedir(), process.env.XDG_CACHE_HOME ? "scormplayer" : ".cache/scormplayer", "agent");
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(path.join(data, "lessons"), { recursive: true });
  const clientDir = cacheClient(fileURLToPath(new URL("./player-client/", import.meta.url)), data);
  return startPlayer({ cacheDir: path.join(data, "cache"), pinsDir: path.join(data, "lessons"), clientDir, registryDir: process.env.SCORMPLAYER_REGISTRY_DIR,
    mode: "library", idleMinutes: null, port: 4620 });
}

function cacheClient(source: string, data: string) {
  // Hosts may delete an old plugin installation while its MCP process is still
  // running. Serve a complete, immutable asset copy outside that installation.
  const hash = createHash("sha256");
  function visit(directory: string, prefix = "") {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.posix.join(prefix, entry.name);
      if (entry.isDirectory()) visit(path.join(directory, entry.name), name);
      else if (entry.isFile()) hash.update(name).update("\0").update(fs.readFileSync(path.join(directory, entry.name))).update("\0");
    }
  }
  visit(source);
  const root = path.join(data, "player-client");
  const destination = path.join(root, hash.digest("hex"));
  if (fs.existsSync(path.join(destination, "index.html"))) return destination;
  fs.mkdirSync(root, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(root, "copy-"));
  try { fs.cpSync(source, temporary, { recursive: true }); fs.renameSync(temporary, destination); }
  catch (error) { if (!fs.existsSync(path.join(destination, "index.html"))) throw error; }
  finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  return destination;
}

export async function openLesson(playerId: string, revision: string, input: string, live = false) {
  const player = await ensureSession();
  const id = `${process.pid}:${new URL(player.url).port}`;
  if (playerId !== id) throw new Error("Open lesson only targets this MCP server's browser session. Call scormplayer_start first.");
  const identity = await (await fetch(new URL("api/player", player.url))).json();
  if (identity.revision !== revision) throw new Error("The lesson changed. Refresh status before opening another lesson.");
  const target = path.resolve(input.replace(/^~(?=$|[\\/])/, os.homedir()));
  await player.open(target, { revision, live });
  return { playerId, url: player.url };
}

export async function closeSession() {
  const current = session;
  session = null;
  if (current) await (await current).close();
}
