// API 1.3's display pieces in a usage dashboard (docs/57 A7–A11): tiles as the Stats window
// draws them (the value, its change as a Delta coloured by the stat's `good`, a sparkline in
// its own colour inside the tile), a stat's detail with its change and a note in the chart's
// header, and the stats as a filtered list (Return opens the first match, the open row
// scrolled into view). Numbers are written by cmd's own formatters (`fmt.value`, `fmt.delta`).
// The Workbench draws it beside the native Stats window (windows/package/display.story.tsx).

import { Window, View, WindowToolbar, ToolbarSearchField, Stack, Tiles, Stat, Sparkline, Panes, Pane, TimeBars, List, ListRow, ListRowContent, ListRowEnd, Chip, useData, useStoredState, cmd, fmt, type Unit } from "@cmd/widget-api";

const STATS = [
  { id: "agents.time", label: "Agent time" },
  { id: "you.active", label: "Active time" },
  { id: "agents.turns", label: "Turns" },
  { id: "commands.runs", label: "Commands" },
  { id: "commands.failrate", label: "Failed commands" },
  { id: "agents.waiting", label: "Waiting on you" },
];

type Result = Awaited<ReturnType<typeof cmd.stats.query>>;

/** Which way `cur` went from `prev`, as the Stats window judges it (half a percent is flat). */
const trendOf = (cur: number, prev: number) => (Math.abs(cur - prev) <= Math.abs(prev) * 0.005 ? "flat" : cur > prev ? "up" : "down");
/** Every series added up per bucket. */
const totals = (r: Result) => r.buckets.map((_, i) => (r.series.every((s) => s.values[i] === null) ? null : r.series.reduce((a, s) => a + (s.values[i] ?? 0), 0)));
const day = (t: number) => new Date(t).toLocaleDateString(undefined, { weekday: "narrow" });

export default function Usage() {
  const [filter, setFilter] = useStoredState("filter", "");
  const [open, setOpen] = useStoredState<string | null>("open", null);
  const { data } = useData(() => Promise.all(STATS.map((s) => cmd.stats.query({ stat: s.id, range: "7d", compare: true }))));
  const results = data ?? [];
  const shown = STATS.filter((s) => s.label.toLowerCase().includes(filter.toLowerCase()));
  const detail = results.find((r) => r.stat.id === open);
  const change = (r: Result) => (r.previous ? fmt.delta(r.total, r.previous.total, r.stat.unit as Unit) : "");

  return (
    <Window menuLabel={detail ? STATS.find((s) => s.id === open)?.label : "This Week"} menu={[{ label: "This Week", checked: !detail, run: () => setOpen(null) }]}>
      <View inset state={data ? null : { kind: "loading" }}>
        <WindowToolbar label="Stats">
          <ToolbarSearchField value={filter} placeholder="Filter stats" count={`${shown.length} of ${STATS.length}`} onChange={setFilter} onSubmit={() => shown[0] && setOpen(shown[0].id)} />
        </WindowToolbar>
        <Stack gap={6}>
          <Tiles min={120} gap={4}>
            {results.slice(0, 4).map((r, i) => (
              <Stat
                key={r.stat.id}
                label={STATS[i]!.label}
                value={fmt.value(r.total, r.stat.unit as Unit)}
                delta={change(r) || undefined}
                trend={r.previous ? trendOf(r.total, r.previous.total) : undefined}
                good={r.stat.good}
                onSelect={() => setOpen(r.stat.id)}
              >
                <Sparkline values={totals(r)} color={i === 0 ? "current" : "neutral"} />
              </Stat>
            ))}
          </Tiles>
          {detail && (
            <Panes>
              <Pane title={detail.stat.title} aside="per day" wide>
                <TimeBars
                  buckets={detail.buckets}
                  series={detail.series.map((s) => ({
                    key: s.key,
                    label: s.label,
                    values: s.values,
                  }))}
                  labels={detail.buckets.map(day)}
                  unit={detail.stat.unit as Unit}
                  label={detail.stat.title}
                  previous={detail.series.length === 1 ? detail.previous?.values : undefined}
                  current={detail.buckets.length - 1}
                  height={200}
                  summary={fmt.value(detail.total, detail.stat.unit as Unit)}
                  delta={
                    detail.previous && change(detail)
                      ? {
                          text: change(detail),
                          trend: trendOf(detail.total, detail.previous.total),
                          good: detail.stat.good,
                        }
                      : undefined
                  }
                  note={`${fmt.value(Math.max(0, ...totals(detail).map((v) => v ?? 0)), detail.stat.unit as Unit)} on the busiest day`}
                  average
                />
              </Pane>
            </Panes>
          )}
          <Pane title="All Stats" aside={shown.length}>
            <List>
              {shown.map((s) => {
                const r = results.find((x) => x.stat.id === s.id);
                return (
                  <ListRow key={s.id} selected={s.id === open} reveal={s.id === open} onClick={() => setOpen(s.id)}>
                    <ListRowContent title={s.label} place={s.id.split(".")[0]} />
                    <ListRowEnd>
                      {r && (
                        <Chip hue={fmt.hue(s.id.split(".")[0]!)}>
                          {fmt.value(r.total, r.stat.unit as Unit, {
                            short: true,
                          })}
                        </Chip>
                      )}
                    </ListRowEnd>
                  </ListRow>
                );
              })}
            </List>
          </Pane>
        </Stack>
      </View>
    </Window>
  );
}
