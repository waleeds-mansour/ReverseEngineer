// What Pip did, and why: one read over the records Hearth already keeps of Pip's turns, the
// actions they ran (the audit log), the approvals they asked for and the heartbeat items they
// took up, grouped so each thing that set Pip off reads as one card (timeline.ts). What Pip did
// without asking can be put back from there, or from Today, in one press (undo.ts).
import { defineAction, defineModule } from "@hearth/kernel";
import { z } from "zod";
import { id, isoDateTime } from "../shared.ts";
import { readTimeline } from "./timeline.ts";
import { undoActions } from "./undo.ts";
import { UNDONE } from "./undo-read.ts";

export type {
  Timeline,
  TimelineAction,
  TimelineApproval,
  TimelineGroup,
  TimelineItem,
  TimelineTouched,
  TimelineTurn,
  Undid,
  UndoRef,
  UndoView,
} from "./shape.ts";

export const activityModule = defineModule({
  name: "activity",
  description:
    "What Pip did and why: its turns, actions, approvals and set-aside items, and Undo for what it did without asking.",
  entityTypes: [],
  events: [
    {
      kind: UNDONE,
      description:
        "You undid something Pip did without asking (activity.undo). Payload: ref, did (what Pip did, in words), type.",
    },
  ],
  knowledge: {},
  reflexes: [],
  noReflexesBecause: "It only reads what other modules and Pip's turns recorded, and puts it back.",
  actions: [
    defineAction({
      name: "activity.timeline",
      description:
        "What Pip did, newest first: each turn or reflex with the actions it ran (risk and outcome), the approvals it asked for and how they went, the records it touched, and its reply.",
      input: z.object({
        limit: z.number().int().min(1).max(100).default(30),
        /** The previous page's `next`: turns queued before this. */
        before: isoDateTime.optional(),
        /** Only what one of Pip's jobs did (role.list, Spec 3). */
        roleId: id.optional(),
      }),
      risk: "read",
      // The audit log holds every input Pip sent: yours alone to read.
      callers: ["owner"],
      handler: (i, ctx) => readTimeline(ctx.tx, i, ctx.now),
    }),
    ...undoActions,
  ],
});
