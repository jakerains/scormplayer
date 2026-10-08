import { randomUUID } from "node:crypto";

const failure = (message, statusCode = 409) => Object.assign(new Error(message), { statusCode });

/** The existing review tab supplies DOM observations; no separate headless course instance. */
export function createBrowserBridge(revision) {
  const sessions = new Map();
  const pending = new Map();
  function cancel(sessionId, message) {
    for (const [id, job] of pending) if (!sessionId || job.sessionId === sessionId) {
      clearTimeout(job.timer); pending.delete(id); job.reject(failure(message));
    }
  }
  return {
    attach(req, res) {
      if (req.query.revision !== revision()) throw failure("The course changed. Reload the player.");
      if (sessions.size >= 16) throw failure("Too many browser tabs connected.", 429);
      const id = randomUUID();
      res.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-store", "Connection": "keep-alive" });
      res.flushHeaders();
      const session = { id, revision: revision(), res, state: null, seen: 0 };
      sessions.set(id, session);
      res.write(`data: ${JSON.stringify({ type: "connected", sessionId: id })}\n\n`);
      req.on("close", () => { sessions.delete(id); cancel(id, "The review tab disconnected. Retry after it reconnects."); });
    },
    state(id, state) {
      const session = sessions.get(id);
      if (!session || session.revision !== revision()) throw failure("Browser session expired.");
      if (!state || JSON.stringify(state).length > 8000) throw failure("Invalid browser state.", 400);
      session.state = { page: state.page, ready: state.ready === true, visible: state.visible === true }; session.seen = Date.now();
    },
    list() {
      return [...sessions.values()].filter((s) => s.revision === revision() && s.state && Date.now() - s.seen < 15_000)
        .map((s) => ({ sessionId: s.id, ...s.state, lastSeenAt: new Date(s.seen).toISOString() }));
    },
    request(action, payload, sessionId) {
      const available = this.list();
      if (!available.length) throw failure("No connected review browser. Open this player's URL and wait for the lesson to load.");
      if (!sessionId && available.length !== 1) throw failure("Several review tabs are connected. Call scormplayer_list_browser_sessions and choose a sessionId.");
      const selected = available.find((s) => s.sessionId === (sessionId || available[0].sessionId));
      if (!selected) throw failure("That browser session is unavailable. List browser sessions again.");
      if (pending.size >= 16) throw failure("Too many browser requests. Try again shortly.", 429);
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(failure("The review tab did not respond. Bring it to the foreground and retry.", 504)); }, 6000);
        pending.set(id, { sessionId: selected.sessionId, revision: revision(), resolve, reject, timer });
        sessions.get(selected.sessionId).res.write(`data: ${JSON.stringify({ type: "request", id, revision: revision(), action, ...payload })}\n\n`);
      });
    },
    answer(sessionId, id, result) {
      const job = pending.get(id);
      if (!job || job.sessionId !== sessionId) throw failure("Browser request expired.");
      if (!result || JSON.stringify(result).length > 100_000) throw failure("Invalid browser observation.", 400);
      clearTimeout(job.timer); pending.delete(id);
      if (job.revision !== revision()) job.reject(failure("The course changed during verification."));
      else job.resolve({ sessionId, revision: job.revision, receivedAt: new Date().toISOString(), observation: result });
    },
    close() {
      cancel(null, "The player closed or changed course.");
      for (const session of sessions.values()) session.res.end();
      sessions.clear();
    },
  };
}
