// Reference window, charts (pnpm workbench chartwindow): a dashboard. A status
// line first, then sections (Panes) most important first: metrics with
// sparklines, a chart over time, a breakdown, a short table. The spec for
// Resources, Agent Activity and any widget that watches numbers.

import { Chart, DataGrid, Inline, Pane, Panes, Progress, Sparkline, Stack, Stat, StatusDot, Text, Tiles, ToolbarButton, ToolbarSegmented, ToolbarSpacer, View, WindowToolbar } from "@cmd/ui";
import { useState } from "react";
import { AllSizes, RefWindow, series, type SizeName } from "./RefWindow.tsx";

const CPU = series(60, 7, 34, 14);
const GPU = series(60, 3, 18, 10);
const MEM = series(60, 11, 62, 4);
const NET = series(60, 5, 4, 3);
const PROCS = [
  { name: "claude", cpu: 38.2, mem: 812 },
  { name: "cmd Helper (Renderer)", cpu: 21.4, mem: 1240 },
  { name: "node · pnpm dev", cpu: 12.9, mem: 534 },
  { name: "Safari Web Content", cpu: 6.1, mem: 702 },
  { name: "codex", cpu: 4.4, mem: 288 },
];
const minutes = Array.from({ length: 60 }, (_, i) => `${59 - i}m`);
minutes[59] = "now";

function Dashboard({ size = "wide" }: { size?: SizeName }) {
  const [range, setRange] = useState<"1h" | "24h" | "7d">("1h");
  const top = Math.max(...PROCS.map((p) => p.mem));
  return (
    <RefWindow icon="gauge.with.dots.needle.33percent" name="Resources" size={size}>
      <View
        inset
        toolbar={
          <WindowToolbar label="Resources">
            <ToolbarSegmented
              label="Range"
              value={range}
              onChange={setRange}
              options={[
                { value: "1h", label: "Hour" },
                { value: "24h", label: "Day" },
                { value: "7d", label: "Week" },
              ]}
            />
            <ToolbarSpacer />
            <ToolbarButton icon="pause" label="Pause" showLabel secondary priority={1} />
          </WindowToolbar>
        }
      >
        <Stack gap="2xl">
          <Inline gap="sm">
            <StatusDot state="done" />
            <Text>Healthy</Text>
            <Text tone="dim" truncate>
              · 4 agents · 23 processes · up 3d 4h
            </Text>
          </Inline>
          <Panes>
            <Pane wide>
              <Tiles min={120} gap="xl">
                <Stat label="CPU" value={CPU.at(-1)} unit="%" delta="▲ 4%" deltaTone="warning">
                  <Sparkline values={CPU} series={0} />
                </Stat>
                <Stat label="Memory" value={(MEM.at(-1)! / 10).toFixed(1)} unit="GB" delta="▼ 2%" deltaTone="success">
                  <Sparkline values={MEM} series={1} />
                </Stat>
                <Stat label="GPU" value={GPU.at(-1)} unit="%">
                  <Sparkline values={GPU} series={2} />
                </Stat>
                <Stat label="Network" value={NET.at(-1)} unit="MB/s">
                  <Sparkline values={NET} series={3} />
                </Stat>
              </Tiles>
            </Pane>
            <Pane title="CPU and GPU" aside="% of all cores">
              <Chart
                series={[
                  { name: "CPU", values: CPU },
                  { name: "GPU", values: GPU },
                ]}
                labels={minutes}
                format={(v) => `${v}`}
              />
            </Pane>
            <Pane title="Memory by Process" aside="MB">
              <Stack gap="sm">
                {PROCS.map((p) => (
                  <Stack key={p.name} gap="2xs">
                    <Inline justify="between" gap="md">
                      <Text truncate>{p.name}</Text>
                      <Text mono size="sm" tone="dim">
                        {p.mem}
                      </Text>
                    </Inline>
                    <Progress value={p.mem / top} label={p.name} width="100%" />
                  </Stack>
                ))}
              </Stack>
            </Pane>
            <Pane title="Network" aside="MB/s">
              <Chart kind="bar" series={[{ name: "Network", values: NET.slice(-24) }]} labels={minutes.slice(-24)} height={110} />
            </Pane>
            <Pane title="Top Processes" aside={`${PROCS.length} of 23`}>
              <DataGrid
                columns={[
                  { key: "name", label: "Process", grow: true },
                  { key: "cpu", label: "CPU %", align: "end" },
                  { key: "mem", label: "MB", align: "end" },
                ]}
                rows={PROCS.map((p) => [p.name, { node: p.cpu.toFixed(1), kind: "number" }, { node: p.mem, kind: "number" }])}
              />
            </Pane>
          </Panes>
        </Stack>
      </View>
    </RefWindow>
  );
}

export const Default = () => <Dashboard />;
export const Sizes = () => <AllSizes render={(s) => <Dashboard size={s} />} />;
