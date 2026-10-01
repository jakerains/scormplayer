/**
 * WebMCP (https://github.com/webmachinelearning/webmcp): the player's actions as tools an AI agent
 * in the browser can call directly, instead of clicking through the page. Registered only where
 * the browser provides `document.modelContext` (or the older `navigator.modelContext`); elsewhere
 * nothing happens. Each tool runs the same code as the matching button, so the page stays in step.
 */

export type PlayerActions = {
  status: () => unknown;
  goToPage: (page: number | string) => Promise<unknown>;
  switchModule: (module: number | string) => unknown;
  skip: () => unknown;
  tourStep: (direction: "next" | "back") => unknown;
  listPins: (status: "open" | "resolved" | "all") => unknown;
  addPin: (input: { note: string; selector?: string; text?: string }) => Promise<unknown>;
  resolvePin: (number: number, note?: string) => Promise<unknown>;
  handOff: () => Promise<string>;
  unzip: (folder?: string) => Promise<string>;
  setScreen: (size: "desktop" | "tablet" | "phone") => unknown;
  scormData: (includeCalls: boolean) => unknown;
};

type Tool = {
  name: string;
  description: string;
  inputSchema: object;
  annotations?: { readOnlyHint?: boolean };
  execute: (input: any) => Promise<unknown> | unknown;
};

export function registerWebMcpTools(actions: () => PlayerActions): () => void {
  const context = (document as any).modelContext ?? (navigator as any).modelContext;
  if (!context || typeof context.registerTool !== "function") return () => {};

  const result = (value: unknown) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
  const tool = (definition: Tool): Tool => ({
    ...definition,
    async execute(input: any) {
      try {
        return result(await definition.execute(input ?? {}));
      } catch (error) {
        return { isError: true, ...result(error instanceof Error ? error.message : String(error)) };
      }
    },
  });

  const tools: Tool[] = [
    tool({
      name: "scormplayer_status",
      description: "What is open in the SCORM player: the course, its SCORM version, the current module and page, any open guided tour, the course's SCORM progress, and how many pins are open.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      execute: () => actions().status(),
    }),
    tool({
      name: "scormplayer_go_to_page",
      description: "Show a page of the course without waiting for narration. Give the page number (1 is the first page) or part of its title.",
      inputSchema: { type: "object", properties: { page: { type: ["integer", "string"], description: "Page number starting at 1, or part of the page title." } }, required: ["page"] },
      execute: ({ page }) => actions().goToPage(page),
    }),
    tool({
      name: "scormplayer_switch_module",
      description: "In a course with several modules (SCOs), open another module by number (1 is the first) or part of its title.",
      inputSchema: { type: "object", properties: { module: { type: ["integer", "string"], description: "Module number starting at 1, or part of its title." } }, required: ["module"] },
      execute: ({ module }) => actions().switchModule(module),
    }),
    tool({
      name: "scormplayer_skip_narration",
      description: "Skip to the end of the narration or video that is playing, so the course continues as if it had finished.",
      inputSchema: { type: "object", properties: {} },
      execute: () => actions().skip(),
    }),
    tool({
      name: "scormplayer_tour_step",
      description: "Move the open guided tour to its next or previous step. If narration is still playing, 'next' skips it first.",
      inputSchema: { type: "object", properties: { direction: { type: "string", enum: ["next", "back"] } }, required: ["direction"] },
      execute: ({ direction }) => actions().tourStep(direction),
    }),
    tool({
      name: "scormplayer_list_pins",
      description: "List the review pins on this course: number, note, page, target and source location.",
      inputSchema: { type: "object", properties: { status: { type: "string", enum: ["open", "resolved", "all"], default: "open" } } },
      annotations: { readOnlyHint: true },
      execute: ({ status }) => actions().listPins(status ?? "open"),
    }),
    tool({
      name: "scormplayer_add_pin",
      description: "Pin a review note on something in the course on the current page. Identify it with a CSS selector, or with visible text (the smallest element containing it is pinned). The note says what should change.",
      inputSchema: {
        type: "object",
        properties: {
          note: { type: "string", description: "What should change." },
          selector: { type: "string", description: "CSS selector of the element in the course page." },
          text: { type: "string", description: "Visible text of the element, when there is no selector." },
        },
        required: ["note"],
      },
      execute: (input) => actions().addPin(input),
    }),
    tool({
      name: "scormplayer_resolve_pin",
      description: "Mark a pin resolved after its change is made, with a short note on what changed.",
      inputSchema: { type: "object", properties: { number: { type: "integer" }, note: { type: "string" } }, required: ["number"] },
      execute: ({ number, note }) => actions().resolvePin(number, note),
    }),
    tool({
      name: "scormplayer_unzip",
      description: "A zip is read-only: it plays from a copy in scormplayer's cache. This copies it to a folder (beside the zip unless you give one), moves its pins along, and reopens the player on the folder, so the course's files can be edited.",
      inputSchema: { type: "object", properties: { folder: { type: "string", description: "Full path of the folder to unzip to. Optional; defaults to a folder beside the zip, named after it." } } },
      execute: ({ folder }) => actions().unzip(folder),
    }),
    tool({
      name: "scormplayer_get_handoff",
      description: "The open pins as a Markdown hand-off for a coding agent: what to change, where, source file and line, screenshot paths.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      execute: () => actions().handOff(),
    }),
    tool({
      name: "scormplayer_set_screen_size",
      description: "Show the course at desktop size, tablet size (1024×768) or phone size (390×844).",
      inputSchema: { type: "object", properties: { size: { type: "string", enum: ["desktop", "tablet", "phone"] } }, required: ["size"] },
      execute: ({ size }) => actions().setScreen(size),
    }),
    tool({
      name: "scormplayer_scorm_data",
      description: "The course's SCORM data as the LMS sees it (completion, success, score, location, suspend data, interactions…), optionally with the recent API calls the course made.",
      inputSchema: { type: "object", properties: { include_calls: { type: "boolean", default: false } } },
      annotations: { readOnlyHint: true },
      execute: ({ include_calls }) => actions().scormData(Boolean(include_calls)),
    }),
  ];

  const handles: unknown[] = [];
  for (const definition of tools) {
    try { handles.push(context.registerTool(definition)); } catch { /* an older or stricter implementation */ }
  }
  return () => {
    for (const [index, handle] of handles.entries()) {
      try {
        if (handle && typeof (handle as any).unregister === "function") (handle as any).unregister();
        else if (handle && typeof (handle as any).dispose === "function") (handle as any).dispose();
        else if (typeof context.unregisterTool === "function") context.unregisterTool(tools[index].name);
      } catch { /* already gone */ }
    }
  };
}
