import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

/**
 * The terminal dashboard: what is open, where, how the course is doing, the pins as they arrive,
 * and a feed of what just happened. One key does each common thing. Without a real terminal
 * (an agent, CI, a pipe) it prints plain timestamped lines instead.
 *
 * @param {{
 *   version: string,
 *   entries: { id: string, player: any }[],
 *   plain?: boolean,
 *   pinsHint?: (entry) => string,
 *   onQuit: () => void | Promise<void>,
 *   courses?: () => { path: string, kind: string, title: string }[],
 *   switchCourse?: (path: string) => Promise<unknown>,
 *   setup?: () => Promise<unknown>,
 *   skill?: { status: () => { state: string, version: string, installed: { version: string | null }[] },
 *     install: () => Promise<{ installed: boolean, output: string }>, update: () => Promise<{ state: string, output: string }> },
 * }} options
 */
export function createDashboard({ version, entries, plain = false, pinsHint, onQuit, skill = null, setup = null, courses = null, switchCourse = null, stdout = process.stdout, stdin = process.stdin }) {
  const interactive = !plain && stdout.isTTY && stdin.isTTY && !process.env.CI;
  const paint = createPaint(stdout);
  const state = entries.map((entry) => ({
    ...entry,
    pins: safeList(entry.player),
    progress: null,
    lastSource: null,
    browser: false,
  }));
  const activity = [];
  let view = "home";
  // The course list for switching to another course without restarting (the l key).
  let courseList = null;
  let briefLines = [];
  let briefScroll = 0;
  let flash = "";
  let flashTimer = null;
  let closed = false;
  let paused = false;
  let update = null;
  let updateCommand = "scormplayer update";
  // Whether coding agents have the scormplayer skill, and whether it matches this version:
  // missing or outdated is offered on the s key; newer means scormplayer itself is behind.
  const firstSkill = skill ? safeSkillStatus(skill) : null;
  let skillState = firstSkill?.state ?? "unknown";
  const skillVersions = () => {
    const status = skill ? safeSkillStatus(skill) : null;
    const installed = status?.installed.map((copy) => copy.version).filter(Boolean)[0];
    return { installed: installed ?? "an older version", current: status?.version ?? version };
  };
  const timers = [];

  const log = (icon, text, entry = null) => {
    const item = { at: new Date(), icon, text, entry: entries.length > 1 ? entry?.id ?? null : null };
    activity.unshift(item);
    activity.length = Math.min(activity.length, 50);
    if (!interactive) {
      stdout.write(`${time(item.at)}  ${item.entry ? `${item.entry}  ` : ""}${text}\n`);
    } else render();
  };

  // Events from each player.
  for (const entry of state) {
    const { events } = entry.player;
    events.on("browser", () => {
      if (!entry.browser) log("◉", "Player opened in the browser", entry);
      entry.browser = true;
    });
    events.on("source", ({ file }) => {
      const now = Date.now();
      const repeat = entry.lastSource && entry.lastSource.file === file && now - entry.lastSource.at < 2000;
      entry.lastSource = { file, at: now };
      if (!repeat) log("↻", file, entry);
      else render();
    });
    events.on("progress", (next, previous) => {
      entry.progress = next;
      const label = progressLabel(next);
      if (!previous || progressLabel(previous).text !== label.text) {
        if (label.tone === "good") log("✓", label.text, entry);
        else if (label.tone === "bad") log("✗", label.text, entry);
        else render();
      }
    });
    events.on("pin", () => pollPins(entry));
    events.on("qa", ({ type, run, logFile }) => {
      if (type === "started") log("▶", `Agent QA pass started (${run.agent})`, entry);
      else if (type === "stopping") log("■", "Agent QA pass asked to stop", entry);
      else if (type === "finished" || type === "stopped") log("✓", `Agent QA pass ${type}: ${run.pages.length} pages logged, ${run.suggestions.length} suggestions · ${logFile}`, entry);
    });
    events.on("unzipped", ({ folder, reused, movedPins }) => {
      log("◉", `${reused ? "Opened the folder it was unzipped to before" : "Unzipped"}: ${displayPath(folder)}${movedPins ? ` · ${movedPins} ${movedPins === 1 ? "pin" : "pins"} moved` : ""}`, entry);
    });
    events.on("course", (course) => {
      entry.pins = safeList(entry.player);
      entry.progress = null;
      entry.lastSource = null;
      log("◉", `Opened ${course.title}`, entry);
    });
  }

  // Pins can also change from the command line (an agent resolving them), so watch the files.
  function pollPins(entry) {
    const next = safeList(entry.player);
    const before = new Map(entry.pins.map((pin) => [pin.id, pin]));
    for (const pin of next) {
      const old = before.get(pin.id);
      if (!old) {
        const where = pin.source?.[0] ? ` · ${pin.source[0].file}:${pin.source[0].line}` : "";
        if (pin.status === "suggested") log("◇", `QA suggestion ${pin.number} (${pin.severity} ${pin.category}): ${oneLine(pin.note)}`, entry);
        else log("◆", `Pin ${pin.number} saved: ${oneLine(pin.note)}${where}`, entry);
      } else if (old.status !== pin.status && (old.status === "suggested" || old.status === "dismissed")) {
        log(pin.status === "open" ? "◆" : "−", `QA suggestion ${pin.number} ${pin.status === "open" ? "accepted" : pin.status === "dismissed" ? "dismissed" : "restored"}`, entry);
      } else if (old.status !== pin.status) {
        log(pin.status === "resolved" ? "✓" : "↺", `Pin ${pin.number} ${pin.status === "resolved" ? "resolved" : "reopened"}${pin.resolution ? `: ${oneLine(pin.resolution)}` : ""}`, entry);
      }
      before.delete(pin.id);
    }
    for (const pin of before.values()) log("−", `Pin ${pin.number} deleted`, entry);
    entry.pins = next;
  }
  timers.push(setInterval(() => state.forEach(pollPins), 1500));

  // ---- Commands ----------------------------------------------------------------------------

  function openUrl(entry) {
    openBrowser(entry.player.url);
    say(`Opening ${entries.length > 1 ? entry.id : "the player"} in your browser`);
  }

  function handOff() {
    return state.filter((entry) => entry.player.pins).map((entry) => entry.player.pins.brief({ status: "open" })).join("\n---\n\n");
  }

  function copyPins() {
    const open = state.reduce((sum, entry) => sum + entry.pins.filter((pin) => pin.status === "open").length, 0);
    if (!open) return say("No open pins to copy");
    const method = copyToClipboard(handOff(), stdout);
    say(method ? `Copied ${open} open ${open === 1 ? "pin" : "pins"} for your agent` : "Couldn't reach the clipboard; press p to see the pins");
  }

  function canSwitch() {
    return Boolean(courses && switchCourse && state.length === 1);
  }

  function showCourses(direction = null) {
    const found = courses();
    if (!found.length) return say("No other courses found here");
    courseList = createCourseList({ courses: found, current: state[0].player.course?.source ?? null });
    if (direction) courseList.key(direction);
    view = "courses";
    render();
  }

  async function chooseCourse(target) {
    view = "home";
    courseList = null;
    if (target === state[0].player.course?.source) return render();
    say("Opening…");
    try { await switchCourse(target); }
    catch (error) { say(error.message); }
  }

  function renderCourses(width, height) {
    const p = paint;
    const lines = ["", `  ${p.pin("◉")} ${p.bold("Switch course")} ${p.dim("· the player and its browser tab move to the one you choose")}`, ""];
    lines.push(...courseList.lines({ p, width, room: height - lines.length - 2 }));
    while (lines.length < height - 1) lines.push("");
    lines.push(courseListKeys(p, courseList, "back"));
    return lines;
  }

  function showPins() {
    briefLines = handOff().trimEnd().split("\n");
    briefScroll = 0;
    view = "brief";
    render();
  }

  async function installSkill() {
    if (!skill || (skillState !== "missing" && skillState !== "outdated")) return;
    const updating = skillState === "outdated";
    skillState = "installing";
    say(updating ? "Updating the agent skill…" : "Installing the agent skill…");
    log("•", updating ? "Updating the scormplayer skill to match this version…" : "Installing the scormplayer skill for your coding agents…");
    if (updating) {
      const result = await skill.update();
      skillState = result.state;
      if (result.state === "outdated") log("✗", `The agent skill didn't update. Run: scormplayer skill${result.output ? ` (${oneLine(result.output).slice(-120)})` : ""}`);
      else log("✓", `Agent skill updated to ${version}`);
      return;
    }
    const result = await skill.install();
    skillState = result.installed ? "current" : "missing";
    if (result.installed) log("✓", "Agent skill installed: Claude Code, Codex, Cursor and other agents can now act on your pins");
    else log("✗", `The agent skill didn't install. Run: scormplayer skill${result.output ? ` (${oneLine(result.output).slice(-120)})` : ""}`);
  }

  async function showSetup() {
    if (!setup || paused) return;
    paused = true;
    stdin.setRawMode?.(false);
    stdout.write("\x1b[?25h\x1b[?1049l");
    try { await setup(); }
    catch (error) { log("✗", `Setup: ${error.message}`); }
    finally {
      skillState = skill ? safeSkillStatus(skill)?.state ?? "unknown" : "unknown";
      paused = false;
      if (!closed) {
        stdout.write("\x1b[?1049h\x1b[?25l\x1b[H\x1b[2J");
        stdin.setRawMode?.(true);
        stdin.resume();
        render();
      }
    }
  }

  function canUnzip() {
    return state.length === 1 && state[0].player.course?.kind === "package" && Boolean(state[0].player.unzip);
  }

  async function unzip(entry) {
    say("Unzipping…");
    try { await entry.player.unzip(); }
    catch (error) { say(error.message); }
  }

  function say(message) {
    flash = message;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { flash = ""; render(); }, 3000);
    render();
  }

  async function quit() {
    if (closed) return;
    closed = true;
    timers.forEach(clearInterval);
    clearTimeout(flashTimer);
    if (interactive) {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdout.write("\x1b[?25h\x1b[?1049l");
    }
    stdout.write(summary());
    await onQuit();
  }

  // ---- Rendering ---------------------------------------------------------------------------

  function render() {
    if (!interactive || closed || paused) return;
    const width = Math.max(56, Math.min(stdout.columns || 80, 112));
    const height = stdout.rows || 30;
    const lines = view === "brief" ? renderBrief(width, height) : view === "courses" ? renderCourses(width, height) : renderHome(width, height);
    stdout.write(`\x1b[H${lines.slice(0, height).map((line) => `${line}\x1b[K`).join("\n")}\x1b[J`);
  }

  function renderHome(width, height) {
    const p = paint;
    const inner = width - 4;
    const live = state.some((entry) => entry.player.course?.kind === "live");
    const lines = [""];
    const headerLeft = `${p.pin("◉")} ${p.bold("scormplayer")} ${p.dim(version)}${entries.length > 1 ? p.dim(` · ${entries.length} courses`) : ""}`;
    const status = live ? `${p.amber(pulse())} ${p.dim("live")}` : `${p.green("●")} ${p.dim("ready")}`;
    const headerRight = update ? `${p.pin("↑")} ${p.bold(update)} ${p.dim("available")}  ${status}` : status;
    lines.push(boxTop(headerLeft, headerRight, width));
    lines.push(boxLine("", width));

    if (state.length === 1 && !state[0].player.course) {
      const { url } = state[0].player;
      const logo = logoLines(p);
      const card = [
        p.bold("No course open yet"),
        p.dim("Drop a SCORM zip on the page in your browser,"),
        p.dim("or click Choose a SCORM zip."),
        "",
        `${p.pin("➜")}  ${p.link(p.bold(p.blue(url)), url)}${state[0].browser ? p.dim("  · open in your browser") : p.dim("  · press o to open")}`,
      ];
      card.forEach((line, index) => lines.push(boxLine(`${logo[index]}   ${line}`, width)));
    } else if (state.length === 1) {
      const entry = state[0];
      const { course, url } = entry.player;
      const logo = logoLines(p);
      const text = inner - 14;
      const card = [
        p.bold(truncate(course.title, text)),
        p.dim(truncate(kindLine(course), text)),
        p.dim(truncate(displayPath(course.source), text)),
        "",
        `${p.pin("➜")}  ${p.link(p.bold(p.blue(url)), url)}${entry.browser ? p.dim("  · open in your browser") : p.dim("  · press o to open")}`,
      ];
      card.forEach((line, index) => lines.push(boxLine(`${logo[index]}   ${line}`, width)));
      lines.push(boxLine("", width));
      lines.push(boxLine(`${p.dim("Progress".padEnd(10))}${progressGraphic(entry.progress, inner - 12)}`, width));
      if (course.kind === "live") lines.push(boxLine(`${p.dim("Source".padEnd(10))}${sourceLine(entry, inner - 12)}`, width));
      lines.push(boxLine(`${p.dim("Pins".padEnd(10))}${pinCounts(entry.pins)}`, width));
      const agentsLine = {
        missing: () => `${p.dim(setup ? "Press s to set up MCP or skill files for your AI apps" : "Press s to install the agent skill")}`,
        outdated: () => `${p.amber(`Skill out of date (${skillVersions().installed}; this is ${version}).`)} ${p.dim(setup ? "Press s for setup" : "Press s to update it")}`,
        newer: () => `${p.amber(`Skill is newer than scormplayer ${version}.`)} ${p.dim("Run: scormplayer update")}`,
        installing: () => p.amber("Updating the agent skill…"),
      }[skillState];
      if (agentsLine) lines.push(boxLine(`${p.dim("Agents".padEnd(10))}${agentsLine()}`, width));
      if (course.kind === "package" && entry.player.unzip) {
        lines.push(boxLine(`${p.dim("Edit".padEnd(10))}${p.amber("Read-only zip.")} ${p.dim("Press u to unzip it to a folder you and agents can edit")}`, width));
      }
    } else {
      state.forEach((entry, index) => {
        const { url } = entry.player;
        const course = entry.player.course ?? { title: "No course open" };
        const key = index < 9 ? p.pin(String(index + 1)) : " ";
        lines.push(boxLine(`${key}  ${p.bold(entry.id.padEnd(9))} ${truncate(course.title, inner - 16)}`, width));
        const label = progressLabel(entry.progress);
        const open = entry.pins.filter((pin) => pin.status === "open").length;
        const status = `${toneDot(label.tone)} ${label.text}`;
        lines.push(boxLine(`     ${padVisible(status, 22)}${padVisible(open ? p.pin(`${open} open ${open === 1 ? "pin" : "pins"}`) : p.dim("no pins"), 14)}${p.link(p.blue(url), url)}`, width));
      });
      const changed = state.filter((entry) => entry.lastSource).sort((a, b) => b.lastSource.at - a.lastSource.at)[0];
      if (live) {
        lines.push(boxLine("", width));
        lines.push(boxLine(`${p.dim("Source".padEnd(10))}${changed ? sourceLine(changed, inner - 12, true) : p.dim("watching for edits")}`, width));
      }
    }
    lines.push(boxLine("", width));
    lines.push(boxBottom(width));

    // Pins
    const openPins = state.flatMap((entry) => entry.pins.filter((pin) => pin.status === "open").map((pin) => ({ pin, entry })));
    lines.push("");
    const pinsLeft = `  ${p.bold("Pins")} ${p.dim("·")} ${openPins.length ? p.pin(`${openPins.length} open`) : p.dim("none open")}`;
    const pinsFile = state.length === 1 && state[0].player.course ? p.dim(truncateStart(displayPath(state[0].player.course.pinsFile), width - visible(pinsLeft) - 4)) : "";
    lines.push(`${pinsLeft}${spacer(pinsLeft, pinsFile, width)}${pinsFile}`);
    // Each pin takes two lines; leave room for the activity feed and the footer.
    const activityRows = Math.min(6, Math.max(1, activity.length)) + 2;
    const pinRows = Math.max(1, Math.min(openPins.length, Math.floor((height - lines.length - 3 - activityRows) / 2)));
    if (!openPins.length) {
      lines.push(`  ${p.dim("Press")} P ${p.dim("in the player, click anything, and say what should change.")}`);
    }
    for (const { pin, entry } of openPins.slice(-pinRows).reverse()) {
      const prefix = `${state.length > 1 ? `${entry.id} ` : ""}#${pin.number}`;
      lines.push(`  ${p.pinBadge(` ${prefix} `)} ${truncate(oneLine(pin.note), width - visible(prefix) - 8)}`);
      const where = [pin.page?.title, pin.target?.name, pin.source?.[0] ? `${pin.source[0].file}:${pin.source[0].line}` : null].filter(Boolean).join(" · ");
      lines.push(`  ${" ".repeat(visible(prefix) + 2)} ${p.dim(truncate(where, width - visible(prefix) - 8))}`);
    }
    if (openPins.length > pinRows) lines.push(`  ${p.dim(`+ ${openPins.length - pinRows} more · press p to see them all`)}`);

    // Activity
    lines.push("");
    lines.push(`  ${p.bold("Activity")}`);
    const room = Math.max(1, height - lines.length - 3);
    if (!activity.length) lines.push(`  ${p.dim("Waiting for the browser…")}`);
    for (const item of activity.slice(0, room)) {
      const who = item.entry ? `${p.dim(item.entry)} ` : "";
      lines.push(`  ${p.dim(time(item.at))}  ${iconColor(item.icon)} ${who}${truncate(item.text, width - 16 - (item.entry ? item.entry.length + 1 : 0))}`);
    }

    // Footer
    while (lines.length < height - (setup ? 3 : 2)) lines.push("");
    lines.push(flash ? `  ${p.pin("●")} ${flash}` : "");
    if (setup) lines.push(`  ${p.key(" s ")} ${p.bold("MCP / skills setup")}`);
    const keys = [
      ["o", entries.length > 1 ? "open all" : "open"],
      ...(entries.length > 1 ? [[`1–${Math.min(9, entries.length)}`, "open one"]] : []),
      ["c", "copy pins"],
      ["p", "show pins"],
      ...(canSwitch() ? [["↑↓", "switch course"]] : []),
      ...(canUnzip() ? [["u", "unzip to edit"]] : []),
      ...(!setup && skillState === "missing" ? [["s", "install agent skill"]] : !setup && skillState === "outdated" ? [["s", "update agent skill"]] : []),
      ["q", "quit"],
    ];
    lines.push(`  ${keys.map(([key, label]) => `${p.key(` ${key} `)} ${p.dim(label)}`).join("   ")}`);
    return lines;
  }

  function renderBrief(width, height) {
    const p = paint;
    const body = height - 5;
    briefScroll = Math.max(0, Math.min(briefScroll, Math.max(0, briefLines.length - body)));
    const lines = ["", `  ${p.pin("◉")} ${p.bold("Pins hand-off")} ${p.dim(`· ${briefLines.length} lines`)}`, ""];
    for (const line of briefLines.slice(briefScroll, briefScroll + body)) {
      const text = truncate(line, width - 4);
      lines.push(`  ${line.startsWith("#") ? p.bold(text) : line.startsWith("- ") ? p.dim(text) : text}`);
    }
    while (lines.length < height - 1) lines.push("");
    lines.push(`  ${p.key(" c ")} ${p.dim("copy")}   ${p.key(" ↑↓ ")} ${p.dim("scroll")}   ${p.key(" esc ")} ${p.dim("back")}`);
    return lines;
  }

  function summary() {
    const p = createPaint(stdout);
    const open = state.reduce((sum, entry) => sum + entry.pins.filter((pin) => pin.status === "open").length, 0);
    const lines = ["", `  ${p.pin("◉")} ${p.bold("scormplayer stopped")}${open ? ` ${p.dim("·")} ${p.pin(`${open} open ${open === 1 ? "pin" : "pins"}`)}` : ""}`];
    if (update) lines.push(`    ${p.pin("↑")} scormplayer ${update} is available: ${p.bold(updateCommand)}`);
    for (const entry of state) {
      const count = entry.pins.filter((pin) => pin.status === "open").length;
      if (!count) continue;
      lines.push(`    ${state.length > 1 ? `${entry.id}  ` : ""}${p.dim(displayPath(entry.player.course?.pinsFile))}`);
      if (pinsHint) lines.push(`    ${p.dim("Hand off:")} ${pinsHint(entry)}`);
    }
    return `${lines.join("\n")}\n\n`;
  }

  // ---- Small renderers --------------------------------------------------------------------

  function progressGraphic(progress, width) {
    const p = paint;
    const label = progressLabel(progress);
    const measure = Number(progress?.progressMeasure);
    if (Number.isFinite(measure) && progress?.progressMeasure !== "") {
      const size = Math.max(10, Math.min(28, width - 24));
      const filled = Math.round(Math.min(1, Math.max(0, measure)) * size);
      return `${p.pin("━".repeat(filled))}${p.dim("━".repeat(size - filled))}  ${toneText(label)} ${p.dim(`${Math.round(measure * 100)}%`)}`;
    }
    const steps = ["Opened", "In progress", label.tone === "bad" ? "Failed" : label.tone === "good" && progress?.success === "passed" ? "Passed" : "Completed"];
    const reached = !progress ? 0 : label.tone === "good" || label.tone === "bad" ? 3 : progress.completion === "incomplete" ? 2 : 1;
    return steps.map((step, index) => {
      const done = index < reached;
      const dot = done ? (index === 2 && label.tone === "bad" ? p.red("●") : p.green("●")) : p.dim("○");
      const text = done ? step : p.dim(step);
      return `${dot} ${text}`;
    }).join(p.dim(" ── ")) + (progress?.score ? `  ${p.dim("score")} ${progress.score}` : "");
  }

  function sourceLine(entry, width, named = false) {
    const p = paint;
    if (!entry.lastSource) return p.dim("watching for edits");
    const ago = agoText(entry.lastSource.at);
    const fresh = Date.now() - entry.lastSource.at < 2500;
    const prefix = named ? `${entry.id} ` : "";
    return `${fresh ? p.amber("↻ updated") : p.dim("↻ updated")} ${p.dim(`${ago} ·`)} ${truncate(`${prefix}${entry.lastSource.file}`, width - 24)}`;
  }

  function pinCounts(pins) {
    const p = paint;
    const open = pins.filter((pin) => pin.status === "open").length;
    const resolved = pins.filter((pin) => pin.status === "resolved").length;
    const suggested = pins.filter((pin) => pin.status === "suggested").length;
    if (!pins.length) return p.dim("none yet");
    return `${open ? p.pin(`${open} open`) : p.dim("0 open")}${suggested ? p.amber(` · ${suggested} suggested`) : ""}${resolved ? p.dim(` · ${resolved} resolved`) : ""}`;
  }

  function toneDot(tone) {
    const p = paint;
    return { good: p.green("●"), bad: p.red("●"), neutral: p.amber("●"), muted: p.dim("○") }[tone];
  }

  function toneText(label) {
    const p = paint;
    return { good: p.green(label.text), bad: p.red(label.text), neutral: label.text, muted: p.dim(label.text) }[label.tone];
  }

  function iconColor(icon) {
    const p = paint;
    if (icon === "◆") return p.pin(icon);
    if (icon === "✓") return p.green(icon);
    if (icon === "✗" || icon === "−") return p.red(icon);
    if (icon === "↻") return p.amber(icon);
    return p.blue(icon);
  }

  function boxTop(left, right, width) {
    // "  ╭─ " + left + " " + fill + " " + right + " ─╮" spans exactly `width` columns.
    const fill = width - 10 - visible(left) - visible(right);
    return `  ${paint.line("╭─")} ${left} ${paint.line("─".repeat(Math.max(1, fill)))} ${right} ${paint.line("─╮")}`;
  }
  function boxLine(content, width) {
    const room = width - 6;
    const text = visible(content) > room ? truncateVisible(content, room) : content;
    return `  ${paint.line("│")} ${text}${" ".repeat(Math.max(0, room - visible(text)))} ${paint.line("│")}`;
  }
  function boxBottom(width) {
    return `  ${paint.line(`╰${"─".repeat(width - 4)}╯`)}`;
  }
  function pulse() {
    return Math.floor(Date.now() / 700) % 2 ? "●" : "○";
  }

  // ---- Start -------------------------------------------------------------------------------

  if (interactive) {
    stdout.write("\x1b[?1049h\x1b[?25l\x1b[H\x1b[2J");
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    onKeys(stdin, (key) => {
      if (paused || closed) return;
      if (key === "ctrl-c" || (view === "home" && (key === "q" || key === "Q"))) return void quit();
      if (view === "courses") {
        const result = courseList.key(key);
        if (result?.cancel) { view = "home"; courseList = null; }
        else if (result?.choose) return void chooseCourse(result.choose);
        return render();
      }
      if (view === "brief") {
        if (key === "escape" || key === "q" || key === "p") { view = "home"; render(); }
        else if (key === "up" || key === "k") { briefScroll -= 1; render(); }
        else if (key === "down" || key === "j" || key === " ") { briefScroll += key === " " ? 10 : 1; render(); }
        else if (key === "pageup") { briefScroll -= 10; render(); }
        else if (key === "pagedown") { briefScroll += 10; render(); }
        else if (key === "c") { copyPins(); view = "home"; render(); }
        return;
      }
      if (key === "o") state.forEach(openUrl);
      else if (/^[1-9]$/.test(key) && state[Number(key) - 1]) openUrl(state[Number(key) - 1]);
      else if (key === "c") copyPins();
      else if (key === "p") showPins();
      else if ((key === "l" || key === "up" || key === "down") && canSwitch()) showCourses(key === "l" ? null : key);
      else if (key === "u" && canUnzip()) void unzip(state[0]);
      else if (key === "s" && setup) void showSetup();
      else if (key === "s" && (skillState === "missing" || skillState === "outdated")) void installSkill();
    });
    stdout.on("resize", render);
    timers.push(setInterval(render, 1000));
    render();
  } else {
    const p = createPaint(stdout);
    for (const entry of state) {
      const { course, url } = entry.player;
      if (!course) {
        stdout.write(`\n  No course open yet. Open ${url} and drop a SCORM zip on the page.\n`);
        continue;
      }
      stdout.write(`\n  ${p.bold(course.title)}${entries.length > 1 ? p.dim(`  (${entry.id})`) : ""}\n  ${kindLine(course)}\n\n  Player  ${url}\n  Pins    ${course.pinsFile}\n`);
      if (course.kind === "package") stdout.write(`\n  This zip is read-only. To edit it, unzip it in the browser, or run: scormplayer unzip ${JSON.stringify(course.source)}\n`);
    }
    stdout.write("\n  Press Ctrl+C to stop.\n\n");
  }

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, () => void quit());

  return {
    log: (text, id) => log("•", text, state.find((entry) => entry.id === id) ?? null),
    /** Show that a newer version is published. */
    updateAvailable(version, command = updateCommand) {
      update = version;
      updateCommand = command;
      log("↑", `scormplayer ${version} is available: ${command}`);
    },
    quit,
    render,
  };
}

