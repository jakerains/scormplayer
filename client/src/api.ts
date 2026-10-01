import type { PinTarget } from "./picker";

export type CourseResponse = Course | { empty: true };

export type Course = {
  title: string;
  kind: "package" | "folder" | "live";
  scormVersion: "1.2" | "2004" | "both" | null;
  source: string;
  launchUrl: string;
  courseKey: string;
  pinsFile: string;
  /** False for a zip: it plays from a copy in the cache until it is unzipped to a folder. */
  editable: boolean;
  /** For a zip: where it unzips to by default, and a folder it was unzipped to before. */
  unzip?: { folder: string; existing: string | null };
  /** Packages with several SCOs. */
  scos?: { id: string; title: string; launchUrl: string }[];
};

export type PinPage = { url: string; title: string; location?: string; navId?: string; navIndex?: number; scoId?: string; scoTitle?: string };

export type Pin = {
  id: string;
  number: number;
  status: "open" | "resolved";
  note: string;
  page?: PinPage;
  target?: PinTarget;
  source?: { file: string; line: number; preview: string }[];
  frame?: string;
  createdAt: string;
  updatedAt: string;
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const type = response.headers.get("content-type") ?? "";
  const body = type.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) throw new Error(typeof body === "object" && body?.error ? body.error : `Request failed (${response.status}).`);
  return body as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const api = {
  course: () => request<CourseResponse>("/api/course"),
  status: () => request<{ lastChangeAt: string | null }>("/api/status"),
  pins: () => request<{ pins: Pin[] }>("/api/pins").then((body) => body.pins),
  createPin: (input: { note: string; page: PinPage; target: PinTarget }) => request<Pin>("/api/pins", json("POST", input)),
  updatePin: (id: string, changes: Partial<Pick<Pin, "note" | "status">> & { resolution?: string }) => request<Pin>(`/api/pins/${id}`, json("PATCH", changes)),
  deletePin: (id: string) => request<Pin>(`/api/pins/${id}`, { method: "DELETE" }),
  saveFrame: (id: string, png: Blob) => request<Pin>(`/api/pins/${id}/frame`, { method: "PUT", headers: { "Content-Type": "image/png" }, body: png }),
  unzip: (folder: string) => request<{ ok: true; folder: string; pinsFile: string; reused: boolean; movedPins: number }>("/api/unzip", json("POST", { folder })),
  brief: (status: "open" | "all" = "open") => request<string>(`/api/brief?status=${status}`),
  reportProgress: (progress: { completion: string; success: string; score: string; location: string; progressMeasure: string }) =>
    fetch("/api/progress", json("POST", progress)).catch(() => {}),
};

/** Send a SCORM zip to the player to open it, reporting upload progress (0–1). */
export function openZip(file: File, onProgress: (fraction: number) => void): Promise<{ title: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/open");
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
