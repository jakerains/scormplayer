# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.7] - October 9, 2026

- Pins use shared UI/MCP identity resolution and show attached, possible, ambiguous or missing
  target status. Copy edits retain stable attachments; duplicate identities never pick a winner.
- Reattach a pin without losing its note, original screenshot or prior target/source history.
  Concurrent changes reject stale reattachments.
- New region anchors use a containing ancestor, including the document canvas for boxes
  beyond the body, and resize proportionally; markers clip inside nested scrolling panels.
- Typed anchor validation and server-stamped capture metadata preserve legacy pin compatibility.
- Bundled MCP and Codex/Claude/Cursor packages are 0.4.9, including player 0.9.7.

## [0.9.6] - October 8, 2026

- Opening an already-running course in a terminal keeps a reuse menu open, with browser,
  separate-player and leave-running choices. Exiting the menu never stops the original player.
- Reuse verifies that the responding process matches the registry entry. Plain and JSON
  launches retain their immediate-return behavior.
- Bundled MCP and Codex/Claude/Cursor packages are 0.4.8, including player 0.9.6.

## [0.9.5] - October 8, 2026

- Pins preserve content and tour IDs, raw and rendered text, CSS casing, ancestor identity,
  and the original clicked child when selection expands to a containing element.
- Source search lists repeated occurrences in minified and hashed bundles with original
  offsets and context. Text matches are labeled as candidates; manifest titles are excluded
  from visible-copy matching and search limits are reported.
- Optional course-authored content manifests map element IDs to JSON fields and known
  consumers. Artifact hashes are checked; stale or ambiguous bindings are rejected.
- Standard MCP adds `scormplayer_verify_pin`, `scormplayer_reload`, and
  `scormplayer_list_browser_sessions`. Agents can inspect the actual open review tab without
  host-specific browser tools. Wrong-page, ambiguous, stale, disconnected and unconfirmed
  targets are reported explicitly; verification never resolves a pin automatically.
- Bundled MCP, pin widget and Codex/Claude/Cursor host packages are 0.4.7. The player guide is
  stamped 0.9.5. Restart older running players and refresh host setup after updating.

## [0.9.4] - October 8, 2026

- Pin selections follow scrolling inside lesson panels without waiting for the polling
  timer. Saving or cancelling a pin cannot leave an old selection outline behind.
- Saved pin screenshots load from hidden project folders such as `.scormplayer`.
- Bundled MCP, pin widget and native host packages are 0.4.6, with the updated player
  included in every host bundle. The bundled player guide is stamped 0.9.4.

## [0.9.3] - October 7, 2026

- The Bash installer adds PATH to both interactive and login startup files, preserving
  the active login profile and avoiding duplicate entries. Newly opened Bash terminals
  can find the player even when installation ran with a temporary PATH addition.
- Terminal setup stays available through F2 beside the course picker and s in the
  running dashboard. Choose MCP, MCP with separate skills, or skills only, then choose
  apps once. Setup returns to the player without closing the lesson.

- MCP tool input and output schemas use JSON Schema 2020-12, fixing Cowork's
  rejection of the SDK's draft-07 declarations. Bundled MCP/native hosts are 0.4.5.
  Schema checks validate the advertised schemas and successful tool results using 2020-12.

## [0.9.2] - October 5, 2026

- Update discovery and downloads use stable GitHub Releases first, with npm as a fallback.
  GitHub packages are checked against SHA-256 checksums before installation; checksum
  failures preserve the current installation. Updates never switch an npm install to Bash.
- Release automation uploads the exact packed npm package and standalone archive with
  checksums, publishes the GitHub release after every asset is uploaded, then publishes
  that same package file to npm. Retried releases preserve already-published GitHub assets.
- Standalone Bash installs support `scormplayer update` directly, preserving the launcher
  and previous version bundles. The updated CLI is verified before success is reported.
- Mixed folders containing an unpacked lesson and other course ZIPs keep the course picker.
  The running terminal dashboard accepts ↑/↓ to open and navigate the course list.

## [0.9.1] - October 5, 2026

- `scormplayer update` downloads the exact npm release it just checked, so stale npm
  `@latest` metadata cannot silently reinstall an older version.
- npm updates target the installation you launched, even when npm's configured global
  prefix has changed. The command verifies the replaced CLI in a fresh process before
  reporting success; it works immediately in the same terminal.
- `scormplayer --help` puts MCP and skills setup commands near the top, including
  `scormplayer setup --with-skills` to install both with one app selection. The README
  includes the same examples.
- Regression checks cover cached commands in Bash and Zsh, stale npm release metadata,
  changed global prefixes, and installers that report success without updating the CLI.

## [0.9.0] - October 5, 2026

### Added
- A normal local MCP server for opening lessons, reading pins and screenshots, preparing
  selected-pin requests, and inspecting saved SCORM progress. Lessons run in the browser.
- A compact light-mode MCP pin widget: choose open pins and send them to the agent. Hosts
  without UI or messaging support can use structured pins and copyable requests.
