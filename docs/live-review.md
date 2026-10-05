# Keeping a live review in place

In live Vite mode, scormplayer injects `window.__SCORMPLAYER_REVIEW__` before course
scripts run. Version 1 retains a view in `sessionStorage`, independently of SCORM
progress, keyed by course, SCO and launch URL in the current browser tab. It survives
Vite HMR, Vite full reload, **Reload course**, and a reload of the player page.
**Reset progress** clears this view and restarts the course. Packaged courses receive
neither the injected bridge nor the review skip menu.

The player saves the current course URL and document scroll. It also retains scroll
containers, focus and native `<details>` with a unique `id` or `data-review-key`.
Restoration retries for up to three seconds to allow rendering to settle, stops on
reviewer interaction, and avoids taking focus from player controls or notes. Missing
targets are ignored. It does not replay clicks, restore form values, start media,
or write learner completion, score or suspend data. Native DOM restoration is best
effort; arbitrary React page, guide and practice state requires a course adapter.
Blocked/full session storage permits only in-document HMR retention, not full reload
retention. Browser tab duplication may copy the starting session snapshot, after
which the tabs retain their views independently.

## Snapshot adapter

The injected API has this contract (the bridge is absent outside live review):

```ts
type LiveReview = {
  version: 1;
  read<T>(id: string, version: number): T | undefined;
  register<T>(adapter: {
    id: string;
    version: number;
    capture(): T;
    restore(snapshot: T): void;
  }): () => void;
  checkpoint(): void;
  ready(): void;
  registerNavigation(adapter: {
    nextPage?(): boolean | Promise<boolean>;
    nextGuideStep?(): boolean | Promise<boolean>;
  }): () => void;
};
```

Use a stable adapter ID and increment its version when the snapshot shape becomes
incompatible. Snapshots must be JSON-safe; the combined view is capped at 256,000
characters. Each adapter is isolated from capture/restore errors in other adapters.
`read` returns a copy only for a matching version. Validate page/step IDs against the
current content and discard removed or invalid selections in course code.

Seed React state from `read` in its initializer, **before guide/media startup effects**,
so a dismissed guide does not start again during the initial render. For example:

```tsx
const review = window.__SCORMPLAYER_REVIEW__;
const [view, setView] = useState(() =>
  validateReviewView(review?.read("lesson-view", 1)) ?? initialReviewView
);
const latest = useRef(view);
useLayoutEffect(() => { latest.current = view; }, [view]);
useLayoutEffect(() => review?.register({
  id: "lesson-view",
  version: 1,
  capture: () => latest.current,
  restore: (saved) => {
    const valid = validateReviewView(saved);
    if (valid) setView(valid);
  },
}), [review]);
```

Capture only transient, safe review state: selected page, carousel index, dismissed
introduction, guide step/time and retained local practice inputs where appropriate.
Restoration must not call a provider, replay a tool action, submit an answer, satisfy
a required activity, autoplay narration, or write to the LMS. An activity's learner
completion remains separate from the selected review page or guide step.

`checkpoint()` records the committed view immediately. Call it after a meaningful
state change when no DOM event accompanies that change. The player checkpoints before
its explicit reloads and review skips; Vite hooks capture before updates/full reload.
For delayed/asynchronous mounts, call `ready()` once the restored state has committed
to retry native DOM restoration. It does not restore adapter state itself. Registration
returns a disposer; replacing an adapter of the same ID keeps the newest registration.

The player never replaces or clears Academy's parent-window
`__academyLiveReviewMemory`. That RAM-only helper can coexist with this adapter, but
a player-page reload requires the course to seed state from `read` to survive loss of
parent RAM. This repository does not install an Academy adapter.

## Explicit navigation for reviewers

Live reviewers can use **More → Skip to next guide step for review** or
**More → Skip to next page for review**. The course opts in separately:

```ts
const dispose = window.__SCORMPLAYER_REVIEW__?.registerNavigation({
  nextPage: () => moveReviewPageWithoutCompletingActivity(),
  nextGuideStep: () => moveReviewGuideWithoutPerformingRequiredCall(),
});
```

Return `true` only after moving to a valid next review location; return `false` at the
end, for an unavailable guide, or when the move is unsupported. Async functions must
resolve once the state change can commit. The player waits two animation frames and
checkpoints the new view, so a skip persists through source updates when the snapshot
adapter captures that state. These hooks must change review selection directly and
must not route through a gated learner Continue handler, fake call results, mark an
activity complete, award a score, unlock content, or modify SCORM suspend data.

Without a registered hook the player reports an unsupported skip. It never tries
arbitrary button clicks or narration tricks to bypass an activity. The existing page
navigation and narration controls continue to use their existing behavior; these
explicit review skips are separate controls.

Validation uses isolated live fixtures at desktop and tablet sizes, including real
Vite HMR/full reload, course/player reload, native state, safe skips, untouched gates,
tab/course/SCO isolation and explicit reset. These checks do not establish LMS
conformance or installation into an already running globally installed player.
