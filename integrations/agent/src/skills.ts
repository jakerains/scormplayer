import fs from "node:fs";
import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError, RequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const resource = z.object({ uri: z.string(), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), size: z.number().int().nonnegative() });
const skill = z.object({ uri: z.string(), frontmatter: z.looseObject({ name: z.string(), description: z.string() }), resources: z.array(resource).min(1).max(512) });
const catalogSchema = z.object({ version: z.literal(1), serverVersion: z.string(), skills: z.array(skill), files: z.array(resource.extend({ mimeType: z.string(), blob: z.string() })) });
const cache = { resultType: "complete" as const, ttlMs: 300_000, cacheScope: "public" as const };
export const reviewGuideUri = "skill://scormplayer-review/SKILL.md";
export const qaGuideUri = "skill://scormplayer-qa/SKILL.md";

export function registerSkills(server: McpServer) {
  const catalog = catalogSchema.parse(JSON.parse(fs.readFileSync(new URL("./skills.json", import.meta.url), "utf8")));
  const files = new Map(catalog.files.map((file) => [file.uri, file]));
  if (files.size !== catalog.files.length || new Set(catalog.skills.map((entry) => entry.uri)).size !== catalog.skills.length) throw new Error("Duplicate skill catalog entries.");
  const contents = new Map<string, { uri: string; mimeType: string; text: string } | { uri: string; mimeType: string; blob: string }>();
  for (const file of catalog.files) {
    const bytes = Buffer.from(file.blob, "base64");
    if (bytes.length !== file.size || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== file.digest) throw new Error(`Invalid skill content: ${file.uri}`);
    // Binary and noncanonical UTF-8 are returned as blobs to preserve exact manifest bytes.
    let text: string | undefined;
    if (file.mimeType !== "application/octet-stream") {
      try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { /* Preserve raw bytes below. */ }
    }
    contents.set(file.uri, text === undefined ? { uri: file.uri, mimeType: file.mimeType, blob: file.blob } : { uri: file.uri, mimeType: file.mimeType, text });
  }
  const published = new Set<string>();
  for (const entry of catalog.skills) {
    if (entry.uri !== `skill://${entry.frontmatter.name}/SKILL.md` || !entry.resources.some((file) => file.uri === entry.uri) || new Set(entry.resources.map((file) => file.uri)).size !== entry.resources.length) throw new Error("Invalid skill manifest.");
    let size = 0;
    const root = entry.uri.slice(0, -"SKILL.md".length);
    for (const file of entry.resources) {
      const stored = files.get(file.uri);
      if (!file.uri.startsWith(root) || stored?.digest !== file.digest || stored.size !== file.size) throw new Error("Incomplete skill manifest.");
      size += file.size;
      published.add(file.uri);
    }
    if (size > 16_777_216) throw new Error("Skill exceeds MCP size limit.");
  }
  if (published.size !== files.size) throw new Error("Unlisted skill content.");
  for (const file of catalog.files) {
    const entry = catalog.skills.find((item) => item.uri === file.uri);
    server.registerResource(entry?.frontmatter.name ?? file.uri, file.uri, {
      mimeType: file.mimeType, description: entry?.frontmatter.description,
      ...(entry ? { _meta: { "io.modelcontextprotocol.skills/frontmatter": entry.frontmatter } } : {}),
    }, async () => ({ ...cache, contents: [contents.get(file.uri)!] }));
  }
  // SDK 1.x negotiates the 2025-11-25 base protocol. Advertise the skill methods
  // in initialize for compatible hosts; do not claim the newer base handshake.
  server.server.registerCapabilities({ resources: {}, extensions: { "io.modelcontextprotocol/skills": {} } });
  const listSchema = RequestSchema.extend({ method: z.literal("skills/list"), params: z.unknown().optional() });
  server.server.setRequestHandler(listSchema, async (request) => {
    const params = z.object({ cursor: z.string().optional() }).passthrough().optional().safeParse(request.params);
    if (!params.success) throw new McpError(ErrorCode.InvalidParams, "Invalid skills/list parameters.");
    // The small static catalog fits in one page. No pagination cursor is emitted.
    if (params.data?.cursor !== undefined) throw new McpError(ErrorCode.InvalidParams, "Unknown skills cursor.");
    return { ...cache, skills: catalog.skills };
  });
  const getSchema = RequestSchema.extend({ method: z.literal("skills/get"), params: z.unknown().optional() });
  server.server.setRequestHandler(getSchema, async (request) => {
    const params = z.object({ uri: z.string() }).passthrough().safeParse(request.params);
    if (!params.success) throw new McpError(ErrorCode.InvalidParams, "Invalid skills/get parameters; supply a skill URI.");
    const entry = catalog.skills.find((item) => item.uri === params.data.uri);
    if (!entry) throw new McpError(ErrorCode.InvalidParams, "Unknown skill URI.");
    return { ...cache, skill: entry };
  });
  const read = (uri: string) => {
    const guide = contents.get(uri);
    const metadata = files.get(uri);
    if (!guide || !("text" in guide) || !metadata) throw new Error(`Guide missing from skill catalog: ${uri}`);
    return { uri, digest: metadata.digest, size: metadata.size, markdown: guide.text };
  };
  // The pin-review guide, and the guide for an agent's own QA pass.
  return { review: read(reviewGuideUri), qa: read(qaGuideUri) };
}
