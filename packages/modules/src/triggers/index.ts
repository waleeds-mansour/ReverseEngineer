// Your triggers (Spec 6): "when an email from Acme arrives, draft a reply and tell me". You pick
// the kind of event from a short list (mail, tasks, calendar, Notion, GitHub), narrow it by a
// field or two if you like, and write what Pip should do. Each match gets one background turn of
// Pip's, for the job you name if any, within its ceiling and turns a day. The words are yours: a
// turn that has read outside content can't write or change them, since a trigger runs by itself.
import { ownerTrigger, role } from "@hearth/db";
import { type ActionContext, ActionError, defineAction, defineModule, newId } from "@hearth/kernel";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { id } from "../shared.ts";
import { fire } from "./fire.ts";
import { filterProblem, TRIGGER_KIND_NAMES } from "./kinds.ts";
import { findTrigger, listTriggers, loosens, nameTaken } from "./store.ts";

export type { TriggerKindView, TriggerList, TriggerView } from "./store.ts";

const CHANGED = "trigger.changed";

function refuseUntrusted(ctx: ActionContext): void {
  if (ctx.caller.origin === "untrusted")
    throw new ActionError(
      "forbidden",
      "A trigger's words are the owner's own; they can't come from outside content.",
    );
}

async function mustFind(ctx: ActionContext, triggerId: string) {
  const t = await findTrigger(ctx.tx, triggerId);
  if (!t) throw new ActionError("not_found", "No trigger with that id.");
  return t;
}

function checkFilter(kind: string, filter: Record<string, string>) {
  const problem = filterProblem(kind, filter);
  if (problem) throw new ActionError("invalid_input", problem);
}

async function checkJob(ctx: ActionContext, roleId: string | null | undefined) {
  if (!roleId) return;
  const [job] = await ctx.tx.select({ id: role.id }).from(role).where(eq(role.id, roleId));
  if (!job) throw new ActionError("not_found", "No job with that id.");
}

const viewOf = async (ctx: ActionContext, triggerId: string) =>
  (await listTriggers(ctx, triggerId)).triggers[0]!;

const name = z.string().trim().min(1).max(80);
const instructions = z.string().trim().min(1).max(4000);
const filter = z
  .record(z.string().min(1).max(40), z.string().trim().min(1).max(200))
  .refine((f) => Object.keys(f).length <= 3, { message: "Three fields at most." })
  .describe(
    "Payload fields that must equal these values, case aside, e.g. { from: 'ana@acme.com' }. Only the fields trigger_list offers for the kind.",
  );
const perDay = z.number().int().min(1).max(50);

export const triggersModule = defineModule({
  name: "trigger",
  description:
    "Your triggers: when something of a kind you picked happens, Pip does what you wrote.",
  entityTypes: [],
  events: [{ kind: CHANGED, description: "One of your triggers was made, changed or removed." }],
  knowledge: {},
  reflexes: [fire],
  actions: [
    defineAction({
      name: "trigger.list",
      description:
        "The owner's triggers: what each waits for, its filter and words, its job, its turns a day and how many it started today; and the kinds of event (with the fields a filter can test) a trigger can wait for.",
      input: z.object({}),
      risk: "read",
      callers: ["owner", "agent"],
      handler: (_i, ctx) => listTriggers(ctx),
    }),
    defineAction({
      name: "trigger.create",
      description:
        "Make a trigger: when an event of a kind from trigger_list happens (and its filter, if any, passes), Pip gets a turn to do what the owner wrote. Optionally for one of Pip's jobs, and with its own most turns a day (10 unless said).",
      input: z.object({
        name,
        on: z.enum(TRIGGER_KIND_NAMES),
        filter: filter.default({}),
        instructions,
        roleId: id.optional(),
        perDay: perDay.default(10),
      }),
      risk: "internal",
      callers: ["owner", "agent"],
      summarize: (i) => `Make the trigger "${i.name}"`,
      async handler(i, ctx) {
        refuseUntrusted(ctx);
        checkFilter(i.on, i.filter);
        await checkJob(ctx, i.roleId);
        if (await nameTaken(ctx.tx, i.name))
          throw new ActionError("conflict", `There's a trigger called ${i.name} already.`);
        const triggerId = newId();
        await ctx.tx.insert(ownerTrigger).values({
          id: triggerId,
          name: i.name,
          eventKind: i.on,
          filter: i.filter,
          instructions: i.instructions,
          roleId: i.roleId ?? null,
          perDay: i.perDay,
          createdAt: ctx.now,
          updatedAt: ctx.now,
        });
        ctx.emit({ kind: CHANGED, payload: { id: triggerId } });
        return viewOf(ctx, triggerId);
      },
    }),
    defineAction({
      name: "trigger.update",
      description:
        "Change a trigger: rename it, change its words or filter, its job or its turns a day, or pause it (active false) and turn it back on. Only the owner can let one do more: back on, more turns, a looser filter, or out of its job.",
      input: z.object({
        id,
        name: name.optional(),
        instructions: instructions.optional(),
        filter: filter.optional(),
        roleId: id.nullable().optional(),
        perDay: perDay.optional(),
        active: z.boolean().optional(),
      }),
      risk: "internal",
      callers: ["owner", "agent"],
      async handler(i, ctx) {
        refuseUntrusted(ctx);
        const was = await mustFind(ctx, i.id);
        const next = {
          active: i.active ?? was.active,
          perDay: i.perDay ?? was.perDay,
          filter: i.filter ?? was.filter,
          roleId: i.roleId === undefined ? was.roleId : i.roleId,
        };
        if (loosens(was, next) && ctx.caller.kind !== "owner")
          throw new ActionError("forbidden", "Only the owner can let a trigger do more.");
        checkFilter(was.eventKind, next.filter);
        await checkJob(ctx, next.roleId);
        if (i.name && (await nameTaken(ctx.tx, i.name, i.id)))
          throw new ActionError("conflict", `There's a trigger called ${i.name} already.`);
        await ctx.tx
          .update(ownerTrigger)
          .set({
            ...next,
            ...(i.name ? { name: i.name } : {}),
            ...(i.instructions ? { instructions: i.instructions } : {}),
            updatedAt: ctx.now,
          })
          .where(eq(ownerTrigger.id, i.id));
        ctx.emit({ kind: CHANGED, payload: { id: i.id } });
        return viewOf(ctx, i.id);
      },
    }),
    defineAction({
      name: "trigger.remove",
      description: "Delete a trigger. It stops at once; its past turns keep its name.",
      input: z.object({ id }),
      risk: "internal",
      callers: ["owner", "agent"],
      async handler(i, ctx) {
        refuseUntrusted(ctx);
        const removed = await ctx.tx
          .delete(ownerTrigger)
          .where(eq(ownerTrigger.id, i.id))
          .returning({ id: ownerTrigger.id });
        if (removed.length === 0) throw new ActionError("not_found", "No trigger with that id.");
        ctx.emit({ kind: CHANGED, payload: { id: i.id } });
        return { removed: true };
      },
    }),
  ],
});
