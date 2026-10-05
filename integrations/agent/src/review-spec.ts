import { defineCatalog, type Spec } from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { z } from "zod";

// Only the server constructs layouts. Pin notes are data, never executable UI.
export const reviewCatalog = defineCatalog(schema, {
  components: {
    ReviewLayout: { props: z.object({}), slots: ["default"], description: "Review checklist layout" },
    ReviewSummary: { props: z.object({}), description: "Course identity and remaining open pin count" },
    PinChecklist: { props: z.object({}), description: "Choose open pins to send, with optional saved screenshots" },
    RequestComposer: { props: z.object({}), description: "Send selected pins on a user click, or provide copyable text" },
  },
  actions: {},
});

export function pinReviewSpec(review: object, filter = "open"): Spec {
  const spec = {
    root: "review",
    elements: {
      review: { type: "ReviewLayout", props: {}, children: ["summary", "pins", "request"] },
      summary: { type: "ReviewSummary", props: {}, children: [] },
      pins: { type: "PinChecklist", props: {}, children: [] },
      request: { type: "RequestComposer", props: {}, children: [] },
    },
    state: { review, filter },
  };
  const validated = reviewCatalog.validate(spec);
  if (!validated.success) throw new Error("The review layout is invalid.");
  return spec;
}
