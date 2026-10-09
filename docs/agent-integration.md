# Browser player and MCP review

Lessons run in the normal local browser player. A standard stdio MCP server gives agents access to registered players, exact course revisions, pins, saved screenshots, source evidence and durable SCORM progress. MCP Apps hosts can render the pin checklist; clients without Apps support receive the same text and structured data. Browser WebMCP tools, when advertised by the browser, control navigation, narration, viewport and the browser's current SCORM state.

## Current-browser verification

The ordinary MCP tools `scormplayer_list_browser_sessions`, `scormplayer_verify_pin`, and
`scormplayer_reload` use the open player's same-origin browser bridge. They require a connected
player tab and an unambiguous session selection. Verification reports DOM observations without
navigating or resolving pins. It reports wrong-page, missing, ambiguous, loading and disconnected
states explicitly. Reload flushes learner progress and returns a request acknowledgement; wait
for readiness before verification. See [pin evidence](pin-evidence.md) for confidence semantics
and optional course-authored content bindings. No proprietary browser API is required.

## Agent QA pass

An agent can review a whole course on the reviewer's behalf, in the reviewer's own player tab.
The `scormplayer_qa_*` tools go through the same browser bridge:
- `qa_start` switches the tab to a throwaway SCORM attempt.
- `qa_snapshot` returns the page's text, images, controls, media, axe findings and SCORM issues,
  each with a selector.
- `qa_go` moves to the next page or module, or jumps to one.
- `qa_suggest` places a suggested pin through the player's normal pin path, with category,
  severity and quoted evidence.
- `qa_log_page` records coverage.
- `qa_finish` writes `<course>.qa-log.md` and restores the reviewer's progress.

Suggestions are pins with `status: "suggested"` and an `origin`. They stay out of the hand-off
until the reviewer accepts them; a dismissed one is refused if suggested again. Triage happens in
the player's Pins → Suggestions tab, in the MCP Apps checklist that `qa_finish` and
`qa_suggestions` render, or with `scormplayer pins --accept/--dismiss/--clear-qa`. The guide
agents follow is the bundled `scormplayer-qa` skill (`scormplayer_get_review_guide` with
`name: "qa"`). WebMCP's `scormplayer_add_pin` accepts the same suggestion fields.

## Normal MCP configuration

The recommended setup is:

```sh
scormplayer setup
```

Choose apps once; the same selection configures normal MCP with bundled review guidance.
There is no separate filesystem skill install by default. Setup supports Codex, Claude Code, Cursor, Claude Desktop, Gemini CLI
and Windsurf. Codex configuration uses its installed CLI; the other apps use structured JSON
configuration. Existing unrelated settings are preserved and JSON files receive a backup
beside them. Malformed configs and unrelated same-name `scormplayer` entries are preserved
and reported as failures. Existing native SCORM Player packages are reused and refreshed
when their version differs from the bundled MCP version. Setup verifies the installed version
without registering a duplicate server; a disabled package must be enabled in its host.

Setup stores complete MCP assets in a content-addressed snapshot outside temporary npm/npx
folders and registers the absolute Node executable and server path. Paths containing spaces
remain separate structured arguments. Run setup again after updating the player to configure
its current snapshot. Previously running servers keep their old assets.

`scormplayer setup --app codex --app cursor --json` is available for scripts. `--skills-only`
installs filesystem skills without MCP; `--with-skills` adds them alongside MCP with the same
app selection, global scope, copied files and one noninteractive Vercel skills CLI invocation.
Claude Desktop has no filesystem skill target. `--mcp-only` is an alias for the default.
npm installation includes a setup tip (npm may hide lifecycle output) but does
not run an interactive installer in its lifecycle hook. The first interactive course launch
offers setup once; Enter skips it. CI, non-terminal, plain, JSON and MCP invocations never
receive that offer. Optional filesystem skill installation requires internet access for the skills CLI; MCP
configuration itself stays local. A successful installation or skip is remembered.

## Bundled workflow guidance

The connection publishes `skill://scormplayer-review/SKILL.md` (the MCP review workflow)
and `skill://scormplayer/SKILL.md` (the CLI fallback guide). `skills/list` and `skills/get`
return their full YAML frontmatter and complete file manifests, with SHA-256 digests and
byte sizes. All files are also ordinary `resources/read` resources. The build snapshots the
authored bytes; a running server keeps the catalog in memory so an update cannot invalidate
its published hashes. Reads use registered resource URIs, never arbitrary filesystem paths.
The server checks packaged bytes against the manifest before advertising the guides.

