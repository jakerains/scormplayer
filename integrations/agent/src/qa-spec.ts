import { defineCatalog, type Spec } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { z } from "zod";

// The QA suggestions checklist. Only the server constructs layouts; suggestion text is data.
export const qaCatalog = defineCatalog(schema, {
  components: {
    QaLayout: { props: z.object({}), slots: ["default"], description: "QA suggestions layout" },
    QaSummary: { props: z.object({}), description: "The QA pass: coverage, suggestion counts, refresh" },
    QaList: { props: z.object({}), description: "Suggestions grouped by module and page, with accept, dismiss and show in player" },
    QaActions: { props: z.object({}), description: "Bulk accept, clear QA pins, and send accepted suggestions to the agent" },
  },
  actions: {},
});

export function qaSuggestionsSpec(suggestions: object): Spec {
  const spec = {
    root: "qa",
    elements: {
      qa: { type: "QaLayout", props: {}, children: ["summary", "list", "actions"] },
      summary: { type: "QaSummary", props: {}, children: [] },
      list: { type: "QaList", props: {}, children: [] },
      actions: { type: "QaActions", props: {}, children: [] },
    },
    state: { suggestions },
  };
  const validated = qaCatalog.validate(spec);
  if (!validated.success) throw new Error("The QA layout is invalid.");
  return spec;
}
