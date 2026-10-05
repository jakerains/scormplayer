import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Launch only a validated player's loopback URL. Never accept arbitrary paths,
// shell commands or external destinations from a view or course.
export async function launchPlayerBrowser(url, { platform = process.platform, execute = promisify(execFile) } = {}) {
  const target = new URL(url);
  if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || !target.port || target.username || target.password || target.pathname !== "/" || target.search || target.hash) {
    throw new Error("Browser launch requires a registered loopback player address.");
  }
  const [command, args] = platform === "darwin" ? ["open", [target.href]]
    : platform === "linux" ? ["xdg-open", [target.href]]
    : platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", target.href]]
    : [null, []];
  if (!command) throw new Error("Open the player address in your browser on this platform.");
  try { await execute(command, args, { timeout: 10000, windowsHide: true }); }
  catch { throw new Error(`The system could not open a browser. Copy this player address: ${target.href}`); }
}
