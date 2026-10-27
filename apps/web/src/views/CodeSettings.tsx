// Settings for code Pip can read (Spec 2): repos you add by their folder on this PC. Pip reads
// them on its own (history, diffs, blame, search, files) and never changes code without your yes.
// Nook's own code is refused, and files that may hold secrets stay out even in a repo you add.

import { createSignal, For, Show } from "solid-js";
import { Button } from "../components/ui.tsx";
import { ago } from "../lib/format.ts";
import { toast } from "../lib/live.ts";
import { act, useAction } from "../lib/query.ts";

interface Repo {
  name: string;
  path: string;
  branch: string | null;
  head: { sha: string; at: string; subject: string } | null;
  /** What keeps Nook from reading it, in git's words or Nook's. */
  problem: string | null;
}

/** Its branch and last commit, in a line. */
function about(r: Repo): string {
  if (r.problem) return r.problem;
  if (!r.head) return "No commits yet";
  return `${r.branch ?? "No branch"} · ${r.head.subject} · ${ago(r.head.at)}`;
}

export function CodeSettings() {
  const repos = useAction<{ repos: Repo[] }>("code.repos");
  const [path, setPath] = createSignal("");

  const add = async (e: Event) => {
    e.preventDefault();
    const r = await act<{ name: string }>("code.add", { path: path().trim() });
    if (!r) return;
    setPath("");
    toast.show(`Pip can read ${r.name} now.`);
  };
  const remove = async (r: Repo) => {
    if (await act("code.remove", { path: r.path })) toast.show(`Pip stopped reading ${r.name}.`);
  };

  return (
    <section class="space-y-3">
      <h2 class="font-semibold">Code Pip can read</h2>
      <p class="text-sm text-muted">
        Pip reads a repo you add here on its own, without asking: its history, what changed, who
        wrote each line, a search over its files, and the files themselves. Changing code still
        waits for your yes. Nook's own code stays out, and so do files that may hold secrets, like
        .env files and keys. What Pip reads here is treated like mail from outside, so anything it
        would send after reading it asks you first.
      </p>
      <Show
        when={repos.data?.repos.length}
        fallback={<p class="text-sm text-faint">No repos yet. Pip reads no code.</p>}
      >
        <ul class="space-y-2">
          <For each={repos.data?.repos}>
            {(r) => (
              <li class="flex items-center gap-3 rounded-md bg-sunk px-3 py-3">
                <div class="min-w-0 flex-1">
                  <p class="truncate font-medium">
                    {r.name}
                    <span class="text-muted"> · {r.path}</span>
                  </p>
                  <p class={`truncate text-sm ${r.problem ? "text-bad" : "text-muted"}`}>
                    {about(r)}
                  </p>
                </div>
                <Button tone="danger" onClick={() => void remove(r)}>
                  Remove
                </Button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <form class="flex items-center gap-2 rounded-md bg-sunk px-3 py-3 text-sm" onSubmit={add}>
        <input
          class="min-w-0 flex-1 rounded border border-line bg-panel px-2 py-1"
          placeholder="D:\code\my-app"
          aria-label="Repo folder"
          value={path()}
          onInput={(e) => setPath(e.currentTarget.value)}
        />
        <Button type="submit" disabled={!path().trim()}>
          Add repo
        </Button>
      </form>
    </section>
  );
}
