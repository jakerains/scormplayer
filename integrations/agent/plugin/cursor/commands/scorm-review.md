---
name: scorm-review
description: Open a SCORM lesson in Cursor's browser, inspect pins, and verify requested source changes live.
---

Use the bundled scormplayer-review skill for this request.

Use tools from the native `scormplayer-cursor` plugin when Cursor also shows an imported Claude `scormplayer` package.

Match the user's lesson to `scormplayer_list_players`. If it isn't running, call `scormplayer_start` with its exact absolute source/ZIP path; use `live: true` for a Vite authoring project. Open the returned URL with Cursor's available browser tools. Fetch current status and open pins with the returned player ID and revision. Work only on the source changes the user requested, then inspect the real desktop/tablet rendering before resolving verified pins.

If the request names no lesson and several players or source folders match, ask which lesson. Do not substitute the first open player. If no browser tools are available, give the user the returned browser URL and identify the rendered checks still needed. A successful source edit or MCP call alone does not prove playback or layout.

Listing pins includes a standard MCP Apps checklist; `scormplayer_show_review` opens the same review panel explicitly. Lessons run in the normal browser. Rendering and messages depend on Cursor's advertised capabilities; use structured pins or a copyable request when unavailable. Do not claim that local notifications start agent turns.
