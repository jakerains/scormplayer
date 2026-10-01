import fs from "node:fs";
import path from "node:path";

const PACKAGE = "@jakerains/scormplayer";
const DAY = 86_400_000;

/**
 * The newer published version, or null. Asks the npm registry at most once a day (the answer is
 * kept in the cache), gives up after a moment, and never runs in CI or when
 * SCORMPLAYER_NO_UPDATE_CHECK / NO_UPDATE_NOTIFIER is set.
 */
export async function checkForUpdate({ current, cacheDir, now = Date.now(), fetchImpl = globalThis.fetch }) {
  if (process.env.CI || process.env.SCORMPLAYER_NO_UPDATE_CHECK || process.env.NO_UPDATE_NOTIFIER) return null;
  const file = path.join(cacheDir, "update-check.json");
  let latest = null;
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (now - saved.checkedAt < DAY) latest = saved.latest;
  } catch { /* no saved answer */ }
  if (!latest) {
    try {
      const response = await fetchImpl(`https://registry.npmjs.org/${PACKAGE.replace("/", "%2f")}/latest`, { signal: AbortSignal.timeout(1500) });
      if (!response.ok) return null;
      latest = (await response.json()).version;
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ latest, checkedAt: now }));
    } catch {
      return null;
    }
  }
  return typeof latest === "string" && isNewer(latest, current) ? latest : null;
}

export function isNewer(candidate, current) {
  const parse = (version) => String(version).split("-")[0].split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

export const UPDATE_COMMAND = `npm i -g ${PACKAGE}@latest`;
