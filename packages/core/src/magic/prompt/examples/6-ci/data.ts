import { s, runJson, type Infer } from "cmd";

export const schema = s.object({
  repo: s.string(),
  runs: s.array(
    s.object({
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

type Run = { number: number; displayTitle: string; workflowName: string; headBranch: string; status: string; conclusion: string | null; createdAt: string; url: string };

function stateOf(r: Run): Data["runs"][number]["state"] {
  if (r.status === "queued" || r.status === "waiting" || r.status === "pending") return "queued";
  if (r.status !== "completed") return "running";
  if (r.conclusion === "success") return "passed";
  if (r.conclusion === "cancelled" || r.conclusion === "skipped") return "cancelled";
  return "failed";
}

export default async function data(config: { repo: string }): Promise<Data> {
  const runs = await runJson<Run[]>("gh", ["run", "list", "--repo", config.repo, "--limit", "20", "--json", "number,displayTitle,workflowName,headBranch,status,conclusion,createdAt,url"]);
  return {
    repo: config.repo,
    runs: runs.map((r) => ({ number: r.number, title: r.displayTitle, workflow: r.workflowName, branch: r.headBranch, state: stateOf(r), createdAt: r.createdAt, url: r.url })),
  };
}
