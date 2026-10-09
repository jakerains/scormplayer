/**
 * The SCORM 1.2 and 2004 data models, as far as a reviewer needs them: which elements exist,
 * whether a course may read or write them, and what values they accept. The API records every
 * departure from the spec as an issue; in strict mode it also fails the call with the spec's
 * error code, as a conformant LMS would.
 */

export type ScormVersion = "1.2" | "2004";
type Access = "ro" | "wo" | "rw";
/** A problem with a value: whether it is the wrong type or out of range, and why. */
type Problem = { kind: "type" | "range" | "long"; message: string } | null;
type Check = (value: string) => Problem;
type Rule = { pattern: RegExp; access: Access; check?: Check; array?: string };

export type ModelError = { code: string; message: string; severity: "error" | "warning" };

const vocab = (...words: string[]): Check => (value) => words.includes(value) ? null : { kind: "type", message: `"${value}" isn't one of ${words.map((word) => `"${word}"`).join(", ")}` };
const text = (max: number, hard: boolean): Check => (value) => value.length <= max ? null
  : { kind: hard ? "type" : "long", message: `${value.length.toLocaleString("en-US")} characters, over the ${max.toLocaleString("en-US")} ${hard ? "allowed" : "every LMS must keep (some LMSs cut it off)"}` };
const number = (min?: number, max?: number): Check => (value) => {
  if (!/^-?\d+(\.\d+)?$|^-?\.\d+$/.test(value.trim())) return { kind: "type", message: `"${value}" isn't a number` };
  const parsed = Number(value);
  if ((min !== undefined && parsed < min) || (max !== undefined && parsed > max)) return { kind: "range", message: `${value} is outside ${min ?? "−∞"}…${max ?? "∞"}` };
  return null;
};
const blankOr = (check: Check): Check => (value) => value === "" ? null : check(value);
const integer = (min: number, max: number): Check => (value) => /^-?\d+$/.test(value) ? number(min, max)(value) : { kind: "type", message: `"${value}" isn't a whole number` };
const matches = (pattern: RegExp, label: string): Check => (value) => pattern.test(value) ? null : { kind: "type", message: `"${value}" isn't ${label}` };
const either = (a: Check, b: Check): Check => (value) => a(value) && b(value) ? a(value) : null;
const identifier12 = matches(/^\S{1,255}$/, "an identifier (no spaces, up to 255 characters)");
const identifier2004 = matches(/^\S{1,4000}$/, "an identifier (no spaces, up to 4000 characters)");
const timespan12 = matches(/^\d{2,4}:\d{2}:\d{2}(\.\d{1,2})?$/, "a CMITimespan like 0001:30:05.00");
const time12 = matches(/^\d{2}:\d{2}:\d{2}(\.\d{1,2})?$/, "a CMITime like 14:30:05");
const duration = matches(/^P(?!$)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d{1,2})?S)?)?$/, "an ISO 8601 duration like PT1H30M5S");
const timestamp = matches(/^\d{4}(-\d{2}(-\d{2}(T\d{2}(:\d{2}(:\d{2}(\.\d{1,2})?)?)?(Z|[+-]\d{2}(:\d{2})?)?)?)?)?$/, "an ISO 8601 timestamp like 2026-01-31T14:30:05Z");
const navRequest = matches(/^(continue|previous|exit|exitAll|abandon|abandonAll|suspendAll|_none_|\{target=[^}\s]+\}(choice|jump))$/, "a navigation request (continue, previous, {target=ID}choice …)");

const rule = (path: string, access: Access, check?: Check): Rule => {
  // "n" stands for an array index; the array is the part before the last index.
  const source = path.replace(/\./g, "\\.").replace(/\\\.n(?=\\\.|$)/g, "\\.(\\d+)");
  const at = path.lastIndexOf(".n.");
  return { pattern: new RegExp(`^${source}$`), access, check, ...(at >= 0 ? { array: path.slice(0, at) } : {}) };
};