Clients without native skill loading can call `scormplayer_get_review_guide` before reviewing
pins. It returns the same authored guide through a standard read-only tool, without needing
a running lesson. Essential safeguards also remain in server instructions and tool descriptions.
Reading a guide supplies ordinary workflow information; it does not activate a native skill
or grant additional authority. Hosts handle native skill approval, verification and discovery.

Compatibility boundary: SDK 1.32.1 negotiates the 2025-11-25 base protocol (and supported older
revisions). This server advertises `io.modelcontextprotocol/skills` in `initialize` and implements
its skill entry and file methods for compatible clients. The current stable extension specifies
the newer 2026-07-28 `server/discover` handshake, which this SDK does not yet implement; this
release does not claim full support for that newer base protocol. The regular guide tool and
resource reads work on the negotiated older protocol. Native host packages still bundle
filesystem skills. Avoid enabling duplicate native and standalone providers for the same host.
See the [Skills extension specification](https://modelcontextprotocol.io/extensions/skills/overview).

For manual MCP configuration:

```json
{
  "mcpServers": {
    "scormplayer": {
      "command": "scormplayer",
      "args": ["mcp"]
    }
  }
}
```

Use an absolute executable path if the host does not inherit your shell's PATH. MCP requires Node.js 22.22.2 or newer; the browser CLI supports Node.js 20+. `scormplayer mcp` writes only MCP protocol messages to stdout. It starts no HTTP player until `scormplayer_start` receives an exact requested lesson path. List existing players first when the intended lesson is already running.

The CLI can start an ordinary browser session directly:

```sh
scormplayer /absolute/path/to/course.zip
scormplayer /absolute/path/to/source --live
```

The MCP tool `scormplayer_open_browser` uses the operating system's browser launcher and accepts only a verified registered player ID and course revision. Its response includes the manual browser address. macOS uses `open`, Linux uses `xdg-open`; Windows has a launcher adapter but is not the primary qualification platform.

## Optional host packages

Host packages contain the same normal MCP server and skills. They do not register a full-player extension, global entrypoint or embedded lesson.

```sh
scormplayer plugin install codex
scormplayer plugin install claude
scormplayer plugin install cursor
scormplayer plugin status all
```

Codex and Claude installation uses their CLIs. Cursor installs a real managed copy in `~/.cursor/plugins/local/scormplayer-cursor`, with `.cursor-plugin/plugin.json`, `mcp.json`, skills, commands and a review rule. The native Cursor identity differs from an imported Claude package; use one provider consistently. The installer preserves an earlier managed copy, detects local edits before replacing it, and uses an absolute Node command. Reload Cursor with **Developer: Reload Window** and inspect **Customize → Plugins** and its MCP settings. Reopen a host chat after replacing an installed server; an existing chat can retain an earlier process.

Cursor's `/scorm-review` command starts or finds the intended lesson and verifies requested edits in the browser. `/scorm-pins` reads pins and evidence without making changes. Both use stable pin IDs and the observed course revision. Native commands and rules remain useful when the host has no rich panel.

## Pin checklist

Calling `scormplayer_list_pins` or `scormplayer_show_review` returns the standard MCP Apps resource `ui://scormplayer/pin-checklist.html` together with current pin data and a bounded json-render spec. The server constructs the layout; course text and pin notes are data, never generated component code or actions.

The light widget shows only pins that still need work. It has one meaning for a checked box: include that pin in the request.

- Remaining pin count, course name, and four short notes per page.
- One selection checkbox per pin and one **Send to agent** button. No prepare step, verification checkbox, status filters, or note editor.
- Search and pagination appear for longer lists; selection survives page changes. **Select all** includes every open pin.
- Full notes and saved screenshots are available through a quiet Details control when needed.
- Refresh and Open player keep the list connected to the ordinary browser lesson.

Sending checks fresh status and selected evidence before and after building the request. A changed pin, completed selection, changed source, or retired session blocks stale sending and refreshes the list. It never chooses another registered player automatically. Sending leaves pins open; the agent resolves them with ordinary MCP tools only after verifying the work.

Actions depend on advertised host capabilities. Without `serverTools`, pins remain readable. Without `message`, the button produces text to copy into chat; rejected sends also keep copyable text. Nothing sends automatically. The host may queue a request while the agent is busy; acceptance does not prove completed work.

The widget stays light even in a dark host. HTML, JavaScript and CSS are bundled into one resource; screenshots arrive as inline MCP image results. It loads no child localhost frame, remote fonts or external scripts and requires no certificate setup. Existing certificates from the retired extension are not modified.

## Local data and lifetime

The server uses stdio and discovers loopback players through registry records that validate the owning process. Pins and SCORM learner state remain local. MCP-owned player data is stored in the platform cache under `scormplayer/agent`; `SCORMPLAYER_DATA_DIR` overrides that location. `SCORMPLAYER_REGISTRY_DIR` isolates discovery. The older `SCORMPLAYER_EXTENSION_DIR` variable remains a data-directory alias for existing setups, with no TLS behavior.

A running MCP process keeps its review HTML in memory and copies browser assets to a content-addressed cache before starting its player. Replacing the plugin installation cannot delete assets underneath a running browser session. Closing the MCP process closes its owned player; separate CLI players are unaffected. Durable pins and learner state remain on disk.

Source notifications and `lastChangeAt` are evidence of file events. Verify the actual rendered lesson, playback and resume before resolving pins. `scormplayer_get_progress` reads the last server-saved SCORM snapshot, not browser calls that have not been saved or the current call log. Server MCP alone cannot inspect the active browser page.

## Build and validation

From the repository root:

```sh
npm ci
npm ci --prefix integrations/agent
npm run check
npm run build:plugins
npx playwright install chromium firefox webkit
npm run test:plugins
npm run test:e2e
SCORMPLAYER_BROWSER=firefox npm run test:e2e
SCORMPLAYER_BROWSER=webkit npm run test:e2e
```

The build emits `dist/mcp` for the direct CLI and host packages in `dist/plugins`. No dependency installation is needed inside a shipped bundle. Standard SDK smoke tests start a copied bundle without node_modules, read its UI resource, exercise real pin edits and progress, reject stale revisions and forged process records, and confirm that deleting original installation assets does not break a running player. Browser tests exercise the shipped checklist through the MCP Apps bridge in Chromium, Firefox and WebKit, including missing host capabilities, rejected messages, concurrent changes during handoff, resolved selections and changed evidence. CI runs these checks on Linux and macOS. Local macOS results do not establish native Linux host acceptance or LMS conformance.

Native Cursor discovery was verified with the earlier 0.3.5 package. Version 0.4.1 was verified in the macOS desktop host in Codex mode, including actual message delivery. Version 0.4.2 simplifies the widget to light-mode pin selection and one-click sending; its native host acceptance must be checked after loading the new version. Version 0.4.4 ships with player 0.9.0 and includes the MCP skill catalog and fallback guide tool; transport and packaged installs are verified, while native skill activation remains host-dependent. These checks do not establish native Linux or Cursor UI acceptance. A host must support MCP Apps to show the panel. The regular browser and plain MCP tools remain the common workflow.

The full-player ChatGPT extension was retired after the native desktop host blocked its loopback iframe with `ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`, even after the approved exact-certificate SSL trust repair. Version 0.4.0 removes that child frame, HTTPS proxy and certificate setup rather than requiring host network permission for lesson embedding. Local stdio does not expose lessons to cloud chats or start agent turns through webhook Events.

MCP 0.4.5 ships with player 0.9.3 and fixes Cowork rejecting draft-07 tool schemas.
Discovery now emits JSON Schema 2020-12 semantics without a dialect header; runtime
Zod validation and MCP Apps metadata remain intact. After updating the player, rerun
`scormplayer setup` for apps with an existing connection, then reopen those apps.
Their persistent MCP snapshots are separate from the CLI installation. Installed-server
stdio verification does not establish a successful native Cowork agent turn.

MCP 0.4.9 ships with player 0.9.7 and includes shared target resolution, attachment status,
reattachment history, and proportional region anchors. Refresh installed host packages or run setup again after updating. Restart older
running players and open a fresh host session to load the new tools.

Protocol and renderer references: [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) and [json-render MCP integration](https://github.com/vercel-labs/json-render/blob/main/skills/mcp/SKILL.md).
