# scormplayer

Open any SCORM course in your browser, click through it the way an LMS would, and pin notes
on anything you want changed. Copy all your pins in one go as a tidy hand-off for a teammate or
an AI coding agent.

```sh
npx @jakerains/scormplayer@latest ./my-course.zip
```

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

## Install

Run it once without installing:

```sh
npx @jakerains/scormplayer@latest ./my-course.zip
```

Or install the `scormplayer` command:

```sh
npm install -g @jakerains/scormplayer@latest
scormplayer ./my-course.zip
```

Needs Node.js 20.19 or newer.

## Use

```sh
scormplayer ./course.zip           # a SCORM zip
scormplayer ./course-folder        # an unzipped SCORM package (imsmanifest.xml inside)
scormplayer ./my-vite-course       # a Vite project: live source with hot reload
scormplayer ./course.zip --port 5000 --no-open
```

In the player:

| Do this | How |
| --- | --- |
| Start or stop pinning | **Pin** in the bottom bar, or <kbd>P</kbd> |
| Pin an element | Click it. The expand button in the note box widens the selection. |
| Pin a phrase | Drag across the text |
| Use the course without leaving pin mode | Hold <kbd>Space</kbd> |
| Save a pin | <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + <kbd>Enter</kbd> |
| See, resolve or delete pins | **Pins** |
| Copy open pins for an agent | **Copy** |
| Start the course over | **More → Reset progress** |

### Where pins are kept

| Course | Pins file |
| --- | --- |
| `course.zip` | `course.pins.json` beside the zip, screenshots in `course.pins-frames/` |
| `course/` folder | `course.pins.json` beside the folder |
| Live project | `.scormplayer/pins.json` inside the project (add `.scormplayer/` to `.gitignore`) |

Use `--pins <file>` to keep them somewhere else.

### Hand pins to an agent

```sh
scormplayer pins ./course.zip            # open pins as Markdown
scormplayer pins ./course.zip --json     # the raw records
scormplayer pins ./course.zip --all      # include resolved pins
scormplayer pins ./course.zip --resolve 3 --note "Shortened the heading"
```

An agent can read the hand-off, make the changes, and resolve each pin with the last command.
The player picks up the change within a few seconds.

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

## Develop

```sh
npm install
npm run build        # builds the player UI into dist/client
npm test
node bin/scormplayer.mjs ./some-course.zip
```

Releases publish to npm from GitHub Actions when a `v*` tag is pushed (see
`.github/workflows/release.yml`).

## License

MIT
