import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import express from "express";
import { courseKey } from "./scorm-state.mjs";

/**
 * A small xAPI Learning Record Store for reviewing xAPI (Tin Can) and cmi5 courses locally, and
 * the LMS side of a cmi5 launch. It keeps one course's statements and documents in the cache,
 * accepts what conformant content sends (statements, state, activity and agent profiles), and
 * records departures from xAPI and cmi5 rules as issues for the inspector. It is a review aid,
 * not a conformant or secure LRS: any request from the page is accepted.
 */

export const XAPI_BASE = "/xapi/";
const VERSION = "1.0.3";
const MAX_STATEMENTS = 5000;
const MAX_ISSUES = 200;
const CMI5_CATEGORY = "https://w3id.org/xapi/cmi5/context/categories/cmi5";
const MOVEON_CATEGORY = "https://w3id.org/xapi/cmi5/context/categories/moveon";
const SESSION_EXTENSION = "https://w3id.org/xapi/cmi5/context/extensions/sessionid";
const VERBS = {
  launched: "http://adlnet.gov/expapi/verbs/launched",
  initialized: "http://adlnet.gov/expapi/verbs/initialized",
  completed: "http://adlnet.gov/expapi/verbs/completed",
  passed: "http://adlnet.gov/expapi/verbs/passed",
  failed: "http://adlnet.gov/expapi/verbs/failed",
  abandoned: "https://w3id.org/xapi/adl/verbs/abandoned",
  waived: "https://w3id.org/xapi/adl/verbs/waived",
  terminated: "http://adlnet.gov/expapi/verbs/terminated",
  satisfied: "https://w3id.org/xapi/adl/verbs/satisfied",
  voided: "http://adlnet.gov/expapi/verbs/voided",
};
const CMI5_VERBS = new Set([VERBS.initialized, VERBS.completed, VERBS.passed, VERBS.failed, VERBS.terminated]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Durable statements, documents and the registration for one course, beside its SCORM progress. */
export function createXapiStore(cacheDir, course) {
  const key = createHash("sha256").update(courseKey(course)).digest("hex");
  const file = path.join(cacheDir, "xapi", `${key}.json`);
  const fresh = () => ({ registration: randomUUID(), statements: [], documents: {}, issues: [] });
  let state;
  try { state = { ...fresh(), ...JSON.parse(fs.readFileSync(file, "utf8")) }; } catch { state = fresh(); }
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state));
    fs.renameSync(temporary, file);
  };
  return {
    get state() { return state; },
    save,
    reset() { state = fresh(); save(); },
  };
}

/**
 * The LRS routes (under /xapi/) and the launch route the player's frame opens. `context()`
 * returns the open course and its store, or null when no xAPI or cmi5 course is open.
 *
 * @param {() => ({ course: any, xapi: ReturnType<typeof createXapiStore> } | null)} context
 * @param {(event: string, detail: object) => void} [emit]
 */
