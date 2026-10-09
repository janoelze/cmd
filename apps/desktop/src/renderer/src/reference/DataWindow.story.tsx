// Reference window, data (pnpm workbench datawindow): a table with a filter bar,
// an inspector for the selected row and a status footer, plus each state the
// body can be in. The spec for SQLite, Task Manager, Events and every window
// whose content is rows.

import { Badge, Button, DataGrid, Inline, KeyValue, Pane, Split, Stack, StatusDot, StatusLine, Text, ToolbarButton, ToolbarSearchField, ToolbarSegmented, ToolbarSpacer, View, WindowToolbar, type GridSort, type ViewStateSpec } from "@cmd/ui";
import { useMemo, useState } from "react";
import { AllSizes, RefWindow, type SizeName } from "./RefWindow.tsx";

type Run = { id: number; name: string; branch: string; status: "passed" | "failed" | "running"; duration: number; when: string; author: string };

const NAMES = ["Build and test", "Release", "Lint", "E2E smoke", "Notarize", "Docs", "Nightly", "Typecheck"];
const BRANCHES = ["master", "window-design", "browser-scrollbar", "workspace-actions", "sqlite-viewer"];
const RUNS: Run[] = Array.from({ length: 40 }, (_, i) => ({
  id: 1840 - i,
  name: NAMES[(i * 5) % NAMES.length]!,
  branch: BRANCHES[(i * 3) % BRANCHES.length]!,
  status: i === 0 ? "running" : i % 7 === 3 ? "failed" : "passed",
  duration: 40 + ((i * 97) % 600),
  when: i < 3 ? `${(i + 1) * 4}m ago` : i < 20 ? `${Math.floor(i / 3)}h ago` : `${Math.floor(i / 8)}d ago`,
  author: ["jan", "claude", "codex"][i % 3]!,
}));

const LIGHT = { passed: "done", failed: "danger", running: "working" } as const;
const dur = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`);

function Inspector({ run }: { run: Run }) {
  return (
    <Stack gap="xl" pad="lg">
      <Stack gap="xs">
        <Inline gap="sm">
          <StatusDot state={LIGHT[run.status]} />
          <Text strong truncate>
            {run.name}
          </Text>
        </Inline>
        <Text tone="dim" mono size="sm">
          #{run.id} · {run.branch}
        </Text>
      </Stack>
      <Pane title="Details">
        <KeyValue
          items={[
            ["Status", run.status === "failed" ? <Badge tone="danger">Failed</Badge> : run.status === "running" ? <Badge tone="accent">Running</Badge> : <Badge tone="success">Passed</Badge>],
            ["Duration", dur(run.duration)],
            ["Started", run.when],
            ["By", run.author],
          ]}
        />
      </Pane>
      <Inline gap="sm" wrap>
        <Button icon="arrow.clockwise">Run Again</Button>
        <Button variant="ghost" icon="doc.text">Logs</Button>
      </Inline>
    </Stack>
  );
}

function Runs({ state, size = "wide", initialQuery = "" }: { state?: ViewStateSpec; size?: SizeName; initialQuery?: string }) {
  const [q, setQ] = useState(initialQuery);
  const [filter, setFilter] = useState<"all" | "failed" | "running">("all");
  const [sort, setSort] = useState<GridSort | null>({ key: "id", desc: true });
  const [sel, setSel] = useState<number | null>(1);
  const [inspector, setInspector] = useState(true);
  const rows = useMemo(() => {
    let r = RUNS.filter((x) => (filter === "all" || x.status === filter) && (x.name + x.branch).toLowerCase().includes(q.toLowerCase()));
    if (sort) r = [...r].sort((a, b) => ((a[sort.key as keyof Run] as number) > (b[sort.key as keyof Run] as number) ? 1 : -1) * (sort.desc ? -1 : 1));
    return r;
  }, [q, filter, sort]);
  const selected = sel != null ? rows[sel] : undefined;
  const failed = RUNS.filter((r) => r.status === "failed").length;
  const noResults: ViewStateSpec | undefined =
    rows.length === 0 ? { kind: "noResults", text: `Nothing matches “${q}”.`, action: <Button onClick={() => (setQ(""), setFilter("all"))}>Clear Filter</Button> } : undefined;

  return (
    <RefWindow icon="checklist" name="CI Runs · cmd" size={size}>
      <View
        toolbar={
          <WindowToolbar label="Runs">
            <ToolbarSearchField value={q} onChange={setQ} placeholder="Filter runs" count={q ? String(rows.length) : undefined} minWidth={90} />
            <ToolbarSegmented
              label="Show"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "All" },
                { value: "failed", label: "Failed" },
                { value: "running", label: "Running" },
              ]}
            />
            <ToolbarSpacer />
            <ToolbarButton icon="arrow.clockwise" label="Refresh" shortcut="⌘R" secondary priority={1} />
            <ToolbarButton icon="sidebar.right" label={inspector ? "Hide Inspector" : "Show Inspector"} pressed={inspector} onClick={() => setInspector((v) => !v)} priority={3} />
          </WindowToolbar>
        }
        footer={
          <StatusLine end={<span>Updated 12s ago</span>}>
            {RUNS.length} runs · {failed} failed
          </StatusLine>
        }
        state={state}
        scroll={false}
      >
        <Split side="end" open={inspector && !!selected && !noResults} pane={selected && <Inspector run={selected} />} width={{ min: 200, ideal: 240, max: 360 }}>
          {noResults ? (
            <View state={noResults} />
          ) : (
            <DataGrid
              columns={[
                { key: "status", label: "" },
                { key: "name", label: "Workflow", grow: true },
                { key: "branch", label: "Branch", hide: "narrow" },
                { key: "duration", label: "Duration", align: "end", hide: "regular" },
                { key: "id", label: "Run", align: "end", hide: "regular" },
                { key: "when", label: "Started", align: "end" },
              ]}
              rows={rows.map((r) => [<StatusDot key="d" state={LIGHT[r.status]} />, r.name, { node: r.branch, kind: "text" }, { node: dur(r.duration), kind: "number" }, { node: `#${r.id}`, kind: "number" }, r.when])}
              rowKey={(_, i) => rows[i]!.id}
              sort={sort}
              onSort={setSort}
              selected={sel}
              onRowClick={setSel}
            />
          )}
        </Split>
      </View>
    </RefWindow>
  );
}

export const Default = () => <Runs />;
export const Sizes = () => <AllSizes render={(s) => <Runs size={s} />} />;
export const Loading = () => <Runs state={{ kind: "loading" }} />;
export const Empty = () => <Runs state={{ kind: "empty", icon: "checklist", title: "No Runs Yet", text: "Runs show here once this repository's workflows start.", action: <Button>Open Workflows</Button> }} />;
export const NoResults = () => <Runs initialQuery="deploy" />;
export const Failed = () => <Runs state={{ kind: "error", title: "Couldn’t Load Runs", text: "GitHub didn’t answer. Check your connection and try again.", action: <Button icon="arrow.clockwise">Try Again</Button> }} />;