const STATUS_12 = vocab("passed", "completed", "failed", "incomplete", "browsed");
const SCORE_12 = blankOr(number(0, 100));
const RULES_12: Rule[] = [
  rule("cmi.core._children", "ro"), rule("cmi.core.student_id", "ro"), rule("cmi.core.student_name", "ro"),
  rule("cmi.core.lesson_location", "rw", text(255, true)), rule("cmi.core.credit", "ro"),
  rule("cmi.core.lesson_status", "rw", STATUS_12), rule("cmi.core.entry", "ro"),
  rule("cmi.core.score._children", "ro"), rule("cmi.core.score.raw", "rw", SCORE_12), rule("cmi.core.score.min", "rw", SCORE_12), rule("cmi.core.score.max", "rw", SCORE_12),
  rule("cmi.core.total_time", "ro"), rule("cmi.core.lesson_mode", "ro"),
  rule("cmi.core.exit", "wo", vocab("time-out", "suspend", "logout", "")), rule("cmi.core.session_time", "wo", timespan12),
  rule("cmi.suspend_data", "rw", text(4096, true)), rule("cmi.launch_data", "ro"),
  rule("cmi.comments", "rw", text(4096, true)), rule("cmi.comments_from_lms", "ro"),
  rule("cmi.objectives._children", "ro"), rule("cmi.objectives._count", "ro"),
  rule("cmi.objectives.n.id", "rw", identifier12), rule("cmi.objectives.n.score._children", "ro"),
  rule("cmi.objectives.n.score.raw", "rw", SCORE_12), rule("cmi.objectives.n.score.min", "rw", SCORE_12), rule("cmi.objectives.n.score.max", "rw", SCORE_12),
  rule("cmi.objectives.n.status", "rw", vocab("passed", "completed", "failed", "incomplete", "browsed", "not attempted")),
  rule("cmi.student_data._children", "ro"), rule("cmi.student_data.mastery_score", "ro"),
  rule("cmi.student_data.max_time_allowed", "ro"), rule("cmi.student_data.time_limit_action", "ro"),
  rule("cmi.student_preference._children", "ro"), rule("cmi.student_preference.audio", "rw", integer(-1, 100)),
  rule("cmi.student_preference.language", "rw", text(255, true)), rule("cmi.student_preference.speed", "rw", integer(-100, 100)),
  rule("cmi.student_preference.text", "rw", integer(-1, 1)),
  rule("cmi.interactions._children", "ro"), rule("cmi.interactions._count", "ro"),
  rule("cmi.interactions.n.id", "wo", identifier12), rule("cmi.interactions.n.objectives._count", "ro"),
  rule("cmi.interactions.n.objectives.n.id", "wo", identifier12), rule("cmi.interactions.n.time", "wo", time12),
  rule("cmi.interactions.n.type", "wo", vocab("true-false", "choice", "fill-in", "matching", "performance", "sequencing", "likert", "numeric")),
  rule("cmi.interactions.n.correct_responses._count", "ro"), rule("cmi.interactions.n.correct_responses.n.pattern", "wo", text(255, true)),
  rule("cmi.interactions.n.weighting", "wo", number()), rule("cmi.interactions.n.student_response", "wo", text(255, true)),
  rule("cmi.interactions.n.result", "wo", either(vocab("correct", "wrong", "unanticipated", "neutral"), number())),
  rule("cmi.interactions.n.latency", "wo", timespan12),
];

