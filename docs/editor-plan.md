# Plan: SCORM Player → WYSIWYG editor (P0–P3)

## Context

Jake wants SCORM Player to become a visual lesson editor:
- open a scene and edit its text directly;
- fix where driver.js tour cards and highlight boxes sit at each step, separately for each screen size;
- adjust element properties.

Saving must write ordinary source code. Nothing editor-specific may end up in the SCORM zip.

Research concluded we should **upgrade the existing player** (see `docs/research/wysiwyg-editor.md` and the published page). Edits go straight to source when the editor can prove where they belong. Anything else becomes an agent "edit request" through the existing pins hand-off. This plan covers P0 to P3. P4, the component palette, is out of scope.

Jake's answers:

| Question | Answer |
| --- | --- |
| Tour placement | Snap, breakpoints and nudge |
| Where tour steps are defined | Not sure; probably mixed |
| Where lesson text lives | A mix of JSON and JSX |
| Shared library packaging | Unknown |

So the plan handles every variant and audits a real lesson repo on day 1.

### Settled facts

- **Editing works only in live (Vite) mode.** The editor plugin is passed only to the dev `createServer` in `server/live.mjs`, with `apply: "serve"`. Builds never load it.
- **driver.js 1.9.0, checked against its bundle and type definitions:**
  - Placement is `side` × `align`: 12 positions, or centered.
  - `stagePadding`, `stageRadius` and `popoverOffset` apply to the whole tour, not one step.
  - `onPopoverRender` runs *before* positioning, and positioning only sets top/left.
  - `DriveStep.data?: Record<string, any>` exists.
- **`@vitejs/plugin-react` 6.1.1** (from the lockfile) compiles JSX in Vite core with oxc. Older Babel-based versions run as `pre` plugins.

## Key design choices

1. **Write-through with a journal, not an in-memory draft.** Tailwind's class scanner and `sync` rules read from disk, so an overlay can't preview their changes.
   - Each committed edit is written to disk at once. A journal in `.scormplayer/edit/` keeps each file's original bytes and the list of ops applied to it.
   - **Undo/Redo** and **Discard** restore exact bytes. **Keep** (the Save button) accepts the changes and clears the journal.
   - After a crash, the journal lets you recover the session or roll it back.
   - The watcher's HMR runs for the editor's own writes, except for tour-only writes (below).
2. **Tagging happens in a `load: { order: "pre" }` hook.** The plugin reads the original file, adds tags with magic-string and returns a sourcemap. It runs before any JSX compiler (Babel, SWC, oxc, esbuild), so plugin order doesn't matter.
3. **The `data-sp-src` attribute goes on lowercase DOM elements only.** Components get no extra prop, because some components treat props as data (Trans, Radix `asChild`, r3f dashed props).
   - Call sites are found by aliasing `react/jsx-dev-runtime` to a small wrapper, with an importer guard so it doesn't wrap itself. The wrapper records each element's dev `source` in a `WeakMap` keyed by its `props` object. React reuses that object as `fiber.memoizedProps`, so the client's fiber walk can look it up.
   - Locate tolerates column numbers that are off by one.
4. **JSON text is edited directly only through declared bindings.** That means `scormplayer.sources.json` or a `data-content-id` key path, matching the repo's rule "never infer a field from equal strings".
   - A string match alone shows candidate fields, and you confirm the right one. These are labelled "inferred".
   - A binding that turned stale because of our own journal write is accepted when the file's hash equals the last journaled write.
5. **Text is edited in an overlay, never with `contenteditable`.** A positioned textarea sits over the element and the real node is left alone. Editing React-owned DOM directly breaks React, so HMR updates the real node after the write.
6. **Tour placement lives in a sidecar file when the helper is installed.** The file is `tour-placement.json`, keyed by the step's `data-tour-id`, or by step index plus element. This works for literal, JSON and runtime-built steps alike, and the editor only ever writes JSON.
   - Without the helper, only the base `popover.side`/`align` can be written, and only when the step's source can be located.

## Dependencies

- **Runtime:** `@babel/parser`, `magic-string`, `jsonc-parser`. All are pure JS and get bundled by the standalone esbuild build in `scripts/package-standalone.mjs`.
  - Parse `.ts` without the `jsx` plugin (so `<T>x` casts still parse), and `.tsx`/`.jsx`/`.js` with it.
  - Keep each file's EOL and BOM.
- **devDependencies:** `driver.js@1.9.0`, plus `@vitejs/plugin-react-swc` for the compatibility matrix.

## P0 — Audit, foundation, safety (~1 week)

