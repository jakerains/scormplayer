# Pin evidence and verification

Pins retain the selected element's selector, tag, raw `textContent`, rendered text, CSS
`text-transform`, identifying attributes, ancestor identities, viewport and scroll position.
A tagged child remains selectable inside a labeled header. If picking promotes a click to a
larger element, `target.clicked` preserves the original child. Screenshots remain saved
capture-time evidence. Old pins still load; re-pin an element to collect missing evidence.

## Source confidence

`source` contains independent evidence, never an instruction to edit the first result:

- `text-match` / `candidate`: text occurs in that file. Every occurrence is listed up to the
  search limit, including minified and hashed bundles. `offset`, `endOffset` (exclusive) and
  one-based `column` use JavaScript UTF-16 code units; `line` is one-based. A nearby preview
  helps distinguish duplicate strings. A shorter fallback needle is reported in `matchedText`.
- `content-binding` / `declared-hash-checked`: the course author explicitly mapped an element
  attribute to a JSON field, the declared artifact hashes agree with disk, and the field agrees
  with the captured raw text. This is a declaration checked at capture, not recovered data flow.
  An ancestor's ID alone is never promoted into the child's binding.

`imsmanifest.xml` is excluded from visible-copy matching. The search scans up to 4,000 files,
2 MiB per file and 64 MiB total, returning at most 100 results. `sourceSearch.truncated` reports
scan/result limits or a failed/timed-out worker. Dependency, cache and hidden directories are
excluded intentionally. Source and generated output are both searchable; authored matches rank
first among returned candidates. Repeated strings do not prove shared ownership.

## Optional content manifest

A cooperating course may supply `scormplayer.sources.json` in its root:

```json
{
  "version": 1,
  "entry": "index.html",
  "artifacts": {
    "index.html": "<sha256 of index.html>",
    "assets/course.js": "<sha256 of the rendering bundle>",
    "copy.json": "<sha256 of copy.json>"
  },
  "bindings": [
    {
      "attribute": "data-content-id",
      "value": "lesson.title",
      "file": "copy.json",
      "pointer": "/lessons/m01-l00/title",
      "consumers": ["lesson header", "lesson heading", "screen-reader label"]
    }
  ]
}
```

Generate this mapping as part of the authoring build. Include the entry and every artifact
that controls these bindings, plus the content file. The author is responsible for complete
artifact coverage and correct declarations. The player validates every listed digest; it cannot
prove that omitted artifacts are irrelevant. Any mismatch invalidates every binding. If the captured identities map to more than one field,
the player reports an ambiguous mapping and falls back to candidates. Rebuild
this manifest after edits. Paths must resolve inside the course, including symlink resolution.
The manifest is limited to 256 KiB, 256 artifacts (2 MiB each, 32 MiB total), and 500 bindings.

Supported binding attributes are `data-content-id`, `data-content-component-id` and
`data-tour-id`. JSON pointers use RFC 6901 escaping. Consumers are author-declared descriptions,
not a runtime-wide dependency analysis. There is no mandatory framework dependency or learner
runtime injection. A course must actually consume the mapped JSON; placing an unused copy
file beside a bundle does not make the bundle editable. Arbitrary third-party ZIPs continue to
work with DOM evidence and search candidates. Exact fields cannot be reconstructed reliably
from a selector and minified strings alone.

## MCP browser observations

The normal player page connects to its local server using same-origin HTTP and Server-Sent
Events. No localhost certificate, embedded extension, cloud callback or host-specific browser
API is required. This bridge uses the currently open course instance, including its page and
learner state, rather than launching a second browser.

- `scormplayer_list_browser_sessions(playerId, revision)` lists connected tabs and readiness.
- `scormplayer_verify_pin(playerId, revision, id, sessionId?)` observes the current target without
  navigating, reloading, editing or resolving. Multiple connected tabs require a session ID.
- `scormplayer_reload(playerId, revision, sessionId?)` flushes progress and requests a frame reload.
  Review position is restored where the course supports it. The result is `reload-requested`;
  wait for readiness, then verify. Reload never resets progress.

Verification reports raw/rendered text, attributes, CSS casing and observation time. Unique
identity, page/SCO/SCORM location and course revision are checked. Missing/ambiguous selectors,
changed identity, wrong page, pending load and unavailable tabs are explicit outcomes. A
structural selector or repeated ID yields `identity-unconfirmed`, even if a node matches.
Area pins require visual review. Same-content-ID peers are observations on the current page
only, not proof that every peer consumes the same field or a complete list of other uses.

A DOM observation is evidence to compare against the request, not an automatic acceptance
result. Layout, animation, images and accessibility still require appropriate inspection.
Saved source hints and screenshots are historical. Editing a folder does not update the
original ZIP; the course's existing packaging workflow must produce the upload artifact.
