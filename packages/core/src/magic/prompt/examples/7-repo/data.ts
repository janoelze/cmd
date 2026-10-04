import { s, run, expandHome, type Infer } from "cmd";

const file = s.object({ path: s.string(), status: s.string(), added: s.number(), removed: s.number() });
export const schema = s.object({
  branch: s.string(),
  upstream: s.string().nullable(),
  ahead: s.number(),
  behind: s.number(),
  changes: s.array(file),
  vsRemote: s.array(file),
  hot: s.array(s.object({ path: s.string(), commits: s.number() })),
});
export type Data = Infer<typeof schema>;

function numstat(text: string): Map<string, { added: number; removed: number }> {
  const out = new Map<string, { added: number; removed: number }>();
  for (const l of text.split("\n")) {
    const [a, r, ...p] = l.split("\t");
    if (p.length) out.set(p.join("\t"), { added: Number(a) || 0, removed: Number(r) || 0 });
  }
  return out;
}

export default async function data(config: { repo: string }): Promise<Data> {
  const cwd = expandHome(config.repo);
  const git = (...args: string[]) => run("git", ["-C", cwd, ...args], { allowFail: true });
  const status = await git("status", "--porcelain=v2", "--branch");
  if (status.code !== 0) throw new Error(`${config.repo} isn't a git repository: ${status.stderr.trim()}`);
  const head = (k: string) => status.stdout.split("\n").find((l) => l.startsWith(`# branch.${k} `))?.slice(`# branch.${k} `.length).trim();
  const ab = /\+(\d+) -(\d+)/.exec(head("ab") ?? "");
  const upstream = head("upstream") ?? null;

  const [local, remote, log] = await Promise.all([git("diff", "--numstat", "HEAD"), upstream ? git("diff", "--numstat", "@{upstream}") : null, git("log", "-50", "--name-only", "--format=")]);
  const localNum = numstat(local.stdout);
  const changes = status.stdout
    .split("\n")
    .filter((l) => /^[12?] /.test(l))
    .map((l) => {
      const parts = l.split(" ");
      const path = l[0] === "?" ? l.slice(2) : parts.slice(l[0] === "2" ? 9 : 8).join(" ").split("\t")[0]!;
      const status = l[0] === "?" ? "?" : (parts[1] ?? "").replace(/\./g, "")[0] ?? "M";
      return { path, status, ...(localNum.get(path) ?? { added: 0, removed: 0 }) };
    });
  const vsRemote = [...numstat(remote?.stdout ?? "")].map(([path, n]) => ({ path, status: "M", ...n })).sort((a, b) => b.added + b.removed - (a.added + a.removed));
  const counts = new Map<string, number>();
  for (const p of log.stdout.split("\n")) if (p.trim()) counts.set(p, (counts.get(p) ?? 0) + 1);
  const hot = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([path, commits]) => ({ path, commits }));

  return { branch: head("head") ?? "detached", upstream, ahead: Number(ab?.[1] ?? 0), behind: Number(ab?.[2] ?? 0), changes, vsRemote, hot };
}
