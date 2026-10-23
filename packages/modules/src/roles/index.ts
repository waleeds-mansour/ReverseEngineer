// Pip's jobs (Spec 3): a profile you define that only ever narrows what Pip does. A job bundles
// some of your routines and Pip's proactive reflexes, caps what their turns may do at a risk
// (the kernel holds it, guard.ts holdsFor), can give them a daily turn allowance of their own, and
// adds a few lines to their prompt. It's still one Pip: no new process, no new concurrency.
// Called "role" in code, since D82 already uses "job" for model tiers (jarvis/src/models.ts).
import { entity, ROLE_CEILINGS, role, roleReflex, roleRoutine, routine } from "@hearth/db";
import { type ActionContext, ActionError, defineAction, defineModule, newId } from "@hearth/kernel";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { id } from "../shared.ts";
import { findRole, listRoles, loosens, nameTaken, proactiveReflexes } from "./store.ts";

export type { AttachableReflex, RoleList, RoleView } from "./store.ts";

const CHANGED = "role.changed";

function refuseUntrusted(ctx: ActionContext): void {
  if (ctx.caller.origin === "untrusted")
    throw new ActionError(
      "forbidden",
      "A job is the owner's own; it can't be set up from outside content.",
    );
}

/** Only you can loosen a job (a higher ceiling, more turns, back on); Pip can only tighten one. */
function refuseLoosening(ctx: ActionContext): void {
  if (ctx.caller.kind !== "owner")
    throw new ActionError("forbidden", "Only the owner can let a job do more.");
}

async function mustFind(ctx: ActionContext, roleId: string) {
  const r = await findRole(ctx.tx, roleId);
  if (!r) throw new ActionError("not_found", "No job with that id.");
  return r;
}

async function viewOf(ctx: ActionContext, roleId: string) {
  return (await listRoles(ctx, roleId)).roles[0]!;
}

const name = z.string().trim().min(1).max(60);
const description = z.string().trim().max(300);
/** "A few lines" for the turn's prompt. */
const personaNote = z.string().trim().max(500);
const riskCeiling = z
  .enum(ROLE_CEILINGS)
  .describe(
    "The most its turns may do: read (looks only, and reports), internal (changes Nook), self_external (the owner's own accounts), outward (what others see, asking first). Anything above is held for the brief.",
  );
const turnsPerDay = z.number().int().min(0).max(500);

/** What a job takes on: one of your routines, or one of Pip's proactive reflexes. */
const Member = z
  .object({ id, routineId: id.optional(), reflex: z.string().min(1).max(120).optional() })
  .refine((i) => Boolean(i.routineId) !== Boolean(i.reflex), {
    message: "Give a routineId or a reflex, not both.",
  });

