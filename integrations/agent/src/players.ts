import { listPlayers } from "../../../server/registry.mjs";

export type Selection = { playerId: string; revision: string };
export function players() {
  return listPlayers(process.env.SCORMPLAYER_REGISTRY_DIR).filter((entry: any) => {
    try {
      const url = new URL(entry.url);
      return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && Number(url.port) === entry.port && !url.username && !url.password && url.pathname === "/";
    } catch { return false; }
  }).map((entry: any) => ({ ...entry, playerId: `${entry.pid}:${entry.port}` }));
}

export async function connect(playerId: string, revision?: string) {
  const player = players().find((entry: any) => entry.playerId === playerId);
  if (!player) throw new Error("Player is no longer registered. Call scormplayer_list_players again.");
  const identity = await request(player.url, "api/player");
  if (identity.pid !== player.pid) throw new Error("The port belongs to a different process. Rediscover players.");
  if (revision && identity.revision !== revision) throw new Error("The course changed. Refresh its status before continuing.");
  const current = revision ?? identity.revision;
  // Tool use is real activity; ordinary browser polling is not.
  await request(player.url, "api/active", current, {});
  return {
    player,
    browserBridgeVersion: identity.browserBridgeVersion,
    revision: current as string,
    get: (endpoint: string) => request(player.url, endpoint, current),
    write: (endpoint: string, body: unknown, method?: "POST" | "PATCH" | "PUT" | "DELETE") => request(player.url, endpoint, current, body, method),
  };
}

/** QA calls drive the review tab (reloading, navigating, scanning), so they may take a while. */
const timeoutFor = (endpoint: string) => (endpoint.startsWith("api/qa") ? 90_000 : 10_000);

async function request(base: string, endpoint: string, revision?: string, body?: unknown, method?: "POST" | "PATCH" | "PUT" | "DELETE"): Promise<any> {
  const verb = method ?? (endpoint === "api/active" ? "POST" : /^api\/pins\/[^/]+$/.test(endpoint) && endpoint !== "api/pins/triage" ? "PATCH" : "POST");
  const response = await fetch(new URL(endpoint, base), {
    redirect: "error",
    signal: AbortSignal.timeout(timeoutFor(endpoint)),
    headers: { ...(revision ? { "X-Scormplayer-Revision": revision } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { method: verb, body: JSON.stringify(body) } : {}),
  });
  if (response.status === 204) return null;
  const type = response.headers.get("content-type") ?? "";
  const data = type.includes("json") ? await response.json() : type.includes("image/png") ? await response.arrayBuffer() : await response.text();
  if (!response.ok) throw new Error(data?.error ?? `Player request failed (${response.status}).`);
  return data;
}
