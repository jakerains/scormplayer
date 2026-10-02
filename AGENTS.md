# Repository Guidelines

## Project Structure & Module Organization

- `bin/scormplayer.mjs`: CLI entry point.
- `server/*.mjs`: Express server, course resolution, live Vite integration, pins, cache, and terminal dashboard.
- `client/src/`: React/TypeScript player, SCORM APIs, controls, and `styles.css`; `client/index.html` is the UI entry.
- `tests/`: server/CLI tests, browser tests, and generated course/media fixtures in `fixtures.mjs`.
- `skills/scormplayer/`: bundled agent guide; `scripts/` maintains its version.
- `dist/client/`: generated UI; do not edit or commit it.

## Build, Test, and Development Commands

Use Node.js 20+ and npm.

- `npm ci`: install locked dependencies.
- `npm run build`: build the player UI.
- `npm start -- /path/to/course.zip`: run the local CLI after building.
- `npm run typecheck`: check strict TypeScript.
- `npm test`: run server/CLI tests.
- `npx playwright install chromium`: install Chromium for browser tests.
- `npm run test:e2e`: run browser tests sequentially; build first.
- `npm run check`: run typecheck, build, and server tests.

## Coding Style & Naming Conventions

Follow existing two-space indentation, double quotes, semicolons, and LF endings. Use ES modules: `.mjs` for Node, `.ts`/`.tsx` for client code. Name React component files in PascalCase, utilities in lowercase or kebab-case, and functions/variables in camelCase. No formatter or linter is configured; match nearby code.

## Testing Guidelines

Tests use `node:test` and `node:assert/strict`; browser tests use Playwright Chromium against real servers. Put regressions in `tests/server.test.mjs` or `tests/e2e.test.mjs` with descriptive behavior names. Reuse fixtures and isolate temporary files. No numerical coverage threshold is configured. Check SCORM 1.2/2004 behavior where relevant. For lesson layouts, focus on desktop, tablet (1024×768), and larger screens.

## Commit & Pull Request Guidelines

History uses descriptive subjects and `release: vX.Y.Z — …` for releases; Conventional Commits are not mandatory. Keep commits focused. PRs should explain the problem, resulting behavior, validation, and related issues; include screenshots for UI changes. Run `npm run check`, plus browser tests for UI changes. CI checks Linux, macOS, and Windows.

## Review & Agent Boundaries

Preserve unrelated uncommitted changes. Keep pins and screenshots out of Git. Treat `[Claude handoff]` as collaborator input, verify material claims, and do not infer owner approval. Distinguish local review from LMS conformance or publication evidence.
