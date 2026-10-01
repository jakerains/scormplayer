# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.8.7] - October 1, 2026

### Fixed
- A zip or folder holding several courses (several `imsmanifest.xml` files) opens instead of
  failing with "Found 2 imsmanifest.xml files; expected one". A terminal asks which to open;
  elsewhere the first opens and the others are listed. `--package <folder or title>` picks one,
  and **More** in the player switches between them. Each keeps its own pins and progress.
- Bare `scormplayer` in a folder of course folders lists them to pick from, instead of trying
  to open the folder itself as one course.

### Changed
- The manifest is found up to three folders deep (it was one), for exports that nest it.

## [0.8.6] - October 1, 2026

### Changed
- One pin gesture instead of two tools: click pins the highlighted element, dragging draws a box
  around an area, and a drag that starts on text still pins that phrase. Hold ⌥ Option / Alt to
  draw a box over text. The Element/Area switch and the R shortcut are gone.

## [0.8.5] - October 1, 2026

### Added
- "Still there?": a background player left open in a tab nobody touches asks after its idle time
  (30 minutes by default) and closes if nobody answers within 2 minutes. An open tab no longer
  keeps a forgotten player running forever. Clicks, typing, scrolling and narration count as
  someone being there.
- When a player closes or is stopped, its tab says so, where the pins are, and the command to
  reopen the course.

### Fixed
- The running-players registry follows `XDG_CACHE_HOME` on every system when it's set.
- Tests stop the players they start even when they fail, so a failure can't hang CI.

## [0.8.4] - October 1, 2026

### Added
- `scormplayer ps` lists running players: port, process, course, and when a browser last
  looked. `scormplayer stop <port|pid>` and `stop --all` stop them. Both take `--json`. Players
  from older versions are found on the port range too.
- Opening a course that's already open reuses that player instead of starting another
  (`--new` starts another anyway). In agent mode, `ready` says `reused: true`.
- A player in the background (an agent, a script, CI) stops by itself after 30 minutes with no
  browser looking at it, or when the program that started it exits. `--idle <minutes>` changes
  that; `--idle 0` turns it off. A terminal dashboard never stops by itself.

### Changed
- When all 20 player ports (4620–4639) are taken, scormplayer lists the players holding them and
  how to stop them, instead of failing with a stack trace.
- The agent `stopped` event says why it stopped.

## [0.8.3] - October 1, 2026

### Changed
- A word that isn't a command or a file, such as a command from a newer version, now says so
  and suggests `scormplayer update`, instead of "Nothing found at …/word".

## [0.8.2] - October 1, 2026

### Added
- `scormplayer update` installs the latest version with whatever installed scormplayer (npm,
  pnpm, yarn or bun), then refreshes the agent skill wherever it's installed. `--check` only
  reports; `--json` for agents.
- Falls back to npm if the tool that installed scormplayer is gone. Runs the install with
  `sudo` (asking for the password) when npm's global folder needs admin rights, as with Node
  from the nodejs.org Mac installer. Explains what to do under npx, in a project, or in a
  source checkout.
- If npm knows about a new version but can't install it by name yet, which happens for a while
  after a release, `update` installs the package file directly.
- The player's More menu shows when a newer scormplayer is available.

### Changed
- The update notice says `scormplayer update` instead of the raw npm command.
- A saved update check older than the running version is ignored, so a hand upgrade sees the
  next release right away.
- README: how to get Node on a Mac, and `scormplayer update` in the Install section.

### Fixed
- Changelog: 0.8.0 was published after all (same code as 0.8.1).

## [0.8.1] - October 1, 2026

Fixes for the 0.8.0 release run. 0.8.0 went out from the same code, so the two match apart
from the version number.

### Fixed
- Unzipping on Windows no longer leaves scormplayer's cache bookkeeping files in the new folder.
- The release workflow builds the player UI before running the tests.
- The agent-mode test reports the CLI's own error right away, and no longer expects a
  `stopped` event on Windows, where a killed process can't send one.

## [0.8.0] - October 1, 2026

### Added
- Agent mode: `--json` on every command prints only JSON on stdout, with no colours, prompts,
  tips or update notices. Errors print `{ ok: false, error, code }` and exit 1.
- `scormplayer <course> --json` streams one event per line: `ready` (url, pid, pinsFile), then
  `pin`, `progress`, `source`, `browser`, `course`, `unzipped`, `log`, and `stopped` on exit.
- `--json` for `pins --resolve`, `cache`, `skill status` and `--version`.
- Unzip to edit: a zip is read-only, so the player says so and offers to unzip it to a folder
  (beside the zip by default). It then reopens on that folder and moves the pins and their
  screenshots with it. Reopening the zip offers the folder it was unzipped to before.
- `scormplayer unzip <zip> [--to <folder>]`, the `u` key in the dashboard, and the
  `scormplayer_unzip` WebMCP tool.
- Hand-offs for a zip say it's read-only and give the unzip command.
- README: an Install section at the top with one-click-copy commands.

### Changed
- **Breaking:** `scormplayer pins <course> --json` prints `{ ok, course, pinsFile, counts, pins }`
  instead of a bare array. Each pin includes its screenshot's full path.
- The agent skill uses `--json` throughout and explains unzipping a zip before editing it.
- Synced `package-lock.json`'s version, which was stuck at 0.5.0.

## [0.7.0] - September 30, 2026

### Added
- SCORM inspector, packages with several modules (SCOs), and WebMCP tools for browser agents.

## [0.6.0] - September 30, 2026

### Added
- Area and multi-element pins, note editing, tablet and phone screen sizes, automatic cache
  cleanup, an update notice, and browser tests.

## [0.5.0] - September 30, 2026

### Added
- Drop or choose a SCORM zip in the browser; a cross-platform pass.

## [0.4.0] - September 30, 2026

### Added
- Page navigation, tour controls and narration skip in the bottom bar.

## [0.3.0] - September 30, 2026

### Added
- A bare `scormplayer` opens a course picker; project config (`scormplayer.config.json`).

## [0.2.0] - September 30, 2026

### Added
- The terminal dashboard.

## [0.1.0] - September 30, 2026

### Added
- A local SCORM player with pins for review and agent hand-off.
