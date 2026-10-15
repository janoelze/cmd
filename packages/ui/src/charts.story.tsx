// The chart presets as the Stats widget holds them (docs/49): headline numbers with deltas
// and sparklines, bars per day with the period before and an average, stacked bars, rankings,
// shares, a year as a calendar, a week as a punch card, a distribution, budgets as meters.
// Scrub a chart: its header shows the bucket under the cursor; arrow keys do the same.
import { Calendar, ChartSummary, Delta, Distribution, Meter, PunchCard, Proportion, Ranking, TimeBars, TimeSeries } from "./charts.tsx";
import { Pane, Panes, Stat, Tiles, View } from "./frame.tsx";
import { PlotGroup } from "./plot.tsx";
import { Sparkline } from "./chart.tsx";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const today = new Date(2026, 9, 14).getTime();
/** Deterministic noise, so stories look the same every run. */
const noise = (i: number) => Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;
const days = (n: number) => Array.from({ length: n }, (_, i) => today - (n - 1 - i) * DAY);
const dur = (ms: number) => (ms >= HOUR ? `${Math.floor(ms / HOUR)}h${ms % HOUR >= 60_000 ? ` ${Math.round((ms % HOUR) / 60_000)}m` : ""}` : `${Math.round(ms / 60_000)}m`);
const num = (v: number) => (v >= 10_000 ? `${(v / 1000).toFixed(1)}K` : String(Math.round(v)));
const wd = (t: number) => new Date(t).toLocaleDateString("en", { weekday: "narrow" });
const long = (t: number) => new Date(t).toLocaleDateString("en", { weekday: "short", day: "numeric", month: "short" });

const week = days(7);
const agentTime = week.map((_, i) => (3 + 9 * noise(i + 1)) * HOUR);
const lastWeek = week.map((_, i) => (3 + 8 * noise(i + 40)) * HOUR);
const byAgent = [
  { key: "claude", label: "Claude", values: agentTime.map((v) => v * 0.78) },
  { key: "codex", label: "Codex", values: agentTime.map((v, i) => v * (0.12 + 0.05 * noise(i))) },
  { key: "gemini", label: "Gemini", values: agentTime.map((v, i) => v * 0.05 * noise(i + 9)) },
];

/** The Stats widget's overview: five numbers with deltas and sparklines, then agent time per day against last week, stacked by agent, and what ran most. */
export const Overview = () => (
  <div style={{ width: 860, height: 640, display: "flex" }}>
    <View inset>
      <Panes>
        <Pane wide>
          <Tiles min={120} gap={4}>
            <Stat label="Agent time" value="4d 7h" delta={<Delta text="+18%" trend="up" />} onSelect={() => {}}>
              <Sparkline values={agentTime} color="current" />
            </Stat>
            <Stat label="Active time" value="21h 40m" delta={<Delta text="−4%" trend="down" />} onSelect={() => {}}>
              <Sparkline values={lastWeek} color="neutral" />
            </Stat>
            <Stat label="Commands" value="1,284" delta={<Delta text="+9%" trend="up" />} onSelect={() => {}}>
              <Sparkline values={week.map((_, i) => 100 + 200 * noise(i + 3))} color="neutral" />
            </Stat>
            <Stat label="Failed" value="6.1%" delta={<Delta text="−1.2 pt" trend="down" good="down" />} onSelect={() => {}}>
              <Sparkline values={week.map((_, i) => 4 + 6 * noise(i + 5))} color="neutral" />
            </Stat>
            <Stat label="Tokens" value="3.4M" delta={<Delta text="+12%" trend="up" />} onSelect={() => {}}>
              <Sparkline values={[null, null, ...week.slice(2).map((_, i) => 300 + 600 * noise(i + 7))]} color="neutral" />
            </Stat>
          </Tiles>
        </Pane>
        <Pane title="Agent time" aside="per day">
          <TimeBars buckets={week} series={[{ key: "t", label: "Agent time", values: agentTime }]} previous={lastWeek} current={6} average format={dur} ticks="duration" xLabel={wd} longLabel={long} label="Agent time per day this week" summary={<><b className="ui-chart-value">4d 7h</b> this week</>} />
        </Pane>
        <Pane title="By agent" aside="per day">
          <TimeBars buckets={week} series={byAgent} format={dur} ticks="duration" xLabel={wd} longLabel={long} label="Agent time per day by agent" summary="Claude did most of it" />
        </Pane>
        <Pane title="Commands" aside="runs">
          <Ranking
            format={num}
            rows={[
              { key: "pnpm test", label: "pnpm test", value: 212, note: "9% failed" },
              { key: "git status", label: "git status", value: 148, note: "" },
              { key: "pnpm typecheck", label: "pnpm typecheck", value: 91, note: "3% failed" },
              { key: "pnpm e2e", label: "pnpm e2e", value: 40, note: "15% failed" },
              { key: "make", label: "make", value: 12, note: "" },
            ]}
            onSelect={() => {}}
          />
        </Pane>
        <Pane title="Turns" aside="how they ended">
          <Proportion
            format={num}
            parts={[
              { key: "done", label: "Done", value: 1269 },
              { key: "interrupted", label: "Interrupted", value: 46 },
              { key: "failed", label: "Failed", value: 39 },
            ]}
          />
        </Pane>
      </Panes>
    </View>
  </div>
);