const COMPLETION = vocab("completed", "incomplete", "not attempted", "unknown");
const SUCCESS = vocab("passed", "failed", "unknown");
const SCALED = number(-1, 1);
const REAL = number();
const MEASURE = number(0, 1);
const RULES_2004: Rule[] = [
  rule("cmi._version", "ro"),
  rule("cmi.comments_from_learner._children", "ro"), rule("cmi.comments_from_learner._count", "ro"),
  rule("cmi.comments_from_learner.n.comment", "rw", text(4000, false)), rule("cmi.comments_from_learner.n.location", "rw", text(250, false)),
  rule("cmi.comments_from_learner.n.timestamp", "rw", timestamp),
  rule("cmi.comments_from_lms._children", "ro"), rule("cmi.comments_from_lms._count", "ro"),
  rule("cmi.comments_from_lms.n.comment", "ro"), rule("cmi.comments_from_lms.n.location", "ro"), rule("cmi.comments_from_lms.n.timestamp", "ro"),
  rule("cmi.completion_status", "rw", COMPLETION), rule("cmi.completion_threshold", "ro"), rule("cmi.credit", "ro"), rule("cmi.entry", "ro"),
  rule("cmi.exit", "wo", vocab("time-out", "suspend", "logout", "normal", "")),
  rule("cmi.interactions._children", "ro"), rule("cmi.interactions._count", "ro"),
  rule("cmi.interactions.n.id", "rw", identifier2004),
  rule("cmi.interactions.n.type", "rw", vocab("true-false", "choice", "fill-in", "long-fill-in", "likert", "matching", "performance", "sequencing", "numeric", "other")),
  rule("cmi.interactions.n.objectives._count", "ro"), rule("cmi.interactions.n.objectives.n.id", "rw", identifier2004),
  rule("cmi.interactions.n.timestamp", "rw", timestamp),
  rule("cmi.interactions.n.correct_responses._count", "ro"), rule("cmi.interactions.n.correct_responses.n.pattern", "rw"),
  rule("cmi.interactions.n.weighting", "rw", REAL), rule("cmi.interactions.n.learner_response", "rw"),
  rule("cmi.interactions.n.result", "rw", either(vocab("correct", "incorrect", "unanticipated", "neutral"), REAL)),
  rule("cmi.interactions.n.latency", "rw", duration), rule("cmi.interactions.n.description", "rw", text(250, false)),
  rule("cmi.launch_data", "ro"), rule("cmi.learner_id", "ro"), rule("cmi.learner_name", "ro"),
  rule("cmi.learner_preference._children", "ro"), rule("cmi.learner_preference.audio_level", "rw", number(0)),
  rule("cmi.learner_preference.language", "rw", text(250, false)), rule("cmi.learner_preference.delivery_speed", "rw", number(0)),
  rule("cmi.learner_preference.audio_captioning", "rw", vocab("-1", "0", "1")),
  rule("cmi.location", "rw", text(1000, false)), rule("cmi.max_time_allowed", "ro"), rule("cmi.mode", "ro"),
  rule("cmi.objectives._children", "ro"), rule("cmi.objectives._count", "ro"),
  rule("cmi.objectives.n.id", "rw", identifier2004), rule("cmi.objectives.n.score._children", "ro"),
  rule("cmi.objectives.n.score.scaled", "rw", SCALED), rule("cmi.objectives.n.score.raw", "rw", REAL),
  rule("cmi.objectives.n.score.min", "rw", REAL), rule("cmi.objectives.n.score.max", "rw", REAL),
  rule("cmi.objectives.n.success_status", "rw", SUCCESS), rule("cmi.objectives.n.completion_status", "rw", COMPLETION),
  rule("cmi.objectives.n.progress_measure", "rw", MEASURE), rule("cmi.objectives.n.description", "rw", text(250, false)),
  rule("cmi.progress_measure", "rw", MEASURE), rule("cmi.scaled_passing_score", "ro"),
  rule("cmi.score._children", "ro"), rule("cmi.score.scaled", "rw", SCALED), rule("cmi.score.raw", "rw", REAL),
  rule("cmi.score.min", "rw", REAL), rule("cmi.score.max", "rw", REAL),
  rule("cmi.session_time", "wo", duration), rule("cmi.success_status", "rw", SUCCESS),
  rule("cmi.suspend_data", "rw", text(64000, false)), rule("cmi.time_limit_action", "ro"), rule("cmi.total_time", "ro"),
  rule("adl.nav.request", "rw", navRequest),
];

export const CHILDREN: Record<ScormVersion, Record<string, string>> = {
  "1.2": {
    "cmi.core._children": "student_id,student_name,lesson_location,credit,lesson_status,entry,score,total_time,lesson_mode,exit,session_time",
    "cmi.core.score._children": "raw,min,max",
    "cmi.objectives._children": "id,score,status",
    "cmi.objectives.n.score._children": "raw,min,max",
    "cmi.student_data._children": "mastery_score,max_time_allowed,time_limit_action",
    "cmi.student_preference._children": "audio,language,speed,text",
    "cmi.interactions._children": "id,objectives,time,type,correct_responses,weighting,student_response,result,latency",
  },
  "2004": {
    "cmi.comments_from_learner._children": "comment,location,timestamp",
    "cmi.comments_from_lms._children": "comment,location,timestamp",
    "cmi.interactions._children": "id,type,objectives,timestamp,correct_responses,weighting,learner_response,result,latency,description",
    "cmi.learner_preference._children": "audio_level,language,delivery_speed,audio_captioning",
    "cmi.objectives._children": "id,score,success_status,completion_status,progress_measure,description",
    "cmi.objectives.n.score._children": "scaled,raw,min,max",
    "cmi.score._children": "scaled,raw,min,max",
  },
};

