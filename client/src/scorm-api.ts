/**
 * A forgiving LMS for review: both SCORM 1.2 (`window.API`) and SCORM 2004
 * (`window.API_1484_11`) are installed on the player window, where a course finds them by
 * walking up its parent frames. The player persists values per course/module through its server,
 * with localStorage retained for migration.
 *
 * It acts as an LMS does at launch and at the end of a session (learner values, manifest
 * thresholds, total time, entry/exit, navigation requests). Each departure from the spec is
 * recorded as an issue; by default the call still succeeds, and strict mode fails it with the
 * spec's error code. This is a review aid, not LMS conformance certification.
 */

import { CHILDREN, ERROR_STRINGS, checkGet, checkSet, countOf, formatDuration, formatTimespan, genericElement, notInitialized, parseDuration, parseTimespan, type ModelError, type ScormVersion } from "./scorm-model";

export type ScormData = Record<string, string>;
/** One call the course made to the LMS API. */
export type ScormCall = { at: number; api: ScormVersion; method: string; args: string[]; result: string; error: string };
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
  "cmi.mode": "normal",
  "cmi.credit": "credit",
  "cmi.entry": "ab-initio",
  "cmi.total_time": "PT0H0M0S",
  // Learner preferences an LMS provides by default.
  "cmi.learner_preference.audio_level": "1",
  "cmi.learner_preference.language": "",
  "cmi.learner_preference.delivery_speed": "1",
  "cmi.learner_preference.audio_captioning": "0",
};

/** Who the learner is and how the LMS launches the course: chosen in Launch settings. */
export type LaunchSettings = { learnerId: string; learnerName: string; mode: "normal" | "browse" | "review"; credit: "credit" | "no-credit"; strict: boolean };
/** Values the manifest gives one SCO, which the LMS hands to it at launch. */
export type ScoRuntime = { masteryScore?: string; dataFromLms?: string; maxTimeAllowed?: string; timeLimitAction?: string; completionThreshold?: string; scaledPassingScore?: string };
/** Where a SCORM 2004 navigation request sends the learner after Terminate. */
export type NavRequest = { request: string; index: number | null };
/** A departure from the SCORM spec: what the course did, and what an LMS would make of it. */
export type ScormIssue = { at: number; api: ScormVersion; method: string; element: string; code: string; message: string; severity: "error" | "warning"; rejected: boolean; count: number };

export const DEFAULT_SETTINGS: LaunchSettings = { learnerId: "scormplayer", learnerName: "Reviewer, Player", mode: "normal", credit: "credit", strict: false };

const MAX_CALLS = 400;
const MAX_ISSUES = 200;
type Lifecycle = "new" | "running" | "terminated";

