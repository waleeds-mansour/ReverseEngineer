// Whether a task is about code (D82): linked to a GitHub pull request, or its words say so. Its
// work and its thread then run on Opus.
import { type DbOrTx, entity, link } from "@hearth/db";
import { and, eq, isNull, or } from "drizzle-orm";
import { looksLikeCode } from "../chat/code.ts";

export async function taskIsCode(
  db: DbOrTx,
  t: { id: string; title: string; body: string | null },
  /** More words that come with it, like the comment being answered. */
  more = "",
): Promise<boolean> {
  if (looksLikeCode(`${t.title}\n${t.body ?? ""}\n${more}`)) return true;
  const [pr] = await db
    .select({ id: entity.id })
    .from(link)
    .innerJoin(
      entity,
      or(
        and(eq(link.fromId, t.id), eq(entity.id, link.toId)),
        and(eq(link.toId, t.id), eq(entity.id, link.fromId)),
      ),
    )
    .where(and(eq(entity.type, "github_pr"), isNull(entity.deletedAt)))
    .limit(1);
  return Boolean(pr);
}
