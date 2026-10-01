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