export function installScormApis(win: Window, storageKey: string, options: {
  initialData?: ScormData;
  commit?: () => void;
  settings?: LaunchSettings;
  runtime?: ScoRuntime;
  /** The package's SCO ids and which one this is, for adl.nav.request. */
  navigation?: { ids: string[]; index: number };
  onNavRequest?: (request: NavRequest) => void;
} = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...options.settings };
  const runtime = options.runtime ?? {};
  const strict = settings.strict;
  const listeners = new Set<Listener>();
  const callListeners = new Set<(calls: ScormCall[]) => void>();
  const issueListeners = new Set<(issues: ScormIssue[]) => void>();
  let calls: ScormCall[] = [];
  let issues: ScormIssue[] = [];
  let active = true;
  const lifecycle: Record<ScormVersion, Lifecycle> = { "1.2": "new", "2004": "new" };
  let lastError = "0";
  let diagnostic = "";
  let data: ScormData = { ...(options.initialData ?? load(storageKey)) };

  const record = (call: ScormCall) => {
    calls = [...calls.slice(-(MAX_CALLS - 1)), call];
    callListeners.forEach((listener) => listener(calls));
  };
  /** Wrap an API method so every call is kept for the inspector. */
  const logged = <T extends (...args: any[]) => string>(api: ScormCall["api"], method: string, fn: T) => ((...args: unknown[]) => {
    if (!active) { lastError = "301"; return "false"; }
    const result = fn(...(args as Parameters<T>));
    record({ at: Date.now(), api, method, args: args.map((arg) => String(arg ?? "")), result: String(result), error: lastError });
    return result;
  }) as T;
  /** What the LMS itself changed, shown among the calls. */
  const note = (api: ScormVersion, element: string, value: string, reason: string) => {
    data[element] = value;
    record({ at: Date.now(), api, method: "LMS", args: [element, value], result: reason, error: "0" });
  };

  /**
   * Record a departure from the spec. Strict mode fails the call with its error code, as a
   * conformant LMS would; otherwise the call goes ahead and the issue is only reported.
   * Returns true when the call must fail.
   */
  const flag = (api: ScormVersion, method: string, element: string, error: ModelError) => {
    const rejected = strict && error.severity === "error";
    const key = `${api}|${method}|${element}|${error.message}`;
    const existing = issues.find((issue) => `${issue.api}|${issue.method}|${issue.element}|${issue.message}` === key);
    issues = existing
      ? issues.map((issue) => issue === existing ? { ...issue, at: Date.now(), count: issue.count + 1, rejected } : issue)
      : [...issues.slice(-(MAX_ISSUES - 1)), { at: Date.now(), api, method, element, code: error.code, message: error.message, severity: error.severity, rejected, count: 1 }];
    issueListeners.forEach((listener) => listener(issues));
    if (rejected) { lastError = error.code; diagnostic = error.message; }
    return rejected;
  };

  const save = () => {
    try { localStorage.setItem(storageKey, JSON.stringify(data)); } catch { /* storage full or blocked: keep in memory */ }
    listeners.forEach((listener) => listener({ ...data }));
  };

  const keys = (api: ScormVersion) => api === "1.2"
    ? { entry: "cmi.core.entry", location: "cmi.core.lesson_location", exit: "cmi.core.exit", session: "cmi.core.session_time", total: "cmi.core.total_time" }
    : { entry: "cmi.entry", location: "cmi.location", exit: "cmi.exit", session: "cmi.session_time", total: "cmi.total_time" };

  /** Values the LMS owns, set at every launch: who the learner is, and what the manifest says. */
  const lmsValues = (api: ScormVersion): Record<string, string | undefined> => api === "1.2" ? {
    "cmi.core.student_id": settings.learnerId,
    "cmi.core.student_name": settings.learnerName,
    "cmi.core.lesson_mode": settings.mode,
    "cmi.core.credit": settings.credit,
    "cmi.launch_data": runtime.dataFromLms ?? "",
    "cmi.student_data.mastery_score": runtime.masteryScore ?? "",
    "cmi.student_data.max_time_allowed": runtime.maxTimeAllowed ?? "",
    "cmi.student_data.time_limit_action": runtime.timeLimitAction ?? "",
  } : {
    "cmi.learner_id": settings.learnerId,
    "cmi.learner_name": settings.learnerName,
    "cmi.mode": settings.mode,
    "cmi.credit": settings.credit,
    "cmi.launch_data": runtime.dataFromLms,
    "cmi.completion_threshold": runtime.completionThreshold,
    "cmi.scaled_passing_score": runtime.scaledPassingScore,
    "cmi.max_time_allowed": runtime.maxTimeAllowed,
    "cmi.time_limit_action": runtime.timeLimitAction,
  };

  /** Add the session's time to the total, as an LMS does when a session ends. */
  const accumulate = (api: ScormVersion) => {
    const { session, total } = keys(api);
    if (!(session in data)) return;
    const seconds = api === "1.2" ? parseTimespan(data[session]) : parseDuration(data[session]);
    const before = api === "1.2" ? parseTimespan(data[total] || "0000:00:00") : parseDuration(data[total] || "PT0H0M0S");
    if (seconds !== null) {
      const sum = (before ?? 0) + seconds;
      note(api, total, api === "1.2" ? formatTimespan(sum) : formatDuration(sum), `added ${data[session]} of session time`);
    }
    delete data[session];
  };

  /** What the LMS decides from the course's scores and the manifest's thresholds. */
  const evaluated = (api: ScormVersion): Record<string, string> => {
    if (api === "1.2") {
      const mastery = data["cmi.student_data.mastery_score"];
      const raw = data["cmi.core.score.raw"];
      if (!mastery || raw === undefined || raw === "" || Number.isNaN(Number(raw)) || data["cmi.core.credit"] !== "credit" || data["cmi.core.lesson_mode"] !== "normal") return {};
      return { "cmi.core.lesson_status": Number(raw) >= Number(mastery) ? "passed" : "failed" };
    }
    const out: Record<string, string> = {};
    const threshold = data["cmi.completion_threshold"];
    if (threshold) {
      const measure = data["cmi.progress_measure"];
      out["cmi.completion_status"] = measure ? (Number(measure) >= Number(threshold) ? "completed" : "incomplete") : "unknown";
    }
    const passing = data["cmi.scaled_passing_score"];
    if (passing) {
      const scaled = data["cmi.score.scaled"];
      out["cmi.success_status"] = scaled ? (Number(scaled) >= Number(passing) ? "passed" : "failed") : "unknown";
    }
    return out;
  };
  const applyEvaluation = (api: ScormVersion) => {
    for (const [element, value] of Object.entries(evaluated(api))) {
      if (data[element] === value) continue;
      const reason = element === "cmi.core.lesson_status" ? `score ${data["cmi.core.score.raw"]} against mastery score ${data["cmi.student_data.mastery_score"]}`
        : element === "cmi.completion_status" ? `progress ${data["cmi.progress_measure"] || "not reported"} against completion threshold ${data["cmi.completion_threshold"]}`
          : `scaled score ${data["cmi.score.scaled"] || "not reported"} against passing score ${data["cmi.scaled_passing_score"]}`;
      note(api, element, value, `LMS decides from ${reason}`);
    }
  };

  /** A spec departure for calls made at the wrong point in the session. Null when the timing is fine. */
  const timing = (api: ScormVersion, method: "get" | "set" | "commit" | "terminate"): ModelError | null => {
    const state = lifecycle[api];
    if (state === "running") return null;
    const codes = { get: ["122", "123"], set: ["132", "133"], commit: ["142", "143"], terminate: ["112", "113"] }[method];
    const code = api === "1.2" ? (state === "terminated" && method === "terminate" ? "101" : "301") : codes[state === "new" ? 0 : 1];
    const what = { get: "Read data", set: "Stored data", commit: "Committed", terminate: "Ended the session" }[method];
    return { code, message: `${what} ${state === "new" ? "before Initialize" : "after the session ended"}; an LMS ignores it.`, severity: "error" };
  };
  const emptyArgument = (api: ScormVersion, method: string, argument: unknown) =>
    String(argument ?? "") === "" ? false : flag(api, method, "", { code: "201", message: `${method} takes an empty string, not "${String(argument)}".`, severity: "error" });

  const initialize = (api: ScormVersion, method: string, defaults: ScormData) => (argument?: unknown) => {
    lastError = "0";
    if (emptyArgument(api, method, argument)) return "false";
    if (lifecycle[api] === "running") return flag(api, method, "", { code: api === "1.2" ? "101" : "103", message: `${method} was called twice.`, severity: "error" }) ? "false" : "true";
    if (lifecycle[api] === "terminated" && flag(api, method, "", { code: api === "1.2" ? "101" : "104", message: `${method} was called after the session ended; an LMS doesn't restart a SCO without a new launch.`, severity: "error" })) return "false";
    const { entry, location, exit } = keys(api);
    // A session that ended without Terminate still counts its time.
    accumulate(api);
    const suspended = data[exit] === "suspend";
    // An earlier session of this SCO, and data the course could resume from.
    const returning = entry in data;
    const saved = Boolean(data["cmi.suspend_data"] || data[location]);
    let next = suspended ? "resume" : api === "1.2" && returning ? "" : "ab-initio";
    if (!suspended && returning && strict && api === "2004") {
      // A new attempt starts from nothing: an LMS keeps none of the learner's data.
      data = {};
      flag(api, method, exit, { code: "0", message: "Started a new attempt: the last session didn't set cmi.exit to \"suspend\", so its status, location and suspend data were dropped, as an LMS would.", severity: "warning" });
    } else if (!suspended && saved) {
      if (!strict) next = "resume";
      flag(api, method, exit, { code: "0", message: strict
        ? `The last session didn't set ${exit} to "suspend", so ${entry} is "" as an LMS would report.`
        : `Resumed saved data, but the last session didn't set ${exit} to "suspend"; many LMSs would start over instead.`, severity: "warning" });
    }
    delete data[exit];
    delete data["adl.nav.request"];
    const lms = lmsValues(api);
    data = { ...defaults, ...data, [entry]: next };
    for (const [element, value] of Object.entries(lms)) {
      if (value === undefined) delete data[element];
      else data[element] = value;
    }
    lifecycle[api] = "running";
    save();
    return "true";
  };

  const terminate = (api: ScormVersion, method: string) => (argument?: unknown) => {
    lastError = "0";
    if (emptyArgument(api, method, argument)) return "false";
    const wrongTime = timing(api, "terminate");
    if (wrongTime && flag(api, method, "", wrongTime)) return "false";
    const { session } = keys(api);
    if (!(session in data) && lifecycle[api] === "running") flag(api, method, session, { code: "0", message: `The session ended without ${session}, so the LMS can't add this session's time.`, severity: "warning" });
    accumulate(api);
    applyEvaluation(api);
    lifecycle[api] = "terminated";
    const request = data["adl.nav.request"];
    delete data["adl.nav.request"];
    save();
    options.commit?.();
    if (api === "2004" && request && request !== "_none_") {
      const target = /^\{target=([^}]+)\}(choice|jump)$/.exec(request)?.[1];
      const ids = options.navigation?.ids ?? [];
      const at = options.navigation?.index ?? 0;
      const index = request === "continue" ? (at + 1 < ids.length ? at + 1 : null)
        : request === "previous" ? (at > 0 ? at - 1 : null)
          : target ? (ids.includes(target) ? ids.indexOf(target) : null) : null;
      // After the call returns, as an LMS acts once the SCO has unloaded.
      win.setTimeout(() => options.onNavRequest?.({ request, index }), 0);
    }
    return "true";
  };

  const commit = (api: ScormVersion, method: string) => (argument?: unknown) => {
    lastError = "0";
    if (emptyArgument(api, method, argument)) return "false";
    const wrongTime = timing(api, "commit");
    if (wrongTime && flag(api, method, "", wrongTime)) return "false";
    applyEvaluation(api);
    save();
    options.commit?.();
    return "true";
  };

  const navValid = (element: string) => {
    const ids = options.navigation?.ids ?? [];
    const at = options.navigation?.index ?? 0;
    if (element.endsWith(".continue")) return at + 1 < ids.length ? "true" : "false";
    if (element.endsWith(".previous")) return at > 0 ? "true" : "false";
    const target = /\{target=([^}]+)\}$/.exec(element)?.[1];
    return target && ids.includes(target) ? "true" : "false";
  };

  const getValue = (api: ScormVersion, method: string, defaults: ScormData) => (element: unknown) => {
    lastError = "0";
    const key = String(element ?? "");
    const wrongTime = timing(api, "get");
    if (wrongTime && flag(api, method, key, wrongTime)) return "";
    const problem = checkGet(api, key, data);
    if (problem && flag(api, method, key, problem)) return "";
    if (key.startsWith("adl.nav.request_valid.")) return api === "2004" ? navValid(key) : "unknown";
    const children = CHILDREN[api][genericElement(key)];
    if (children) return children;
    const count = /^(.*)\._count$/.exec(key);
    if (count) return String(countOf(data, count[1]));
    if (key === "cmi._version") return "1.0";
    const decided = evaluated(api)[key];
    if (decided) return decided;
    if (key in data) return data[key];
    if (strict && notInitialized(api, key, data) && !(key in defaults)) { lastError = "403"; diagnostic = `${key} has not been set.`; return ""; }
    return defaults[key] ?? "";
  };

  const setValue = (api: ScormVersion, method: string) => (element: unknown, value: unknown) => {
    lastError = "0";
    const key = String(element ?? "");
    const text = String(value ?? "");
    const wrongTime = timing(api, "set");
    if (wrongTime && flag(api, method, key, wrongTime)) return "false";
    const problem = checkSet(api, key, text, data);
    if (problem && flag(api, method, key, problem)) return "false";
    data[key] = text;
    save();
    return "true";
  };

  const errors = (api: ScormVersion) => ({
    lastError: () => lastError,
    errorString: (code: unknown) => ERROR_STRINGS[api][String(code ?? "")] ?? "Unknown error",
    diagnostic: (code: unknown) => {
      const asked = String(code ?? "");
      return (asked === "" || asked === lastError) && lastError !== "0" && diagnostic ? diagnostic : ERROR_STRINGS[api][asked || lastError] ?? "Unknown error";
    },
  });
  const errors12 = errors("1.2");
  const errors2004 = errors("2004");

  const api12 = {
    LMSInitialize: logged("1.2", "LMSInitialize", initialize("1.2", "LMSInitialize", DEFAULTS_12)),
    LMSFinish: logged("1.2", "LMSFinish", terminate("1.2", "LMSFinish")),
    LMSGetValue: logged("1.2", "LMSGetValue", getValue("1.2", "LMSGetValue", DEFAULTS_12)),
    LMSSetValue: logged("1.2", "LMSSetValue", setValue("1.2", "LMSSetValue")),
    LMSCommit: logged("1.2", "LMSCommit", commit("1.2", "LMSCommit")),
    LMSGetLastError: logged("1.2", "LMSGetLastError", errors12.lastError),
    LMSGetErrorString: logged("1.2", "LMSGetErrorString", errors12.errorString),
    LMSGetDiagnostic: logged("1.2", "LMSGetDiagnostic", errors12.diagnostic),
  };

  const api2004 = {
    version: "1.0",
    Initialize: logged("2004", "Initialize", initialize("2004", "Initialize", DEFAULTS_2004)),
    Terminate: logged("2004", "Terminate", terminate("2004", "Terminate")),
    GetValue: logged("2004", "GetValue", getValue("2004", "GetValue", DEFAULTS_2004)),
    SetValue: logged("2004", "SetValue", setValue("2004", "SetValue")),
    Commit: logged("2004", "Commit", commit("2004", "Commit")),
    GetLastError: logged("2004", "GetLastError", errors2004.lastError),
    GetErrorString: logged("2004", "GetErrorString", errors2004.errorString),
    GetDiagnostic: logged("2004", "GetDiagnostic", errors2004.diagnostic),
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
      issues = [];
      callListeners.forEach((listener) => listener(calls));
      issueListeners.forEach((listener) => listener(issues));
    },
    issues: () => issues,
    subscribeIssues(listener: (issues: ScormIssue[]) => void) {
      issueListeners.add(listener);
      listener(issues);
      return () => issueListeners.delete(listener);
    },
    subscribe(listener: Listener) {
      listeners.add(listener);
      listener({ ...data });
      return () => listeners.delete(listener);
    },
    reset() {
      active = false;
      data = {};
      try { localStorage.removeItem(storageKey); } catch { /* nothing stored */ }
      listeners.forEach((listener) => listener({}));
    },
    uninstall() {
      active = false;
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

function load(storageKey: string): ScormData {
  try {
    const raw = localStorage.getItem(storageKey);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
