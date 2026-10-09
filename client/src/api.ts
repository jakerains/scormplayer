import type { PinTarget } from "./picker";
import type { ScormState, ScormWrite } from "./scorm-state";
import type { ScoRuntime } from "./scorm-api";
import type { QaSuggestion } from "./webmcp";

export type CourseResponse = Course | { empty: true; revision: string };

export type Course = {
  revision: string;
  title: string;
  kind: "package" | "folder" | "live";
  /** SCORM, or an xAPI (Tin Can) or cmi5 package played through the local LRS. */
  standard?: "scorm" | "xapi" | "cmi5";
  scormVersion: "1.2" | "2004" | "both" | null;
  source: string;
  launchUrl: string;
  courseKey: string;
  pinsFile: string;
  /** Minutes without anyone using the page before it asks "Still there?"; null never asks. */
  idleMinutes: number | null;
  /** False for a zip: it plays from a copy in the cache until it is unzipped to a folder. */
  editable: boolean;
  /** For a zip: where it unzips to by default, and a folder it was unzipped to before. */
  unzip?: { folder: string; existing: string | null };
  /** A zip or folder holding several courses: the one open, and all of them. */
  package?: string;
  packages?: { name: string; title: string }[];
  /** Packages with several SCOs. */
  scos?: { id: string; title: string; launchUrl: string; runtime?: ScoRuntime }[];
  /** What the manifest hands a single-SCO course at launch. */
  runtime?: ScoRuntime;
};

export type CheckFinding = { severity: "error" | "warning" | "info"; code: string; message: string; file?: string; examples?: string[] };
export type CheckReport = { ok: boolean; counts: { error: number; warning: number; info: number }; files: number; bytes: number; findings: CheckFinding[] };

export type XapiStatement = { id: string; actor?: { name?: string }; verb: { id: string; display?: Record<string, string> }; object?: { id?: string; definition?: { name?: Record<string, string> } }; result?: { score?: { scaled?: number; raw?: number }; success?: boolean; completion?: boolean; duration?: string; response?: string }; timestamp?: string; stored?: string };
export type XapiSummary = {
  standard: "xapi" | "cmi5";
  registration: string;
  modules: Record<string, { completion: string; success: string; score: string; satisfied: boolean }>;
  statements: XapiStatement[];
  count: number;
  issues: { at: number; severity: "error" | "warning"; message: string; count: number }[];
};

export type QaRun = {
  id: string;
  agent: string;
  state: "running" | "stopping" | "finished" | "stopped" | "abandoned";
  startedAt: string;
  endedAt?: string;
  pages: { module: { title?: string } | null; page: { index?: number; of?: number; title?: string } | null; status: string; notes: string; pins: number[] }[];
  suggestions: number[];
  summary: string;
};
export type QaStatus = { active: QaRun | null; last: QaRun | null; logFile: string | null; counts: { suggested: number; dismissed: number } };

export type PinPage = { url: string; title: string; location?: string; navId?: string; navIndex?: number; scoId?: string; scoTitle?: string };

export type PinStatus = "open" | "resolved" | "suggested" | "dismissed";
export type QaCategory = "copy" | "content" | "accessibility" | "scorm" | "layout" | "interaction" | "media";
export type QaSeverity = "blocker" | "major" | "minor" | "polish";

export type Pin = {
  id: string;
  number: number;
  status: PinStatus;
  /** An agent's QA suggestion (or one the reviewer accepted). Absent for a person's pin. */
  origin?: { kind: "agent"; agent: string; runId?: string };
  category?: QaCategory;
  severity?: QaSeverity;
  confidence?: "high" | "medium" | "low";
  evidence?: string;
  alsoOn?: { title?: string; url?: string; navIndex?: number; scoId?: string; scoTitle?: string }[];
  note: string;
  page?: PinPage;
  target?: PinTarget;
  source?: { file: string; line: number; preview: string; provenance?: string; pointer?: string }[];
  sourceSearch?: { truncated: boolean; bindingStatus?: string; advice?: string };
  capture?: { sessionRevision?: string; packageSha256?: string; at: string };
  attachmentHistory?: { page?: PinPage; target?: PinTarget; capture?: Pin["capture"]; frame?: string; at: string }[];
  frame?: string;
  createdAt: string;
  updatedAt: string;
};

let revision = "";
const courseHeaders = (): Record<string, string> => revision ? { "X-Scormplayer-Revision": revision } : {};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (revision && !["/api/course", "/api/player"].includes(url)) headers.set("X-Scormplayer-Revision", revision);
  const response = await fetch(url, { cache: "no-store", ...init, headers });
  const type = response.headers.get("content-type") ?? "";
  const body = type.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) throw new Error(typeof body === "object" && body?.error ? body.error : `Request failed (${response.status}).`);
  return body as T;
}

