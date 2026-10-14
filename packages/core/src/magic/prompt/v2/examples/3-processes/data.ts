import { s, run, columns, type Infer } from "cmd";

export const schema = s.object({
  total: s.number(),
  procs: s.array(s.object({ pid: s.number(), cpu: s.number(), rss: s.number(), name: s.string() })),
});
export type Data = Infer<typeof schema>;

export default async function data(config: { count: number }): Promise<Data> {
  const r = await run("ps", ["-Ao", "pid,pcpu,rss,comm", "-r"]);
  const rows = columns(r.stdout, { skip: 1, max: 4 }).map(([pid, cpu, rss, comm]) => ({
    pid: Number(pid),
    cpu: Number(cpu),
    rss: Number(rss) * 1024,
    name: (comm ?? "").split("/").pop() ?? "",
  }));
  const procs = rows.filter((p) => Number.isFinite(p.pid) && Number.isFinite(p.cpu));
  return { total: procs.reduce((a, p) => a + p.cpu, 0), procs: procs.slice(0, Math.max(1, config.count || 8)) };
}