/** Bars at other grains: the hours of today (the open hour in the accent, later hours empty), a year by week with the first weeks before the data started, and nothing at all. */
export const Bars = () => {
  const hours = Array.from({ length: 24 }, (_, i) => today + i * HOUR);
  const now = 15;
  const weeks = Array.from({ length: 53 }, (_, i) => today - (52 - i) * 7 * DAY);
  return (
    <div style={{ width: 560, display: "flex", flexDirection: "column", gap: 24, padding: 16 }}>
      <TimeBars buckets={hours} series={[{ key: "t", label: "Active", values: hours.map((_, i) => (i > now ? null : (i < 8 ? 0 : 20 + 40 * noise(i)) * 60_000)) }]} current={now} format={dur} ticks="duration" xLabel={(t) => String(new Date(t).getHours()).padStart(2, "0")} label="Active time per hour today" summary="Active 4h 20m today" />
      <TimeBars buckets={weeks} series={[{ key: "c", label: "Commits", values: weeks.map((_, i) => (i < 30 ? null : Math.round(80 * noise(i)))) }]} current={52} average format={num} xLabel={(t, i) => (i === 0 || new Date(t).getMonth() !== new Date(weeks[i - 1]!).getMonth() ? new Date(t).toLocaleDateString("en", { month: "short" }) : "")} longLabel={(t) => `Week of ${long(t)}`} label="Commits per week this year" summary="Counting since May" />
      <TimeBars buckets={week} series={[{ key: "n", label: "Pages", values: week.map(() => 0) }]} format={num} xLabel={wd} label="Pages per day" summary="No pages this week" />
    </div>
  );
};

/** A stat's detail: the header a ChartSummary (the value bold, its change, a dim note), as the Stats window's detail and a widget chart's `delta` and `note` draw it. */
export const Detail = () => (
  <div style={{ width: 560, padding: 16 }}>
    <TimeBars buckets={week} series={[{ key: "w", label: "Waiting on you", values: agentTime.map((v) => v / 6) }]} previous={lastWeek.map((v) => v / 6)} current={6} average format={dur} ticks="duration" xLabel={wd} longLabel={long} label="Waiting on you" height={200} summary={<ChartSummary value="6h 12m" delta={<Delta text="−8%" trend="down" good="down" />} note="median 2m, 90% under 14m" />} />
  </div>
);

