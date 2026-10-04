import { s, runJson, status, notify, type Infer } from "cmd";

export const schema = s.object({
  repo: s.string(),
  runs: s.array(
    s.object({
      id: s.number(),
      number: s.number(),
      title: s.string(),
      workflow: s.string(),
      branch: s.string(),
      state: s.enum(["passed", "failed", "running", "queued", "cancelled"]),
      createdAt: s.string(),
      url: s.string(),
    }),
  ),
});
export type Data = Infer<typeof schema>;

type Run = { databaseId: number; number: number; displayTitle: string; workflowName: string; headBranch: string; status: string; conclusion: string | null; createdAt: string; url: string };

function stateOf(r: Run): Data["runs"][number]["state"] {
  if (r.status === "queued" || r.status === "waiting" || r.status === "pending") return "queued";
  if (r.status !== "completed") return "running";
  if (r.conclusion === "success") return "passed";
  if (r.conclusion === "cancelled" || r.conclusion === "skipped") return "cancelled";
  return "failed";
}

export default async function data(config: { repo: string }): Promise<Data> {
  const list = await runJson<Run[]>("gh", ["run", "list", "--repo", config.repo, "--limit", "20", "--json", "databaseId,number,displayTitle,workflowName,headBranch,status,conclusion,createdAt,url"]);
  const runs = list.map((r) => ({ id: r.databaseId, number: r.number, title: r.displayTitle, workflow: r.workflowName, branch: r.headBranch, state: stateOf(r), createdAt: r.createdAt, url: r.url }));

  // The title bar and sidebar show the latest run; each workflow's newest run failing is news.
  const last = runs[0];
  if (last) status({ text: `${last.workflow} ${last.state}`, tone: last.state === "passed" ? "good" : last.state === "failed" ? "bad" : last.state === "cancelled" ? "dim" : "warn" });
  const newest = new Map<string, (typeof runs)[number]>();
  for (const r of runs) if (!newest.has(r.workflow)) newest.set(r.workflow, r);
  for (const r of newest.values()) {
    if (r.state === "failed") notify({ key: `failed-${r.id}`, title: `${r.workflow} failed`, body: `#${r.number} ${r.title} · ${r.branch}` });
  }
  return { repo: config.repo, runs };
}
