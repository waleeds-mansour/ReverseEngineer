// Calendar's controls in its header: Today, earlier and later, and Day, Week or Month. The dates
// shown are said under the pane's name, so these never move as that changes length.

import { type Segment, Segmented } from "../../components/kit/Segmented.tsx";
import { Button, IconButton } from "../../components/ui.tsx";
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
    </div>
  );
}