/** Lines: one gauge filled under it with last week dashed, and three series over each other with a legend. Two charts in a PlotGroup scrub together. */
export const Lines = () => {
  const hours = Array.from({ length: 48 }, (_, i) => today - (47 - i) * HOUR);
  const mem = hours.map((_, i) => 400 + 120 * Math.sin(i / 6) + 40 * noise(i));
  return (
    <PlotGroup>
      <div style={{ width: 560, display: "flex", flexDirection: "column", gap: 24, padding: 16 }}>
        <TimeSeries buckets={hours} series={[{ key: "m", label: "Core memory", values: mem }]} previous={mem.map((v, i) => v * 0.9 + 30 * noise(i + 2))} format={(v) => `${Math.round(v)} MB`} xLabel={(t) => String(new Date(t).getHours()).padStart(2, "0")} longLabel={(t) => new Date(t).toLocaleString("en", { weekday: "short", hour: "2-digit", minute: "2-digit" })} label="Core memory, last two days" summary="412 MB now" />
        <TimeSeries buckets={hours} series={["journal", "names", "notify"].map((k, j) => ({ key: k, label: k, values: hours.map((_, i) => Math.round(10 * noise(i + j * 50) * (j + 1))) }))} format={num} xLabel={(t) => String(new Date(t).getHours()).padStart(2, "0")} label="Model calls per hour by feature" summary="Model calls by feature" />
      </div>
    </PlotGroup>
  );
};

/** One line at the widths a chart gets, from a narrow widget to a wide window: the stroke stays 2 px. */
export const LineWidths = () => {
  const hours = Array.from({ length: 48 }, (_, i) => today - (47 - i) * HOUR);
  const mem = hours.map((_, i) => 400 + 120 * Math.sin(i / 6) + 40 * noise(i));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24, padding: 16 }}>
      {[220, 480, 760, 1100].map((w) => (
        <div key={w} style={{ width: w }}>
          <TimeSeries buckets={hours} series={[{ key: "m", label: "Core memory", values: mem }]} previous={mem.map((v, i) => v * 0.9 + 30 * noise(i + 2))} format={(v) => `${Math.round(v)} MB`} xLabel={(t) => String(new Date(t).getHours()).padStart(2, "0")} label={`Core memory at ${w} px`} summary={`${w} px`} />
        </div>
      ))}
    </div>
  );
};

/** A year of active time as a calendar, and when you work as a punch card (weekday × hour). */
export const Heat = () => {
  const year = Array.from({ length: 365 }, (_, i) => (i < 40 ? null : noise(i) < 0.15 ? 0 : noise(i + 1) * 8 * HOUR));
  const rows = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const punch = rows.map((_, d) => Array.from({ length: 24 }, (_, h) => (h < 8 || h > 21 ? (noise(d * 24 + h) < 0.8 ? 0 : 5) : (d > 4 ? 10 : 40) * noise(d * 24 + h + 3))));
  return (
    <div style={{ width: 760, display: "flex", flexDirection: "column", gap: 24, padding: 16 }}>
      <Calendar start={today - 364 * DAY} values={year} format={dur} label="Active time, the last year" dayLabel={long} />
      <PunchCard values={punch} rows={rows} format={(v) => `${Math.round(v)}m`} label="When you work" />
    </div>
  );
};

/** How long commands take (log bins, median and 90th percentile marked), and budgets as meters: under, near and over. */
export const Spread = () => {
  const edges = Array.from({ length: 22 }, (_, i) => Math.pow(2, (i + 14) / 2));
  const bins = edges.slice(0, -1).map((lo, i) => ({ lo, hi: edges[i + 1]!, n: Math.round(60 * Math.exp(-((i - 8) ** 2) / 12) + 4 * noise(i)) }));
  return (
    <div style={{ width: 480, display: "flex", flexDirection: "column", gap: 24, padding: 16 }}>
      <Distribution bins={bins} p50={bins[8]!.lo} p90={bins[13]!.lo} format={(ms) => (ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`)} label="Command time" />
      <Meter label="Tokens this month" value={2_400_000} max={5_000_000} target={4_000_000} bands={[3_000_000, 4_000_000]} format={(v) => `${(v / 1e6).toFixed(1)}M`} />
      <Meter label="Disk for the event log" value={2.7} max={3} bands={[2, 2.5]} format={(v) => `${v.toFixed(1)} GB`} />
      <Meter label="Over a limit" value={6.2} max={5} format={(v) => `${v.toFixed(1)} GB`} />
    </div>
  );
};