1. **Audit one real lesson repo (day 1).**
   - Record: where tour steps live, how text is bound, how the shared library is packaged, versions of React, Vite and the React plugin, whether Tailwind is used, and the sync rules.
   - Write the findings into `docs/editor.md` and narrow P2 to match.
2. **`server/fs-safe.mjs`.** Move three helpers into it and re-point their callers with no behavior change:
   - atomic write, from `server/pins.mjs:22-27`;
   - realpath containment read, from `source-bindings.mjs:13-19`;
   - JSON-pointer get, from `source-bindings.mjs:41-44`.

   Add pointer→path conversion for jsonc. Lock with one per-course `.scormplayer/edit.lock` via `withFileLock` (`server/file-lock.mjs`), never a lock next to the source files.
3. **Security hardening** in `server/index.mjs`, applied before any write route:
   - **Host allowlist** against DNS rebinding: `localhost`, `127.0.0.1` and `[::1]` on the player's port.
   - **Writable files:** inside `course.root` and in Vite's module graph; JSON files that bindings declare; or the explicit inputs listed by `sync` rules.
   - **Never writable:** `node_modules`, `scormplayer.config.json`, `package.json`, `vite.config.*`, `scripts/` and lockfiles.
   - **Workspace library files** outside the root stay read-only unless listed in `editor.writable`.
4. **Editor settings.** `server/config.mjs` gets `editorSettings(config)` and `syncInputs(config, source)`, reusing `fill`/`courseName`. The server calls `findConfig(course.source)` when a course opens; sync itself still runs from `bin/scormplayer.mjs:317`.
   - `"editor": false` or the `--no-edit` flag turns the editor off.
   - `editor.breakpoints` defaults to Tailwind `screens` when found, otherwise `[0, 768, 1025]`. With those defaults the player's phone preset (390) and tablet preset (1024) fall in separate bands, and desktop is the third band.
5. **`server/edit/vite-plugin.mjs`** is appended to the `plugins` array in `live.mjs:41`, with `apply: "serve"`. It does four things:
   - **(a) DOM tagging.** In the `load`-pre hook, add `data-sp-src="posix/rel/path:line:col"` to lowercase JSX elements in files Vite serves from the project. It skips `node_modules`, `.scormplayer` and virtual ids, and checks a cheap regex before parsing. Parses are cached by content hash.
   - **(b) Tour-step tagging.** Add a computed `[Symbol.for("scormplayer.src")]` key to object literals that have a `popover` key.
   - **(c) JSX runtime alias.** Alias `react/jsx-dev-runtime` to the WeakMap wrapper from design choice 3.
   - **(d) driver.js shim.** A virtual module whose source is an inline string. It wraps `driver()`, `setSteps`, `drive`, `highlight`, `moveTo`, `setConfig` and `destroy`, and publishes instances, config, steps (with their source symbol) and the active index on `window.__SCORMPLAYER_EDIT__`.
     - When driver.js is missing, or bundled inside a prebundled library, the shim does nothing and the editor falls back to the DOM `tourState` (`client/src/media.ts:63`) plus agent requests.
   - **HMR suppression.** A `hotUpdate` hook (Vite 6+) or `handleHotUpdate` (Vite 5) returns `[]` when a file's hash matches a write the editor flagged "silent".
   - **Version differences.** Use `server.environments.client.moduleGraph` when present, otherwise `server.moduleGraph`.
6. **Fixtures** (`tests/fixtures.mjs`). A live React and Tailwind lesson containing:
   - JSX text, literal props, `className`/`cn()`, an inline style, sibling lists, a `.map`, a conditional;
   - `content/lesson.json` plus `scormplayer.sources.json` bindings;
   - a sync rule;
   - `tour.ts` (literal steps), `tour.json` (JSON steps) and one runtime-built tour.

   Repo `node_modules` are reached with the symlink trick from `tests/server.test.mjs:1063`.
7. **Leak and compatibility guards.**
   - After saves, `vite build` the fixture; assert `dist` contains no `data-sp-`, `scormplayer.src` or `__SCORMPLAYER_EDIT__`, and that saved files contain no editor markers.
   - A matrix test on Vite 5 and 8, with plugin-react (Babel), plugin-react-swc and oxc, proves the tags appear in dev.
   - Pin capture strips `data-sp-*` from pin evidence (`client/src/picker.ts` `READ_ATTRIBUTES`) and records the location as source evidence instead.

## P1 — Inspect, inline text, journal, agent fallback (~3 weeks)

