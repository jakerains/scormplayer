import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";

const held = new Set();
/**
 * Serialize short file transactions across processes, including aliases of a parent folder.
 * `wait` is how long to wait for another process to finish; `stale` is when a lock left by a
 * process that died counts as abandoned. Pin edits take milliseconds, so the defaults are short;
 * the course cache passes longer ones, since unpacking a large zip can take a while.
 */
export function withFileLock(file, fn, { wait = 5000, stale = 10_000 } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const key = path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
  if (held.has(key)) return fn();
  const deadline = Date.now() + wait;
  let release;
  while (!release) {
    try { release = lockfile.lockSync(key, { realpath: false, stale }); }
    catch (error) {
      if (error.code !== "ELOCKED" || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  held.add(key);
  try { return fn(); } finally { held.delete(key); release(); }
}
