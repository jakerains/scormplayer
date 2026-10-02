import fs from "node:fs";
import path from "node:path";
import { withFileLock } from "./file-lock.mjs";
import { randomUUID } from "node:crypto";

/**
 * Unpacked zips and zips opened from the browser live in the cache. Each entry is stamped when it
 * is used; entries unused for MAX_AGE_DAYS go, and beyond MAX_ENTRIES the least recently used go.
 * The course being opened is never removed.
 */
export const MAX_ENTRIES = 20;
export const MAX_AGE_DAYS = 14;
const STAMP = ".last-used";

export function touchCacheEntry(dir) {
  try {
    if (fs.statSync(dir).isDirectory()) fs.writeFileSync(path.join(dir, STAMP), new Date().toISOString());
    else fs.utimesSync(dir, new Date(), new Date());
  } catch { /* the entry may not exist yet */ }
}

/** Every cache entry with its size and when it was last used. */
export function cacheEntries(cacheDir, { sizes = true } = {}) {
  const out = [];
  for (const area of ["packages", "uploads"]) {
    const dir = path.join(cacheDir, area);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      let used;
      try {
        const stat = fs.statSync(full);
        used = stat.isDirectory() && fs.existsSync(path.join(full, STAMP)) ? fs.statSync(path.join(full, STAMP)).mtimeMs : stat.mtimeMs;
      } catch { continue; }
      out.push({ path: full, area, name, usedAt: used, bytes: sizes ? sizeOf(full) : 0 });
    }
  }
  return out.sort((a, b) => b.usedAt - a.usedAt);
}

/** Remove stale entries. `keep` lists paths that must stay (the course being opened). */
function prune(cacheDir, { keep = [], now = Date.now(), maxEntries = MAX_ENTRIES, maxAgeDays = MAX_AGE_DAYS } = {}) {
  const kept = new Set([...keep, ...leasedPaths(cacheDir)].map((file) => path.resolve(file)));
  const removed = [];
  const all = cacheEntries(cacheDir, { sizes: false });
  for (const area of ["packages", "uploads"]) {
    const entries = all.filter((entry) => entry.area === area);
    entries.forEach((entry, index) => {
      if (kept.has(path.resolve(entry.path))) return;
      const stale = now - entry.usedAt > maxAgeDays * 86_400_000;
      if (stale || index >= maxEntries) {
        entry.bytes = sizeOf(entry.path);
        fs.rmSync(entry.path, { recursive: true, force: true });
        removed.push(entry);
      }
    });
  }
  return removed;
}

function clear(cacheDir) {
  const protectedPaths = new Set(leasedPaths(cacheDir));
  const entries = cacheEntries(cacheDir).filter((entry) => !protectedPaths.has(path.resolve(entry.path)));
  for (const entry of entries) fs.rmSync(entry.path, { recursive: true, force: true });
  return entries;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function sizeOf(target) {
  try {
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) return stat.size;
    return fs.readdirSync(target).reduce((sum, name) => sum + sizeOf(path.join(target, name)), 0);
  } catch {
    return 0;
  }
}

/** A lease protects every library/CLI player, including players without a registry. */
export function createCacheLease(cacheDir) {
  const dir = path.join(cacheDir, "leases");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${process.pid}-${randomUUID()}.json`);
  return {
    update(paths) {
      const temp = `${file}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ pid: process.pid, paths: paths.filter(Boolean).map((item) => path.resolve(item)) }));
      fs.renameSync(temp, file);
    },
    close() { fs.rmSync(file, { force: true }); },
  };
}

function leasedPaths(cacheDir) {
  const dir = path.join(cacheDir, "leases");
  let files;
  try { files = fs.readdirSync(dir); } catch { return []; }
  const paths = [];
  for (const name of files.filter((name) => name.endsWith(".json"))) {
    const file = path.join(dir, name);
    try {
      const lease = JSON.parse(fs.readFileSync(file, "utf8"));
      try { process.kill(lease.pid, 0); }
      catch (error) {
        if (error.code === "ESRCH") { fs.rmSync(file, { force: true }); continue; }
        if (error.code !== "EPERM") continue;
      }
      paths.push(...lease.paths);
    } catch { /* another process may have just removed its lease */ }
  }
  return paths;
}

/** Cache changes one process at a time. Unpacking a large zip happens inside, so waits are long. */
export function withCacheLock(cacheDir, fn) {
  return withFileLock(path.join(cacheDir, ".cache-transaction"), fn, { wait: 120_000, stale: 300_000 });
}
export function pruneCache(cacheDir, options) {
  return withCacheLock(cacheDir, () => prune(cacheDir, options));
}
export function clearCache(cacheDir) {
  return withCacheLock(cacheDir, () => clear(cacheDir));
}
