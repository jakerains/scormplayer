# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
