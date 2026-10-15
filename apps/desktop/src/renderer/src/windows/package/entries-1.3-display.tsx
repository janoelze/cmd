// API 1.3's display pieces that translate (protocol widget-elements-1.3-display.ts; docs/57
// A6–A9), each drawn by the kit piece the native view draws with, so a port looks the same:
// - Dial: the Timer's ring. The typed text stays here (as a TextField's draft does) and reaches
//   the process only on Return, as `onSubmit`; Escape or leaving the field puts the value back.
// - Stat: with `trend`, its `delta` is the kit's Delta (as the Stats window's tiles draw it),
//   else text in `deltaTone`; its children (a Sparkline) go inside the tile, as wide as it.
// - A time chart's header (entries-1.2.tsx's TimeSeries and TimeBars take it from here): with a
//   `delta` or a `note`, the summary is the value of a ChartSummary, as a stat's detail has it.
// Window `menuLabel` is chrome.ts's, ToolbarSearchField `onSubmit` and ListRow `reveal`
// elements.tsx's entries; TimelineEntry's `reveal` and Sparkline's `series` the kit's own props.

import { ChartSummary, Delta, Dial, Stat, type Tone } from "@cmd/ui";
import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import type { ApiElement, WireValue } from "@cmd/protocol";
import { on, press, str, v, type Drawn } from "./draw.ts";

type Trend = "up" | "down" | "flat";

function DialEntry({ p, ctx }: Drawn) {
  const submit = on(ctx, p.onSubmit, "onSubmit");
  const value = String(v<string | number>(p.value) ?? "");
  const editable = p.editable === true;
  const [draft, setDraft] = useState<string | null>(null);
  // No longer editable (the timer started elsewhere): the draft goes.
  useEffect(() => {
    if (!editable) setDraft(null);
  }, [editable]);
  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    submit?.(draft);
  };
  return (
    <Dial
      label={str(p.label) ?? ""}
      value={value}
      progress={v<number>(p.progress) ?? 0}
      tone={v<"accent" | "needs" | "dim">(p.tone)}
      caption={v<string | number>(p.caption)}
      onEdit={editable ? () => setDraft(value) : undefined}
      edit={draft === null ? undefined : { text: draft, onChange: setDraft, onCommit: commit, onCancel: () => setDraft(null), blur: "cancel" }}
    />
  );
}

function StatEntry({ p, ctx, children }: Drawn) {
  const trend = v<Trend>(p.trend);
  const text = v<string | number>(p.delta);
  const delta = text === undefined ? undefined : trend ? <Delta text={String(text)} trend={trend} good={v<"up" | "down">(p.good)} /> : text;
  return (
    <Stat label={str(p.label) ?? ""} value={v<string | number>(p.value) ?? ""} unit={str(p.unit)} delta={delta} deltaTone={trend ? undefined : v<Tone>(p.deltaTone)} onSelect={press(ctx, p.onSelect, "onSelect")}>
      {children}
    </Stat>
  );
}

/** A time chart's header: its summary, or with a `delta` or `note` (1.3) the summary as the value, the change and the note. */
export function chartSummary(p: Record<string, WireValue>): ReactNode {
  const summary = str(p.summary);
  const d = v<{ text: string; trend: Trend; good?: "up" | "down" }>(p.delta);
  const note = str(p.note);
  if (!d && !note) return summary;
  return <ChartSummary value={summary} delta={d ? <Delta text={d.text} trend={d.trend} good={d.good} /> : undefined} note={note} />;
}

/** The 1.3 display elements that translate, and what draws each. */
export type Translated13Display = "Dial" | "Stat";
export const ENTRIES_1_3_DISPLAY: { readonly [K in Translated13Display & ApiElement]: ComponentType<Drawn> } = {
  Dial: DialEntry,
  Stat: StatEntry,
};
