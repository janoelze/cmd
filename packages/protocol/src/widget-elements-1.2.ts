// API 1.2's elements (docs/57, "Elements for the ports"): the window-content kit cmd's own
// widgets draw with, so a built-in ported to a package looks like the view it replaces.
// Layout (Panes, Pane, Panel, PanelBody, ListGroup), lists (ListRowActions, ListValue),
// content (CodeBlock, Icon, Mark, Delta, Spinner, StatusLine), controls (IconButton,
// LinkButton, TextField), charts (TimeSeries, TimeBars, TimeBar, Ranking, Proportion,
// PunchCard, Calendar, Timeline, TimelineEntry, Ribbon) and DataGrid. Props are data:
// a chart's values are numbers and strings, its formatting a `unit`, never a function.
// widget-elements.ts merges these into API_ELEMENTS.

import { BREAKS, DISABLED, LIGHTS, SYMBOL, UNITS, pick, press, typed, type ApiElementSpec, type ApiShape } from "./widget-spec.ts";

const since = "1.2";
const UNIT = { type: UNITS, doc: "How its values read: counts (the default), `ms` as durations, bytes, tokens, percent." } as const;
const LABEL = { type: "string", required: true, shows: "title", doc: "What it shows, in words: its header without a summary, and its accessible name." } as const;

// The records inside props, each named as @cmd/widget-api names it.
const SERIES = {
  name: "ChartSeries",
  doc: "One series of a chart: a key, its name in the legend and the readout, and a value per bucket (null: no data).",
  list: {
    key: { type: "string", required: true, doc: "Unique among the series." },
    label: { type: "string", required: true, doc: "Its name in the legend and the readout." },
    values: { type: "numbers", required: true, doc: "One per bucket, in order; null for no data." },
  },
} as const satisfies ApiShape;
const RANKING_ROW = {
  name: "RankingRow",
  doc: "A row of a Ranking: what it is, its value, and a note after the value.",
  list: {
    key: { type: "string", required: true, doc: "Unique among the rows; what `onSelect` says." },
    label: { type: "text", required: true, doc: "What it is." },
    value: { type: "number", required: true, doc: "Its value, in the Ranking's unit." },
    note: { type: "text", doc: 'A second number after the value ("9% failed").' },
  },
} as const satisfies ApiShape;
const PART = {
  name: "ProportionPart",
  doc: "A part of a Proportion's whole.",
  list: {
    key: { type: "string", required: true, doc: "Unique among the parts." },
    label: { type: "string", required: true, doc: "Its name." },
    value: { type: "number", required: true, doc: "Its share, in the Proportion's unit." },
  },
} as const satisfies ApiShape;
const RIBBON_ITEM = {
  name: "RibbonItem",
  doc: "A bar of a Ribbon: from `start` to `end` (ms), in a hue.",
  list: {
    id: { type: "string", required: true, doc: "Unique among the items; what `onPick` says." },
    start: { type: "number", required: true, doc: "When it starts, in ms since the epoch." },
    end: { type: "number", required: true, doc: "When it ends." },
    hue: { type: "number", required: true, doc: "Its colour as a hue (0–360): a kind's or a project's." },
    label: { type: "string", required: true, doc: "Its tooltip and accessible name." },
  },
} as const satisfies ApiShape;
const TICK = {
  name: "RibbonTick",
  doc: "A tick under a Ribbon: a time and its label.",
  list: {
    at: { type: "number", required: true, doc: "When, in ms since the epoch." },
    label: { type: "string", required: true, doc: 'Its label ("14:00").' },
  },
} as const satisfies ApiShape;
const COLUMN = {
  name: "GridColumn",
  doc: "A column of a DataGrid.",
  list: {
    key: { type: "string", required: true, doc: "Unique among the columns; what a sort names." },
    label: { type: "string", required: true, doc: "Its header (empty for an icon column)." },
    note: { type: "string", doc: "A second line under the header (a unit, a type)." },
    align: { type: ["start", "end"], doc: '"end" for numbers.' },
    grow: { type: "boolean", doc: "Takes the width left over (the name column)." },
    hide: { type: BREAKS, doc: "Dropped while the table is narrower than this size class: the columns that matter least." },
    icon: { type: "boolean", doc: "Its cells are SF Symbol names, drawn as icons (with the row's `light`): as narrow as an icon." },
    dim: { type: "boolean", doc: "Its values in the dim tone (a detail beside the name)." },
  },
} as const satisfies ApiShape;
const ROW = {
  name: "GridRow",
  doc: "A row of a DataGrid: its key and a value per column.",
  list: {
    key: { type: "string", required: true, doc: "Unique among the rows; what `selected` and the row events say." },
    cells: { type: "cells", required: true, doc: "A value per column, in the columns' order: text, a number, or null for nothing." },
    light: { type: LIGHTS, doc: "A status light in place of the icon column's icon (a busy terminal)." },
    tip: { type: "string", doc: "A tooltip on the row's name." },
    heading: { type: "boolean", doc: "A section's heading: its cells are the section's name and totals; not selectable." },
    depth: { type: "number", doc: "Nested this deep under the row before it (1: a child)." },
    expanded: { type: "boolean", doc: "Has rows nested under it: a disclosure, open or not (`onToggle`)." },
  },
} as const satisfies ApiShape;
const SORT = {
  name: "GridSort",
  doc: "A DataGrid's sort: a column's key, and whether it is descending.",
  record: {
    key: { type: "string", required: true, doc: "The column's key." },
    desc: { type: "boolean", required: true, doc: "Descending." },
  },
} as const satisfies ApiShape;

