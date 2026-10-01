import fs from "node:fs";
import path from "node:path";
import { findManifest, siblingPinsFile, UserError } from "./course.mjs";

/**
 * A zip is read-only: the player serves a copy unpacked in the cache, so nobody (least of all an
 * agent acting on pins) can edit it. Unzipping copies that package to a real folder, by default
 * beside the zip and named after it, so the course can be edited and reopened as a folder.
 * The folder keeps the zip's layout exactly, so the source lines pins point at stay right.
 */

/** Where a zip unzips to unless told otherwise: beside it, named after it. */
export function defaultUnzipFolder(course) {
  // A zip dropped in the browser lives in the cache; put its folder where its pins are.
  const dir = isUpload(course) ? path.dirname(course.pinsFile) : path.dirname(course.source);
  return path.join(dir, zipName(course));
}

/** A folder that already holds this course from an earlier unzip, if there is one. */
export function existingUnzip(course, folder = defaultUnzipFolder(course)) {
  return isCourseFolder(folder) ? folder : null;
}

/**
 * Copy the unpacked package to `folder` (or reuse it when it already holds a course), and move
 * the zip's pins beside it unless they are kept somewhere chosen on purpose (`keepPinsFile`).
 *
 * @returns {{ folder: string, pinsFile: string, reused: boolean, movedPins: number }}
 */
export function unzipCourse(course, { folder = defaultUnzipFolder(course), keepPinsFile = false } = {}) {
  if (course.kind !== "package") throw new UserError("Only a zip needs unzipping; this course is already a folder.");
  const target = path.resolve(folder);
  let reused = false;
  if (fs.existsSync(target)) {
    if (!fs.statSync(target).isDirectory()) throw new UserError(`${target} is a file. Choose a folder.`);
    if (isCourseFolder(target)) reused = true;
    else if (fs.readdirSync(target).length) throw new UserError(`${target} already exists and has other files in it. Choose an empty or new folder.`);
  }
  if (!reused) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(course.root, target, { recursive: true });
    // Drop the cache's own bookkeeping files. Removed after copying rather than filtered, since
    // Windows can name the same cache folder two ways (short and long) and a path match misses.
    for (const name of [".extracted", ".last-used"]) fs.rmSync(path.join(target, name), { force: true });
  }

  const pinsFile = keepPinsFile ? course.pinsFile : siblingPinsFile(target);
  const movedPins = pinsFile === course.pinsFile ? 0 : movePins(course.pinsFile, pinsFile);
  return { folder: target, pinsFile, reused, movedPins };
}

/**
 * Move a pins file and its screenshots, rewriting each pin's screenshot path. Leaves both alone
 * when the destination already has pins, so nothing is overwritten. Returns how many moved.
 */
function movePins(from, to) {
  if (!fs.existsSync(from) || fs.existsSync(to)) return 0;
  const data = JSON.parse(fs.readFileSync(from, "utf8"));
  if (!Array.isArray(data.pins)) return 0;
  const fromFrames = framesDir(from);
  const toFrames = framesDir(to);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (fs.existsSync(fromFrames)) fs.cpSync(fromFrames, toFrames, { recursive: true });
  for (const pin of data.pins) {
    if (!pin.frame) continue;
    const file = path.join(toFrames, path.basename(pin.frame));
    pin.frame = path.relative(path.dirname(to), file).split(path.sep).join("/");
  }
  fs.writeFileSync(to, `${JSON.stringify(data, null, 2)}\n`);
  fs.rmSync(from, { force: true });
  fs.rmSync(fromFrames, { recursive: true, force: true });
  return data.pins.length;
}

function framesDir(pinsFile) {
  return path.join(path.dirname(pinsFile), `${path.basename(pinsFile, ".json")}-frames`);
}

function zipName(course) {
  return path.basename(course.displayName ?? course.source).replace(/\.zip$/i, "");
}

function isUpload(course) {
  return Boolean(course.displayName);
}

function isCourseFolder(dir) {
  try { return fs.statSync(dir).isDirectory() && Boolean(findManifest(dir, { required: false })); }
  catch { return false; }
}
