import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import app from "./index.js";

await app.connect(new StdioServerTransport());
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await app.close();
}
process.stdin.once("end", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
