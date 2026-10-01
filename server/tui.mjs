import os from "node:os";
import path from "node:path";
import { UPDATE_COMMAND } from "./update.mjs";
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
 * }} options
 */
export function createDashboard({ version, entries, plain = false, pinsHint, onQuit, stdout = process.stdout, stdin = process.stdin }) {
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
  let briefLines = [];
  let briefScroll = 0;
  let flash = "";
  let flashTimer = null;
  let closed = false;
  let update = null;
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
        log("◆", `Pin ${pin.number} saved: ${oneLine(pin.note)}${where}`, entry);
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

  function showPins() {
    briefLines = handOff().trimEnd().split("\n");
    briefScroll = 0;
    view = "brief";
    render();
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
    if (!interactive || closed) return;
    const width = Math.max(56, Math.min(stdout.columns || 80, 112));
    const height = stdout.rows || 30;
    const lines = view === "brief" ? renderBrief(width, height) : renderHome(width, height);
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
    while (lines.length < height - 2) lines.push("");
    lines.push(flash ? `  ${p.pin("●")} ${flash}` : "");
    const keys = [
      ["o", entries.length > 1 ? "open all" : "open"],
      ...(entries.length > 1 ? [[`1–${Math.min(9, entries.length)}`, "open one"]] : []),
      ["c", "copy pins"],
      ["p", "show pins"],
      ...(canUnzip() ? [["u", "unzip to edit"]] : []),
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
    if (update) lines.push(`    ${p.pin("↑")} scormplayer ${update} is available: ${p.bold(UPDATE_COMMAND)}`);
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
    const resolved = pins.length - open;
    if (!pins.length) return p.dim("none yet");
    return `${open ? p.pin(`${open} open`) : p.dim("0 open")}${resolved ? p.dim(` · ${resolved} resolved`) : ""}`;
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
    stdin.on("data", (key) => {
      if (key === "\u0003" || (view === "home" && (key === "q" || key === "Q"))) return void quit();
      if (view === "brief") {
        if (key === "\u001b" || key === "q" || key === "p") { view = "home"; render(); }
        else if (key === "\u001b[A" || key === "k") { briefScroll -= 1; render(); }
        else if (key === "\u001b[B" || key === "j" || key === " ") { briefScroll += key === " " ? 10 : 1; render(); }
        else if (key === "c") { copyPins(); view = "home"; render(); }
        return;
      }
      if (key === "o") state.forEach(openUrl);
      else if (/^[1-9]$/.test(key) && state[Number(key) - 1]) openUrl(state[Number(key) - 1]);
      else if (key === "c") copyPins();
      else if (key === "p") showPins();
      else if (key === "u" && canUnzip()) void unzip(state[0]);
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
    updateAvailable(version) {
      update = version;
      log("↑", `scormplayer ${version} is available: ${UPDATE_COMMAND}`);
    },
    quit,
    render,
  };
}

// ---- Shared helpers --------------------------------------------------------------------------

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
  const kind = { package: "SCORM zip (read-only)", folder: "SCORM folder", live: "Live source · hot reload" }[course.kind] ?? course.kind;
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

/** What pickCourse returns when the user wants to drop or choose a zip in the browser. */
export const DROP_PAGE = Symbol("drop page");

/**
 * The screen for a bare `scormplayer`: the logo, what was found here, and a list to pick from
 * with the arrow keys. Resolves to the chosen course path, or null when the user quits or
 * nothing was found.
 */
export function pickCourse({ version, courses, cwd = process.cwd(), stdout = process.stdout, stdin = process.stdin }) {
  const p = createPaint(stdout);
  let index = 0;
  const rows = courses.length ? [...courses, { path: DROP_PAGE, kind: "drop", title: "Empty player" }] : [];
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
        lines.push(`  ${p.key(" enter ")} ${p.dim("open the drop page")}   ${p.key(" q ")} ${p.dim("quit")}`);
      } else {
        const room = Math.max(3, height - lines.length - 4);
        const start = Math.max(0, Math.min(index - Math.floor(room / 2), rows.length - room));
        const nameWidth = Math.min(46, Math.max(...rows.map((course) => visible(course.title))) + 2);
        rows.slice(start, start + room).forEach((course, offset) => {
          const i = start + offset;
          const active = i === index;
          const marker = active ? p.pin("❯") : " ";
          if (course.kind === "drop") {
            const label = `${active ? p.bold("Empty player") : "Empty player"}`;
            lines.push(`  ${marker} ${p.pin("+")}  ${padVisible(label, nameWidth + 1)}${p.dim("drop or choose a SCORM zip in the browser")}`);
            return;
          }
          const number = i < 9 ? p.dim(String(i + 1)) : " ";
          const title = truncate(course.title, nameWidth);
          const kind = KIND_LABEL[course.kind] ?? course.kind;
          const where = truncateStart(displayPath(course.path), width - nameWidth - 30);
          const row = `${padVisible(active ? p.bold(title) : title, nameWidth + 1)}${padVisible(active ? kindColor(course.kind)(kind) : p.dim(kind), 14)}${p.dim(where)}`;
          lines.push(`  ${marker} ${number}  ${row}`);
        });
        if (rows.length > room) lines.push(`      ${p.dim(`${courses.length} courses · scroll with ↑ ↓`)}`);
        while (lines.length < height - 2) lines.push("");
        lines.push(`  ${p.key(" ↑↓ ")} ${p.dim("choose")}   ${p.key(" enter ")} ${p.dim("open")}   ${p.key(" 1–9 ")} ${p.dim("open that one")}   ${p.key(" d ")} ${p.dim("empty player")}   ${p.key(" q ")} ${p.dim("quit")}`);
      }
      stdout.write(`\x1b[H${lines.slice(0, height).map((line) => `${line}\x1b[K`).join("\n")}\x1b[J`);
    };

    const kindColor = (kind) => ({ zip: p.green, folder: p.blue, live: p.amber })[kind] ?? p.dim;

    const finish = (choice) => {
      stdin.off("data", onKey);
      stdout.off("resize", render);
      stdin.setRawMode?.(false);
      stdin.pause();
      stdout.write("\x1b[?25h\x1b[?1049l");
      resolve(choice);
    };
    const onKey = (key) => {
      if (key === "\u0003" || key === "q" || key === "\u001b") return finish(null);
      if (key === "d" || (!courses.length && (key === "\r" || key === "\n"))) return finish(DROP_PAGE);
      if (!courses.length) return;
      if (key === "\u001b[A" || key === "k") index = (index - 1 + rows.length) % rows.length;
      else if (key === "\u001b[B" || key === "j") index = (index + 1) % rows.length;
      else if (key === "\r" || key === "\n" || key === " ") return finish(rows[index].path);
      else if (/^[1-9]$/.test(key) && courses[Number(key) - 1]) return finish(courses[Number(key) - 1].path);
      render();
    };

    stdout.write("\x1b[?1049h\x1b[?25l\x1b[H\x1b[2J");
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.on("data", onKey);
    stdout.on("resize", render);
    render();
  });
}
