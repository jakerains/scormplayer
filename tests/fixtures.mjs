import AdmZip from "adm-zip";

const MANIFEST_12 = (title) => `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="demo-12" version="1"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2">
  <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
  <organizations default="org">
    <organization identifier="org">
      <title>${title}</title>
      <item identifier="item-1" identifierref="res-1"><title>Only page</title></item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="res-1" type="webcontent" adlcp:scormtype="sco" href="index.html"><file href="index.html"/></resource>
  </resources>
</manifest>
`;

const MANIFEST_2004 = (title, href = "content/start.html", parameters = "?page=1") => `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="demo-2004" version="1"
  xmlns="http://www.imsglobal.org/xsd/imscp_v1p1"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3">
  <metadata><schema>ADL SCORM</schema><schemaversion>2004 4th Edition</schemaversion></metadata>
  <organizations default="org">
    <organization identifier="org">
      <title>${title}</title>
      <item identifier="item-1" identifierref="res-1" parameters="${parameters}"><title>Start</title></item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="res-1" type="webcontent" adlcp:scormType="sco" href="${href}"><file href="${href}"/></resource>
  </resources>
</manifest>
`;

/** A one-page SCORM 1.2 course that completes itself, as a zip buffer. */
export function scorm12Zip({ title = "Demo 1.2 course", wrapper = "" } = {}) {
  const zip = new AdmZip();
  const prefix = wrapper ? `${wrapper}/` : "";
  zip.addFile(`${prefix}imsmanifest.xml`, Buffer.from(MANIFEST_12(title)));
  zip.addFile(`${prefix}index.html`, Buffer.from(`<!doctype html><title>${title}</title>
<h1>Welcome to the demo</h1><p id="intro">This paragraph explains the course.</p>
<script>
  let win = window, api = null;
  while (win && !api) { api = win.API; win = win === win.parent ? null : win.parent; }
  if (api) { api.LMSInitialize(""); api.LMSSetValue("cmi.core.lesson_status", "completed"); api.LMSCommit(""); }
  document.body.dataset.api = api ? "found" : "missing";
</script>`));
  return zip.toBuffer();
}

/**
 * Several packages in one zip, each with its own imsmanifest.xml, as some exports and hand-made
 * bundles are: `{ "lesson-1": "Lesson one", "more/lesson-2": "Lesson two" }`.
 */
export function bundleZip(packages = { "lesson-1": "Lesson one", "more/lesson-2": "Lesson two" }) {
  const zip = new AdmZip();
  for (const [folder, title] of Object.entries(packages)) {
    zip.addFile(`${folder}/imsmanifest.xml`, Buffer.from(MANIFEST_12(title)));
    zip.addFile(`${folder}/index.html`, Buffer.from(`<!doctype html><title>${title}</title><h1>${title}</h1>`));
  }
  return zip.toBuffer();
}

/** A SCORM 2004 course in a subfolder with launch parameters, as a zip buffer. */
export function scorm2004Zip({ title = "Demo 2004 course" } = {}) {
  const zip = new AdmZip();
  zip.addFile("imsmanifest.xml", Buffer.from(MANIFEST_2004(title)));
  zip.addFile("content/start.html", Buffer.from(`<!doctype html><title>${title}</title><h1>Start here</h1>`));
  return zip.toBuffer();
}

/** A zip that tries to write outside its folder. */
export function traversalZip() {
  const zip = new AdmZip();
  zip.addFile("imsmanifest.xml", Buffer.from(MANIFEST_12("Bad")));
  zip.addFile("index.html", Buffer.from("<p>hi</p>"));
  // AdmZip normalises names passed to addFile, so set the raw entry name afterwards.
  zip.addFile("placeholder.txt", Buffer.from("escape"));
  zip.getEntry("placeholder.txt").entryName = "../escape.txt";
  return zip.toBuffer();
}

export { MANIFEST_12, MANIFEST_2004 };

/** A SCORM 2004 package with three SCOs, each a page that records its own location. */
export function multiScoZip({ title = "Three modules" } = {}) {
  const zip = new AdmZip();
  const items = [1, 2, 3].map((n) => `<item identifier="item-${n}" identifierref="res-${n}"><title>Module ${n}</title></item>`).join("");
  const resources = [1, 2, 3].map((n) => `<resource identifier="res-${n}" type="webcontent" adlcp:scormType="sco" href="m${n}/index.html"/>`).join("");
  zip.addFile("imsmanifest.xml", Buffer.from(`<?xml version="1.0"?><manifest identifier="multi" xmlns="http://www.imsglobal.org/xsd/imscp_v1p1" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3"><metadata><schema>ADL SCORM</schema><schemaversion>2004 4th Edition</schemaversion></metadata><organizations default="o"><organization identifier="o"><title>${title}</title>${items}</organization></organizations><resources>${resources}</resources></manifest>`));
  for (const n of [1, 2, 3]) {
    zip.addFile(`m${n}/index.html`, Buffer.from(`<!doctype html><title>Module ${n}</title><h1>Module ${n}</h1><script>
let w=window,api=null;while(w&&!api){api=w.API_1484_11;w=w===w.parent?null:w.parent;}
if(api){api.Initialize("");api.SetValue("cmi.location","module-${n}");api.SetValue("cmi.completion_status","${n === 1 ? "completed" : "incomplete"}");api.Commit("");}
</script>`));
  }
  return zip.toBuffer();
}

