/**
 * A forgiving LMS for review: both SCORM 1.2 (`window.API`) and SCORM 2004
 * (`window.API_1484_11`) are installed on the player window, where a course finds them by
 * walking up its parent frames. Values persist in localStorage per course, so a reload resumes
 * where the reviewer was. It accepts what courses send rather than enforcing the full spec; this
 * is a review tool, not a conformance checker.
 */

export type ScormData = Record<string, string>;
/** One call the course made to the LMS API. */
export type ScormCall = { at: number; api: "1.2" | "2004"; method: string; args: string[]; result: string; error: string };
export type ScormProgress = { completion: string; success: string; score: string; location: string; progressMeasure: string };
type Listener = (data: ScormData) => void;

const DEFAULTS_12: ScormData = {
  "cmi.core.student_id": "scormplayer",
  "cmi.core.student_name": "Reviewer, Player",
  "cmi.core.lesson_status": "not attempted",
  "cmi.core.lesson_location": "",
  "cmi.core.lesson_mode": "normal",
  "cmi.core.credit": "credit",
  "cmi.core.entry": "ab-initio",
  "cmi.core.total_time": "0000:00:00",
  "cmi.core.score.raw": "",
  "cmi.core.score.min": "",
  "cmi.core.score.max": "",
  "cmi.suspend_data": "",
  "cmi.launch_data": "",
  "cmi.comments": "",
  "cmi.student_data.mastery_score": "",
};

const DEFAULTS_2004: ScormData = {
  "cmi.learner_id": "scormplayer",
  "cmi.learner_name": "Reviewer, Player",
  "cmi.completion_status": "unknown",
  "cmi.success_status": "unknown",
  "cmi.location": "",
  "cmi.mode": "normal",
  "cmi.credit": "credit",
  "cmi.entry": "ab-initio",
  "cmi.total_time": "PT0H0M0S",
  "cmi.score.raw": "",
  "cmi.score.scaled": "",
  "cmi.score.min": "",
  "cmi.score.max": "",
  "cmi.progress_measure": "",
  "cmi.suspend_data": "",
  "cmi.launch_data": "",
  "cmi.completion_threshold": "",
  "cmi.scaled_passing_score": "",
};

const CHILDREN: Record<string, string> = {
  "cmi.core._children": "student_id,student_name,lesson_location,credit,lesson_status,entry,score,total_time,lesson_mode,exit,session_time",
  "cmi.core.score._children": "raw,min,max",
  "cmi.objectives._children": "id,score,status",
  "cmi.interactions._children": "id,objectives,time,type,correct_responses,weighting,student_response,result,latency",
  "cmi.score._children": "scaled,raw,min,max",
};

const ERRORS: Record<string, string> = {
  "0": "No error",
  "101": "General exception",
  "301": "Not initialized",
};

const MAX_CALLS = 400;

