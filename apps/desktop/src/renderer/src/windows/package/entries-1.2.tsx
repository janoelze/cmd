// The API 1.2 elements that translate (protocol widget-elements-1.2.ts; the rest are the kit
// component of the same name, elements.tsx's KIT). Each for a reason the kit's props can't
// cross the wire as they are:
// - StatusLine: its `action` is data, drawn as a dim LinkButton at the line's end (the View
//   puts the line in its footer, elements.tsx).
// - TextField: the caret and the draft stay here, the value goes to the process debounced,
//   as ToolbarField's does.
// - The time charts, Ranking, Proportion, PunchCard, Calendar: the kit takes functions
//   (`format`, `xLabel`, `dayLabel`); the API takes a `unit` (protocol format.ts formats it, as
//   the Stats window does) and labels as strings.
// - Frame: a page of the package in the shared frame host (FrameElement.tsx), its label
//   standing in where pixels aren't drawn.
// - DataGrid: columns and rows are data; a row's cells become the kit's cells (an icon
//   column's a Mark, a dim column's dim text), its key the row's, `selected` a key.

import { Calendar, DataGrid, LinkButton, Mark, Proportion, PunchCard, Ranking, StatusLine, Text, TextField, TimeBars, TimeSeries, type DotState, type GridCell, type GridColumn, type GridSort } from "@cmd/ui";
import { formatValue, type ApiElement, type StatUnit, type WireValue } from "@cmd/protocol";
import type { ComponentType } from "react";
import { on, press, str, useDraft, v, type Drawn } from "./draw.ts";
import { FrameElement } from "./FrameElement.tsx";
import { chartSummary } from "./entries-1.3-display.tsx";

/** A unit prop's formatter: short, as charts' ticks and readouts are. */
const fmt = (p: Record<string, WireValue>) => {
  const unit = (str(p.unit) ?? "count") as StatUnit;
  return (x: number) => formatValue(x, unit, true);
};
const strings = (x: WireValue | undefined): string[] => (Array.isArray(x) ? (x as string[]) : []);
const numbers = (x: WireValue | undefined): (number | null)[] => (Array.isArray(x) ? (x as (number | null)[]) : []);
const pick = <T,>(ctx: Drawn["ctx"], ref: WireValue | undefined, event: string) => {
  const fn = on(ctx, ref, event);
  return fn && ((x: T) => fn(x as WireValue));
};

function StatusLineEntry({ p, ctx, children }: Drawn) {
  const a = v<{ label: string; run: WireValue }>(p.action);
  const end = p.end ?? null;
  return (
    <StatusLine
      end={
        end !== null || a ? (
          <>
            {end}
            {a && (
              <LinkButton tone="dim" onClick={press(ctx, a.run, "run")}>
                {a.label}
              </LinkButton>
            )}
          </>
        ) : undefined
      }
    >
      {children}
    </StatusLine>
  );
}

function TextFieldEntry({ p, ctx }: Drawn) {
  const submit = on(ctx, p.onSubmit, "onSubmit");
  const [draft, setDraft, flush] = useDraft(str(p.value) ?? "", on(ctx, p.onChange, "onChange"));
  return (
    <TextField
      value={draft}
      onChange={setDraft}
      onBlur={() => void flush()}
      onKeyDown={(e) => {
        if (e.key === "Enter") submit?.(flush());
      }}
      placeholder={str(p.placeholder)}
      aria-label={str(p.label) ?? str(p.placeholder)}
      icon={str(p.icon)}
      code={p.code === true}
      size={v<"sm" | "md" | "lg">(p.size)}
      fill={p.fill === true}
      invalid={p.invalid === true}
      disabled={p.disabled === true}
    />
  );
}

/** TimeSeries' and TimeBars' props as the kit takes them. */
function timeChart({ p, ctx }: Drawn) {
  const labels = strings(p.labels);
  const long = p.longLabels ? strings(p.longLabels) : labels;
  return {
    buckets: numbers(p.buckets) as number[],
    series: v<{ key: string; label: string; values: (number | null)[] }[]>(p.series) ?? [],
    previous: p.previous ? numbers(p.previous) : undefined,
    current: v<number>(p.current) ?? null,
    format: fmt(p),
    ticks: str(p.unit) === "ms" ? ("duration" as const) : ("number" as const),
    xLabel: (_: number, i: number) => labels[i] ?? "",
    longLabel: (_: number, i: number) => long[i] ?? labels[i] ?? "",
    label: str(p.label) ?? "",
    summary: chartSummary(p),
    height: p.fill === true ? ("fill" as const) : v<number>(p.height),
    onSelect: pick<number>(ctx, p.onSelect, "onSelect"),
  };
}

function TimeSeriesEntry(d: Drawn) {
  return <TimeSeries {...timeChart(d)} area={d.p.area !== false} />;
}
function TimeBarsEntry(d: Drawn) {
  return <TimeBars {...timeChart(d)} average={d.p.average === true} />;
}