/**
 * A cmi5 course with two AUs. The first AU does what an AU must: it fetches its token, reads
 * LMS.LaunchData, sends initialized, passed (with a score) and completed, then terminated.
 */
export function cmi5Zip({ title = "Demo cmi5 course" } = {}) {
  const zip = new AdmZip();
  zip.addFile("cmi5.xml", Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<courseStructure xmlns="https://w3id.org/xapi/profiles/cmi5/v1/CourseStructure.xsd">
  <course id="https://example.com/courses/demo"><title><langstring lang="en-US">${title}</langstring></title><description><langstring lang="en-US">Demo</langstring></description></course>
  <au id="https://example.com/courses/demo/au1" moveOn="CompletedAndPassed" masteryScore="0.8"><title><langstring lang="en-US">Lesson one</langstring></title><description><langstring lang="en-US">One</langstring></description><url>au1/index.html</url></au>
  <block id="https://example.com/courses/demo/b"><title><langstring lang="en-US">Block</langstring></title><description><langstring lang="en-US">B</langstring></description>
    <au id="https://example.com/courses/demo/au2"><title><langstring lang="en-US">Lesson two</langstring></title><description><langstring lang="en-US">Two</langstring></description><url>au2/index.html</url></au>
  </block>
</courseStructure>`));
  zip.addFile("au1/index.html", Buffer.from(`<!doctype html><title>Lesson one</title><h1>Lesson one</h1><p id="status">starting</p>
<script>
(async () => {
  const q = new URLSearchParams(location.search);
  const endpoint = q.get("endpoint"), actor = JSON.parse(q.get("actor")), registration = q.get("registration"), activityId = q.get("activityId");
  const token = (await (await fetch(q.get("fetch"), { method: "POST" })).json())["auth-token"];
  const headers = { "Content-Type": "application/json", "X-Experience-API-Version": "1.0.3", Authorization: "Basic " + token };
  const state = new URLSearchParams({ activityId, agent: JSON.stringify(actor), registration, stateId: "LMS.LaunchData" });
  const launchData = await (await fetch(endpoint + "activities/state?" + state, { headers })).json();
  const context = { ...launchData.contextTemplate, registration, contextActivities: { ...launchData.contextTemplate.contextActivities, category: [{ id: "https://w3id.org/xapi/cmi5/context/categories/cmi5" }] } };
  const send = (verb, result) => fetch(endpoint + "statements", { method: "POST", headers, body: JSON.stringify({ actor, verb: { id: verb, display: { "en-US": verb.split("/").pop() } }, object: { id: activityId }, context, ...(result ? { result } : {}) }) });
  await send("http://adlnet.gov/expapi/verbs/initialized");
  await send("http://adlnet.gov/expapi/verbs/passed", { score: { scaled: 0.9 }, success: true, duration: "PT1M" });
  await send("http://adlnet.gov/expapi/verbs/completed", { completion: true, duration: "PT1M" });
  await send("http://adlnet.gov/expapi/verbs/terminated", { duration: "PT2M" });
  document.getElementById("status").textContent = "done " + launchData.launchMode + " " + launchData.masteryScore;
})();
</script>`));
  zip.addFile("au2/index.html", Buffer.from(`<!doctype html><title>Lesson two</title><h1>Lesson two</h1>`));
  return zip.toBuffer();
}

/** An xAPI (Tin Can) package that reads its launch parameters and reports completion. */
export function tincanZip({ title = "Demo xAPI course" } = {}) {
  const zip = new AdmZip();
  zip.addFile("tincan.xml", Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<tincan xmlns="http://projecttincan.com/tincan.xsd"><activities>
  <activity id="https://example.com/xapi/demo" type="http://adlnet.gov/expapi/activities/course"><name>${title}</name><description lang="en-US">Demo</description><launch lang="en-us">index_lms.html</launch></activity>
</activities></tincan>`));
  zip.addFile("index_lms.html", Buffer.from(`<!doctype html><title>${title}</title><h1>xAPI lesson</h1><p id="status">starting</p>
<script>
(async () => {
  const q = new URLSearchParams(location.search);
  const headers = { "Content-Type": "application/json", "X-Experience-API-Version": "1.0.3", Authorization: q.get("auth") };
  const actor = JSON.parse(q.get("actor"));
  await fetch(q.get("endpoint") + "statements", { method: "POST", headers, body: JSON.stringify({ actor, verb: { id: "http://adlnet.gov/expapi/verbs/completed", display: { "en-US": "completed" } }, object: { id: q.get("activity_id") }, result: { completion: true, success: true, score: { scaled: 0.75 } }, context: { registration: q.get("registration") } }) });
  document.getElementById("status").textContent = "sent";
})();
</script>`));
  return zip.toBuffer();
}
