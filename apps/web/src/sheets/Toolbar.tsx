// A spreadsheet's formatting, beside the formula bar: bold, italic, which side, the number format,
// a fill, and keeping the top row in place. Each acts on the cells selected, as one step to undo,
// and shows what the cell the cursor is on has.

import { SHEET_FILLS, type SheetFill } from "@hearth/core";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { Icon, type IconName } from "../components/icons.tsx";
import { Button } from "../components/kit/Button.tsx";
import { IconButton } from "../components/kit/IconButton.tsx";
import { Overflow } from "../components/Menu.tsx";
import { keyLabel } from "../lib/keys.ts";
import { type Align, fillSwatch, NUMBER_CHOICES, numberLabel, turnsOn } from "./format.ts";
import type { Sheet } from "./state.ts";

const ALIGNS: { value: Align; label: string; icon: IconName }[] = [
  { value: "left", label: "Align left", icon: "text-align-start" },
  { value: "center", label: "Align center", icon: "text-align-center" },
  { value: "right", label: "Align right", icon: "text-align-end" },
];

const name = (fill: SheetFill) => fill[0]!.toUpperCase() + fill.slice(1);

export function Toolbar(props: {
  sheet: Sheet;
  tab: number;
  /** The cells selected, which a button formats. */
  refs: string[];
  /** The cell the cursor is on, whose formats the buttons show. */
  at: string;
  /** Hands the keys back to the grid after a click, so typing goes on there. */
  done: () => void;
}) {
  const s = props.sheet;
  const sheet = () => s.book.sheets[props.tab];
  const formats = () => sheet()?.formats ?? {};
  const here = () => formats()[props.at];
  const off = () => !s.loaded();
  const apply = (patch: Parameters<Sheet["format"]>[2]) => {
    s.format(props.tab, props.refs, patch);
    props.done();
  };
  const toggle = (part: "bold" | "italic") =>
    apply({ [part]: turnsOn(formats(), props.refs, part) || null });

  const [picking, setPicking] = createSignal(false);
  let picker: HTMLDivElement | undefined;
  createEffect(() => {
    if (!picking()) return;
    const outside = (e: PointerEvent) => {
      if (!picker?.contains(e.target as Node)) setPicking(false);
    };
    document.addEventListener("pointerdown", outside, true);
    onCleanup(() => document.removeEventListener("pointerdown", outside, true));
  });
  const paint = (fill: SheetFill | null) => {
    setPicking(false);
    apply({ fill });
  };

  return (
    <div
      role="toolbar"
      aria-label="Format cells"
      class="flex shrink-0 flex-wrap items-center gap-0.5"
    >
      <IconButton
        icon="bold"
        label="Bold"
        title={`Bold (${keyLabel("mod+b")})`}
        pressed={!!props.refs.length && !turnsOn(formats(), props.refs, "bold")}
        disabled={off()}
        onClick={() => toggle("bold")}
      />
      <IconButton
        icon="italic"
        label="Italic"
        title={`Italic (${keyLabel("mod+i")})`}
        pressed={!!props.refs.length && !turnsOn(formats(), props.refs, "italic")}
        disabled={off()}
        onClick={() => toggle("italic")}
      />
      <span class="mx-1 h-4 w-px bg-line" />
      <For each={ALIGNS}>
        {(a) => (
          <IconButton
            icon={a.icon}
            label={a.label}
            pressed={here()?.align === a.value}
            disabled={off()}
            // Pressed again, it goes back to the spreadsheet's own: numbers right, words left.
            onClick={() => apply({ align: here()?.align === a.value ? null : a.value })}
          />
        )}
      </For>
      <span class="mx-1 h-4 w-px bg-line" />
      <Overflow
        label="Number format"
        start
        class="flex h-control-md items-center gap-1 rounded-sm px-2 text-callout text-ink hover:bg-surface-3 max-md:min-h-11"
        items={NUMBER_CHOICES.map((c) => ({
          label: `${c.label} (${c.example})`,
          run: () => apply({ number: c.value }),
        }))}
      >
        {numberLabel(here()?.number)}
        <Icon name="chevron-down" size={14} class="text-faint" />
      </Overflow>
      <div class="relative" ref={picker}>
        <Button
          variant="quiet"
          label="Fill"
          title="Fill colour"
          expanded={picking()}
          disabled={off()}
          onClick={() => setPicking(!picking())}
        >
          <span
            class="size-4 rounded-full border border-line"
            style={{ background: here()?.fill ? fillSwatch(here()!.fill!) : "transparent" }}
          />
          Fill
        </Button>
        <Show when={picking()}>
          <div class="glass-strong absolute top-full right-0 z-(--z-menu) mt-1 flex items-center gap-0.5 rounded-lg p-1 shadow-4">
            <For each={SHEET_FILLS}>
              {(f) => (
                <Button
                  variant="quiet"
                  size="sm"
                  label={`Fill ${name(f)}`}
                  title={name(f)}
                  onClick={() => paint(f)}
                >
                  <span class="size-4 rounded-full" style={{ background: fillSwatch(f) }} />
                </Button>
              )}
            </For>
            <Button variant="quiet" size="sm" onClick={() => paint(null)}>
              No fill
            </Button>
          </div>
        </Show>
      </div>
      <span class="mx-1 h-4 w-px bg-line" />
      <Button
        variant="quiet"
        title="Keep the top row in place while the rest scrolls"
        pressed={(sheet()?.freeze.rows ?? 0) > 0}
        disabled={off()}
        onClick={() => {
          const f = sheet()?.freeze;
          if (f) s.setFreeze(props.tab, f.rows > 0 ? 0 : 1, f.cols);
          props.done();
        }}
      >
        Freeze top row
      </Button>
    </div>
  );
}
