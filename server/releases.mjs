import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const RELEASES_API = "https://api.github.com/repos/jakerains/scormplayer/releases/latest";
const DOWNLOADS = "https://github.com/jakerains/scormplayer/releases/download";
export const releaseFilename = (version, kind = "npm") => kind === "standalone" ? `scormplayer-${version}-standalone.tar.gz` : `jakerains-scormplayer-${version}.tgz`;
export const stableVersion = (version) => typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version);

/** Accept only this repository's stable, uploaded release assets. */
export async function githubRelease({ kind = "npm", fetchImpl = globalThis.fetch, timeout = 8000 } = {}) {
  const response = await fetchImpl(RELEASES_API, { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}.`);
  const release = await response.json();
  const version = release.tag_name?.replace(/^v/, "");
  if (release.draft || release.prerelease || !stableVersion(version)) throw new Error("GitHub gave no stable SCORM Player release.");
  const filename = releaseFilename(version, kind);
  const base = `${DOWNLOADS}/${release.tag_name}`;
  const asset = (name) => release.assets?.find((item) => item.name === name && item.state === "uploaded" && item.browser_download_url === `${base}/${name}`);
  const result = { version, source: "github", kind, ready: false, asset: null };
  if (!asset(filename) || !asset("SHA256SUMS")) return result;
  const checksums = await fetchImpl(`${base}/SHA256SUMS`, { signal: AbortSignal.timeout(timeout) });
  if (!checksums.ok) return result;
  const text = await checksums.text();
  if (text.length > 16384) throw new Error("GitHub's checksum file is too large.");
  const hashes = text.split(/\r?\n/).map((line) => /^([a-f0-9]{64})\s+\*?(\S+)$/.exec(line)).filter((match) => match?.[2] === filename);
  if (hashes.length !== 1) return result;
  result.asset = { filename, url: `${base}/${filename}`, sha256: hashes[0][1] };
  result.ready = await releaseReady(result, { fetchImpl, timeout });
  return result;
}

export async function releaseReady(release, { fetchImpl = globalThis.fetch, timeout = 1500 } = {}) {
  if (!release.asset || !stableVersion(release.version)) return false;
  const { filename, url, sha256 } = release.asset;
  if (filename !== releaseFilename(release.version, release.kind) || !/^[a-f0-9]{64}$/.test(sha256) || ![`${DOWNLOADS}/v${release.version}/${filename}`, `${DOWNLOADS}/${release.version}/${filename}`].includes(url)) return false;
  try {
    return (await fetchImpl(url, { method: "HEAD", signal: AbortSignal.timeout(timeout) })).ok;
  } catch { return false; }
}

/** Verify the exact bytes before handing a package to any installer. */
export async function downloadRelease(release, directory, { fetchImpl = globalThis.fetch, timeout = 60000 } = {}) {
  const unavailable = (error) => Object.assign(error, { code: "github_unavailable" });
  if (!await releaseReady(release, { fetchImpl, timeout })) throw unavailable(new Error("The GitHub release download is unavailable."));
  let response;
  try { response = await fetchImpl(release.asset.url, { signal: AbortSignal.timeout(timeout) }); }
  catch (error) { throw unavailable(error); }
  if (!response.ok || !response.body) throw unavailable(new Error(`GitHub's download answered ${response.status}.`));
  const chunks = [];
  const hash = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) throw Object.assign(new Error("The release download exceeds 64 MB."), { code: "invalid_release" });
      hash.update(chunk);
      chunks.push(chunk);
    }
  } catch (error) { throw error.code === "invalid_release" ? error : unavailable(error); }
  if (hash.digest("hex") !== release.asset.sha256) throw Object.assign(new Error("The GitHub release checksum did not match. Your existing installation was preserved."), { code: "checksum_mismatch" });
  const file = path.join(directory, release.asset.filename);
  fs.writeFileSync(file, Buffer.concat(chunks), { mode: 0o600, flag: "wx" });
  return file;
}
