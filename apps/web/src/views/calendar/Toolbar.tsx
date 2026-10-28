// Calendar's controls in its header: Today, earlier and later, Day, Week or Month, and Find a time.
// The dates shown are said under the pane's name, so these never move as that changes length.

import { type Segment, Segmented } from "../../components/kit/Segmented.tsx";
import { Button, IconButton } from "../../components/ui.tsx";
import { keyLabel } from "../../lib/keys.ts";
import type { CalView } from "../../lib/week.ts";

const VIEWS: readonly Segment<CalView>[] = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
];

export function Toolbar(props: {
  view: CalView;
  onView: (view: CalView) => void;
  onStep: (by: number) => void;
  onToday: () => void;
  onFind: () => void;
}) {
  return (
    <div class="flex flex-wrap items-center gap-2">
      <Button size="sm" title="Today (T)" onClick={() => props.onToday()}>
        Today
      </Button>
      <div class="flex">
        <IconButton
          icon="arrow-left"
          label={`Previous ${props.view}`}
          title={`Previous ${props.view} (←)`}
          onClick={() => props.onStep(-1)}
        />
        <IconButton
          icon="arrow-right"
          label={`Next ${props.view}`}
          title={`Next ${props.view} (→)`}
          onClick={() => props.onStep(1)}
        />
      </div>
      <Segmented options={VIEWS} value={props.view} onChange={props.onView} label="Show" />
      <Button
        size="sm"
        icon="search"
        title={`Find a time (${keyLabel("f")})`}
        onClick={() => props.onFind()}
      >
        Find a time
      </Button>
    </div>
  );
}