/** Spec error codes and their standard messages. */
export const ERROR_STRINGS: Record<ScormVersion, Record<string, string>> = {
  "1.2": {
    "0": "No error", "101": "General exception", "201": "Invalid argument error", "202": "Element cannot have children",
    "203": "Element not an array. Cannot have count.", "301": "Not initialized", "401": "Not implemented error",
    "402": "Invalid set value, element is a keyword", "403": "Element is read only", "404": "Element is write only", "405": "Incorrect Data Type",
  },
  "2004": {
    "0": "No Error", "101": "General Exception", "102": "General Initialization Failure", "103": "Already Initialized",
    "104": "Content Instance Terminated", "111": "General Termination Failure", "112": "Termination Before Initialization",
    "113": "Termination After Termination", "122": "Retrieve Data Before Initialization", "123": "Retrieve Data After Termination",
    "132": "Store Data Before Initialization", "133": "Store Data After Termination", "142": "Commit Before Initialization",
    "143": "Commit After Termination", "201": "General Argument Error", "301": "General Get Failure", "351": "General Set Failure",
    "391": "General Commit Failure", "401": "Undefined Data Model Element", "402": "Unimplemented Data Model Element",
    "403": "Data Model Element Value Not Initialized", "404": "Data Model Element Is Read Only", "405": "Data Model Element Is Write Only",
    "406": "Data Model Element Type Mismatch", "407": "Data Model Element Value Out Of Range", "408": "Data Model Dependency Not Established",
  },
};

const RULES = { "1.2": RULES_12, "2004": RULES_2004 };
const ADL_VALID = /^adl\.nav\.request_valid\.(continue|previous|choice\.\{target=[^}]+\}|jump\.\{target=[^}]+\})$/;

function find(version: ScormVersion, element: string) {
  for (const candidate of RULES[version]) {
    const match = candidate.pattern.exec(element);
    if (match) return { rule: candidate };
  }
  return null;
}

/** The generic form of an element, with array indexes as "n". */
export function genericElement(element: string) {
  return element.replace(/\.\d+(?=\.|$)/g, ".n");
}

/** Elements from the other SCORM version, named so the issue says what went wrong. */
function otherVersionHint(version: ScormVersion, element: string) {
  const other: ScormVersion = version === "1.2" ? "2004" : "1.2";
  return find(other, element) ? ` It is a SCORM ${other} element; this call went to the SCORM ${version} API.` : "";
}

/** Why the course can't read `element`, or null when it can. */
export function checkGet(version: ScormVersion, element: string, data: Record<string, string>): ModelError | null {
  if (!element) return { code: "201", message: "GetValue needs an element name.", severity: "error" };
  if (version === "2004" && ADL_VALID.test(element)) return null;
  const children = /^(.*)\._children$/.exec(element);
  if (children) {
    if (CHILDREN[version][genericElement(element)]) return null;
    if (find(version, children[1])) return { code: version === "1.2" ? "202" : "301", message: `${children[1]} has no children.`, severity: "error" };
  }
  const count = /^(.*)\._count$/.exec(element);
  if (count && !find(version, element) && (find(version, count[1]) || CHILDREN[version][`${genericElement(count[1])}._children`]))
    return { code: version === "1.2" ? "203" : "301", message: `${count[1]} isn't an array, so it has no _count.`, severity: "error" };
  const found = find(version, element);
  if (!found) return { code: version === "1.2" ? "201" : "401", message: `${element} isn't a SCORM ${version} element.${otherVersionHint(version, element)}`, severity: "error" };
  if (found.rule.access === "wo") return { code: version === "1.2" ? "404" : "405", message: `${element} is write-only; a course can't read it back from an LMS.`, severity: "error" };
  for (const prefix of found.rule.array ? arrayPrefixes(element) : []) {
    const index = Number(/\.(\d+)$/.exec(prefix.path)?.[1]);
    if (index >= countOf(data, prefix.array)) return { code: version === "1.2" ? "201" : "301", message: `${element} reads past the end of ${prefix.array}.`, severity: "error" };
  }
  return null;
}

