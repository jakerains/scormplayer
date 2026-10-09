import type { ScormData } from "./scorm-api";

export type ScormState = { saved: boolean; epoch: number; selectedSco: string; modules: Record<string, ScormData> };
export type ScormWrite = { epoch: number; selectedSco: string; modules?: Record<string, ScormData>; reset?: boolean };

/** Coalesce API writes, flush commits, and serialize reset behind earlier saves. */
export class ScormPersistence {
  private dirty: Record<string, ScormData> = {};
  private selected = false;
  private timer: number | undefined;
  private queue: Promise<void> = Promise.resolve();
  private resetting = false;

  constructor(public state: ScormState, private write: (patch: ScormWrite, keepalive?: boolean) => Promise<ScormState>, private report: (message: string) => void) {
    if (!state.saved) { this.dirty = { ...state.modules }; this.selected = true; this.schedule(); }
  }

  update(id: string, data: ScormData) {
    if (this.resetting || JSON.stringify(this.state.modules[id]) === JSON.stringify(data)) return;
    this.state.modules = { ...this.state.modules, [id]: { ...data } };
    this.dirty = { ...this.dirty, [id]: { ...data } };
    this.schedule();
  }

  select(id: string) {
    if (this.resetting || this.state.selectedSco === id) return;
    this.state.selectedSco = id;
    this.selected = true;
    this.schedule();
  }

  private schedule() {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.flush(), 100);
  }

  flush(keepalive = false): Promise<void> {
    window.clearTimeout(this.timer);
    if (this.resetting || (!Object.keys(this.dirty).length && !this.selected)) return this.queue;
    const patch = { epoch: this.state.epoch, selectedSco: this.state.selectedSco, modules: this.dirty };
    this.dirty = {};
    this.selected = false;
    this.queue = this.queue.then(async () => {
      try { await this.write(patch, keepalive); this.report(""); }
      catch (error) {
        // A newer commit can already be queued; retry the latest local values.
        const latest = Object.fromEntries(Object.keys(patch.modules).map((id) => [id, { ...this.state.modules[id] }]));
        this.dirty = { ...latest, ...this.dirty };
        this.selected = true;
        this.report(error instanceof Error ? error.message : "Progress could not be saved.");
      }
    });
    return this.queue;
  }

  /** Stop saving (an agent's QA pass switches the course to another attempt). Pending writes are dropped. */
  freeze() {
    window.clearTimeout(this.timer);
    this.resetting = true;
    this.dirty = {};
    this.selected = false;
  }

  async reset(firstSco: string) {
    window.clearTimeout(this.timer);
    this.resetting = true;
    try {
      await this.queue;
      const state = await this.write({ epoch: this.state.epoch, selectedSco: firstSco, reset: true });
      this.state = state;
      this.dirty = {};
      this.selected = false;
      this.report("");
    } finally { this.resetting = false; }
  }
}
