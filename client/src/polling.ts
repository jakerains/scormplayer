/** No overlapping requests; hidden tabs poll less often and refresh when brought forward. */
export function pollWhileVisible(task: () => Promise<unknown>, visibleMs: number, hiddenMs: number) {
  let stopped = false;
  let running = false;
  let timer = 0;
  const run = async () => {
    window.clearTimeout(timer);
    if (stopped || running) return;
    running = true;
    try { await task(); } catch { /* the caller handles display errors */ }
    finally {
      running = false;
      if (!stopped) timer = window.setTimeout(() => void run(), document.hidden ? hiddenMs : visibleMs);
    }
  };
  const changed = () => { void run(); };
  document.addEventListener("visibilitychange", changed);
  void run();
  return () => {
    stopped = true;
    window.clearTimeout(timer);
    document.removeEventListener("visibilitychange", changed);
  };
}