/** Why the course can't write `value` to `element`, or null when it can. */
export function checkSet(version: ScormVersion, element: string, value: string, data: Record<string, string>): ModelError | null {
  if (!element) return { code: version === "1.2" ? "201" : "351", message: "SetValue needs an element name.", severity: "error" };
  if (/\._(children|count|version)$/.test(element)) return { code: version === "1.2" ? "402" : "404", message: `${element} is a keyword the LMS sets; a course can't write it.`, severity: "error" };
  if (version === "2004" && ADL_VALID.test(element)) return { code: "404", message: `${element} is read-only.`, severity: "error" };
  const found = find(version, element);
  if (!found) return { code: version === "1.2" ? "201" : "401", message: `${element} isn't a SCORM ${version} element.${otherVersionHint(version, element)}`, severity: "error" };
  if (found.rule.access === "ro") return { code: version === "1.2" ? "403" : "404", message: `${element} is read-only; the LMS sets it.`, severity: "error" };
  if (found.rule.array) {
    // Each index of an array path must already exist or be the next one.
    const prefixes = arrayPrefixes(element);
    for (const prefix of prefixes) {
      const index = Number(/\.(\d+)$/.exec(prefix.path)?.[1]);
      const count = countOf(data, prefix.array);
      if (index > count) return { code: version === "1.2" ? "201" : "351", message: `${element} skips ahead: ${prefix.array} has ${count} entr${count === 1 ? "y" : "ies"}, so the next index is ${count}.`, severity: "error" };
    }
    // SCORM 2004: an objective or interaction needs its id before anything else.
    const last = prefixes[0];
    if (version === "2004" && /^cmi\.(objectives|interactions)\.\d+$/.test(last.path) && !element.endsWith(".id") && !(`${last.path}.id` in data))
      return { code: "408", message: `${element} was set before ${last.path}.id; SCORM 2004 needs the id first.`, severity: "error" };
  }
  if (version === "1.2" && element === "cmi.core.lesson_status" && value === "not attempted")
    return { code: "405", message: "A course can't set cmi.core.lesson_status back to \"not attempted\".", severity: "error" };
  const problem = found.rule.check?.(value) ?? null;
  if (!problem) return null;
  if (problem.kind === "long") return { code: "0", message: `${element}: ${problem.message}.`, severity: "warning" };
  const code = version === "1.2" ? "405" : problem.kind === "range" ? "407" : "406";
  return { code, message: `${element}: ${problem.message}.`, severity: "error" };
}

/** True when a 2004 read-write element has never been set and has no LMS value (error 403). */
export function notInitialized(version: ScormVersion, element: string, data: Record<string, string>) {
  if (version !== "2004" || element in data) return false;
  const found = find(version, element);
  return Boolean(found && found.rule.access === "rw");
}

/** Every array index along a path, innermost first: cmi.interactions.0.objectives.1.id → [objectives.1, interactions.0]. */
function arrayPrefixes(element: string) {
  const out: { path: string; array: string }[] = [];
  const pattern = /\.(\d+)(?=\.|$)/g;
  let match;
  while ((match = pattern.exec(element))) {
    const path = element.slice(0, match.index + match[0].length);
    out.unshift({ path, array: element.slice(0, match.index) });
  }
  return out;
}

export function countOf(data: Record<string, string>, prefix: string) {
  const pattern = new RegExp(`^${prefix.replace(/\./g, "\\.")}\\.(\\d+)\\.`);
  let max = -1;
  for (const key of Object.keys(data)) {
    const match = pattern.exec(key);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

/** Seconds in a SCORM 1.2 CMITimespan ("HHHH:MM:SS.SS"), or null. */
export function parseTimespan(value: string) {
  const match = /^(\d{2,4}):(\d{2}):(\d{2}(?:\.\d{1,2})?)$/.exec(value);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null;
}

/** Seconds in an ISO 8601 duration ("PT1H2M3.5S"), or null. Years and months use 365 and 30 days. */
export function parseDuration(value: string) {
  const match = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!match || value === "P" || value.endsWith("T")) return null;
  const [, y, mo, d, h, mi, s] = match.map((part) => Number(part ?? 0));
  return ((y * 365 + mo * 30 + d) * 24 + h) * 3600 + mi * 60 + s;
}

export function formatTimespan(seconds: number) {
  const whole = Math.floor(seconds);
  const hundredths = Math.round((seconds - whole) * 100);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(Math.floor(whole / 3600), 4)}:${pad(Math.floor(whole / 60) % 60)}:${pad(whole % 60)}${hundredths ? `.${pad(hundredths)}` : ""}`;
}

export function formatDuration(seconds: number) {
  const whole = Math.floor(seconds);
  const fraction = Math.round((seconds - whole) * 100) / 100;
  const s = whole % 60 + fraction;
  return `PT${Math.floor(whole / 3600)}H${Math.floor(whole / 60) % 60}M${Number(s.toFixed(2))}S`;
}
