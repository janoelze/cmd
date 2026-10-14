// The processes using the most CPU, from `ps` through cmd.run every 5 seconds (read-only, no
// shell: the arguments are a list and the cut is made here). The busiest leads the title bar;
// a row's menu opens a terminal with `top` typed, for more.

import { Window, View, List, ListSection, ListRow, ListRowIcon, ListRowContent, ListRowEnd, Chip, useData, cmd, type Light } from "@cmd/widget-api";

export interface Proc {
  pid: number;
  cpu: number;
  mem: number;
  name: string;
}

export const PS = ["-Ao", "pid,pcpu,pmem,comm", "-r"];

/** ps's columns as processes, busiest first; a line that doesn't parse is skipped. */
export function parsePs(out: string, keep = 12): Proc[] {
  const procs: Proc[] = [];
  for (const line of out.split("\n").slice(1)) {
    const m = /^\s*(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const path = m[4]!.trim();
    procs.push({ pid: Number(m[1]), cpu: Number(m[2]), mem: Number(m[3]), name: path.split("/").pop() || path });
  }
  return procs.sort((a, b) => b.cpu - a.cpu).slice(0, keep);
}

export async function processes(): Promise<Proc[]> {
  const r = await cmd.run("ps", PS);
  if (r.code !== 0) throw new Error(r.stderr.split("\n")[0] || `ps exited ${r.code}`);
  return parsePs(r.stdout);
}

const light = (cpu: number): Light => (cpu >= 80 ? "danger" : cpu >= 30 ? "warning" : "idle");

export default function Processes() {
  const { data, error } = useData(processes, { every: 5 });
  const top = data?.[0];
  const status = error ? `Stale · ${error.message}` : top ? `${top.name} · ${top.cpu.toFixed(0)}%` : null;
  const view = data ? (data.length ? null : { icon: "cpu", title: "Nothing running", text: "ps listed no processes." }) : error ? { kind: "error" as const, icon: "cpu", title: "No processes", text: error.message } : { kind: "loading" as const, title: "Asking ps…" };

  return (
    <Window status={status}>
      <View state={view}>
        <List>
          <ListSection title="By CPU" count={data?.length ?? 0}>
            {(data ?? []).map((p) => (
              <ListRow key={p.pid} tip={`pid ${p.pid}`} menu={[{ label: "Open top in a Terminal", run: () => void cmd.terminals.open({ command: "top -o cpu" }).catch(() => {}) }]}>
                <ListRowIcon icon="cpu" light={light(p.cpu)} />
                <ListRowContent title={p.name} detail={`pid ${p.pid} · ${p.mem.toFixed(1)}% memory`} />
                <ListRowEnd>
                  <Chip>{`${p.cpu.toFixed(1)}%`}</Chip>
                </ListRowEnd>
              </ListRow>
            ))}
          </ListSection>
        </List>
      </View>
    </Window>
  );
}
