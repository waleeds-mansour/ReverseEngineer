// The board's tools, colors, record picker and zoom.

import type { CanvasNode } from "@hearth/core";
import { createSignal, For, Show } from "solid-js";
import type { IconName } from "../components/icons.tsx";
import { Button } from "../components/kit/Button.tsx";
import { IconButton } from "../components/kit/IconButton.tsx";
import { action } from "../lib/api.ts";
import { keyLabel } from "../lib/keys.ts";
import type { SearchHit } from "../lib/types.ts";
import type { Board, Tool } from "./state.ts";

/** Each tool is an icon; its name is its tooltip, with the key Board.tsx binds to it. */
const TOOLS: { tool: Tool; label: string; key: string; icon: IconName }[] = [
  { tool: "select", label: "Select", key: "v", icon: "mouse-pointer-2" },
  { tool: "text", label: "Text", key: "t", icon: "type" },
  { tool: "rectangle", label: "Box", key: "r", icon: "square" },
  { tool: "ellipse", label: "Circle", key: "o", icon: "circle" },
  { tool: "arrow", label: "Arrow", key: "a", icon: "move-up-right" },
];

const FILLS = ["#fff7ed", "#fef3c7", "#dcfce7", "#dbeafe", "#f3e8ff", "#fee2e2", "transparent"];

export function Toolbar(props: {
  board: Board;
  zoom: number;
  onZoom: (factor: number) => void;
  onFit: () => void;
  /** Puts a record's card in the middle of the view. */
  onRecord: (hit: SearchHit) => void;
}) {
  const b = props.board;
  const [picking, setPicking] = createSignal(false);
  const [hits, setHits] = createSignal<SearchHit[]>([]);
  const search = async (q: string) => {
    setHits(
      await (q.trim()
        ? action<SearchHit[]>("entity.search", { query: q, limit: 8 })
        : action<SearchHit[]>("entity.recent", { limit: 8 })
      ).catch(() => []),
    );
  };
  const paint = (fill: string) =>
    b.change((d) => {
      for (const n of d.nodes as CanvasNode[])
        if (b.selected().has(n.id)) n.style = { ...n.style, fillColor: fill };
    });

  return (
    <div
      data-toolbar
      class="absolute top-3 left-3 z-10 flex flex-wrap items-center gap-1 glass rounded-lg p-1 shadow-3"
    >
      <For each={TOOLS}>
        {(t) => (
          <IconButton
            icon={t.icon}
            label={t.label}
            title={`${t.label} (${keyLabel(t.key)})`}
            pressed={b.tool() === t.tool}
            onClick={() => b.setTool(t.tool)}
          />
        )}
      </For>
      <span class="mx-1 h-4 w-px bg-line" />
      <div class="relative">
        <Button
          variant="quiet"
          icon="at-sign"
          title="Put a task, note, person or any record on the board"
          label="@ Record"
          expanded={picking()}
          onClick={() => {
            setPicking(!picking());
            void search("");
          }}
        >
          Record
        </Button>
        <Show when={picking()}>
          <div class="absolute top-full left-0 mt-1 w-64 glass-strong rounded-md p-2 shadow-4">
            <input
              class="mb-1 w-full rounded border border-line bg-panel px-2 py-1 text-sm"
              placeholder="Find a record…"
              aria-label="Find a record"
              ref={(el) => queueMicrotask(() => el.focus())}
              onInput={(e) => void search(e.currentTarget.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Escape") setPicking(false);
              }}
            />
            <ul class="max-h-60 overflow-auto">
              <For each={hits()}>
                {(h) => (
                  <li>
                    <button
                      type="button"
                      class="w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-sunk"
                      onClick={() => {
                        props.onRecord(h);
                        setPicking(false);
                      }}
                    >
                      {h.title || "Untitled"} <span class="text-xs text-faint">{h.type}</span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </div>
        </Show>
      </div>
      <Show when={b.selected().size > 0}>
        <span class="mx-1 h-4 w-px bg-line" />
        <For each={FILLS}>
          {(f) => (
            <button
              type="button"
              aria-label={f === "transparent" ? "No fill" : `Fill ${f}`}
              class="size-5 rounded-full border border-line"
              style={{
                background:
                  f === "transparent"
                    ? "linear-gradient(135deg, transparent 45%, var(--color-bad) 45% 55%, transparent 55%)"
                    : f,
              }}
              onClick={() => paint(f)}
            />
          )}
        </For>
      </Show>
      <span class="mx-1 h-4 w-px bg-line" />
      <IconButton
        icon="undo-2"
        label="Undo"
        title={`Undo (${keyLabel("mod+z")})`}
        onClick={() => b.undo()}
      />
      <IconButton icon="minus" label="Zoom out" onClick={() => props.onZoom(0.8)} />
      <Button variant="quiet" title="Fit everything" onClick={props.onFit}>
        {Math.round(props.zoom * 100)}%
      </Button>
      <IconButton icon="plus" label="Zoom in" onClick={() => props.onZoom(1.25)} />
    </div>
  );
}