let pinsCache: { revision: string; etag: string; pins: Pin[] } | null = null;
async function fetchPins(): Promise<Pin[]> {
  const key = revision;
  const headers = new Headers(courseHeaders());
  if (pinsCache?.revision === key) headers.set("If-None-Match", pinsCache.etag);
  const response = await fetch("/api/pins", { cache: "no-store", headers });
  if (response.status === 304 && pinsCache?.revision === key) return pinsCache.pins;
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Could not load pins.");
  pinsCache = { revision: key, etag: response.headers.get("etag") ?? "", pins: body.pins };
  return body.pins;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const api = {
  scormState: () => request<ScormState>("/api/scorm"),
  saveScormState: (patch: ScormWrite, keepalive = false) => request<ScormState>("/api/scorm", { ...json("PUT", patch), keepalive }),
  course: () => request<CourseResponse>("/api/course").then((course) => { revision = course.revision; return course; }),
  status: () => request<{ lastChangeAt: string | null }>("/api/status"),
  pins: () => fetchPins(),
  createPin: (input: { note: string; page: PinPage; target: PinTarget; qa?: QaSuggestion }) => request<Pin & { outcome?: "created" | "merged" | "duplicate"; stop?: boolean }>("/api/pins", json("POST", input)),
  updatePin: (id: string, changes: Partial<Pick<Pin, "note" | "status">> & { resolution?: string }) => request<Pin>(`/api/pins/${id}`, json("PATCH", changes)),
  triage: (ids: string[], action: "accept" | "dismiss" | "restore") => request<{ ok: true; pins: Pin[] }>("/api/pins/triage", json("POST", { ids, action })),
  clearQa: (runId?: string) => request<{ ok: true; removed: number }>(`/api/qa/pins${runId ? `?runId=${encodeURIComponent(runId)}` : ""}`, { method: "DELETE" }),
  qa: () => request<QaStatus>("/api/qa"),
  stopQa: (runId: string) => request<{ ok: true }>(`/api/qa/runs/${encodeURIComponent(runId)}/stop`, json("POST", {})),
  finishQa: (runId: string, summary: string) => request<unknown>(`/api/qa/runs/${encodeURIComponent(runId)}/finish`, json("POST", { summary })),
  reattachPin: (id: string, input: { target: PinTarget; page: PinPage; expectedUpdatedAt: string }) => request<Pin>(`/api/pins/${id}/reattach`, json("POST", input)),
  deletePin: (id: string) => request<Pin>(`/api/pins/${id}`, { method: "DELETE" }),
  saveFrame: (id: string, png: Blob) => request<Pin>(`/api/pins/${id}/frame`, { method: "PUT", headers: { "Content-Type": "image/png" }, body: png }),
  active: () => fetch("/api/active", { method: "POST" }).catch(() => {}),
  idleClose: () => request<{ closed: boolean }>("/api/idle-close", { method: "POST" }),
  player: () => request<{ pid: number; courseVersion: number; revision: string }>("/api/player"),
  courses: () => request<{ courses: { path: string; kind: "zip" | "folder" | "live"; title: string; current: boolean }[] }>("/api/courses").then((body) => body.courses),
  switchCourse: (path: string) => request<{ ok: true; title: string }>("/api/switch", json("POST", { path })),
  update: () => request<{ update: { latest: string; command: string } | null }>("/api/update").then((body) => body.update),
  skill: () => request<{ state: "missing" | "current" | "outdated" | "newer" | "unknown"; version: string | null; installedVersion: string | null }>("/api/skill"),
  openPackage: (name: string) => request<{ ok: true; title: string }>("/api/package", json("POST", { name })),
  unzip: (folder: string) => request<{ ok: true; folder: string; pinsFile: string; reused: boolean; movedPins: number }>("/api/unzip", json("POST", { folder })),
  check: () => request<CheckReport>("/api/check"),
  xapi: () => request<XapiSummary>("/api/xapi"),
  brief: (status: "open" | "all" = "open") => request<string>(`/api/brief?status=${status}`),
  reportProgress: (progress: { completion: string; success: string; score: string; location: string; progressMeasure: string }) =>
    fetch("/api/progress", { ...json("POST", progress), headers: { "Content-Type": "application/json", ...courseHeaders() } }).catch(() => {}),
};

/** Send a SCORM zip to the player to open it, reporting upload progress (0–1). */
export function openZip(file: File, onProgress: (fraction: number) => void): Promise<{ title: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/open");
    if (revision) xhr.setRequestHeader("X-Scormplayer-Revision", revision);
    xhr.setRequestHeader("Content-Type", "application/zip");
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(event.loaded / event.total); };
    xhr.onload = () => {
      let body: any = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(new Error(body?.error ?? `Could not open ${file.name} (${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error("The upload failed. Is scormplayer still running?"));
    xhr.send(file);
  });
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Fall back to the selection-based copy some embedded browsers still require.
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  Object.assign(field.style, { position: "fixed", left: "-9999px", top: "0" });
  document.body.append(field);
  field.select();
  const copied = document.execCommand("copy");
  field.remove();
  if (!copied) throw new Error("The browser blocked the clipboard. Click the page and try again.");
}
