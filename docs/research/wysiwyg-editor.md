# Turning SCORM Player into a WYSIWYG course editor

Research checked October 10, 2026. Sources: this repository, the published driver.js 1.9.0 type definitions and bundle, and public documentation for the visual editors cited below. **[F]** means a documented or inspected fact. **[I]** means our inference. Read this together with [Accurate visual targeting](visual-targeting-platforms.md), which already covers DOM-to-source evidence (Lovable tagger, Cursor Design Mode, React Grab, Domscribe). That material is not repeated here.

**Blind spot:** this research did not have access to the course repositories. Several conclusions depend on three facts about those repos:
- how the tour steps are defined;
- whether lesson text lives in JSON;
- how the shared components are packaged.

The [first next step](#next-steps) is to check these.

## Short answers

1. **Upgrade the existing app; don't build a new one.** The player already has most of what an editor needs:
   - it runs the course's own Vite dev server, same-origin, inside the player;
   - it has a dev-only plugin hook;
   - it has an element picker with overlays, page navigation and driver.js tour detection;
   - it keeps the review position across hot-reload and full reload;
   - it searches source for text, with JSON content bindings;
   - it has a browser↔server bridge and the pins → agent hand-off.

   Add an **Edit mode** next to Pin mode. Editing works only in live (Vite source) mode. Packaged ZIPs stay review-only, because a ZIP has no source to edit.
2. **Yes, it can be built.** One condition: only edits that can be traced back to a specific spot in the source are applied directly. Everything else goes to an agent, using the existing pin hand-off. Every comparable product has ended up with this split (see [market](#what-other-editors-do)).
3. **"No extra code in the lesson" is achievable.** SCORM Player never runs `vite build`. It only runs the course's Vite in dev middleware (`server/live.mjs`). Anything the editor injects through a dev-only plugin therefore can't reach the packaged SCORM ZIP; the existing `scormplayer-live-base` plugin already relies on this. A save writes the same code change a person would make by hand.

## The two models, and why to use both

| | A: direct write | B: send intent to an agent |
| --- | --- | --- |
| How it saves | Edits the exact source text; Vite hot-reloads it | A structured request (target, before/after, screenshot) goes to an agent |
| Strength | Instant, deterministic, free | Handles anything: data-built text, loops, layout, new components |
| Weakness | Only edits it can trace to a spot in the source | Slower; needs review; may not do exactly what was asked |
| In this repo today | Not built | **Already built:** pins + Copy/MCP hand-off |

Direct writes (A) are the main path. Anything A can't trace to an exact spot in the source falls back to B automatically, with no dead end.

### Where direct writes are safe [I]

Direct writes work for:
- a text value in a content JSON file;
- static text written directly in a component's markup (JSX);
- a fixed string or number setting on a component (a literal prop);
- `className` and Tailwind classes, plus inline style literals;
- reordering elements that sit side by side in the same markup;
- inserting or deleting a fixed element;
- tour-step settings written as plain values.

These go to the agent:
- text built from expressions, i18n or computed values;
- items rendered in a loop (`.map`);
- conditional branches;
- settings passed in bulk (`{...props}`) or handed down through several components;
- anything defined only inside a shared library.

## Proposed architecture

### 1. Source tagging (dev only)

Add a Vite plugin to the one `live.mjs` already injects. It tags each element with its file, line and column, for example `data-sp-src="src/scenes/Intro.tsx:42:7"`.
- Run it with `enforce: "pre"` so it sees the original JSX.
- Use `magic-string` and the parser the project already has.
- TanStack Devtools' source inspector uses this same pattern: `data-tsd-source`, injected through oxc + MagicString, dev only [F] ([docs](https://tanstack.com/devtools/latest/docs/source-inspector)).

Do this ourselves rather than read React internals:
- React 19 removed `_debugSource` and the element-level `__source` [F] ([react#28265](https://github.com/facebook/react/pull/28265)).
- That change broke LocatorJS, react-dev-inspector and similar tools [F] ([react#32574](https://github.com/facebook/react/issues/32574)).

**Avoid Onlook's approach.** Onlook writes `data-oid` attributes into the `.tsx` files themselves. Its parser fixtures show this, and its AI prompt forbids removing them [F] ([fixture](https://github.com/onlook-dev/onlook/blob/main/packages/parser/test/data/ids/adds-ids-to-jsx/expected.tsx), [prompt](https://github.com/onlook-dev/onlook/blob/main/packages/ai/src/prompt/constants/system.ts)). That breaks the "no extra code" rule.

**Guard [I].** Add a test that builds a fixture course and fails if `data-sp-` appears anywhere in the output.

### 2. Three ways a save is written

1. **JSON field write.**
   - The courses seem to keep lesson text in JSON already: the README's sync example rebuilds from `content/{name}.json`, and `docs/pin-evidence.md` supports `data-content-id` bindings.
   - Saving changes one field with format-preserving JSON editing (the field's value only, keeping key order and indentation).
   - The existing `sync` rule then rebuilds if needed.
   - This is the easiest and safest kind of edit, and needs no code parsing.
2. **Code edit at the tagged location.**
   - Parse the file, find the node at the tagged line and column, and check it is something we can edit directly (see the list above).
   - Splice only that range with `magic-string`. This keeps the original formatting, unlike reprinting the whole file.
   - Use `recast` only for structural inserts. It reprints only the nodes that changed [F] ([recast](https://github.com/benjamn/recast)).
   - Optionally run the project's own formatter on the changed file.
3. **Agent fallback.**
   - Create a pin of a new kind, "edit request", holding the source location, the before/after values and a screenshot.
   - It reaches the agent through the existing Copy/MCP route.

Every save goes through the server:
- **Pending changes.** Edits collect as a list of pending changes, each shown as a diff, with undo.
- **Hash check.** The file's hash is re-checked before writing, the same way `expectedUpdatedAt` is checked for pins.
- **Hot-reload.** After writing, Vite hot-reloads the course, and the review position is restored.

### 3. Driver.js tour step editor (the hardest UX constraint)

driver.js 1.9.0 can't place a popover at an arbitrary x/y [F] ([config](https://driverjs.com/docs/configuration), [position](https://driverjs.com/docs/popover-position), inspected `driver.js.d.ts`):
- `popover.side`: `top | right | bottom | left`.
- `popover.align`: `start | center | end`.
- A step with no `element` shows a centered popover.
- `popoverOffset`, `stagePadding` and `stageRadius` exist only at the **driver level** (defaults 10, 10, 5), not per step.
- `step.element` takes a selector string, an Element or a function. A string uses the first match.
- `popoverClass` and `onPopoverRender` are available per step.

What this means for the editor [I]:
- **Moving the card.** While the user drags, the card moves freely. On drop it **snaps** to the nearest of the 12 side/align placements, or to "centered" (no element), and saves those plain values. If we kept free x/y, the saved lesson and the preview would disagree.
- **Free positioning, if wanted.** It would need a small, explicit offset feature in the course's own tour wrapper. For example, `data.offset` could be applied in `onPopoverRender`. That is course code, so it is a product decision, not something the editor should add silently.
- **Changing the highlight box.**
  - To highlight a different element, re-pick it with the existing picker and save it as `step.element`. Prefer a stable `[data-tour-id="…"]` selector; point-and-click tour builders (Userpilot, Appcues, Usetiful) warn about fragile generated selectors [F] ([Userpilot](https://docs.userpilot.com/article/173-detecting-and-displaying-the-right-element)).
  - To change padding or radius, either edit the tour-level setting, or give the course's tour wrapper a per-step value applied with `setConfig`.
- **Stepping through the tour.** The player can already detect and step through a tour (`client/src/media.ts`). For the editor to know *which* step is open and where it is defined, the course should expose that to the dev bridge. The best option is to register the tour with the existing `__SCORMPLAYER_REVIEW__` bridge, which only exists in live review. Keeping the same step across a hot-reload already requires a course snapshot adapter ([live-review.md](../live-review.md)).
- **Where steps are defined.** If steps are a literal array in a `.ts` file or a JSON file, all of the above are direct writes. If they are assembled at runtime, these edits go to the agent.

### 4. Dragging in shared components (furthest out)

This needs a **component registry**: names, editable settings (props) and their types, defaults and a thumbnail. Puck and Makeswift work this way [F] ([Puck data](https://puckeditor.com/docs/api-reference/data-model/data), [Makeswift](https://docs.makeswift.com/developer/docs/reference/reactruntime/register-component)).

The registry can be generated from the shared library's TypeScript types, or kept as a small `scormplayer.components.json` in the project; the latter is project metadata, not lesson code.

Dropping a component means inserting the JSX, adding the import, and filling in default props. It works when the drop target is fixed markup in a scene file, and falls back to the agent otherwise.

How the library ships matters:
- **npm package:** tags stop where the scene uses the component.
- **Workspace source:** tags reach inside it, and the editor must stop users from editing the shared component by accident.

## What other editors do

- **Lovable.** Direct inline text edits; element edits and drawings go to AI. Its Oct 7, 2026 changelog says text built from data or translations "takes a little longer" [F] ([visual edit](https://docs.lovable.dev/features/visual-edit), [changelog](https://docs.lovable.dev/changelog)).
- **Vercel v0 Design Mode.** Started with free direct saves; by March 2026, users report that saving uses an AI "Apply" step [F, user reports] ([launch](https://community.vercel.com/t/introducing-design-mode-on-v0/13225), [reports](https://community.vercel.com/t/new-design-mode-why-do-simple-edits-now-require-ai-credits/44083)).
- **Onlook.** Direct code edits plus AI chat, but its ids live in the source files (see above) [F].
- **Cursor, Stagewise.** Agent only: the selection becomes context for the agent [F] ([Stagewise](https://docs.stagewise.io/features/dom-context-selector)).
- **TinaCMS, Storyblok, Puck, Adapt.** The editor only changes data; the code never changes [F] ([Tina](https://tina.io/docs/contextual-editing/tinafield), [Adapt](https://github.com/adaptlearning/adapt_framework/wiki/Content-starts-with-course.json)).

Our proposal: JSON writes like the CMSes, direct code edits for the simple cases, and agent fallback like Cursor and Lovable. It also keeps the property that none of them guarantees: nothing extra in the build.

## Effort [I]

Estimates assume one experienced developer working with an agent.

| Phase | Scope | Rough size |
| --- | --- | --- |
| P0 | Check one real course repo (list below); build a spike of the tagging plugin and the build-output check | 2–3 days |
| P1 | Edit mode, inline text editing (JSON + JSX), pending changes/diff/undo, file-hash check, hot-reload loop, agent fallback | 2–3 weeks |
| P2 | Tour step editor: step list, snap-to-placement drag, re-pick the highlighted element, course tour registration | 1–2 weeks |
| P3 | Properties panel: className/Tailwind, inline style, literal props, side-by-side reorder | 2–3 weeks |
| P4 | Component palette, registry, drag-insert with imports | 3–4 weeks |

Risks:
- Formatting drift when writing code back.
- Some edits trigger a full reload instead of Fast Refresh, losing state unless the course has a snapshot adapter.
- Files changing on disk while an edit is pending.
- The README's promise that "nothing is written inside the course" changes. Edit mode must be opt-in, separate from Pin mode, and clearly labelled.
- Editing a folder still doesn't update a ZIP; repackaging is a separate step.

## Next steps

1. **Check in one course repo:**
   - Where do tour steps live (literal array, JSON, or built at runtime)?
   - Which React and Vite versions does it use?
   - Is lesson text in JSON with `data-content-id`?
   - Are shared components an npm package or workspace source?
   - Is there a tour wrapper we can extend?
2. **P0 spike** in this repo:
   - dev-only tagging plugin in `server/live.mjs`;
   - a fixture course with a driver.js tour;
   - the "no `data-sp-` in build output" test.
3. **Decide:** snap-only tour placement, or a course-side offset option.
4. **Then P1.**