- `scormplayer setup`: choose apps once to configure MCP with bundled review guidance.
  Supports Codex, Claude Code, Cursor, Claude Desktop, Gemini CLI and Windsurf. Filesystem
  skills remain optional through `--skills-only` or `--with-skills`.
- A verified standalone Bash install for macOS/Linux, including a private Node runtime
  when needed. `npx @jakerains/scormplayer@latest` also opens or picks courses without a
  global install; an exact current course folder is detected even without a terminal.
- Native Codex, Claude and Cursor packages; Cursor includes review commands and a rule.
  Both review guides are also readable as MCP resources. A normal guide tool supports
  hosts without native skill loading.
- Live-review view retention across HMR and reloads, with optional lesson adapters for
  page/guide state and review navigation. Packaged courses retain ordinary learner gates.

### Fixed
- SCORM 1.2/2004 progress now persists through the server across ports and player restarts,
  separately for each SCO. Reset clears all modules and rejects late writes from old tabs.
- Progress and pin write failures show retryable errors instead of silently losing work.
- Dropped ZIPs with the same filename keep separate pins, and packaged player assets work
  from hidden installation folders such as `.nvm` and `.codex`.
- Browser tools report current availability and reject stale lesson revisions.
- MCP-owned players include the source-search worker, so pins retain source locations.
- Live course switches isolate their hot-reload sockets and close retired reconnects on shutdown.
- A downloadable update is visible on the browser's More button, without opening its menu.

### Changed
- Release checks cover Linux and macOS, Node.js 20/22/24, and Chromium, Firefox and WebKit.
  MCP and native host packages require Node.js 22.22.2+; the browser CLI supports Node.js 20+.
- Full-player ChatGPT embedding and local certificate setup are retired. The small MCP
  widget uses bundled resources; the lesson stays in the normal browser.

## [0.8.10] - October 2, 2026

### Fixed
- `scormplayer update` right after a release no longer fails with screens of npm 404 errors. npm
  names a new version minutes before its package can be downloaded; `update` now checks the
  package is there first and, if not, says npm is still getting it ready and to try again
  shortly (`--json`: `code: "not_ready"`). The update notice waits for it too.
- npm's own output is kept out of the way: a successful update prints a line, a failed one the
  few lines that say why and where npm's full log is. The agent skill is refreshed only when
  it's behind the new version.

## [0.8.9] - October 1, 2026

### Added
- Switch to another course without restarting: press `l` in the dashboard to bring the course
  list back, or use **More → Switch course…** in the player. The player and its browser tab move
  to the chosen course; its pins follow the project's config, and so do its sync commands.

### Changed
- The course lists have no number keys (they stopped at 9). Type to filter by title or folder
  instead, then ↑↓ and Enter; Esc clears the filter, then leaves. The course choice for a zip
  holding several courses drops its numbers too.

### Fixed
- No pin is lost when several players, agents or `scormplayer pins --resolve` change the same
  pins file at once: each change locks the file, re-reads it and writes it whole. A lock left by a
  process that crashed is cleared after 10 seconds.
- Clearing or tidying the cache never removes a course another running player is using.
- A tab left open on the previous course can't save pins or progress into the course the player
  has since switched to; it reloads onto the new one instead.
- A course whose text holds a malformed character reference no longer stops pins from saving,
  and launch files with spaces or accented names in their path open.
- Paused narration no longer keeps "Still there?" from appearing, and Skip stays available while
  it's paused.
- Switching courses stops the old course's sync commands cleanly, in agent mode too.
- Two scormplayers opening courses at the same moment wait for each other (up to two minutes
  while a large zip unpacks) instead of failing.

### Performance
- Pin source lookup reads each course file once, in the background, so a big course doesn't
  slow the player while a pin saves.
- The player page loads faster: its scripts are served compressed and cached by the browser,
  while course files and live data always come fresh.
- Background checks never pile up, slow down in hidden tabs, and skip re-sending pins that
  haven't changed.
- Pin markers stop re-measuring while the tab is hidden and remember which elements they belong
  to; tidying the cache no longer measures every course's size.

## [0.8.8] - October 1, 2026

### Added
- The agent skill keeps up with the player. Each release stamps the skill with its version, and
  scormplayer compares the installed copy with its own every time it starts.
- `scormplayer skill` on its own installs the skill if no agent has it, updates it if it's behind,
  or says it's current. `scormplayer skill status` (and `--json`) reports the versions.
- When the skill is missing or out of date, the dashboard says so and offers the `s` key to
  install or update it; the player's Pins panel shows the `scormplayer skill` command.

### Security
- The player only accepts changes (pins, unzip and the rest) from its own page, so another
  website open in the browser can't use the local server.

### Fixed
- Arrow keys work in the course picker and the dashboard's pin list in every terminal. Some
  (macOS Terminal and iTerm in some modes, tmux) send arrows in a form that was ignored, and a
  quick press arriving in pieces could close the picker as if Esc were pressed.
- Choosing a course in a zip that holds several now uses the same arrow-key list (↑↓, Enter,
  1–9, q) instead of typing a number.

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
