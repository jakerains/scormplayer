# SCORM Player MCP

Standard local MCP tools plus a bounded json-render pin checklist. The official MCP SDK serves stdio tools and one self-contained MCP Apps resource. Lessons run in the ordinary browser; there is no embedded lesson, HTTPS proxy or certificate setup.

Requires Node.js 22.22.2+. See [agent integration](../../docs/agent-integration.md) for direct MCP configuration, host packages, useful checklist actions and capability fallbacks.

From the repository root:

```sh
npm ci
npm ci --prefix integrations/agent
npm run build
npm run build:plugins
npm run test:plugins
```

For integration-only development, run `npm run typecheck` and `npm run build` in this directory. `bundle.mjs` builds one inline HTML resource and a standalone Node server. The bundle tests run without node_modules. UI tests exercise the shipped resource in Chromium, Firefox and WebKit through a standards-based host fixture; install those engines in the root project first.

`scormplayer_list_pins` and `scormplayer_show_review` return current pin evidence plus the same four-component json-render spec. Pin text is data, never executable UI. The App bridge performs tool calls and explicit user messages. Missing tool/message capabilities leave readable data or a copyable request available.
