import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export function client(entry, registry, cwd, command = globalThis.process.execPath, environment = {}) {
  const process = spawn(command, [entry], { cwd, env: { ...globalThis.process.env, ...environment, SCORMPLAYER_REGISTRY_DIR: registry, SCORMPLAYER_DATA_DIR: path.join(cwd, "agent") }, stdio: ["pipe", "pipe", "pipe"] });
  let sequence = 0, errors = "";
  const pending = new Map();
  process.stderr.on("data", (data) => { errors += data; });
  createInterface({ input: process.stdout }).on("line", (line) => {
    try {
      const response = JSON.parse(line);
      const request = pending.get(response.id);
      if (request) { pending.delete(response.id); clearTimeout(request.timer); request.resolve(response); }
    } catch (error) { for (const request of pending.values()) request.reject(new Error(`Non-protocol stdout: ${line}`)); }
  });
  process.on("exit", (code) => { for (const request of pending.values()) request.reject(new Error(`MCP exited ${code}: ${errors}`)); });
  return {
    request(method, params = {}) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out ${method}: ${errors}`)); }, 15_000);
        pending.set(id, { resolve, reject, timer });
        process.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    notify(method) { process.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n"); },
    close() { process.stdin.end(); process.kill("SIGTERM"); for (const request of pending.values()) clearTimeout(request.timer); },
  };
}