**P1a, Inspect (week 1).** Read-only. Hover shows each element's source location and why it is or isn't directly editable. It proves `locate` before anything writes.

**Server, `server/edit/`:**
- **`locate.mjs`:** `inspect({loc, chain, rawText, attributes, repeatCount})` returns capabilities, each with a reason:
  - `jsx-text`: a single text segment, edited segment by segment when text is mixed with elements;
  - `attr-literal`;
  - `json-field`: `bound` or `inferred-candidates`;
  - `none`: expressions, `.map`, conditionals, spreads, `node_modules`, nodes rendered more than once from the same location, or HTML-rendered content.

  It walks the call-site chain to offer the nearest editable instance.
- **`ops.mjs`:** pure `(text, op) → {text, inverse}`. Every op carries `expect`, the old value.
  - **`setText`** follows JSX whitespace-collapse rules, keeps entities, and escapes `{ } < >`.
  - **`setJson`** uses jsonc-parser's `modify`.
- **`journal.mjs`:**
  - Per course it keeps an ops log, undo and redo stacks, the original bytes and hash of each file, and a sequence number.
  - It writes atomically under the course lock.
  - The watcher flags outside edits to journaled files right away. Re-applying the journal compares each op's `expect` against the file's new text and marks any that no longer match as conflicts.
  - It emits `events.emit("edit", …)` for the TUI feed (`server/tui.mjs`) and pushes state to the other tabs over the browser bridge (`server/browser-bridge.mjs`).
- **Routes:**
  - `GET /api/edit/state`; `POST /api/edit/inspect|ops|undo|redo|keep|discard|request`.
  - Add `edit(?:/|$)` to the `scoped` regex (`server/index.mjs:194`) and re-check the revision after each `await`.
  - Ops whose sequence number is stale get 409.
  - Switching course or package, or an idle shutdown, warns when there are unkept edits. They stay on disk and the journal offers to recover them.
- **Agent fallback.** `POST /api/edit/request` creates a pin with an optional `editRequest` (`{intent, before, after, chain, reason}`).
  - It goes through `createPinStore.create` in `server/pins.mjs`, using `clean()`.
  - `formatBrief` prints it, so Copy, MCP and `scormplayer pins` all carry it.

**Client, `client/src/editor/`:**
- **`fiber.ts`:** reads the `__reactFiber$*` key, walks `.return`, and reads the WeakMap sources from `memoizedProps`. It falls back to `closest("[data-sp-src]")`.
- **`EditMode.tsx`:** the hover and selection overlay, reusing the `chooseTarget` and `.sp-box` patterns from App.tsx.
  - Click → `inspect` → an overlay textarea for editable text. Enter commits, Esc cancels, and paste is plain text only.
  - A chip shows where the edit goes (`App.tsx:42 · JSX` or `lesson.json /intro/title · bound`), or an **Ask agent…** button that prefills the composer.
- **App.tsx:**
  - `pinMode: boolean` becomes `mode: "review" | "pin" | "edit"`. Add the `E` key and an **Edit** tab, shown only when `course.kind === "live"`.
  - Extend the Esc chain and the `editing()` guard, and reuse the Space passthrough.
  - Add a bar: `n changes · Undo · Redo · Discard · Keep`, with Cmd/Ctrl-S, -Z and Shift-Z.
  - Call `checkpointReview` before an op that will force a full reload.
- **`api.ts`:** one-liners for the new endpoints.

## P2 — Tour step editor (~2.5 weeks, scope set by the audit)

- **Tour panel in Edit mode.** It lists the shim's steps; clicking one jumps there with `moveTo`. A warning explains that `moveTo` re-runs step hooks, which can restart narration.
- **Locating a step's source** (`inspectTour`), in this order:
  1. the step's source symbol → AST object literal;
  2. a JSON object whose `element` and `popover.title` match → jsonc;
  3. otherwise the step is runtime-built. With the helper installed it uses the sidecar; without it, it becomes an agent request.
- **Snapping** (`client/src/editor/snap.ts`) is a pure function mirroring driver.js geometry: the `popoverOffset`, and the left, right, top, bottom flip order.
  - Drag the card freely. On drop it snaps to the nearest placement that fits.
  - The leftover distance becomes `dx`/`dy`, rounded to 4px and capped at ±160px. Beyond the cap, the editor suggests changing side instead.
- **Highlight retargeting** reuses `chooseTarget`/`widenTarget`. The selector is chosen in this order:
  - an existing `data-tour-id`;
  - a unique `id` or `data-content-id`;
  - otherwise the editor offers to add `data-tour-id` to the target's JSX with `setAttr`.