// ---- Shared helpers --------------------------------------------------------------------------

function safeSkillStatus(skill) {
  try { return skill.status(); } catch { return null; }
}

export function progressLabel(progress) {
  if (!progress) return { text: "Not opened yet", tone: "muted" };
  const score = progress.score ? ` · ${progress.score}` : "";
  if (progress.success === "passed") return { text: `Passed${score}`, tone: "good" };
  if (progress.success === "failed") return { text: `Failed${score}`, tone: "bad" };
  if (progress.completion === "completed") return { text: `Completed${score}`, tone: "good" };
  if (progress.completion === "incomplete") return { text: "In progress", tone: "neutral" };
  return { text: "Started", tone: "neutral" };
}

export function kindLine(course) {
  const label = { xapi: "xAPI", cmi5: "cmi5" }[course.standard] ?? "SCORM";
  const kind = { package: `${label} zip (read-only)`, folder: `${label} folder`, live: "Live source · hot reload" }[course.kind] ?? course.kind;
  return `${kind}${course.scormVersion && course.scormVersion !== "both" ? ` · SCORM ${course.scormVersion}` : ""}`;
}

export function openBrowser(url) {
  const [command, args] = process.platform === "darwin"
    ? ["open", [url]]
    : process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : ["xdg-open", [url]];
  try {
    spawn(command, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    // The URL is on screen; opening it is a convenience.
  }
}

/** System clipboard first; OSC 52 (most modern terminals) as the fallback. Returns the method or null. */
export function copyToClipboard(text, stdout = process.stdout) {
  const tools = process.platform === "darwin" ? [["pbcopy", []]]
    : process.platform === "win32" ? [["clip", []]]
      : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]];
  for (const [command, args] of tools) {
    const result = spawnSync(command, args, { input: text, stdio: ["pipe", "ignore", "ignore"] });
    if (result.status === 0) return command;
  }
  if (stdout.isTTY) {
    stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
    return "osc52";
  }
  return null;
}

