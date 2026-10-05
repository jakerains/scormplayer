import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { withFileLock } from "./file-lock.mjs";

export function courseKey(course) {
  return `${course.sha256 ?? course.source}${course.package ? `:${course.package}` : ""}`;
}

/** Durable learner state is separate from disposable extracted packages and review snapshots. */
export function createScormStore(cacheDir, course) {
  const key = createHash("sha256").update(courseKey(course)).digest("hex");
  const file = path.join(cacheDir, "progress", `${key}.json`);
  const ids = course.scos?.length > 1 ? course.scos.map((sco) => sco.id) : [""];
  const read = () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8"))
    : { saved: false, epoch: 0, selectedSco: ids[0], modules: {} };
  return {
    read,
    update(input) {
      return withFileLock(file, () => {
        if (!input || typeof input !== "object" || Array.isArray(input) || !Number.isInteger(input.epoch) || input.epoch < 0
          || (input.reset !== undefined && typeof input.reset !== "boolean")
          || (input.modules !== undefined && (!input.modules || typeof input.modules !== "object" || Array.isArray(input.modules)))) {
          throw Object.assign(new Error("Invalid SCORM state."), { statusCode: 400 });
        }
        const previous = read();
        if (input.epoch !== previous.epoch) throw Object.assign(new Error("Progress was reset in another tab. Reload before saving."), { statusCode: 409 });
        if (!ids.includes(input.selectedSco)) throw Object.assign(new Error("Unknown module."), { statusCode: 400 });
        let modules = { ...previous.modules };
        for (const [id, data] of Object.entries(input.modules ?? {})) {
          if (!ids.includes(id) || !data || typeof data !== "object" || Array.isArray(data) || Object.values(data).some((value) => typeof value !== "string")) {
            throw Object.assign(new Error("Invalid SCORM state."), { statusCode: 400 });
          }
          modules = { ...modules, [id]: data };
        }
        const state = { saved: true, epoch: previous.epoch + (input.reset === true ? 1 : 0), selectedSco: input.selectedSco, modules: input.reset === true ? {} : modules };
        const temporary = `${file}.${randomUUID()}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(state));
        fs.renameSync(temporary, file);
        return state;
      });
    },
  };
}