export function createXapiRoutes(context, emit = () => {}) {
  const router = express.Router();
  const sessions = new Map();
  router.use(express.raw({ type: () => true, limit: "16mb" }));
  router.use((req, res, next) => {
    res.set("X-Experience-API-Version", VERSION);
    res.set("Cache-Control", "no-store");
    if (!context()) return res.status(404).json({ error: "No xAPI or cmi5 course is open." });
    next();
  });

  const store = () => context().xapi;
  const issue = (severity, message, statement = null) => {
    const state = store().state;
    const existing = state.issues.find((item) => item.message === message);
    if (existing) { existing.count += 1; existing.at = Date.now(); }
    else state.issues = [...state.issues.slice(-(MAX_ISSUES - 1)), { at: Date.now(), severity, message, count: 1, ...(statement?.id ? { statement: statement.id } : {}) }];
  };

  router.get("/about", (_req, res) => res.json({ version: [VERSION, "1.0.0", "2.0.0"] }));

  // cmi5: the AU trades the one-time fetch URL for its credentials.
  router.post("/cmi5/fetch", (req, res) => {
    const session = sessions.get(String(req.query.session ?? ""));
    if (!session) return res.json({ "error-code": "3", "error-text": "Unknown or expired launch session." });
    if (session.fetched) {
      issue("error", "The AU called the fetch URL more than once in a session; an LMS refuses the second call.");
      return res.json({ "error-code": "1", "error-text": "The fetch URL was already used in this session." });
    }
    session.fetched = true;
    res.json({ "auth-token": Buffer.from(`scormplayer:${session.id}`).toString("base64") });
  });

  router.put("/statements", (req, res) => {
    const id = String(req.query.statementId ?? "");
    if (!UUID.test(id)) return res.status(400).json({ error: "PUT /statements needs a statementId that is a UUID." });
    const statement = parseBody(req);
    if (!statement || Array.isArray(statement)) return res.status(400).json({ error: "PUT /statements takes one statement." });
    if (statement.id && statement.id !== id) return res.status(400).json({ error: "The statement id doesn't match statementId." });
    const stored = store().state.statements.find((item) => item.id === id);
    if (stored) return stored.raw === JSON.stringify({ ...statement, id }) ? res.status(204).end() : res.status(409).json({ error: "A different statement already has this id." });
    const problem = accept({ ...statement, id });
    if (problem) return res.status(400).json({ error: problem });
    res.status(204).end();
  });

  router.post("/statements", (req, res) => {
    const body = parseBody(req);
    if (!body || typeof body !== "object") return res.status(400).json({ error: "The body must be a statement or a list of statements." });
    const statements = Array.isArray(body) ? body : [body];
    const ids = [];
    for (const statement of statements) {
      const problem = accept({ ...statement, id: statement?.id ?? randomUUID() }, ids);
      if (problem) return res.status(400).json({ error: problem });
    }
    res.json(ids);
  });

  router.get("/statements", (req, res) => {
    const state = store().state;
    const id = req.query.statementId ?? req.query.voidedStatementId;
    if (id) {
      const found = state.statements.find((item) => item.id === id);
      return found ? res.json(found.statement) : res.status(404).json({ error: "No such statement." });
    }
    let list = state.statements.filter((item) => !item.voided);
    if (req.query.verb) list = list.filter((item) => item.statement.verb?.id === req.query.verb);
    if (req.query.activity) list = list.filter((item) => item.statement.object?.id === req.query.activity);
    if (req.query.registration) list = list.filter((item) => item.statement.context?.registration === req.query.registration);
    if (req.query.agent) { const wanted = agentKey(parseJson(req.query.agent)); list = list.filter((item) => agentKey(item.statement.actor) === wanted); }
    if (req.query.since) list = list.filter((item) => item.statement.stored > req.query.since);
    if (req.query.until) list = list.filter((item) => item.statement.stored <= req.query.until);
    list = req.query.ascending === "true" ? list : [...list].reverse();
    const limit = Number(req.query.limit) > 0 ? Number(req.query.limit) : 100;
    res.json({ statements: list.slice(0, limit).map((item) => item.statement), more: "" });
  });

  // Documents: state (per activity, agent and registration), activity profiles and agent profiles.
  const documentKey = (req, kind) => {
    if (kind === "state") return ["state", req.query.activityId, agentKey(parseJson(req.query.agent)), req.query.registration ?? ""].join("|");
    if (kind === "activity") return ["activity", req.query.activityId].join("|");
    return ["agent", agentKey(parseJson(req.query.agent))].join("|");
  };
  const idParam = { state: "stateId", activity: "profileId", agent: "profileId" };
  const documentRoutes = (route, kind) => {
    router.get(route, (req, res) => {
      const documents = store().state.documents;
      const prefix = `${documentKey(req, kind)}|`;
      const id = req.query[idParam[kind]];
      if (id === undefined) {
        const since = req.query.since ? String(req.query.since) : "";
        return res.json(Object.entries(documents).filter(([name, doc]) => name.startsWith(prefix) && doc.updated > since).map(([name]) => name.slice(prefix.length)));
      }
      const doc = documents[`${prefix}${id}`];
      if (!doc) return res.status(404).end();
      res.set("ETag", `"${doc.etag}"`).set("Last-Modified", new Date(doc.updated).toUTCString()).type(doc.contentType).send(Buffer.from(doc.body, "base64"));
    });
    const write = (merge) => (req, res) => {
      const id = req.query[idParam[kind]];
      if (!id) return res.status(400).json({ error: `${idParam[kind]} is required.` });
      if (kind !== "activity" && !req.query.agent) return res.status(400).json({ error: "agent is required." });
      const state = store().state;
      const name = `${documentKey(req, kind)}|${id}`;
      const existing = state.documents[name];
      const ifMatch = req.get("if-match");
      if (ifMatch && (!existing || ifMatch.replace(/"/g, "") !== existing.etag)) return res.status(412).end();
      if (req.get("if-none-match") === "*" && existing) return res.status(412).end();
      let body = rawBody(req);
      let contentType = req.get("content-type") || "application/octet-stream";
      if (merge && existing) {
        const before = parseJson(Buffer.from(existing.body, "base64").toString("utf8"));
        const after = parseJson(body.toString("utf8"));
        if (!isObject(before) || !isObject(after)) return res.status(400).json({ error: "POST merges JSON objects; use PUT to replace other documents." });
        body = Buffer.from(JSON.stringify({ ...before, ...after }));
        contentType = "application/json";
      }
      state.documents[name] = { contentType, body: body.toString("base64"), updated: new Date().toISOString(), etag: createHash("sha1").update(body).digest("hex") };
      store().save();
      emit("document", { kind, id });
      res.status(204).end();
    };
    router.put(route, write(false));
    router.post(route, write(true));
    router.delete(route, (req, res) => {
      const state = store().state;
      const prefix = `${documentKey(req, kind)}|`;
      const id = req.query[idParam[kind]];
      for (const name of Object.keys(state.documents)) {
        if (id === undefined ? name.startsWith(prefix) : name === `${prefix}${id}`) delete state.documents[name];
      }
      store().save();
      res.status(204).end();
    });
  };
  documentRoutes("/activities/state", "state");
  documentRoutes("/activities/profile", "activity");
  documentRoutes("/agents/profile", "agent");
  router.get("/activities", (req, res) => res.json({ objectType: "Activity", id: String(req.query.activityId ?? "") }));
  router.get("/agents", (req, res) => { const agent = parseJson(req.query.agent) ?? {}; res.json({ objectType: "Person", ...(agent.name ? { name: [agent.name] } : {}), ...(agent.mbox ? { mbox: [agent.mbox] } : {}), ...(agent.account ? { account: [agent.account] } : {}) }); });

  /** Validate, check against cmi5 rules, store. Returns an error message for a statement an LRS must reject. */
  function accept(statement, ids = []) {
    const problem = validateStatement(statement);
    if (problem) { issue("error", `The LRS rejected a statement: ${problem}`, statement); store().save(); return problem; }
    const state = store().state;
    if (state.statements.some((item) => item.id === statement.id) || ids.includes(statement.id)) return `Statement ${statement.id} already exists.`;
    const now = new Date().toISOString();
    const full = { ...statement, timestamp: statement.timestamp ?? now, stored: now, authority: { objectType: "Agent", name: "scormplayer", account: { homePage: "https://github.com/jakerains/scormplayer", name: "scormplayer" } }, version: statement.version ?? VERSION };
    if (statement.verb.id === VERBS.voided && statement.object?.objectType === "StatementRef") {
      const target = state.statements.find((item) => item.id === statement.object.id);
      if (target) target.voided = true;
    }
    checkCmi5(full);
    state.statements = [...state.statements.slice(-(MAX_STATEMENTS - 1)), { id: full.id, raw: JSON.stringify(statement), statement: full }];
    ids.push(full.id);
    satisfy(full);
    store().save();
    emit("statement", { verb: full.verb.id, display: verbName(full.verb) });
    return null;
  }

  /** cmi5 rules for AU statements, recorded as issues (an LMS would ignore or reject these). */
  function checkCmi5(statement) {
    const { course } = context();
    if (course.standard !== "cmi5") return;
    const sessionId = statement.context?.extensions?.[SESSION_EXTENSION];
    const session = sessionId ? sessions.get(sessionId) : [...sessions.values()].at(-1);
    if (!session || statement.verb.id === VERBS.launched || statement.verb.id === VERBS.satisfied) return;
    const verb = verbName(statement.verb);
    const cmi5 = CMI5_VERBS.has(statement.verb.id);
    if (!session.initialized && statement.verb.id !== VERBS.initialized) issue("error", `The AU sent "${verb}" before "initialized"; the first statement of a session must be initialized.`, statement);
    if (session.terminated) issue("error", `The AU sent "${verb}" after "terminated"; an LMS rejects statements after the session ends.`, statement);
    if (statement.context?.registration !== session.registration) issue("error", `A "${verb}" statement doesn't carry the launch's registration (${session.registration}) in context.registration.`, statement);
    if (!sessionId) issue("error", `A "${verb}" statement has no cmi5 session id extension in its context.`, statement);
    if (cmi5) {
      const categories = statement.context?.contextActivities?.category ?? [];
      if (!(Array.isArray(categories) ? categories : [categories]).some((activity) => activity?.id === CMI5_CATEGORY)) issue("error", `The "${verb}" statement lacks the cmi5 category in context.contextActivities.category.`, statement);
      if (statement.object?.id !== session.au.id) issue("error", `The "${verb}" statement's object is ${statement.object?.id}, not the AU's activity id ${session.au.id}.`, statement);
      if ([VERBS.terminated, VERBS.completed, VERBS.passed, VERBS.failed].includes(statement.verb.id) && !statement.result?.duration) issue("warning", `The "${verb}" statement has no result.duration; cmi5 asks AUs to report time.`, statement);
    }
    if (statement.verb.id === VERBS.initialized) {
      if (session.initialized) issue("error", "The AU sent \"initialized\" twice in one session.", statement);
      session.initialized = true;
    }
    if ([VERBS.completed, VERBS.passed, VERBS.failed].includes(statement.verb.id)) {
      if (session.mode !== "Normal") issue("error", `The AU sent "${verb}" in ${session.mode} mode; cmi5 allows it only in Normal mode.`, statement);
      const earlier = registrationVerbs(session.au.id, session.registration).filter((id) => id === statement.verb.id).length;
      if (earlier > 0 && statement.verb.id !== VERBS.failed) issue("error", `The AU sent "${verb}" again; cmi5 allows it once per registration.`, statement);
      const mastery = session.au.cmi5?.masteryScore;
      const scaled = statement.result?.score?.scaled;
      if (mastery !== undefined && statement.verb.id !== VERBS.completed) {
        if (scaled === undefined) issue("warning", `The "${verb}" statement has no result.score.scaled to compare with the mastery score ${mastery}.`, statement);
        else if (statement.verb.id === VERBS.passed && scaled < mastery) issue("error", `The AU passed with ${scaled}, below its mastery score ${mastery}.`, statement);
        else if (statement.verb.id === VERBS.failed && scaled >= mastery) issue("error", `The AU failed with ${scaled}, at or above its mastery score ${mastery}.`, statement);
      }
    }
    if (statement.verb.id === VERBS.terminated) session.terminated = true;
  }

  function registrationVerbs(activityId, registration) {
    return store().state.statements.filter((item) => item.statement.object?.id === activityId && item.statement.context?.registration === registration).map((item) => item.statement.verb.id);
  }

  /** cmi5: the LMS sends "satisfied" once an AU (and then the course) meets its moveOn. */
  function satisfy(statement) {
    const { course } = context();
    if (course.standard !== "cmi5" || ![VERBS.completed, VERBS.passed].includes(statement.verb.id)) return;
    const registration = statement.context?.registration;
    const sco = course.scos.find((item) => item.id === statement.object?.id);
    if (!sco || !registration) return;
    const done = (au) => {
      const verbs = registrationVerbs(au.id, registration);
      const completed = verbs.includes(VERBS.completed);
      const passed = verbs.includes(VERBS.passed);
      return { Completed: completed, Passed: passed, CompletedAndPassed: completed && passed, CompletedOrPassed: completed || passed, NotApplicable: true }[au.cmi5?.moveOn ?? "NotApplicable"] ?? false;
    };
    const send = (object) => {
      if (registrationVerbs(object.id, registration).includes(VERBS.satisfied)) return;
      const now = new Date().toISOString();
      const satisfied = { id: randomUUID(), actor: statement.actor, verb: { id: VERBS.satisfied, display: { "en-US": "satisfied" } }, object,
        context: { registration, contextActivities: { category: [{ id: MOVEON_CATEGORY }], grouping: [{ id: course.identifier || "urn:scormplayer:course" }] }, extensions: statement.context?.extensions ?? {} },
        timestamp: now, stored: now, version: VERSION };
      store().state.statements.push({ id: satisfied.id, raw: JSON.stringify(satisfied), statement: satisfied });
    };
    if (done(sco)) send({ objectType: "Activity", id: sco.id });
    if (course.scos.every(done)) send({ objectType: "Activity", id: course.identifier || "urn:scormplayer:course", definition: { type: "https://w3id.org/xapi/cmi5/activitytype/course" } });
  }

  /**
   * Start a launch as an LMS would and send the frame to the course with its launch
   * parameters. The learner's name, id and mode come from the player's launch settings.
   */
  function launch(req, res) {
    const { course, xapi } = context();
    const sco = course.scos.find((item) => item.id === req.query.au) ?? course.scos[0];
    const origin = `${req.protocol}://${req.get("host")}`;
    const learnerId = String(req.query.learnerId || "scormplayer");
    const learnerName = String(req.query.learnerName || "Reviewer, Player");
    const mode = { normal: "Normal", browse: "Browse", review: "Review" }[String(req.query.mode)] ?? "Normal";
    const registration = xapi.state.registration;
    const endpoint = `${origin}${XAPI_BASE}`;
    const params = new URLSearchParams();
    if (course.standard === "cmi5") {
      const actor = { objectType: "Agent", name: learnerName, account: { homePage: "https://github.com/jakerains/scormplayer", name: learnerId } };
      const id = randomUUID();
      sessions.set(id, { id, au: sco, registration, mode, initialized: false, terminated: false, fetched: false });
      const contextTemplate = { contextActivities: { grouping: [{ objectType: "Activity", id: course.identifier || "urn:scormplayer:course" }] }, extensions: { [SESSION_EXTENSION]: id } };
      const launchData = {
        contextTemplate, launchMode: mode, launchMethod: sco.cmi5?.launchMethod ?? "AnyWindow", moveOn: sco.cmi5?.moveOn ?? "NotApplicable",
        ...(sco.cmi5?.masteryScore !== undefined ? { masteryScore: sco.cmi5.masteryScore } : {}),
        ...(sco.cmi5?.launchParameters ? { launchParameters: sco.cmi5.launchParameters } : {}),
        ...(sco.cmi5?.entitlementKey ? { entitlementKey: { courseStructure: sco.cmi5.entitlementKey } } : {}),
      };
      const body = Buffer.from(JSON.stringify(launchData));
      xapi.state.documents[["state", sco.id, agentKey(actor), registration, "LMS.LaunchData"].join("|")] = { contentType: "application/json", body: body.toString("base64"), updated: new Date().toISOString(), etag: createHash("sha1").update(body).digest("hex") };
      const now = new Date().toISOString();
      const launched = { id: randomUUID(), actor, verb: { id: VERBS.launched, display: { "en-US": "launched" } }, object: { objectType: "Activity", id: sco.id },
        context: { ...contextTemplate, registration, contextActivities: { ...contextTemplate.contextActivities, category: [{ id: CMI5_CATEGORY }] },
          extensions: { ...contextTemplate.extensions, "https://w3id.org/xapi/cmi5/context/extensions/launchmode": mode, "https://w3id.org/xapi/cmi5/context/extensions/launchurl": `${origin}/course/${sco.launch}`, "https://w3id.org/xapi/cmi5/context/extensions/moveon": launchData.moveOn } },
        timestamp: now, stored: now, version: VERSION };
      xapi.state.statements.push({ id: launched.id, raw: JSON.stringify(launched), statement: launched });
      if ((sco.cmi5?.moveOn ?? "NotApplicable") === "NotApplicable") satisfy({ ...launched, verb: { id: VERBS.completed } });
      xapi.save();
      params.set("endpoint", endpoint);
      params.set("fetch", `${origin}${XAPI_BASE}cmi5/fetch?session=${id}`);
      params.set("actor", JSON.stringify(actor));
      params.set("registration", registration);
      params.set("activityId", sco.id);
    } else {
      const actor = { objectType: "Agent", name: learnerName, mbox: `mailto:${learnerId.replace(/[^\w.+-]/g, "_")}@scormplayer.local` };
      params.set("endpoint", endpoint);
      params.set("auth", `Basic ${Buffer.from("scormplayer:review").toString("base64")}`);
      params.set("actor", JSON.stringify(actor));
      params.set("registration", registration);
      params.set("activity_id", sco.id);
    }
    const [file, query = ""] = sco.launch.split("#")[0].split("?");
    const target = `/course/${file.split("/").map((part) => encodeURIComponent(decodeSafe(part))).join("/")}?${[query, params.toString()].filter(Boolean).join("&")}`;
    res.set("Cache-Control", "no-store").redirect(302, target);
  }

  /** The current registration's statements and what they say about each module. */
  function summary() {
    const { course, xapi } = context();
    const registration = xapi.state.registration;
    const statements = xapi.state.statements.filter((item) => !item.voided && (!item.statement.context?.registration || item.statement.context.registration === registration)).map((item) => item.statement);
    const modules = Object.fromEntries(course.scos.map((sco) => {
      const own = statements.filter((statement) => statement.object?.id === sco.id || (course.standard === "xapi" && course.scos.length === 1));
      const has = (verb) => own.some((statement) => statement.verb?.id === verb);
      const scored = [...own].reverse().find((statement) => statement.result?.score);
      const score = scored?.result?.score;
      const success = has(VERBS.passed) ? "passed" : has(VERBS.failed) ? "failed" : own.some((statement) => statement.result?.success === true) ? "passed" : own.some((statement) => statement.result?.success === false) ? "failed" : "";
      const completion = has(VERBS.completed) || own.some((statement) => statement.result?.completion === true) ? "completed" : own.length ? "incomplete" : "";
      return [sco.id, { completion, success, score: score ? (score.scaled !== undefined ? `${Math.round(score.scaled * 100)}%` : String(score.raw ?? "")) : "", satisfied: has(VERBS.satisfied) }];
    }));
    return { standard: course.standard, registration, modules, statements: [...statements].reverse().slice(0, 500), count: statements.length, issues: xapi.state.issues };
  }

  return { router, launch, summary };
}

function validateStatement(statement) {
  if (!isObject(statement)) return "a statement must be a JSON object.";
  if (statement.id !== undefined && !UUID.test(String(statement.id))) return `id "${statement.id}" isn't a UUID.`;
  if (!isObject(statement.actor)) return "actor is required.";
  const actor = statement.actor;
  const ifis = ["mbox", "mbox_sha1sum", "openid", "account"].filter((key) => actor[key] !== undefined);
  if (actor.objectType !== "Group" && ifis.length !== 1) return "the actor needs exactly one identifier (mbox, mbox_sha1sum, openid or account).";
  if (actor.mbox !== undefined && !/^mailto:[^@\s]+@[^@\s]+$/.test(String(actor.mbox))) return `actor.mbox "${actor.mbox}" must be a mailto: address.`;
  if (actor.account && (!actor.account.homePage || actor.account.name === undefined)) return "actor.account needs homePage and name.";
  if (!isObject(statement.verb) || !/^[a-z][a-z0-9+.-]*:/i.test(String(statement.verb.id ?? ""))) return "verb.id must be an IRI.";
  if (!isObject(statement.object)) return "object is required.";
  const type = statement.object.objectType ?? "Activity";
  if (type === "Activity" && !/^[a-z][a-z0-9+.-]*:/i.test(String(statement.object.id ?? ""))) return "object.id must be an IRI.";
  const scaled = statement.result?.score?.scaled;
  if (scaled !== undefined && (typeof scaled !== "number" || scaled < -1 || scaled > 1)) return "result.score.scaled must be a number from -1 to 1.";
  if (statement.result?.duration !== undefined && !/^P(?!$)(\d+(\.\d+)?Y)?(\d+(\.\d+)?M)?(\d+(\.\d+)?W)?(\d+(\.\d+)?D)?(T(?=\d)(\d+(\.\d+)?H)?(\d+(\.\d+)?M)?(\d+(\.\d+)?S)?)?$/.test(String(statement.result.duration))) return `result.duration "${statement.result.duration}" isn't an ISO 8601 duration.`;
  if (statement.context?.registration !== undefined && !UUID.test(String(statement.context.registration))) return "context.registration must be a UUID.";
  return null;
}

function verbName(verb) {
  const display = verb?.display && Object.values(verb.display)[0];
  return String(display || String(verb?.id ?? "").split("/").pop());
}

function agentKey(agent) {
  if (!isObject(agent)) return "";
  if (agent.mbox) return `mbox:${agent.mbox}`;
  if (agent.mbox_sha1sum) return `sha1:${agent.mbox_sha1sum}`;
  if (agent.openid) return `openid:${agent.openid}`;
  if (agent.account) return `account:${agent.account.homePage}|${agent.account.name}`;
  return JSON.stringify(agent);
}

function parseBody(req) {
  if (isObject(req.body) && !Buffer.isBuffer(req.body)) return req.body;
  return parseJson(rawBody(req).toString("utf8"));
}

function rawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body);
  return Buffer.from(req.body === undefined ? "" : JSON.stringify(req.body));
}

function parseJson(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return null; }
}

function decodeSafe(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