function RankingEntry({ p, ctx }: Drawn) {
  const rows = v<{ key: string; label: string | number; value: number; note?: string | number }[]>(p.rows) ?? [];
  return <Ranking rows={rows} format={fmt(p)} max={v<number>(p.max)} empty={str(p.empty)} onSelect={pick<string>(ctx, p.onSelect, "onSelect")} />;
}

function ProportionEntry({ p }: Drawn) {
  return <Proportion parts={v<{ key: string; label: string; value: number }[]>(p.parts) ?? []} format={fmt(p)} />;
}

function PunchCardEntry({ p }: Drawn) {
  return <PunchCard values={v<number[][]>(p.values) ?? []} rows={strings(p.rows)} format={fmt(p)} label={str(p.label) ?? ""} />;
}

function CalendarEntry({ p, ctx }: Drawn) {
  const start = v<number>(p.start) ?? 0;
  const days = p.dayLabels ? strings(p.dayLabels) : null;
  const dayOf = (t: number) => Math.round((new Date(t).setHours(12) - new Date(start).setHours(12)) / 86_400_000);
  return (
    <Calendar
      start={start}
      values={numbers(p.values)}
      format={fmt(p)}
      firstDay={v<number>(p.firstDay)}
      label={str(p.label) ?? ""}
      dayLabel={days ? (t) => days[dayOf(t)] ?? new Date(t).toDateString() : undefined}
      onSelect={pick<number>(ctx, p.onSelect, "onSelect")}
    />
  );
}

type Column = { key: string; label: string; note?: string; align?: "start" | "end"; grow?: boolean; hide?: "narrow" | "regular"; icon?: boolean; dim?: boolean };
type Row = { key: string; cells: (string | number | null)[]; light?: DotState; tip?: string; heading?: boolean; depth?: number; expanded?: boolean };

function DataGridEntry({ p, ctx }: Drawn) {
  const columns = v<Column[]>(p.columns) ?? [];
  const rows = v<Row[]>(p.rows) ?? [];
  const grow = Math.max(0, columns.findIndex((c) => c.grow));
  const kit: GridColumn[] = columns.map((c) => ({ key: c.key, label: c.label, note: c.note, align: c.align, grow: c.grow, hide: c.hide, icon: c.icon }));
  const cell = (r: Row, x: string | number | null | undefined, j: number): GridCell => {
    const c = columns[j];
    if (c?.icon) return typeof x === "string" && x ? <Mark icon={x} light={r.light} /> : null;
    if (x === null || x === undefined) return null;
    const node = c?.dim ? <Text tone="dim">{x}</Text> : x;
    return { node, kind: c?.align === "end" ? "number" : undefined, tip: j === grow ? r.tip : undefined };
  };
  const key = (i: number) => rows[i]?.key ?? String(i);
  const row = (event: "onRowClick" | "onRowDoubleClick") => {
    const fn = pick<string>(ctx, p[event], event);
    return fn && ((i: number) => fn(key(i)));
  };
  const toggle = pick<string>(ctx, p.onToggle, "onToggle");
  const sort = pick<{ key: string; desc: boolean } | null>(ctx, p.onSort, "onSort");
  const selected = str(p.selected);
  const index = selected === undefined ? -1 : rows.findIndex((r) => r.key === selected);
  const nested = rows.some((r) => r.heading || r.depth || r.expanded !== undefined);
  return (
    <DataGrid
      columns={kit}
      rows={rows.map((r) => columns.map((_, j) => cell(r, r.cells[j], j)))}
      rowKey={(_, i) => key(i)}
      sort={v<GridSort>(p.sort) ?? null}
      onSort={sort && ((s) => sort(s ? { key: s.key, desc: s.desc } : null))}
      onRowClick={row("onRowClick")}
      onRowDoubleClick={row("onRowDoubleClick")}
      rowInfo={nested ? (i) => ({ heading: rows[i]?.heading, depth: rows[i]?.depth, expanded: rows[i]?.expanded, onToggle: toggle && (() => toggle(key(i))) }) : undefined}
      selected={index >= 0 ? index : null}
      mono={p.mono === true}
      numbered={p.numbered === true}
      headless={p.headless === true}
    />
  );
}

/** The 1.2 elements that translate, and what draws each. */
export type Translated12 = "Frame" | "StatusLine" | "TextField" | "TimeSeries" | "TimeBars" | "Ranking" | "Proportion" | "PunchCard" | "Calendar" | "DataGrid";
export const ENTRIES_1_2: { readonly [K in Translated12 & ApiElement]: ComponentType<Drawn> } = {
  Frame: FrameElement,
  StatusLine: StatusLineEntry,
  TextField: TextFieldEntry,
  TimeSeries: TimeSeriesEntry,
  TimeBars: TimeBarsEntry,
  Ranking: RankingEntry,
  Proportion: ProportionEntry,
  PunchCard: PunchCardEntry,
  Calendar: CalendarEntry,
  DataGrid: DataGridEntry,
};
