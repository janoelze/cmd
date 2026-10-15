// API 1.3's display pieces (docs/57, "1.3 additions" A6–A10): what the native views draw that a
// port couldn't. A new element, Dial (the Timer's ring, a value typed into it), and props added
// to older elements, each with its own `since`: Window `menuLabel`, ToolbarSearchField
// `onSubmit`, Stat `trend`/`good` and children, Sparkline `series`, a time chart's `delta` and
// `note`, `reveal` on ListRow and TimelineEntry. The older elements spread these groups into
// their entries (widget-elements.ts, widget-elements-1.2.ts); widget-elements.ts merges
// ELEMENTS_1_3_DISPLAY into API_ELEMENTS.

import type { ApiElementSpec, ApiShape } from "./widget-spec.ts";

const since = "1.3";

/** Window's (A7): the title menu's button. */
export const WINDOW_1_3 = {
  menuLabel: { type: "string", since, doc: 'The title menu\'s button ("3 hidden", "cmd · main"); without one, the checked entry\'s label, or "Options".' },
} as const;

/** ToolbarSearchField's events (A7): Return in the filter. */
export const SEARCH_EVENTS_1_3 = {
  onSubmit: { gesture: "submit", since, doc: "Return pressed, with the text (run the first match)." },
} as const;

/** Stat's (A8): its change as the kit's Delta. Its children came in 1.3 too (`childrenSince`). */
export const STAT_1_3 = {
  trend: { type: ["up", "down", "flat"], since, doc: "Which way `delta` went: draws it as a Delta (▲ 18%, coloured by `good`, dim when flat) instead of text in `deltaTone`." },
  good: { type: ["up", "down"], since, doc: "Which way is better for what it counts, with `trend`; without one the change stays neutral." },
} as const;

/** Sparkline's (A8): a colour of the chart palette. */
export const SPARKLINE_1_3 = {
  series: { type: [0, 1, 2, 3, 4, 5], since, doc: "Draws in the chart palette's nth colour, as charts colour their series (a stat's own: CPU 0, memory 1); `color` wins." },
} as const;

/** A time chart's change in its header (A9). */
const CHART_DELTA = {
  name: "ChartDelta",
  doc: 'A change against the period before, drawn as a Delta: "▲ 18%" in green when up is good, red when it isn\'t, dim when flat.',
  record: {
    text: { type: "string", required: true, doc: 'The change ("18%", `fmt.delta`; a leading sign is dropped).' },
    trend: { type: ["up", "down", "flat"], required: true, doc: "Which way it went." },
    good: { type: ["up", "down"], doc: "Which way is better; without one it stays neutral." },
  },
} as const satisfies ApiShape;

/** TimeSeries' and TimeBars' (A9): a detail's header, the value bold, its change and a note. */
export const TIME_CHART_1_3 = {
  delta: { type: CHART_DELTA, since, doc: "A change after the summary, drawn as a Delta. With it or a `note`, the summary is the chart's value, bold (a stat's detail)." },
  note: { type: "string", since, shows: "words", doc: 'Dim words after the change ("median 4m, 90% under 12m").' },
} as const;

/** ListRow's and TimelineEntry's (A10). */
export const REVEAL_1_3 = {
  reveal: { type: "boolean", since, doc: "Scrolled into view (to the nearest edge) when it becomes true: once per change, not on every redraw." },
} as const;

export const ELEMENTS_1_3_DISPLAY = {
  Dial: {
    doc: "A value to read across the room, in a ring that shows how much is left (a timer, a quota): as large as the view allows, so it goes alone in a View. With `editable`, a click on the value types a new one: Return sends it, Escape or leaving the field puts the value back.",
    since,
    props: {
      value: { type: "text", required: true, shows: "words", doc: 'The value, formatted ("12:30").' },
      label: { type: "string", required: true, shows: "title", doc: 'Its steady name ("Time"): its accessible name, the value its description.' },
      progress: { type: "number", doc: "How much of the ring is drawn, 0–1 (default 0: only the track)." },
      tone: { type: ["accent", "needs", "dim"], doc: '"accent" (default) while running, "needs" when done, "dim" paused or idle.' },
      caption: { type: "text", shows: "words", doc: 'A quiet line under the value ("ends 14:32").' },
      editable: { type: "boolean", doc: "A click on the value types a new one, sent to `onSubmit`." },
    },
    events: { onSubmit: { gesture: "submit", doc: 'Return pressed in the typed value, with the text as typed ("10", "1:30", "90s": parse it). Escape or leaving sends nothing.' } },
    children: "none",
  },
} as const satisfies Record<string, ApiElementSpec>;
