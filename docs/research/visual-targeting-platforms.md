# Accurate visual targeting for SCORM Player

Research checked October 8, 2026, using Firecrawl searches and primary documentation. Published package inspection is identified separately. These findings concern targeting and source provenance, not SCORM conformance.

## Recommendation

Use a hybrid: preserve a precise DOM target and visual evidence for every course; enrich it with verified source locations when available; use explicit content bindings for exact field edits; and verify changes through the same running browser session. A locator, a rendering-code location, and a content-field binding are three separate pieces of evidence. The following implementation recommendations are our inference from the researched systems, not features already shipped in SCORM Player.

## What ChatGPT documents

OpenAI's current browser documentation describes element and area annotations, plus an Adjust control for previewing text, font, spacing and color changes before sending feedback. Its workflow ends with reviewing the rendered page again. This establishes visual targeting and a browser verification loop; it does not document a deterministic DOM-to-source or DOM-to-content-field algorithm. The older Codex browser documentation URL currently redirects to this ChatGPT documentation. [Browser annotations and styling feedback](https://learn.chatgpt.com/docs/browser).

The older Canvas help article linked from search returned 404 during this research. We did not use it to infer annotation internals. Likewise, the `oai-annotatable` and `oai-annotation-metadata` handling visible in our own picker is evidence about our adapter, not proof of ChatGPT's private implementation.

## What Cursor documents

