import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Every running player leaves a small file here (one per process, removed when it stops), so
 * `scormplayer ps` can list them, `scormplayer stop` can end them, and opening a course that is
 * already open reuses that player instead of starting another. A file whose process has died
 * (killed outright, a crash) is cleaned up the next time anyone lists the players.
 */

/** Per user, whatever cache folder a player was started with: %LOCALAPPDATA% or XDG_CACHE_HOME/~/.cache. */
export function defaultRegistryDir() {
  if (process.platform === "win32" && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, "scormplayer", "Cache", "players");
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "scormplayer", "players");
}

/**
 * Record this player. Returns `update(fields)` for when it opens another course, and
 * `remove()` for when it stops.
 */
export function registerPlayer(dir, entry) {
  // One file per player; a program using the library can run several.
  const file = path.join(dir, `${entry.pid}-${entry.port}.json`);
  let current = { ...entry };
  const write = () => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(current));
    } catch { /* the registry is a convenience; a player runs without it */ }
  };
  write();
  return {
    update(fields) { current = { ...current, ...fields }; write(); },
    remove() { fs.rmSync(file, { force: true }); },
  };
}

/** The players that are still running, oldest first. Files left by dead processes are removed. */
export function listPlayers(dir = defaultRegistryDir()) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((name) => name.endsWith(".json")); } catch { return []; }
  const players = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let entry;
    try { entry = JSON.parse(fs.readFileSync(file, "utf8")); } catch { fs.rmSync(file, { force: true }); continue; }
    if (!isAlive(entry.pid)) { fs.rmSync(file, { force: true }); continue; }
    players.push(entry);
  }
  return players.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

/** A running player already serving this course with these pins, if there is one. */
export function findPlayer({ input, pinsFile = null }, dir = defaultRegistryDir()) {
  const target = path.resolve(input);
  return listPlayers(dir).find((player) => player.input && path.resolve(player.input) === target
    && (!pinsFile || path.resolve(pinsFile) === player.pinsFile)) ?? null;
}

/** Stop a player by its process id: ask it to stop, then insist after a few seconds. */
export async function stopPlayer(pid, { wait = 4000 } = {}) {
  const gone = () => !isAlive(pid) || isZombie(pid);
  try { process.kill(pid, "SIGTERM"); } catch { return gone(); }
  const deadline = Date.now() + wait;
  while (Date.now() < deadline) {
    if (gone()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  await new Promise((resolve) => setTimeout(resolve, 200));
  return gone();
}

/**
 * A process that has exited but whose parent hasn't collected it yet (macOS and Linux). It still
 * answers to its process id, but it's stopped and holds no port.
 */
function isZombie(pid) {
  if (process.platform === "win32") return false;
  try { return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().startsWith("Z"); }
  catch { return false; }
}

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

/**
 * What a running player says about itself (process id, how long since a browser asked for
 * anything), or null when it doesn't answer. Older versions have no such endpoint, so they
 * are recognized by their course endpoint instead.
 */
export async function askPlayer(url, { timeout = 800 } = {}) {
  try {
    const response = await fetch(new URL("api/player", url), { signal: AbortSignal.timeout(timeout) });
    if (response.ok) return await response.json();
  } catch { /* not answering */ }
  return null;
}

/**
 * Players on ports of the range that aren't in the registry: ones started by a scormplayer
 * from before the registry (0.8.3 and older). Each has a port, URL and title; the process id
 * is looked up from the port where the system can tell.
 */
export async function unregisteredPlayers({ first = 4620, count = 20, known = [], host = "127.0.0.1" } = {}) {
  const ports = Array.from({ length: count }, (_, index) => first + index).filter((port) => !known.includes(port));
  const found = await Promise.all(ports.map(async (port) => {
    const url = `http://${host}:${port}/`;
    try {
      const response = await fetch(new URL("api/course", url), { signal: AbortSignal.timeout(400) });
      if (!response.ok || !(response.headers.get("content-type") ?? "").includes("json")) return null;
      const course = await response.json();
      if (!course?.empty && !course?.launchUrl) return null;
      return { port, url, pid: pidOnPort(port), title: course.title ?? null, source: course.source ?? null, kind: course.kind ?? null, registered: false };
    } catch {
      return null;
    }
  }));
  return found.filter(Boolean);
}

/** The process listening on a local port, where the system can say (lsof on macOS and Linux, netstat on Windows). */
export function pidOnPort(port) {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const line = out.split(/\r?\n/).find((row) => new RegExp(`[:.]${port}\\s+\\S+\\s+LISTENING`, "i").test(row));
      const pid = Number(line?.trim().split(/\s+/).pop());
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    }
    const out = execFileSync("lsof", ["-nP", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const pid = Number(out.trim().split(/\s+/)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}
