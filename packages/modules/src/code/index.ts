// Code Pip can read (Spec 2, the owner 2026-10-27): repos you add in Settings, which Pip reads on
// its own (log, diff, blame, search, files) without asking. Every action here only reads, through
// git run safely (git.ts), and only in repos you added; changing code is not here, and it would
// ask. Only you add or remove a repo, and Nook's own code is refused wherever it's checked out.

import { basename } from "node:path";
import { ActionError, defineAction, defineModule } from "@hearth/kernel";
import { z } from "zod";
import { historyActions } from "./history.ts";
import { readingActions } from "./reading.ts";
import { checkRepo, readRepos, samePath, writeRepos } from "./repos.ts";

export { isSecret } from "./paths.ts";
export { checkRepo, NOOK_ROOT } from "./repos.ts";

/** Repos Pip may read, as Settings lists them before git has looked. */
const listOf = (repos: string[]) => repos.map((path) => ({ name: basename(path), path }));

const folder = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .describe("The repo's folder on this PC, like D:\\code\\my-app.");

export const codeModule = defineModule({
  name: "code",
  description:
    "Code repos you let Pip read: their history, diffs, blame, a search and their files.",
  entityTypes: [],
  events: [
    { kind: "code.repo_added", description: "You let Pip read a repo." },
    { kind: "code.repo_removed", description: "You took a repo out of what Pip reads." },
  ],
  reflexes: [],
  noReflexesBecause:
    "A repo is read when you ask or while Pip works a task; nothing in one is news to react to yet.",
  knowledge: {},
  actions: [
    defineAction({
      name: "code.add",
      description:
        "Lets Pip read a repo: its folder on this PC, which must be a git repo. Not Nook's own code, a system folder or a whole drive. Only the owner adds repos, in Settings.",
      input: z.object({ path: folder }),
      risk: "internal",
      callers: ["owner"],
      async handler(i, ctx) {
        const checked = checkRepo(i.path);
        if ("refused" in checked) throw new ActionError("invalid_input", checked.refused);
        const repos = await readRepos(ctx.tx);
        const name = basename(checked.path);
        if (repos.some((p) => samePath(p, checked.path))) return { name, repos: listOf(repos) };
        const next = [...repos, checked.path];
        await writeRepos(ctx.tx, next, ctx.now);
        ctx.emit({ kind: "code.repo_added", payload: { name, path: checked.path } });
        return { name, repos: listOf(next) };
      },
    }),
    defineAction({
      name: "code.remove",
      description:
        "Stops Pip reading a repo. Nothing in the repo changes. Only the owner does this.",
      input: z.object({ path: folder }),
      risk: "internal",
      callers: ["owner"],
      async handler(i, ctx) {
        const repos = await readRepos(ctx.tx);
        const next = repos.filter((p) => !samePath(p, i.path));
        if (next.length === repos.length)
          throw new ActionError("not_found", `Pip isn't reading ${i.path}.`);
        await writeRepos(ctx.tx, next, ctx.now);
        ctx.emit({ kind: "code.repo_removed", payload: { path: i.path } });
        return { repos: listOf(next) };
      },
    }),
    ...readingActions,
    ...historyActions,
  ],
});
