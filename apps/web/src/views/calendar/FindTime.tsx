// Find a time, under Calendar's header: who (email addresses, or nobody for time of your own), how
// long, and a title if you like. Find asks for free times in the days shown, and Pip's
// suggestions go on the grid as dashed blocks (Suggested.tsx), or in a short list here on a phone.
// It says what it found, whose calendar it couldn't see, and how far ahead Nook knows yours. Esc
// or Close clears them.

import { For, onMount, Show } from "solid-js";
import { Notice } from "../../components/kit/Notice.tsx";
import { type Segment, Segmented } from "../../components/kit/Segmented.tsx";
import { Button } from "../../components/ui.tsx";
import { date, hours } from "../../lib/format.ts";
import { failedMessage } from "../../lib/readState.ts";
import { foundLine, knownLine, LENGTHS, lengthLabel, unseenLines } from "../../lib/suggest.ts";
import type { Finder } from "./finder.ts";

const LENGTH_CHOICES: readonly Segment<string>[] = LENGTHS.map((m) => ({
  value: String(m),
  label: lengthLabel(m),
}));

const FIELD = "min-w-0 rounded border border-line bg-panel px-2 py-1";

export function FindTime(props: {
  finder: Finder;
  /** The days shown, as Calendar says them: "that week", "that day", "in October". */
  where: string;
  /** Lists the suggestions here, where there's no grid to put them on (a phone, a month). */
  list: boolean;
}) {
  const f = () => props.finder;
  let who!: HTMLInputElement;
  onMount(() => who.focus());
  return (
    <section
      aria-label="Find a time"
      class="border-b border-line"
      onKeyDown={(ev) => {
        // Esc clears it, unless it's a menu's or a question's.
        if (ev.key === "Escape" && !ev.defaultPrevented) {
          ev.preventDefault();
          f().close();
        }
      }}
    >
      <form
        class="flex flex-wrap items-center gap-2 px-4 py-2"
        onSubmit={(e) => {
          e.preventDefault();
          f().find();
        }}
      >
        <input
          ref={who}
          data-find-who
          class={`${FIELD} flex-[2_1_14rem]`}
          aria-label="Who"
          placeholder="Who? Email addresses, or nobody for time of your own"
          value={f().who()}
          onInput={(e) => f().setWho(e.currentTarget.value)}
        />
        <Segmented
          options={LENGTH_CHOICES}
          value={String(f().minutes())}
          onChange={(v) => f().setMinutes(Number(v))}
          label="How long"
        />
        <input
          class={`${FIELD} flex-[1_1_9rem]`}
          aria-label="Title"
          placeholder="Title (optional)"
          value={f().title()}
          onInput={(e) => f().setTitle(e.currentTarget.value)}
        />
        <Button size="sm" variant="primary" type="submit">
          Find
        </Button>
        <Button size="sm" variant="quiet" title="Close (Esc)" onClick={() => f().close()}>
          Close
        </Button>
      </form>
      <Show when={f().asked()}>
        <Said finder={f()} where={props.where} list={props.list} />
      </Show>
    </section>
  );
}

/** What was found for what was asked, or why nothing could be. */
function Said(props: { finder: Finder; where: string; list: boolean }) {
  const f = () => props.finder;
  const r = () => f().result();
  return (
    <div aria-live="polite">
      <Show
        when={!f().passed()}
        fallback={<Notice strip>Those days have passed. Go to later ones to find a time.</Notice>}
      >
        <Show when={f().read().isError}>
          <Notice
            strip
            tone="bad"
            action={
              <Button size="sm" onClick={() => void f().read().refetch()}>
                Try again
              </Button>
            }
          >
            {failedMessage(f().read().error, "your free time")}
          </Notice>
        </Show>
        <Show when={!f().read().isError && !r()}>
          <Notice strip>Looking…</Notice>
        </Show>
        <Show when={r()}>
          {(found) => (
            <>
              <Notice strip icon="calendar">
                {foundLine(
                  f().suggestions().length,
                  f().asked()?.minutes ?? 30,
                  f().guests(),
                  found().checked,
                  props.where,
                )}
              </Notice>
              <For each={unseenLines(found().unseen)}>
                {(line) => (
                  <Notice strip tone="warn">
                    {line}
                  </Notice>
                )}
              </For>
              <Show when={found().knownUntil}>
                {(until) => (
                  <Notice strip tone="warn">
                    {knownLine(until())}
                  </Notice>
                )}
              </Show>
              <Show when={props.list && f().suggestions().length > 0}>
                <SuggestedList finder={f()} />
              </Show>
            </>
          )}
        </Show>
      </Show>
    </div>
  );
}

/** The suggestions as a list, each a button that adds it or asks to invite them. */
function SuggestedList(props: { finder: Finder }) {
  return (
    <ul class="flex flex-wrap gap-2 px-4 py-2">
      <For each={props.finder.suggestions()}>
        {(s) => {
          let el: HTMLElement | undefined;
          return (
            <li>
              <Button
                size="sm"
                icon="plus"
                ref={(b) => (el = b)}
                onClick={() => el && props.finder.pick(s, el.getBoundingClientRect())}
              >
                {`${date(s.start)}, ${hours(s.start, s.end)}`}
              </Button>
            </li>
          );
        }}
      </For>
    </ul>
  );
}