- **Breakpoint bands.** The active band is computed from the frame's `innerWidth`, together with the player's device presets. A band without its own override inherits from the next smaller one.
- **Placement helper** (`docs/tour-placement.md`), about 60 lines of neutrally named product code:
  - `tourPlacement.ts` reads `tour-placement.json`.
  - Before each step it sets `side` and `align` for the current band, and calls `moveTo` when the width crosses a band.
  - In `onPopoverRender` it applies the CSS `translate` property (not `transform`), keeps the card inside the viewport, and hides the arrow.
  - It re-clamps on resize and scroll, and skips the nudge when driver.js has flipped the card to another side (read from the arrow's class).
  - **Add placement helper** writes the helper file and its wiring to a path you choose, or creates an agent request.
- **Preview.**
  - **Instant preview:** the shim calls `setSteps(modified)` then `moveTo(i)`, so you see the change before any write.
  - **Silent writes:** sidecar and step writes are flagged "silent", so HMR doesn't restart the tour.
  - **Reload behavior:** files whose components start the tour in `useEffect` re-run that effect after Fast Refresh. Steps files that export no components may force a full reload. In both cases the editor re-drives to the saved index through the shim.
- **Ops:**
  - `setTourStep`: base `element`, `popover.side` and `popover.align` in literal or JSON steps;
  - `setPlacement`: sidecar entries for a band, `{side, align, dx, dy}`;
  - `setTourConfig`: tour-wide literal `stagePadding` or `stageRadius`.

## P3 — Properties panel and structure (~2.5 weeks)

`PropertiesPanel.tsx` reuses the `.sp-panel` pattern and shows only the capabilities that `inspect` reports:
- **className chips** for string literals, and for `cn()`/`clsx()` calls whose arguments are all string literals, edited per argument. Tailwind picks up new tokens because writes go to disk.
- **Literal props** on any instance in the call-site chain: string and number values, and boolean toggles.
- **Inline style literals:** edit or add keys. Computed values are read-only.
- **Structure:**
  - Move up or down among siblings, but only when every sibling is a JSX element.
  - **Duplicate** strips or suffixes `key`, `id` and `data-tour-id`.
  - **Delete** removes imports that become unused, so `noUnusedLocals` still passes.
  - Never run a formatter over the whole file.
- **Ops:** `setAttr`, `setClassTokens`, `setStyle`, `moveSibling`, `duplicate`, `remove`, each with an inverse.

## Docs and release

- Add `docs/editor.md` (what saves directly, what goes to an agent, guarantees, limits, audit findings) and `docs/tour-placement.md`.
- **README:** reword the "Leaves your course alone" promise. Edit mode is opt-in and live-only, writes ordinary source, and Discard restores the original bytes.
- Update `skills/scormplayer/SKILL.md` for `editRequest` pins, then run `npm run version`.
- Add a CHANGELOG entry. 0.10.0 ships after P1; P2 and P3 follow as minor releases.

## Verification

- **Unit tests** (`tests/editor.test.mjs`, added to `npm test`):
  - every op round-trips byte for byte through its inverse;
  - JSX whitespace and escaping;
  - jsonc keeps formatting;
  - each capability classification;
  - journal undo, discard, crash recovery and conflicts;
  - `snap.ts` fit and flip cases;
  - containment and denylist, including symlink and `../` escapes, and Windows paths with `file:line:col` parsed from the right;
  - Host allowlist, 409 on a stale revision or sequence number.
- **Server tests:** the live fixture through `startPlayer`. Inspect → op → the served module and the disk both change → undo restores the bytes → keep → discard round-trip. A sync-rule edit triggers sync.
- **E2E** (`tests/e2e.test.mjs`, desktop and 1024×768):
  - inline JSX and bound-JSON text edits;
  - an inferred-candidate confirmation;
  - an uneditable element creates an edit request that shows up in Copy;
  - tour: drag → snap → keep → reload → the step renders at the saved placement;
  - a tablet-band override and nudge with the helper installed;
  - retargeting the highlight;
  - a Playwright check that `snap.ts`'s predicted rectangle equals the real driver.js popover rectangle at each preset;
  - properties: class token, literal prop, reorder, duplicate, delete.
- **Leak guard:** run `vite build` after the e2e saves and assert there are no markers in `dist` or in saved files. The fixture's built tour must render with the saved placement.
- **CI and manual:** `npm run check` and `npm run test:e2e` on Linux, macOS and Windows. Manually, `npm run build && npm start -- <real lesson>`, working through each phase, with screenshots in each PR.
