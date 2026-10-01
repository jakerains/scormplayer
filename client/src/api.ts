import type { PinTarget } from "./picker";

export type Course = {
  title: string;
  kind: "package" | "folder" | "live";
  scormVersion: "1.2" | "2004" | "both" | null;
  source: string;
  launchUrl: string;
  courseKey: string;
  pinsFile: string;
};

export type PinPage = { url: string; title: string; location?: string };

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
  course: () => request<Course>("/api/course"),
  status: () => request<{ lastChangeAt: string | null }>("/api/status"),
  pins: () => request<{ pins: Pin[] }>("/api/pins").then((body) => body.pins),
  createPin: (input: { note: string; page: PinPage; target: PinTarget }) => request<Pin>("/api/pins", json("POST", input)),
  updatePin: (id: string, changes: Partial<Pick<Pin, "note" | "status">>) => request<Pin>(`/api/pins/${id}`, json("PATCH", changes)),
  deletePin: (id: string) => request<Pin>(`/api/pins/${id}`, { method: "DELETE" }),
  saveFrame: (id: string, png: Blob) => request<Pin>(`/api/pins/${id}/frame`, { method: "PUT", headers: { "Content-Type": "image/png" }, body: png }),
  brief: (status: "open" | "all" = "open") => request<string>(`/api/brief?status=${status}`),
  reportProgress: (progress: { completion: string; success: string; score: string; location: string; progressMeasure: string }) =>
    fetch("/api/progress", json("POST", progress)).catch(() => {}),
};

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
