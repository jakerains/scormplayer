import { Worker } from "node:worker_threads";

/** Keep source scanning off the HTTP event loop; bound queued work and its lifetime. */
export function createSourceSearch() {
  let worker = null;
  let next = 0;
  const pending = new Map();
  const close = () => {
    const previous = worker;
    worker = null;
    for (const job of pending.values()) { clearTimeout(job.timer); job.resolve({ source: [], sourceSearch: { truncated: true, advice: "Source search unavailable or timed out." } }); }
    pending.clear();
    void previous?.terminate();
  };
  return {
    find(root, target) {
      if (pending.size >= 32) return Promise.resolve({ source: [], sourceSearch: { truncated: true, advice: "Source search busy." } });
      if (!worker) {
        worker = new Worker(new URL("./source-worker.mjs", import.meta.url));
        worker.on("message", ({ id, matches }) => {
          const job = pending.get(id);
          if (!job) return;
          clearTimeout(job.timer);
          pending.delete(id);
          job.resolve(matches);
        });
        const created = worker;
        const failed = () => { if (worker === created) close(); };
        worker.on("error", failed);
        worker.on("exit", failed);
        worker.unref();
      }
      return new Promise((resolve) => {
        const id = ++next;
        const timer = setTimeout(close, 5000);
        pending.set(id, { resolve, timer });
        worker.postMessage({ id, root, target });
      });
    },
    close,
  };
}
