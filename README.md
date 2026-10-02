# scormplayer

Open any SCORM course in your browser, click through it the way an LMS would, and pin notes
on anything you want changed. Copy all your pins in one go as a tidy hand-off for a teammate or
an AI coding agent.

## Install

Click the copy button on a box, paste it into your terminal, and press Enter.

**1. Install scormplayer**

```sh
npm install -g @jakerains/scormplayer@latest
```

**2. Open a course**

```sh
scormplayer ./my-course.zip
```

Or run `scormplayer` on its own in a folder of courses to pick one, or to get a page where you
can drop a zip.

**3. Optional: let your AI coding agent work through your pins**

```sh
scormplayer skill
```

**Just trying it out?** Run it once without installing anything:

```sh
npx @jakerains/scormplayer@latest ./my-course.zip
```

**Keep it current:**

```sh
scormplayer update
```

Needs [Node.js](https://nodejs.org) 20 or newer, which includes npm. No Node yet? On a Mac, the
installer from [nodejs.org](https://nodejs.org) works, or `brew install node` with Homebrew.
Works on macOS, Windows and Linux.

## What it does

- **Plays SCORM 1.2 and SCORM 2004** zips or unzipped folders. Progress is saved in your
  browser, so a reload picks up where you left off.
- **Pins.** Press <kbd>P</kbd>, click anything in the course (or drag across text), and write
  what should change. Each pin saves the element, its text, the page, a screenshot of the
  element and, when it can find it, the file and line the text came from.
- **Hand-off.** **Copy** puts every open pin on your clipboard as Markdown that an agent can
  act on. `scormplayer pins <course>` prints the same thing in the terminal.
- **Live mode** for courses built with Vite: edit the source and the course updates in the
  player as you save. Pins keep working.
- **Agent-ready.** `scormplayer skill install` (or `npx skills add jakerains/scormplayer`)
  teaches your coding agents how to work through your pins.
- **Leaves your course alone.** Nothing is injected into or written inside the course. Pins
  live in a JSON file next to it.

## The terminal dashboard

Running `scormplayer` opens a live dashboard in your terminal: the course, its address, how far
the course says you've got, the pins as you add them, and a feed of what just happened (pins
saved and resolved, files edited, the course completing).

![The scormplayer terminal dashboard](https://raw.githubusercontent.com/jakerains/scormplayer/main/docs/dashboard.png)

| Key | Does |
| --- | --- |
| <kbd>o</kbd> | Open the player in your browser |
| <kbd>c</kbd> | Copy the open pins as a hand-off for an agent |
| <kbd>p</kbd> | Show the hand-off in the terminal (<kbd>↑</kbd>/<kbd>↓</kbd> to scroll, <kbd>esc</kbd> to go back) |
| <kbd>l</kbd> | Switch to another course: the list comes back, type to filter, <kbd>enter</kbd> to open it (the browser tab follows) |
| <kbd>u</kbd> | Unzip a zipped course to a folder you can edit (shown only for a zip) |
| <kbd>s</kbd> | Install the agent skill, or update it (shown only when it's missing or out of date) |
| <kbd>q</kbd> | Quit, with a summary of what's still open |

Without a real terminal (an agent, CI, a pipe), or with `--plain`, it prints plain timestamped
lines instead. `NO_COLOR` is respected.

## Drop a zip in the browser

Run `scormplayer --drop` (or pick **Empty player** in the course list, or just run `scormplayer`
in a folder with no courses) and the browser opens a drop zone: drag a SCORM zip in, or click
**Choose a SCORM zip**. While a course is playing you can drop another zip anywhere on the
player, or use **More → Open another course…**, to switch. Pins for a dropped zip are saved
next to where you started scormplayer, named after the zip.

## Use

```sh
scormplayer                        # pick from the courses found here: type to filter, ↑↓, enter
scormplayer ./course.zip           # a SCORM zip
scormplayer ./course-folder        # an unzipped SCORM package (imsmanifest.xml inside)
scormplayer ./my-vite-course       # a Vite project: live source with hot reload
scormplayer ./course.zip --port 5000 --no-open
scormplayer ./course.zip --plain   # log lines instead of the dashboard
scormplayer --drop                 # empty player: drop or choose a zip in the browser
```

In the player:

| Do this | How |
| --- | --- |
| Start or stop pinning | **Pin** in the bottom bar, or <kbd>P</kbd> |
| Pin an element | Click it (whatever is highlighted). The expand button in the note box widens the selection. |
| Pin several elements with one note | <kbd>Shift</kbd>-click each one |
| Pin an area | Drag a box, starting anywhere that isn't text (hold <kbd>⌥ Option</kbd> / <kbd>Alt</kbd> to start one on text) |
| Pin a phrase | Drag across the text, starting on it |
| Use the course without leaving pin mode | Hold <kbd>Space</kbd> |
| Save a pin | <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>Enter</kbd> |
| See, edit, resolve or delete pins | **Pins** |
| Check tablet or phone layouts | The screen-size switch in the bar (tablet 1024×768, phone 390×844) |
| See what the course tells the LMS | **More → SCORM inspector**, or <kbd>I</kbd> |
| Move between modules (multi-SCO packages) | The **Module** switcher in the bar |
| Copy open pins for an agent | **Copy** |
| Move between pages | ‹ › in the bar, the page menu, or <kbd>[</kbd> <kbd>]</kbd> |
| Skip narration or a video | **Skip** in the bar, or <kbd>.</kbd> |
| Start the course over | **More → Reset progress** |

### Page navigation and narration

The bottom bar shows the course's pages (‹ 3 / 7 · Page title ›, with a menu of every page;
<kbd>[</kbd> and <kbd>]</kbd> step through them) whenever the course offers a page list. It uses,
best first:

1. a same-origin `window.__SCORM_REVIEW__` bridge (`getScenes()` → `[{ id, title }]`,
   `getCurrentIndex()`, `goToScene(index)`);
2. the **scorm-review handshake**: the player posts `{ type: "scorm-review:host", version: 1 }` to
   the course frame; the course replies with `{ type: "scorm-review:nav", version: 1, pages:
   [{ id, title }], index }` after every move, and jumps when it receives
   `{ type: "scorm-review:goto", version: 1, index }`;
3. the course's own page menu, found by `aria-current="step"` or `"page"`.

While audio or video is playing, **Skip** (or <kbd>.</kbd>) jumps it to the end, so the course
runs its own "finished" logic: a narrated driver.js tour unlocks Next exactly as if you had
waited. While a tour is open the bar also shows its step and Back/Next.

### SCORM inspector

**More → SCORM inspector** (or <kbd>I</kbd>) shows the course's SCORM data as the LMS sees it
(completion, success, score, location, suspend data, interactions) and every API call it makes,
newest first, with a filter, a *writes only* switch and **Copy JSON**. It's the quickest way to
see why a course doesn't complete, score or resume.

### Zips and folders holding several courses

Some exports and hand-made bundles put several SCORM packages in one zip or folder, each with its
own `imsmanifest.xml` (scormplayer looks at the root and up to three folders down). In a terminal
it asks which to open; elsewhere it opens the first and says how to open the others. Pick one
directly with `--package`, by its folder or part of its title:

```sh
scormplayer ./bundle.zip --package lesson-2
```

In the player, **More** lists the courses in the zip to switch between. Each keeps its own pins
(`bundle.lesson-2.pins.json`) and its own progress. Bare `scormplayer` in a folder of course
folders lists each course to pick from.

### Packages with several modules

When a manifest lists several SCOs, a **Module** switcher appears in the bar. Each module keeps
its own SCORM data, as it would in an LMS, and pins remember their module.

### For AI agents in the browser (WebMCP)

In browsers that support [WebMCP](https://github.com/webmachinelearning/webmcp), the player
registers tools an agent can call instead of clicking around: `scormplayer_status`,
`scormplayer_go_to_page`, `scormplayer_switch_module`, `scormplayer_skip_narration`,
`scormplayer_tour_step`, `scormplayer_list_pins`, `scormplayer_add_pin`,
`scormplayer_resolve_pin`, `scormplayer_get_handoff`, `scormplayer_set_screen_size` and
`scormplayer_scorm_data`. In other browsers nothing is registered and nothing changes.

### Where pins are kept

| Course | Pins file |
| --- | --- |
| `course.zip` | `course.pins.json` beside the zip, screenshots in `course.pins-frames/` |
| `course/` folder | `course.pins.json` beside the folder |
| Live project | `.scormplayer/pins.json` inside the project (add `.scormplayer/` to `.gitignore`) |

Use `--pins <file>` to keep them somewhere else.

### Editing a zipped course

A zip is read-only: scormplayer plays it from a copy in its cache, so neither you nor an agent
can edit it there. When you open one, the player says so and offers **Unzip to edit…**: it
copies the course into a folder (beside the zip by default, named after it; you can choose
another), reopens the player on that folder, and moves your pins along. The zip itself isn't
changed. Open the same zip later and the player offers to switch to that folder instead.

The same from the terminal: press <kbd>u</kbd> in the dashboard, or run

```sh
scormplayer unzip ./my-course.zip                  # → ./my-course/, pins move to my-course.pins.json
scormplayer unzip ./my-course.zip --to ~/edits/my-course
```

The folder keeps the zip's layout exactly, so the file and line each pin points at stay right.

### Hand pins to an agent

```sh
scormplayer pins ./course.zip            # open pins as Markdown
scormplayer pins ./course.zip --all      # include resolved pins
scormplayer pins ./course.zip --resolve 3 --note "Shortened the heading"
```

An agent can read the hand-off, make the changes, and resolve each pin with the last command.
The player picks up the change within a few seconds.

### Agent mode (`--json`)

Every command has two outputs: the one above for people, and `--json` for agents and scripts.
With `--json` scormplayer prints only JSON on stdout: no colours, prompts, tips or update
notices. Errors print `{"ok": false, "error": "…", "code": "…"}` and exit 1.

| Command | Prints |
| --- | --- |
| `scormplayer pins <course> --json` | `{ ok, course, pinsFile, counts, pins }`; each pin includes its screenshot's full path |
| `scormplayer pins <course> --resolve 3 --note "…" --json` | `{ ok, resolved, counts }` |
| `scormplayer unzip <zip> --json` | `{ ok, folder, pinsFile, reused, movedPins }` |
| `scormplayer <course> --json --no-open` | One event per line: `ready` (with `url`, `pid`, `pinsFile`, and `course.editable`, which is false for a zip), then `pin`, `progress`, `source`, `browser`, `course`, `unzipped`, `log`, and `stopped` (with a `reason`) on exit. If the course is already open, `ready` has `reused: true` and the command exits |
| `scormplayer update --check --json` | `{ ok, current, latest, updateAvailable, method }` |
| `scormplayer ps --json` | `{ ok, players }`: each with `port`, `pid`, `url`, `title`, `mode`, `idleSeconds` |
| `scormplayer stop <port> --json` | `{ ok, stopped, failed }` |
| `scormplayer cache --json`, `scormplayer skill status --json` | `{ ok, … }` |

An agent can start the player in the background with `--port 0`, read the URL from the first
line, and watch pins arrive as the reviewer leaves them.

### Project settings

A `scormplayer.config.json` in the course folder or any folder above it can tell scormplayer
where a project's courses are, where their pins go, and what to run when files change while a
course is open. `{name}` is the course's folder or zip name; paths are relative to the config.

```json
{
  "courses": ["lessons/*"],
  "pins": ".local/pins/{name}.pins.json",
  "sync": [
    { "files": ["content/{name}.json"], "run": "npm run build-content -- {name}" }
  ]
}
```

With it, a bare `scormplayer` lists exactly those courses (from the project or a folder above
it), pins stay out of the course folders, and generated files stay current while you review.
Sync results appear in the dashboard's activity feed.

### Teach your coding agents

scormplayer comes with an agent skill that tells coding agents how to read pins, find the
source, make only the requested change, and resolve the pin. Install it with the open
[`skills`](https://github.com/vercel-labs/skills) CLI, which lets you pick your agents (Claude
Code, Codex, Cursor, Gemini CLI, GitHub Copilot and many more), project or global scope, and
symlink or copy:

```sh
scormplayer skill install        # same as: npx skills add jakerains/scormplayer
```

You don't need scormplayer installed to add the skill: `npx skills add jakerains/scormplayer`
works on its own. Flags pass through: `-g` for all projects, `-a claude-code -a codex` to choose
agents, `-y` to skip prompts, `--copy` to copy instead of symlink. `--local` installs the copy
bundled with your installed version instead of the GitHub one. `npx skills update` keeps it
current, and `scormplayer skill remove` removes it. Nothing is installed automatically.

`scormplayer skill` on its own does whatever is needed: installs the skill if no agent has it,
updates it if it's behind your scormplayer, and otherwise says it's current. Each release stamps
the skill with its version, and every time scormplayer starts it compares the installed copy with
the one it ships with, so the two don't drift apart after an upgrade (`scormplayer update`
refreshes both). When the skill is missing or out of date, the dashboard shows an <kbd>s</kbd> key
that installs or updates it, and the player's **Pins** panel shows the command.
`scormplayer skill status` (or `--json`) says which version is installed.

### Live mode

Point `scormplayer` at a Vite project (a folder with a `vite.config.*` and an `index.html`). It
starts the project's **own** Vite inside the player, so your plugins and config apply unchanged,
and serves the course from source with hot reload. Install the project's dependencies first.
Use `--live` to force live mode for a folder that also has an `imsmanifest.xml`.

### Pin targets

The player chooses what a click selects from the page's own structure: buttons, links, images,
headings, paragraphs, list items, and elements with an `aria-label` or `data-testid`. If a course
already uses ChatGPT's browser annotation attributes (`oai-annotation-container`,
`oai-annotatable`, `oai-annotation-metadata`), they are respected too. You never need to add
anything to a course for pins to work.

## How it works

`scormplayer` runs a small local server (127.0.0.1 by default) that serves the course and the
player page from the same origin. The player installs `window.API` (SCORM 1.2) and
`window.API_1484_11` (SCORM 2004) for the course to find, as an LMS would. The API is forgiving:
it records what the course sends rather than enforcing the full specification. It's a review
tool, not a conformance test.

### Use it from your own scripts

```js
import { startPlayer, createDashboard } from "@jakerains/scormplayer";

const player = await startPlayer({ input: "./course.zip", cacheDir: "/tmp/scormplayer" });
createDashboard({ version: "1.0.0", entries: [{ id: "course", player }], onQuit: () => player.close() });
```

Pass several players to `createDashboard` to watch several courses in one screen.

### Running players

Each course opens in one player. Run `scormplayer` on a course that's already open and it opens
that player again rather than starting another (`--new` starts another anyway).

```sh
scormplayer ps                 # what's running: port, course, when a browser last looked
scormplayer stop 4621          # stop one (by port or process id)
scormplayer stop --all         # stop them all
```

Players use ports 4620–4639, 20 at most. One started in the background (by an agent, a script
or CI, with no terminal) closes itself when it's been left behind:

- no browser has it open for 30 minutes;
- it's open in a tab nobody has touched for 30 minutes: the page asks **Still there?** and closes
  the player if nobody answers within 2 minutes (the tab then says how to reopen it);
- the program that started it exits.

`--idle <minutes>` changes the 30 minutes and `--idle 0` turns all of this off. A dashboard in
your terminal runs until you quit it. If all 20 ports are ever taken, scormplayer says which
players hold them.

### Cache and updates

Opened zips are unpacked into a cache (`~/.cache/scormplayer`, or `%LOCALAPPDATA%\scormplayer\Cache` on
Windows). It keeps itself small: the 20 most recently used courses, nothing unused for 14 days.
`scormplayer cache` shows its size and `scormplayer cache clear` empties it.

The dashboard, and **More** in the player, tell you when a newer scormplayer is published
(checked at most once a day). `scormplayer update` installs it and refreshes the agent skill
wherever it's installed; `scormplayer update --check` only says whether there is one.

It updates with whatever installed scormplayer: npm, or pnpm, yarn or bun if you used one
(falling back to npm if that tool has since gone). If your Node came from the nodejs.org
installer on a Mac, npm needs admin rights for global packages, so the update runs with `sudo`
and asks for your password. Running through `npx …@latest` always gets the newest version, so
there's nothing to update. Set `SCORMPLAYER_NO_UPDATE_CHECK=1` to turn the check off.

## Develop

```sh
npm install
npm run build        # builds the player UI into dist/client
npm test
npx playwright install chromium && npm run test:e2e   # browser tests of the player page
node bin/scormplayer.mjs ./some-course.zip
```

Releases publish to npm from GitHub Actions when a `v*` tag is pushed (see
`.github/workflows/release.yml`).

## License

MIT