/** The props TimeSeries and TimeBars share. */
const TIME_CHART = {
  buckets: { type: "numbers", required: true, doc: "Each bucket's start, in ms since the epoch." },
  series: { type: SERIES, required: true, doc: "One series, or several (stacked bars, lines over each other)." },
  labels: { type: "strings", required: true, doc: 'Each bucket\'s short label on the x axis ("M", "14"), in order.' },
  longLabels: { type: "strings", doc: 'Each bucket\'s long label, in the readout under the cursor ("Mon 14 Oct"); `labels` without.' },
  previous: { type: "numbers", doc: "The same buckets one period earlier." },
  current: { type: "number", nullable: true, doc: "The bucket that matters (today), by index: in the accent." },
  unit: UNIT,
  label: LABEL,
  summary: { type: "string", shows: "words", doc: 'Its header ("Active 3h 12m"), replaced by the bucket under the cursor.' },
  height: { type: "number", doc: "In px (default 120)." },
  fill: { type: "boolean", doc: "As tall as its pane, instead of `height`." },
} as const;
const BUCKET = pick("A bucket was clicked: its index.", "number");

export const ELEMENTS_1_2 = {
  // ── layout ──
  Panes: { doc: "A dashboard's sections: one column, two side by side once the window is wide.", since, props: {}, events: {}, children: "elements", childrenDoc: "Its Panes." },
  Pane: {
    doc: "One section of Panes: a title line, then its content.",
    since,
    props: {
      title: { type: "string", shows: "title", doc: "Its name." },
      aside: { type: "text", shows: "words", doc: "At the title's right: a count, a unit." },
      wide: { type: "boolean", doc: "Spans every column." },
    },
    events: {},
    children: "elements",
    childrenDoc: "What the section shows.",
  },
  Panel: { doc: "A frame for a list that runs to the window's edges: a WindowToolbar over a PanelBody.", since, props: {}, events: {}, children: "elements", childrenDoc: "A WindowToolbar, then a PanelBody." },
  PanelBody: { doc: "A Panel's scrolling body.", since, props: {}, events: {}, children: "elements", childrenDoc: "Its rows." },
  ListGroup: { doc: "Rows without a heading: a list's main action, above its sections.", since, props: {}, events: {}, children: "elements", childrenDoc: "Its ListRows." },

  // ── lists ──
  ListRowActions: {
    doc: "Buttons a row shows while the pointer is over it (Run, Stop), in place of its end. Pressing one doesn't press the row.",
    since,
    props: {},
    events: {},
    children: "elements",
    childrenDoc: "IconButtons, or a small Button.",
  },
  ListValue: { doc: "A number at a row's end, in even-width digits (CPU, a duration).", since, props: { strong: { type: "boolean", doc: "In the text colour instead of dim." } }, events: {}, children: "text", childrenDoc: "The value, formatted." },

  // ── content ──
  CodeBlock: {
    doc: "Output, an error, a command, a record: monospaced, wrapped, scrolling past a height.",
    since,
    props: {
      maxHeight: { type: "number", doc: "In px before it scrolls (default 180)." },
      tone: { type: ["danger"], doc: '"danger" for an error.' },
    },
    events: {},
    children: "text",
    childrenDoc: "The text, as it is.",
  },
  Icon: {
    doc: "An SF Symbol on its own (in a line of text, a status line).",
    since,
    props: {
      name: { type: "string", required: true, doc: SYMBOL },
      size: { type: [12, 13, 14, 20, 22], doc: "In points: 12 small, 13 a row's, 14 a toolbar's (default), 20 an empty state's, 22 a feature's." },
      weight: { type: ["regular", "medium", "semibold", "bold"], doc: "Its stroke (default medium)." },
    },
    events: {},
    children: "none",
  },
  Mark: {
    doc: "An icon that gives way to a status light when there is one: a row's, or one in a line of text.",
    since,
    props: {
      icon: { type: "string", required: true, doc: SYMBOL },
      light: { type: LIGHTS, doc: "The status light that takes the icon's place." },
      tone: { type: [...LIGHTS, "dim"], doc: "Colours the icon." },
    },
    events: {},
    children: "none",
  },
  Delta: {
    doc: "A change against the period before: ▲ 18% in green when up is good, red when it isn't, dim when flat.",
    since,
    props: {
      text: { type: "string", required: true, shows: "words", doc: 'The change ("18%"; a leading sign is dropped).' },
      trend: { type: ["up", "down", "flat"], required: true, doc: "Which way it went." },
      good: { type: ["up", "down"], doc: "Which way is better; without one it stays neutral." },
    },
    events: {},
    children: "none",
  },
  Spinner: {
    doc: "Something is happening, in a row or a status line. A view that is loading says so with its `state` instead.",
    since,
    props: {
      size: { type: [10, 12, 14, 16], doc: "In px (default 12)." },
      label: { type: "string", shows: "title", doc: "Its accessible name." },
    },
    events: {},
    children: "none",
  },
  StatusLine: {
    doc: "A view's footer: one quiet line under the content (counts, where it runs). In a View it sits at the bottom edge.",
    since,
    props: {
      end: { type: "text", shows: "words", doc: "At the line's right (a branch, a folder)." },
      action: { type: "action", doc: "A quiet link at the line's right (Task Manager)." },
    },
    events: {},
    children: "any",
    childrenDoc: "The line: words, and a Spinner or an Icon among them.",
  },

  // ── controls ──
  IconButton: {
    doc: "A button that is an icon alone (a row's Run, a bar's Refresh).",
    since,
    props: {
      icon: { type: "string", required: true, doc: SYMBOL },
      label: { type: "string", required: true, shows: "title", doc: "Its tooltip and accessible name." },
      size: { type: ["sm", "md", "lg"], doc: '"sm" in a row, "md" (default) elsewhere.' },
      variant: { type: ["ghost", "default"], doc: '"ghost" (default) for bars and rows, "default" for a filled square beside other controls.' },
      pressed: { type: "boolean", doc: "On (a mode that is active)." },
      tone: { type: ["accent", "needs"], doc: "Its icon in a tone: accent (something is on), needs (it needs a look)." },
      pulse: { type: "boolean", doc: "The icon pulses: something waits for an answer." },
      disabled: DISABLED,
    },
    events: { onClick: press("Pressed.") },
    children: "none",
  },
  LinkButton: {
    doc: "An action inside running text or a dim line: coloured text, no box.",
    since,
    props: {
      tone: { type: ["accent", "dim", "danger"], doc: '"accent" (default), "dim" in a footer, "danger".' },
      disabled: DISABLED,
    },
    events: { onClick: press("Pressed.") },
    children: "text",
    childrenDoc: "Its words.",
  },
  TextField: {
    doc: "A text field in the body (a form, a length to type). The app keeps the caret and sends what is typed, debounced; a filter belongs in the toolbar (ToolbarSearchField).",
    since,
    props: {
      value: { type: "string", required: true, shows: "words", doc: "The text in it." },
      placeholder: { type: "string", doc: "Shown while it is empty." },
      label: { type: "string", doc: "Its accessible name, when the placeholder doesn't say what it is." },
      icon: { type: "string", doc: "An SF Symbol name before the text." },
      code: { type: "boolean", doc: "Commands, paths, keys: the monospaced font." },
      size: { type: ["sm", "md", "lg"], doc: '"sm", "md" (default) or "lg".' },
      fill: { type: "boolean", doc: "As wide as its container (default 240 px)." },
      invalid: { type: "boolean", doc: "Marked as not what it should be." },
      disabled: DISABLED,
    },
    events: { onChange: typed("The text as typed (debounced by the app, which keeps the caret)."), onSubmit: { gesture: "submit", doc: "Return pressed, with the text." } },
    children: "none",
  },

  // ── charts ──
  TimeSeries: {
    doc: "Lines over time buckets, filled under when there's one; the period before dashed. For rates, gauges and running totals.",
    since,
    props: { ...TIME_CHART, area: { type: "boolean", doc: "Fills under a single line (default true)." } },
    events: { onSelect: BUCKET },
    children: "none",
  },
  TimeBars: {
    doc: "Bars over time buckets: the current one in the accent, the period before as ticks, an average line. The chart most stats want.",
    since,
    props: { ...TIME_CHART, average: { type: "boolean", doc: "A dashed line at the mean of the buckets with data." } },
    events: { onSelect: BUCKET },
    children: "none",
  },
  TimeBar: {
    doc: "A track's position (a song's, a video's): played in the accent, moving on by itself while playing. Click or drag to seek.",
    since,
    props: {
      duration: { type: "number", required: true, doc: "Its length, in seconds." },
      time: { type: "number", required: true, doc: "Where it is now, in seconds." },
      playing: { type: "boolean", doc: "Moves on by itself from `time` (send a new `time` only when the player reports one)." },
      rate: { type: "number", doc: "How fast it moves while playing (default 1)." },
      label: { type: "string", shows: "title", doc: 'Its accessible name (default "Position").' },
    },
    events: { onSeek: pick("Seeked: the time let go at, in seconds.", "number") },
    children: "none",
  },
  Ranking: {
    doc: "A ranked list with a bar per row (most used, slowest): label, bar, value.",
    since,
    props: {
      rows: { type: RANKING_ROW, required: true, doc: "The rows, in the order shown." },
      unit: UNIT,
      max: { type: "number", doc: "The value of a full bar (default the largest)." },
      empty: { type: "string", doc: 'Shown without rows (default "Nothing yet").' },
    },
    events: { onSelect: pick("A row was pressed: its key. Rows are buttons only with it.", "string") },
    children: "none",
  },
  Proportion: {
    doc: "Shares of a whole as one bar split by part, with labels and percentages under it. Instead of a pie.",
    since,
    props: { parts: { type: PART, required: true, doc: "The parts, in order." }, unit: UNIT },
    events: {},
    children: "none",
  },
  PunchCard: {
    doc: "When things happen: rows (weekdays) × the 24 hours, five levels of one hue.",
    since,
    props: {
      values: { type: "matrix", required: true, doc: "values[row][hour]: 24 numbers per row." },
      rows: { type: "strings", required: true, doc: 'Each row\'s label ("Mon"), in order.' },
      unit: UNIT,
      label: LABEL,
    },
    events: {},
    children: "none",
  },
  Calendar: {
    doc: "A run of days (a year) as weeks × weekdays, five levels of one hue, empty days still visible.",
    since,
    props: {
      start: { type: "number", required: true, doc: "The first day, in ms since the epoch." },
      values: { type: "numbers", required: true, doc: "One per day from `start`; null for no data." },
      unit: UNIT,
      firstDay: { type: [0, 1, 6], doc: "The week's first day: 0 Sunday, 1 Monday (default), 6 Saturday." },
      label: LABEL,
      dayLabels: { type: "strings", doc: "Each day's name in the readout, in order (default the date)." },
    },
    events: { onSelect: pick("A day with data was clicked: its start, in ms.", "number") },
    children: "none",
  },
  Timeline: { doc: "Entries down a rail, in the order given (newest or oldest first).", since, props: {}, events: {}, children: "elements", childrenDoc: "Its TimelineEntries." },
  TimelineEntry: {
    doc: "One entry of a Timeline: its time, a mark in its hue on the rail, then what happened.",
    since,
    props: {
      time: { type: "text", required: true, shows: "words", doc: 'Its time ("14:05").' },
      hue: { type: "number", required: true, doc: "The mark's hue (0–360): its kind's or project's." },
      label: { type: "string", doc: "The mark's tooltip." },
      picked: { type: "boolean", doc: "Rings the mark (the entry picked in a Ribbon)." },
    },
    events: {},
    children: "any",
    childrenDoc: "What happened: Text, and more.",
  },
  Ribbon: {
    doc: "Bars between two times on lanes (parallel work on lanes of its own), ticks under them; a click picks one.",
    since,
    props: {
      items: { type: RIBBON_ITEM, required: true, doc: "The bars." },
      from: { type: "number", required: true, doc: "Its left edge, in ms since the epoch." },
      to: { type: "number", required: true, doc: "Its right edge." },
      ticks: { type: TICK, required: true, doc: "The ticks under it." },
      picked: { type: "string", nullable: true, doc: "The picked item's id." },
    },
    events: { onPick: pick("A bar was clicked: its id.", "string") },
    children: "none",
  },

  // ── data ──
  DataGrid: {
    doc: "A table: rows and columns of values, a header that sorts, columns that drop as the window narrows. For records; a list of things to open is a List.",
    since,
    props: {
      columns: { type: COLUMN, required: true, doc: "The columns, in order." },
      rows: { type: ROW, required: true, doc: "The rows, in order." },
      sort: { type: SORT, nullable: true, doc: "The column it is sorted by, shown in its header." },
      selected: { type: "string", nullable: true, doc: "The selected row's key." },
      mono: { type: "boolean", doc: "Values in the monospaced font (data, not labels)." },
      numbered: { type: "boolean", doc: "A row number before each row." },
      headless: { type: "boolean", doc: "No header, where the values say what they are." },
    },
    events: {
      onSort: { ...pick("A header was clicked: the next sort (ascending, then descending, then none). The header sorts only with it.", SORT), nullable: true },
      onRowClick: pick("A row was clicked: its key.", "string"),
      onRowDoubleClick: pick("A row was double-clicked: its key.", "string"),
      onToggle: pick("A row's disclosure was clicked: its key.", "string"),
    },
    children: "none",
  },
} as const satisfies Record<string, ApiElementSpec>;
