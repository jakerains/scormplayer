/**
 * A forgiving LMS for review: both SCORM 1.2 (`window.API`) and SCORM 2004
 * (`window.API_1484_11`) are installed on the player window, where a course finds them by
 * walking up its parent frames. Values persist in localStorage per course, so a reload resumes
 * where the reviewer was. It accepts what courses send rather than enforcing the full spec; this
 * is a review tool, not a conformance checker.
 */

export type ScormData = Record<string, string>;
export type ScormProgress = { completion: string; success: string; score: string; location: string };
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

export function installScormApis(win: Window, storageKey: string) {
  const listeners = new Set<Listener>();
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
    LMSInitialize: initialize(DEFAULTS_12, "cmi.core.entry", "cmi.core.lesson_location"),
    LMSFinish: () => { save(); return "true"; },
    LMSGetValue: getValue(DEFAULTS_12),
    LMSSetValue: setValue,
    LMSCommit: () => { save(); return "true"; },
    LMSGetLastError: common.lastError,
    LMSGetErrorString: common.errorString,
    LMSGetDiagnostic: common.errorString,
  };

  const api2004 = {
    version: "1.0",
    Initialize: initialize(DEFAULTS_2004, "cmi.entry", "cmi.location"),
    Terminate: () => { save(); return "true"; },
    GetValue: getValue(DEFAULTS_2004),
    SetValue: setValue,
    Commit: () => { save(); return "true"; },
    GetLastError: common.lastError,
    GetErrorString: common.errorString,
    GetDiagnostic: common.errorString,
  };

  Object.assign(win, { API: api12, API_1484_11: api2004 });

  return {
    data: () => ({ ...data }),
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
  return { completion, success, score, location: data["cmi.location"] || data["cmi.core.lesson_location"] || "" };
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