function safeList(player) {
  try { return player.pins.list(); } catch { return []; }
}

function createPaint(stdout) {
  const color = Boolean(stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb";
  const truecolor = /truecolor|24bit/i.test(process.env.COLORTERM ?? "") || ["iTerm.app", "vscode", "WezTerm", "ghostty"].includes(process.env.TERM_PROGRAM ?? "");
  const links = color && process.env.TERM_PROGRAM !== "Apple_Terminal";
  const wrap = (open, close = 39) => (text) => (color ? `\x1b[${open}m${text}\x1b[${close}m` : String(text));
  const rgb = (r, g, b, fallback) => wrap(truecolor ? `38;2;${r};${g};${b}` : fallback);
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    pin: rgb(255, 92, 57, "38;5;203"),
    green: rgb(62, 207, 142, "38;5;78"),
    amber: rgb(245, 178, 61, "38;5;214"),
    blue: rgb(106, 168, 255, "38;5;75"),
    red: rgb(255, 107, 107, "38;5;203"),
    line: rgb(84, 90, 102, "38;5;240"),
    key: (text) => (color ? `\x1b[48;5;236m\x1b[38;5;255m${text}\x1b[0m` : `[${text.trim()}]`),
    pinBadge: (text) => (color ? (truecolor ? `\x1b[48;2;255;92;57m\x1b[38;2;255;255;255m\x1b[1m${text}\x1b[0m` : `\x1b[48;5;203m\x1b[97m\x1b[1m${text}\x1b[0m`) : text),
    rgb: (r, g, b) => (truecolor ? wrap(`38;2;${r};${g};${b}`) : wrap("38;5;203")),
    link: (text, url) => (links ? `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\` : text),
  };
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\]8;;[^\x1b]*\x1b\\/g;

function charWidth(code) {
  if (code === 0 || (code >= 0x300 && code <= 0x36f) || (code >= 0x200b && code <= 0x200f) || code === 0xfe0f) return 0;
  if ((code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff) || (code >= 0x20000 && code <= 0x3fffd)) return 2;
  return 1;
}

export function visible(text) {
  let width = 0;
  for (const char of String(text).replace(ANSI, "")) width += charWidth(char.codePointAt(0));
  return width;
}

/** Cut plain text to a display width, with an ellipsis. */
export function truncate(text, width) {
  const value = String(text ?? "");
  if (width <= 1) return "";
  if (visible(value) <= width) return value;
  let out = "";
  let used = 0;
  for (const char of value) {
    const size = charWidth(char.codePointAt(0));
    if (used + size > width - 1) break;
    out += char;
    used += size;
  }
  return `${out}…`;
}

/** Cut from the front, keeping the end of a path ("…/lessons/m02-l01"). */
export function truncateStart(text, width) {
  const value = String(text ?? "");
  if (visible(value) <= width) return value;
  const chars = [...value];
  let out = "";
  let used = 1;
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const size = charWidth(chars[i].codePointAt(0));
    if (used + size > width) break;
    out = chars[i] + out;
    used += size;
  }
  return `…${out}`;
}

/** Cut styled text to a display width, keeping escape codes intact. */
function truncateVisible(text, width) {
  let out = "";
  let used = 0;
  let index = 0;
  const source = String(text);
  while (index < source.length && used < width - 1) {
    ANSI.lastIndex = index;
    const match = ANSI.exec(source);
    if (match && match.index === index) {
      out += match[0];
      index += match[0].length;
      continue;
    }
    const char = String.fromCodePoint(source.codePointAt(index));
    used += charWidth(char.codePointAt(0));
    out += char;
    index += char.length;
  }
  return `${out}…\x1b[0m`;
}

function padVisible(text, width) {
  return `${text}${" ".repeat(Math.max(1, width - visible(text)))}`;
}

function spacer(left, right, width) {
  return " ".repeat(Math.max(2, width - visible(left) - visible(right) - 2));
}

function oneLine(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function time(date) {
  return date.toTimeString().slice(0, 8);
}

function agoText(at) {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

/** A pin in block characters, shaded top to bottom. Five rows, nine columns. */
function logoLines(p) {
  const rows = [" ▄█████▄ ", "██▀ ▄ ▀██", "██▄ ▀ ▄██", " ▀██▄██▀ ", "   ▀█▀   "];
  const shades = [[255, 138, 102], [255, 112, 76], [255, 92, 57], [235, 72, 40], [210, 58, 30]];
  return rows.map((row, index) => p.rgb(...shades[index])(row));
}

/** The shorter of a path relative to here and the home-relative path. */
export function displayPath(file) {
  if (!file) return "";
  const relative = path.relative(process.cwd(), file);
  const home = tildify(file);
  return !relative.startsWith("..") && relative.length < home.length ? relative || "." : home;
}

export function tildify(file) {
  const home = os.homedir();
  return file && file.startsWith(home) ? `~${file.slice(home.length)}` : file;
}


const KIND_LABEL = { zip: "SCORM zip", folder: "SCORM folder", live: "Live source" };

/**
 * The course list both pickers use (the startup screen and the dashboard's switcher): type to
 * filter by title or folder, ↑↓ to move, Enter to choose, Esc to clear the filter (or leave when
 * it's empty). No number keys, since a folder can hold any number of courses.
 */
export function createCourseList({ courses, empty = false, current = null }) {
  let query = "";
  const all = empty ? [...courses, { path: DROP_PAGE, kind: "drop", title: "Empty player" }] : courses;
  const matches = () => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return all;
    return all.filter((course) => course.kind !== "drop" && words.every((word) => `${course.title} ${displayPath(course.path)}`.toLowerCase().includes(word)));
  };
  let index = Math.max(0, current ? all.findIndex((course) => course.path === current) : 0);
  const kindColor = (p, kind) => ({ zip: p.green, folder: p.blue, live: p.amber })[kind] ?? p.dim;
  return {
    get query() { return query; },
    get count() { return matches().length; },
    /** Handle a key: `{ choose: path }`, `{ cancel: true }`, or null when it only changed the list. */
    key(key) {
      const rows = matches();
      if (key === "escape") {
        if (!query) return { cancel: true };
        query = "";
        index = 0;
        return null;
      }
      if (key === "enter") return rows[index] ? { choose: rows[index].path } : null;
      if (key === "up") index = rows.length ? (index - 1 + rows.length) % rows.length : 0;
      else if (key === "down") index = rows.length ? (index + 1) % rows.length : 0;
      else if (key === "pageup") index = Math.max(0, index - 10);
      else if (key === "pagedown") index = Math.min(rows.length - 1, index + 10);
      else if (key === "home") index = 0;
      else if (key === "end") index = rows.length - 1;
      else if (key === "\x7f" || key === "\b") { query = query.slice(0, -1); index = 0; }
      else if (key.length === 1 && key >= " ") { query += key; index = 0; }
      index = Math.max(0, Math.min(index, matches().length - 1));
      return null;
    },
    lines({ p, width, room }) {
      const rows = matches();
      const out = [query
        ? `  ${p.pin("⌕")} ${p.bold(query)}${p.pin("▌")}  ${p.dim(`${rows.filter((row) => row.kind !== "drop").length} of ${courses.length}`)}`
        : `  ${p.dim(`⌕ type to filter ${courses.length} ${courses.length === 1 ? "course" : "courses"}`)}`, ""];
      if (!rows.length) return [...out, `    ${p.dim("No course matches. Esc clears the filter.")}`];
      const height = Math.max(3, room - 3);
      const start = Math.max(0, Math.min(index - Math.floor(height / 2), rows.length - height));
      const nameWidth = Math.min(46, Math.max(...rows.map((course) => visible(course.title))) + 2);
      rows.slice(start, start + height).forEach((course, offset) => {
        const active = start + offset === index;
        const marker = active ? p.pin("❯") : " ";
        if (course.kind === "drop") {
          out.push(`  ${marker} ${p.pin("+")} ${padVisible(active ? p.bold("Empty player") : "Empty player", nameWidth + 1)}${p.dim("drop or choose a SCORM zip in the browser")}`);
          return;
        }
        const title = truncate(course.title, nameWidth);
        const kind = KIND_LABEL[course.kind] ?? course.kind;
        const where = truncateStart(displayPath(course.path), width - nameWidth - 30);
        const open = current && course.path === current ? p.pin(" · open") : "";
        out.push(`  ${marker}   ${padVisible(active ? p.bold(title) : title, nameWidth + 1)}${padVisible(active ? kindColor(p, course.kind)(kind) : p.dim(kind), 14)}${p.dim(where)}${open}`);
      });
      if (rows.length > height) out.push(`      ${p.dim(`${index + 1} of ${rows.length} · ↑ ↓ to scroll`)}`);
      return out;
    },
  };
}

function courseListKeys(p, list, leave) {
  return `  ${p.key(" type ")} ${p.dim("filter")}   ${p.key(" ↑↓ ")} ${p.dim("choose")}   ${p.key(" enter ")} ${p.dim("open")}   ${p.key(" esc ")} ${p.dim(list.query ? "clear filter" : leave)}`;
}

/** What pickCourse returns when the user wants to drop or choose a zip in the browser. */
export const DROP_PAGE = Symbol("drop page");
export const SETUP_MENU = Symbol("setup menu");

/**
 * The screen for a bare `scormplayer`: the logo, what was found here, and a list to pick from
 * with the arrow keys. Resolves to the chosen course path, or null when the user quits or
 * nothing was found.
 */
export function pickCourse({ version, courses, cwd = process.cwd(), stdout = process.stdout, stdin = process.stdin }) {
  const p = createPaint(stdout);
  const list = createCourseList({ courses, empty: true });
  const here = displayPath(cwd) === "." || !displayPath(cwd) ? "this folder" : displayPath(cwd);
  return new Promise((resolve) => {
    const logo = logoLines(p);
    const header = [
      `${p.bold("scormplayer")} ${p.dim(version)}`,
      p.dim("Open a SCORM course in your browser"),
      p.dim("and pin notes on anything you want changed."),
      "",
      courses.length
        ? `${p.pin(String(courses.length))} ${courses.length === 1 ? "course" : "courses"} ${p.dim(`in ${here}`)}`
        : p.dim(`No SCORM course in ${here}`),
    ];

    const render = () => {
      const width = Math.max(56, Math.min(stdout.columns || 80, 112));
      const height = stdout.rows || 30;
      const lines = [""];
      logo.forEach((row, i) => lines.push(`  ${row}   ${header[i] ?? ""}`));
      lines.push("");
      if (!courses.length) {
        lines.push(`  ${p.pin("❯")} ${p.bold("Press enter")} to open the player in your browser, then drop a SCORM`);
        lines.push(`    zip on it or click ${p.bold("Choose a SCORM zip")}.`);
        lines.push("");
        lines.push(`  ${p.dim("Or point at a course:")}`);
        lines.push("");
        for (const [command, note] of [
          ["scormplayer ./course.zip", "a SCORM zip"],
          ["scormplayer ./course-folder", "an unzipped SCORM package"],
          ["scormplayer ./my-vite-course", "a Vite project, live with hot reload"],
          ["scormplayer --help", "everything else"],
        ]) lines.push(`    ${p.pin("›")} ${p.bold(command.padEnd(30))} ${p.dim(note)}`);
        lines.push("");
        lines.push(`  ${p.key(" F2 ")} ${p.bold("Set up MCP / skills")}`);
        lines.push(`  ${p.key(" enter ")} ${p.dim("open the drop page")}   ${p.key(" q ")} ${p.dim("quit")}`);
      } else {
        lines.push(...list.lines({ p, width, room: Math.max(3, height - lines.length - 3) }));
        while (lines.length < height - 2) lines.push("");
        lines.push(`  ${p.key(" F2 ")} ${p.bold("Set up MCP / skills")}`);
        lines.push(courseListKeys(p, list, "quit"));
      }
      stdout.write(`\x1b[H${lines.slice(0, height).map((line) => `${line}\x1b[K`).join("\n")}\x1b[J`);
    };

    let stopKeys = () => {};
    const finish = (choice) => {
      stopKeys();
      stdout.off("resize", render);
      stdin.setRawMode?.(false);
      stdin.pause();
      stdout.write("\x1b[?25h\x1b[?1049l");
      resolve(choice);
    };
    const onKey = (key) => {
      if (key === "ctrl-c") return finish(null);
      if (key === "f2") return finish(SETUP_MENU);
      if (!courses.length) {
        if (key === "q" || key === "escape") return finish(null);
        if (key === "enter") return finish(DROP_PAGE);
        return;
      }
      const result = list.key(key);
      if (result?.cancel) return finish(null);
      if (result?.choose) return finish(result.choose);
      render();
    };

    stdout.write("\x1b[?1049h\x1b[?25l\x1b[H\x1b[2J");
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    stopKeys = onKeys(stdin, onKey);
    stdout.on("resize", render);
    render();
  });
}

/**
 * A short list to choose from with the arrow keys, drawn in place under what's already on screen
 * (not a full-screen view): the courses in a zip, say. Resolves to the chosen item's index, or
 * null on q / Esc / Ctrl+C.
 *
 * @param {{ title: string, items: { label: string, note?: string }[], stdout?: any, stdin?: any }} options
 */
export function pickFromList({ title, items, stdout = process.stdout, stdin = process.stdin }) {
  const p = createPaint(stdout);
  let index = 0;
  let drawn = 0;
  return new Promise((resolve) => {
    const render = () => {
      const width = Math.max(40, (stdout.columns || 80) - 4);
      const lines = [
        p.bold(title),
        ...items.map((item, i) => {
          const active = i === index;
          const label = truncate(item.label, Math.max(10, width - 14 - visible(item.note ?? "")));
          return `${active ? p.pin("❯") : " "} ${active ? p.bold(label) : label}${item.note ? `  ${p.dim(item.note)}` : ""}`;
        }),
        `${p.key(" ↑↓ ")} ${p.dim("choose")}   ${p.key(" enter ")} ${p.dim("open")}   ${p.key(" q ")} ${p.dim("cancel")}`,
      ];
      // Back to the top of the list drawn last time, then redraw it.
      stdout.write(`${drawn ? `\x1b[${drawn}A\r` : ""}${lines.map((line) => `${line}\x1b[K`).join("\n")}\n`);
      drawn = lines.length;
    };
    let stopKeys = () => {};
    const finish = (choice) => {
      stopKeys();
      stdin.setRawMode?.(false);
      stdin.pause();
      stdout.write("\x1b[?25h");
      resolve(choice);
    };
    stdout.write("\x1b[?25l");
    stdin.setRawMode?.(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    stopKeys = onKeys(stdin, (key) => {
      if (key === "ctrl-c" || key === "q" || key === "escape") return finish(null);
      if (key === "up" || key === "k") index = (index - 1 + items.length) % items.length;
      else if (key === "down" || key === "j") index = (index + 1) % items.length;
      else if (key === "home") index = 0;
      else if (key === "end") index = items.length - 1;
      else if (key === "enter" || key === " ") return finish(index);
      render();
    });
    render();
  });
}

/**
 * Turn raw terminal input into key names: "up", "down", "left", "right", "home", "end",
 * "pageup", "pagedown", "enter", "escape", "ctrl-c", or the character typed. Terminals send the
 * arrows two ways (ESC [ A, or ESC O A in "application" mode, as macOS Terminal, iTerm and tmux
 * can), several presses can arrive in one chunk, and a sequence can arrive split; a lone ESC only
 * counts once nothing follows it. Returns a function that stops listening.
 */
export function onKeys(stdin, handle) {
  let pending = "";
  let timer = null;
  const NAMES = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end", Q: "f2" };
  const TILDE = { 1: "home", 4: "end", 5: "pageup", 6: "pagedown", 7: "home", 8: "end", 12: "f2" };
  const drain = (flush) => {
    while (pending) {
      const char = pending[0];
      if (char !== "\u001b") {
        pending = pending.slice(1);
        handle(char === "\r" || char === "\n" ? "enter" : char === "\u0003" ? "ctrl-c" : char);
        continue;
      }
      // ESC [ … letter, ESC [ n ~, or ESC O letter.
      const match = /^\u001b(?:\[([0-9;]*)([A-Za-z~])|O([A-Za-z]))/.exec(pending);
      if (match) {
        pending = pending.slice(match[0].length);
        const key = match[3] ? NAMES[match[3]] : match[2] === "~" ? TILDE[Number(match[1].split(";")[0])] : NAMES[match[2]];
        if (key) handle(key);
        continue;
      }
      // An ESC that might begin a sequence still on its way: wait a moment before calling it Esc.
      if (!flush && /^\u001b(?:\[[0-9;]*|O)?$/.test(pending)) return;
      pending = pending.slice(1);
      handle("escape");
    }
  };
  const onData = (chunk) => {
    clearTimeout(timer);
    pending += String(chunk);
    drain(false);
    if (pending) timer = setTimeout(() => drain(true), 40);
  };
  stdin.on("data", onData);
  return () => { clearTimeout(timer); stdin.off("data", onData); };
}