export const rolesModule = defineModule({
  name: "role",
  description:
    "Pip's jobs: profiles that narrow what some of its routines and reflexes may do, and how often.",
  entityTypes: [],
  events: [{ kind: CHANGED, description: "One of Pip's jobs was made, changed or removed." }],
  knowledge: {},
  reflexes: [],
  noReflexesBecause: "A job only narrows what other reflexes do; it watches for nothing itself.",
  actions: [
    defineAction({
      name: "role.list",
      description:
        "Pip's jobs: each with its ceiling, its own daily turns (and how many it spent today), and the routines and reflexes in it; and the proactive reflexes a job can take on.",
      input: z.object({}),
      risk: "read",
      callers: ["owner", "agent"],
      handler: (_i, ctx) => listRoles(ctx),
    }),
    defineAction({
      name: "role.create",
      description:
        "Make a job for Pip: a name, what it's for, a ceiling on what its turns may do, optionally its own daily turns and a few lines on how to go about it. It does nothing until routines or reflexes are attached.",
      input: z.object({
        name,
        description: description.default(""),
        personaNote: personaNote.optional(),
        riskCeiling: riskCeiling.default("read"),
        turnsPerDay: turnsPerDay.optional(),
      }),
      risk: "internal",
      callers: ["owner", "agent"],
      summarize: (i) => `Make the job "${i.name}"`,
      async handler(i, ctx) {
        refuseUntrusted(ctx);
        if (await nameTaken(ctx.tx, i.name))
          throw new ActionError("conflict", `There's a job called ${i.name} already.`);
        const roleId = newId();
        await ctx.tx.insert(role).values({
          id: roleId,
          name: i.name,
          description: i.description,
          personaNote: i.personaNote || null,
          riskCeiling: i.riskCeiling,
          turnsPerDay: i.turnsPerDay ?? null,
          createdAt: ctx.now,
          updatedAt: ctx.now,
        });
        ctx.emit({ kind: CHANGED, payload: { id: roleId } });
        return viewOf(ctx, roleId);
      },
    }),
    defineAction({
      name: "role.update",
      description:
        "Change a job: rename it, change its ceiling, daily turns or notes, or turn it off (which pauses everything in it) and on. Only the owner can let a job do more.",
      input: z.object({
        id,
        name: name.optional(),
        description: description.optional(),
        personaNote: personaNote.nullable().optional(),
        riskCeiling: riskCeiling.optional(),
        turnsPerDay: turnsPerDay.nullable().optional(),
        active: z.boolean().optional(),
      }),
      risk: "internal",
      callers: ["owner", "agent"],
      async handler(i, ctx) {
        refuseUntrusted(ctx);
        const was = await mustFind(ctx, i.id);
        if (i.name && (await nameTaken(ctx.tx, i.name, i.id)))
          throw new ActionError("conflict", `There's a job called ${i.name} already.`);
        const next = {
          riskCeiling: i.riskCeiling ?? was.riskCeiling,
          active: i.active ?? was.active,
          turnsPerDay: i.turnsPerDay === undefined ? was.turnsPerDay : i.turnsPerDay,
        };
        if (loosens(was, next)) refuseLoosening(ctx);
        await ctx.tx
          .update(role)
          .set({
            ...next,
            ...(i.name ? { name: i.name } : {}),
            ...(i.description !== undefined ? { description: i.description } : {}),
            ...(i.personaNote !== undefined ? { personaNote: i.personaNote || null } : {}),
            updatedAt: ctx.now,
          })
          .where(eq(role.id, i.id));
        ctx.emit({ kind: CHANGED, payload: { id: i.id } });
        return viewOf(ctx, i.id);
      },
    }),
    defineAction({
      name: "role.attach",
      description:
        "Put one of the owner's routines (routineId) or one of Pip's proactive reflexes (reflex, by name) in a job: its turns then run for the job, within its ceiling and turns. It leaves any job it was in.",
      input: Member,
      risk: "internal",
      callers: ["owner", "agent"],
      async handler(i, ctx) {
        refuseUntrusted(ctx);
        await mustFind(ctx, i.id);
        let from: string | undefined;
        if (i.routineId) {
          const [r] = await ctx.tx
            .select({ id: routine.entityId, roleId: roleRoutine.roleId })
            .from(routine)
            .innerJoin(entity, eq(entity.id, routine.entityId))
            .leftJoin(roleRoutine, eq(roleRoutine.routineId, routine.entityId))
            .where(and(eq(routine.entityId, i.routineId), isNull(entity.deletedAt)));
          if (!r) throw new ActionError("not_found", "No routine with that id.");
          from = r.roleId ?? undefined;
        } else {
          const reflex = proactiveReflexes(ctx).find((x) => x.name === i.reflex);
          if (!reflex)
            throw new ActionError(
              "not_found",
              `${i.reflex} isn't one of the things Pip does on its own, so no job can take it on.`,
            );
          const [r] = await ctx.tx
            .select({ roleId: roleReflex.roleId })
            .from(roleReflex)
            .where(eq(roleReflex.reflexName, reflex.name));
          from = r?.roleId;
        }
        if (from === i.id) return viewOf(ctx, i.id);
        // Moving it out of another job could loosen it.
        if (from) refuseLoosening(ctx);
        if (i.routineId)
          await ctx.tx
            .insert(roleRoutine)
            .values({ routineId: i.routineId, roleId: i.id })
            .onConflictDoUpdate({ target: roleRoutine.routineId, set: { roleId: i.id } });
        else
          await ctx.tx
            .insert(roleReflex)
            .values({ reflexName: i.reflex!, roleId: i.id })
            .onConflictDoUpdate({ target: roleReflex.reflexName, set: { roleId: i.id } });
        ctx.emit({ kind: CHANGED, payload: { id: i.id, ...(from ? { from } : {}) } });
        return viewOf(ctx, i.id);
      },
    }),
    defineAction({
      name: "role.detach",
      description:
        "Take a routine or reflex out of a job: it runs as it did before, without the job's ceiling or turns. Only the owner can.",
      input: Member,
      risk: "internal",
      // It loosens what the routine or reflex may do.
      callers: ["owner"],
      async handler(i, ctx) {
        await mustFind(ctx, i.id);
        if (i.routineId)
          await ctx.tx
            .delete(roleRoutine)
            .where(and(eq(roleRoutine.routineId, i.routineId), eq(roleRoutine.roleId, i.id)));
        else
          await ctx.tx
            .delete(roleReflex)
            .where(and(eq(roleReflex.reflexName, i.reflex!), eq(roleReflex.roleId, i.id)));
        ctx.emit({ kind: CHANGED, payload: { id: i.id } });
        return viewOf(ctx, i.id);
      },
    }),
    defineAction({
      name: "role.remove",
      description:
        "Remove a job. Its routines and reflexes stay, and run as they did before it; its past turns lose the label.",
      input: z.object({ id }),
      risk: "internal",
      callers: ["owner"],
      async handler(i, ctx) {
        const removed = await ctx.tx
          .delete(role)
          .where(eq(role.id, i.id))
          .returning({ id: role.id });
        if (removed.length === 0) throw new ActionError("not_found", "No job with that id.");
        ctx.emit({ kind: CHANGED, payload: { id: i.id } });
        return { removed: true };
      },
    }),
  ],
});