Cursor Design Mode combines runtime identity with a visual snapshot. Its current documentation explicitly lists XPath, component identity, attributes, computed styles and React fiber props, plus a screenshot showing layout and page state. Users can select individual or multiple elements; drawings refer to a frozen viewport frame. These are documented inputs to the agent, rather than evidence that a CSS selector alone proves a source binding. [Design Mode documentation](https://cursor.com/docs/agent/design-mode#what-the-agent-sees), [official engineering/product explanation](https://cursor.com/blog/design-mode).

The visual editor also exposes component props for testing variants and lets users preview DOM rearrangement before asking the agent to update source. That separates the visible experiment from persisting code. Cursor's description says the agent locates the relevant components; it does not publish a deterministic algorithm proving which upstream content field feeds every rendered string. [Visual editor announcement](https://cursor.com/blog/browser-visual-editor).

Cursor has a browser verification loop: navigation/refresh, clicks, screenshots, console output and network traffic. The browser is a native secure webview controlled through an MCP server, with authentication and tab isolation. This is a useful architecture example for delivering browser evidence to an agent, but those native capabilities do not establish that an unrelated MCP client, such as Cowork, has the same browser tools. [Browser tools documentation](https://cursor.com/docs/agent/tools/browser).

**Boundary:** public Cursor documentation verifies rich selection context and browser tools. Its private implementation, completeness on non-React sites, and guarantees for arbitrary minified production ZIPs were not verified. Source availability should be treated as a capability, not assumed from the existence of a screenshot or fiber props.

## What Lovable documents and ships

Lovable's March 13, 2025 engineering article describes compile-time JSX tagging through a custom Vite plugin, a complete project source copy, source ASTs synchronized into the browser, precise AST changes, and Vite HMR after saving. This is materially different from locating the first equal string in built JavaScript. The platform controls both the development build and editable source. [How we built Visual Edits](https://lovable.dev/blog/visual-edits).

That architecture description is historical. The current preview-toolbar documentation says the toolbar replaces Visual Edits. Selected elements attach as references to chat; inline text changes apply after sending; comments remain attached to the pinned element; drawings attach annotated screenshots. It does not promise that every operation uses the 2025 implementation unchanged. [Current preview toolbar](https://docs.lovable.dev/features/preview-toolbar).

An important date correction: older third-party tutorials say dynamic text cannot be edited directly. The October 7, 2026 official changelog says simple inline edits became faster, while text assembled from data or translations takes longer. Therefore dynamic text is not documented as categorically unsupported today. [October 7 changelog](https://docs.lovable.dev/changelog#faster-inline-text-edits).

We inspected the published `lovable-tagger@1.3.5` artifact without installing or executing it. Its actual implementation wraps `react/jsx-dev-runtime`. On rendered nodes it writes `Symbol.for("__jsxSource__")` metadata containing filename, line, column and display name. It also registers weak DOM references in `window.sourceElementMap`, keyed by source location; a location can map to several rendered nodes. The `jsxSource` feature defaults to enabled when `LOVABLE_DEV_SERVER` is `true`, and can be explicitly configured. Server rendering bypasses tagging. [Published package](https://www.npmjs.com/package/lovable-tagger), [exact inspected archive](https://registry.npmjs.org/lovable-tagger/-/lovable-tagger-1.3.5.tgz).

This proves a versioned runtime source-location channel exists. It also shows why collecting only `data-*` attributes is insufficient: the npm README describes attributes, but this artifact uses symbol metadata. The source map's multiple-node sets can reveal repeated rendering from a JSX location; they do not prove which data field supplies text. Nothing inspected promises this metadata survives a normal optimized production build.

## Open-source approaches worth learning from

**React Grab / element-source:** React Grab's architecture describes DOM-to-fiber lookup, owner-stack extraction and source-map symbolication. It keeps the nearest source location separate from choosing a readable component name, preserves semantic selector fallbacks, and invalidates cached source context as fibers or development metadata change. These are useful design rules for avoiding the wrong ancestor or a stale file hint. The document also explains coupling to React internals; that makes this optional enrichment rather than a universal guarantee for packaged courses. `element-source` exposes source and component-stack resolvers for several frameworks. [React Grab architecture, inspected commit](https://github.com/aidenybai/react-grab/blob/ea4bbec9e80f4802e8ae19ad18431edb9ddbb670/packages/react-grab/docs/architecture.md#notes-about-source-resolution), [element-source API](https://github.com/aidenybai/element-source).

**Agentation:** its integration API lets hosts choose identifying attributes, emits structured annotations and supports same-origin frames and open shadow roots. Its source-opening action is hidden when a trustworthy source reference is unavailable; development metadata is best effort. This is a good precedent for useful evidence without pretending every selection has exact source. [Integration documentation](https://github.com/benjitaylor/agentation/blob/HEAD/package/README.md), [capabilities](https://github.com/benjitaylor/agentation).

**Domscribe:** its documented architecture assigns AST-based element IDs during the build, writes an ID-to-source manifest, and connects browser runtime queries to MCP through a local relay. It can query rendered DOM by source location. Its normal production build strips the instrumentation, so installing its MCP alone would not make an arbitrary exported SCORM ZIP source-aware. This is the strongest architectural precedent for our proposed source manifest and host-independent verification bridge, not a claim that we have tested or should adopt its whole implementation. [Architecture and runtime-query tools](https://github.com/patchorbit/domscribe#how-it-works).

Ordinary JavaScript source maps connect generated code positions to authored code positions. They do not by themselves tell us which JSON field supplies a rendered title; obtaining a runtime code position and establishing a content binding remain separate work. The latter distinction is our inference from the source-map and instrumentation models. [Chrome source-map documentation](https://developer.chrome.com/docs/devtools/javascript/source-maps).

## Proposed SCORM Player implementation

The shared lesson is to collect several independent signals and distinguish their authority:

1. **Capture complete, bounded evidence.** Preserve the clicked element separately from any selected group or larger ancestor. Collect its own and ancestor `data-content-id`, `data-content-component-id` and `data-tour-id` values without flattening their ownership. Add raw `textContent`, rendered text, computed text transform, relevant accessible labels, page/SCO, frame path, viewport, scroll and screenshot. Prefer unique authored IDs and domain attributes, with scoped structural selectors as fallbacks. A repeated content ID is not a unique DOM instance. Collect only the relevant evidence rather than dumping every prop or attribute.
2. **Resolve source with explicit provenance.** Keep separate records for an exact content-field binding, a verified renderer location, and a text-match candidate. For Live mode, evaluate an optional framework resolver such as element-source before implementing React-internal introspection ourselves. For cooperating builds, consume a versioned manifest that maps stable element/content IDs to source and JSON pointers. Validate it against the current build. Show all bounded text occurrences with offsets and nearby context; report truncation. Manifest titles can be package metadata, but must not become the primary source of visible body text solely because the strings match.
3. **Describe known edit impact.** A binding can identify `lesson.title` and its known heading/header/accessibility consumers. Runtime inspection can list other currently rendered consumers. Label the difference: uses visible on one page are not a complete list of uses throughout the course. A source-location-to-elements map also does not establish shared data ownership.
4. **Verify through the existing player browser.** Propose `scormplayer_verify_pin` backed by a bounded browser-to-player-server request/response channel. Read the current DOM text, relevant attributes/styles and observation time from the intended tab, with course/build revision and target identity checks. If multiple tabs are ambiguous, the browser is unavailable, the page differs, or the target changed, report that state instead of silently adopting another element. Reload should be a separate explicit operation, preserving review position and learner progress where supported. The MCP can expose these operations to Cowork, Cursor, Codex or other hosts without requiring their proprietary browser API. A returned text observation is evidence for the agent to compare with the request, not an automatic assertion that every visual requirement passed.

Keep the pin widget compact. Rich evidence belongs in the MCP response and handoff; users should still see the pin note, selection checkbox and send action, with a short source-confidence indicator only when useful.

For an arbitrary packaged ZIP without source metadata, neither researched platform establishes a general solution that reconstructs exact data bindings. The honest fallback is rich DOM evidence plus all bounded search candidates, followed by verification; the stronger solution is optional build-time bindings shipped with cooperating courses. Shared-field impact must come from those bindings or verified analysis, not an assumption that matching text means shared ownership.

## Packaged-course boundary

Source-aware review must not require changing learner behavior or add host-specific APIs to a SCORM lesson. Optional build mappings should be inert review metadata, or supplied as a companion artifact tied to the ZIP digest. Original source files named by a source map must actually be available before the agent is told they are editable.

A structured copy JSON file is helpful only when the course reads it at runtime or its build consumes it. Shipping an unused JSON next to a bundle would not make copy editable. Repackaging an edited folder is a separate useful follow-up: generate a new ZIP, validate its manifest/resources, report its digest and keep the original artifact. Do not conflate successful folder preview with an updated upload ZIP.

## Acceptance cases before claiming accuracy

- Four identical strings: identify the verified binding, or return all candidate occurrences with an ambiguity warning.
- CSS-uppercase text: preserve raw and rendered forms and resolve using the raw value.
- Tagged text inside a labeled header: preserve the child and ancestor identities separately.
- Shared lesson title: show known other consumers before editing; do not infer sharing from equal text.
- Repeated components: retain both the shared source location and the distinct rendered instance.
- Reload/HMR: reacquire the target and source context; reject stale build mappings.
- Minified third-party ZIP without maps: provide honest fallback evidence and no fabricated exact source.
- Cowork without browser tools: verify against the same locally open player through ordinary MCP.
- Several tabs/SCOs: require an unambiguous observation and avoid changing unrelated review or learner state.
- Edited folder vs upload ZIP: prove the newly packaged artifact contains the edited files.

This report records the research stage. The subsequent implementation and its limits are documented in [Pin evidence and verification](../pin-evidence.md).
