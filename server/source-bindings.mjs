import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const IDENTITIES = new Set(["data-content-id", "data-content-component-id", "data-tour-id"]);

/** Optional author-declared bindings. Never infer a data field from equal strings. */
export function resolveBindings(root, target) {
  const manifestFile = path.join(root, "scormplayer.sources.json");
  if (!fs.existsSync(manifestFile)) return { matches: [], status: "unavailable" };
  try {
    const base = fs.realpathSync(root);
    const read = (file, max = 2 * 1024 * 1024) => {
      if (typeof file !== "string" || path.isAbsolute(file)) throw new Error("Invalid path");
      const full = fs.realpathSync(path.resolve(base, file));
      const relative = path.relative(base, full);
      if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative) || fs.statSync(full).size > max) throw new Error("Outside course or too large");
      return fs.readFileSync(full);
    };
    const manifest = JSON.parse(read("scormplayer.sources.json", 256 * 1024));
    if (manifest.version !== 1 || !Array.isArray(manifest.bindings) || manifest.bindings.length > 500 || !manifest.artifacts || typeof manifest.artifacts !== "object") throw new Error("Unsupported manifest");
    const artifacts = Object.entries(manifest.artifacts);
    if (!artifacts.length || artifacts.length > 256 || typeof manifest.entry !== "string" || !manifest.artifacts[manifest.entry]) throw new Error("Missing build entry");
    let bytes = 0;
    const files = new Map();
    for (const [file, expected] of artifacts) {
      if (typeof expected !== "string" || !/^[a-f0-9]{64}$/i.test(expected)) throw new Error("Invalid hash");
      const data = read(file);
      bytes += data.length;
      if (bytes > 32 * 1024 * 1024) throw new Error("Build metadata too large");
      if (createHash("sha256").update(data).digest("hex") !== expected.toLowerCase()) return { matches: [], status: "stale" };
      files.set(file, data);
    }
    const matches = [];
    // Only the target's own binding identifies its content. Ancestors are evidence for agents,
    // not permission to assume the child consumes the ancestor's entire content field.
    for (const binding of manifest.bindings) {
      if (!IDENTITIES.has(binding.attribute) || typeof binding.value !== "string" || target.attributes?.[binding.attribute] !== binding.value) continue;
      if (!files.has(binding.file) || typeof binding.pointer !== "string" || (binding.pointer !== "" && !binding.pointer.startsWith("/"))) continue;
      let value = JSON.parse(files.get(binding.file).toString("utf8"));
      for (const key of binding.pointer === "" ? [] : binding.pointer.slice(1).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))) {
        if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) { value = undefined; break; }
        value = value[key];
      }
      // Confirm the declared field actually agrees with the captured raw text. CSS casing is irrelevant.
      if (typeof value !== "string" || value.replace(/\s+/g, " ").trim() !== String(target.rawText ?? "").replace(/\s+/g, " ").trim()) continue;
      matches.push({ file: binding.file, line: 1, pointer: binding.pointer, preview: value.slice(0, 160),
        provenance: "content-binding", confidence: "declared-hash-checked", attribute: binding.attribute, value: binding.value,
        sha256: manifest.artifacts[binding.file], entry: manifest.entry,
        consumers: Array.isArray(binding.consumers) ? binding.consumers.filter((item) => typeof item === "string").slice(0, 30).map((item) => item.slice(0, 300)) : [],
      });
    }
    const fields = new Map(matches.map((match) => [`${match.file}\0${match.pointer}`, match]));
    if (fields.size > 1) return { matches: [], status: "ambiguous" };
    return { matches: [...fields.values()], status: matches.length ? "validated" : "no-matching-binding" };
  } catch { return { matches: [], status: "invalid" }; }
}