export function installScormApis(win: Window, storageKey: string) {
  const listeners = new Set<Listener>();
  const callListeners = new Set<(calls: ScormCall[]) => void>();
  let calls: ScormCall[] = [];
  /** Wrap an API method so every call is kept for the inspector. */
  const logged = <T extends (...args: any[]) => string>(api: ScormCall["api"], method: string, fn: T) => ((...args: unknown[]) => {
    const result = fn(...(args as Parameters<T>));
    calls = [...calls.slice(-(MAX_CALLS - 1)), { at: Date.now(), api, method, args: args.map((arg) => String(arg ?? "")), result: String(result), error: lastError }];
    callListeners.forEach((listener) => listener(calls));
    return result;
  }) as T;
  let data: ScormData = { ...load(storageKey) };
  let lastError = "0";

  const save = () => {
    try { localStorage.setItem(storageKey, JSON.stringify(data)); } catch { /* storage full or blocked: keep in memory */ }
    listeners.forEach((listener) => listener({ ...data }));
  };

  const getValue = (defaults: ScormData) => (element: string) => {
    lastError = "0";
    const key = String(element);
    if (key in data) return data[key];
    if (key in CHILDREN) return CHILDREN[key];
    const count = /^(.*)\._count$/.exec(key);
    if (count) return String(countOf(data, count[1]));
    if (key.startsWith("adl.nav.request_valid")) return "unknown";
    return defaults[key] ?? "";
  };

  const setValue = (element: string, value: unknown) => {
    lastError = "0";
    data[String(element)] = String(value ?? "");
    save();
    return "true";
  };

  const initialize = (defaults: ScormData, entryKey: string, locationKey: string) => () => {
    lastError = "0";
    const resumed = Boolean(data["cmi.suspend_data"] || data[locationKey]);
    data = { ...defaults, ...data, [entryKey]: resumed ? "resume" : "ab-initio" };
    save();
    return "true";
  };

  const common = {
    errorString: (code: string) => ERRORS[String(code)] ?? "Unknown error",
    lastError: () => lastError,
  };

  const api12 = {
    LMSInitialize: logged("1.2", "LMSInitialize", initialize(DEFAULTS_12, "cmi.core.entry", "cmi.core.lesson_location")),
    LMSFinish: logged("1.2", "LMSFinish", () => { save(); return "true"; }),
    LMSGetValue: logged("1.2", "LMSGetValue", getValue(DEFAULTS_12)),
    LMSSetValue: logged("1.2", "LMSSetValue", setValue),
    LMSCommit: logged("1.2", "LMSCommit", () => { save(); return "true"; }),
    LMSGetLastError: logged("1.2", "LMSGetLastError", common.lastError),
    LMSGetErrorString: logged("1.2", "LMSGetErrorString", common.errorString),
    LMSGetDiagnostic: logged("1.2", "LMSGetDiagnostic", common.errorString),
  };

  const api2004 = {
    version: "1.0",
    Initialize: logged("2004", "Initialize", initialize(DEFAULTS_2004, "cmi.entry", "cmi.location")),
    Terminate: logged("2004", "Terminate", () => { save(); return "true"; }),
    GetValue: logged("2004", "GetValue", getValue(DEFAULTS_2004)),
    SetValue: logged("2004", "SetValue", setValue),
    Commit: logged("2004", "Commit", () => { save(); return "true"; }),
    GetLastError: logged("2004", "GetLastError", common.lastError),
    GetErrorString: logged("2004", "GetErrorString", common.errorString),
    GetDiagnostic: logged("2004", "GetDiagnostic", common.errorString),
  };

  Object.assign(win, { API: api12, API_1484_11: api2004 });

  return {
    data: () => ({ ...data }),
    calls: () => calls,
    subscribeCalls(listener: (calls: ScormCall[]) => void) {
      callListeners.add(listener);
      listener(calls);
      return () => callListeners.delete(listener);
    },
    clearCalls() {
      calls = [];
      callListeners.forEach((listener) => listener(calls));
    },
    subscribe(listener: Listener) {
      listeners.add(listener);
      listener({ ...data });
      return () => listeners.delete(listener);
    },
    reset() {
      data = {};
      try { localStorage.removeItem(storageKey); } catch { /* nothing stored */ }
      listeners.forEach((listener) => listener({}));
    },
    uninstall() {
      const target = win as unknown as Record<string, unknown>;
      if (target.API === api12) delete target.API;
      if (target.API_1484_11 === api2004) delete target.API_1484_11;
    },
  };
}

/** What the bottom bar shows, from whichever SCORM version the course used. */
export function progressOf(data: ScormData): ScormProgress {
  const status12 = data["cmi.core.lesson_status"];
  const completion = data["cmi.completion_status"]
    || (status12 === "completed" || status12 === "passed" || status12 === "failed" ? "completed" : status12 === "incomplete" ? "incomplete" : "");
  const success = data["cmi.success_status"] || (status12 === "passed" || status12 === "failed" ? status12 : "");
  const scaled = data["cmi.score.scaled"];
  const raw = data["cmi.score.raw"] || data["cmi.core.score.raw"];
  const score = scaled ? `${Math.round(Number(scaled) * 100)}%` : raw ? raw : "";
  return {
    completion,
    success,
    score,
    location: data["cmi.location"] || data["cmi.core.lesson_location"] || "",
    progressMeasure: data["cmi.progress_measure"] || "",
  };
}

function countOf(data: ScormData, prefix: string) {
  const pattern = new RegExp(`^${prefix.replace(/\./g, "\\.")}\\.(\\d+)\\.`);
  let max = -1;
  for (const key of Object.keys(data)) {
    const match = pattern.exec(key);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

function load(storageKey: string): ScormData {
  try {
    const raw = localStorage.getItem(storageKey);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
