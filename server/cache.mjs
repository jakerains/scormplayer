import fs from "node:fs";
import path from "node:path";

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
export function cacheEntries(cacheDir) {
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
      out.push({ path: full, area, name, usedAt: used, bytes: sizeOf(full) });
    }
  }
  return out.sort((a, b) => b.usedAt - a.usedAt);
}

/** Remove stale entries. `keep` lists paths that must stay (the course being opened). */
export function pruneCache(cacheDir, { keep = [], now = Date.now(), maxEntries = MAX_ENTRIES, maxAgeDays = MAX_AGE_DAYS } = {}) {
  const kept = new Set(keep.map((file) => path.resolve(file)));
  const removed = [];
  for (const area of ["packages", "uploads"]) {
    const entries = cacheEntries(cacheDir).filter((entry) => entry.area === area);
    entries.forEach((entry, index) => {
      if (kept.has(path.resolve(entry.path))) return;
      const stale = now - entry.usedAt > maxAgeDays * 86_400_000;
      if (stale || index >= maxEntries) {
        fs.rmSync(entry.path, { recursive: true, force: true });
        removed.push(entry);
      }
    });
  }
  return removed;
}

export function clearCache(cacheDir) {
  const entries = cacheEntries(cacheDir);
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
