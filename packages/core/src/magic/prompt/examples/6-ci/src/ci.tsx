// The latest GitHub Actions runs of a repository (the API through cmd.net.fetch; the token,
// if set, is attached by cmd to api.github.com only). The latest run leads the title bar;
// each workflow's newest failure notifies once; a click opens the run on github.com, and a failed
// run's menu has Rerun: a terminal with `gh run rerun` typed, for the person to run (it writes).

import { useEffect } from "react";
import { Window, View, List, ListSection, ListRow, ListRowIcon, ListRowContent, ListRowEnd, Chip, useConfig, useData, useNow, cmd, fmt, type Light } from "@cmd/widget-api";

export interface Run {
  id: number;
  name: string;
  branch: string;
  number: number;
  event: string;
  status: string;
  conclusion: string | null;
  url: string;
  at: string;
}

export async function runs(repo: string): Promise<Run[]> {
  const r = await cmd.net.fetch(`https://api.github.com/repos/${repo}/actions/runs?per_page=20`, { auth: "token", headers: { accept: "application/vnd.github+json" } });
  if (r.status === 404) throw new Error(`No repository ${repo} (or it's private: set a token)`);
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  const j = JSON.parse(r.body) as { workflow_runs?: { id: number; name: string; head_branch: string; run_number: number; event: string; status: string; conclusion: string | null; html_url: string; updated_at: string }[] };
  return (j.workflow_runs ?? []).map((w) => ({ id: w.id, name: w.name, branch: w.head_branch, number: w.run_number, event: w.event, status: w.status, conclusion: w.conclusion, url: w.html_url, at: w.updated_at }));
}

/** A run as a word and a light. */
function state(r: Run): [string, Light] {
  if (r.status !== "completed") return [r.status === "queued" ? "Queued" : "Running", "working"];
  if (r.conclusion === "success") return ["Passed", "success"];
  if (r.conclusion === "failure" || r.conclusion === "timed_out") return ["Failed", "danger"];
  return [r.conclusion ? r.conclusion.replace(/_/g, " ") : "Done", "idle"];
}

export default function Ci() {
  const repo = useConfig<{ repo: string }>().repo || "acme/shop";
  const { data, error } = useData(() => runs(repo), { every: 120 });
  const now = useNow(30_000);

  // Each workflow's newest run, if it failed: notified once (the key is the run).
  useEffect(() => {
    const newest = new Map<string, Run>();
    for (const r of data ?? []) if (!newest.has(r.name)) newest.set(r.name, r);
    for (const r of newest.values()) if (state(r)[1] === "danger") void cmd.notify.send({ key: `ci-failed-${r.id}`, title: `${r.name} failed`, body: `${repo} · ${r.branch} #${r.number}` });
  }, [data, repo]);

  const latest = data?.[0];
  const status = error ? `Stale · ${error.message}` : latest ? `${state(latest)[0]} · ${latest.name} on ${latest.branch}` : null;
  const view = data ? (data.length ? null : { icon: "checkmark.seal", title: "No runs yet", text: `${repo} has no workflow runs.` }) : error ? { kind: "error" as const, icon: "checkmark.seal", title: "No runs", text: error.message } : { kind: "loading" as const, title: "Asking GitHub…" };

  return (
    <Window status={status}>
      <View state={view}>
        <List>
          <ListSection title={repo} count={data?.length ?? 0}>
            {(data ?? []).map((r) => {
              const [word, light] = state(r);
              return (
                <ListRow
                  key={r.id}
                  onClick={() => void cmd.windows.open(r.url).catch(() => {})}
                  tip="Open on github.com"
                  menu={light === "danger" ? [{ label: "Rerun Failed Jobs", run: () => void cmd.terminals.open({ command: `gh run rerun ${r.id} --failed -R ${repo}` }).catch(() => {}) }] : undefined}
                >
                  <ListRowIcon icon="checkmark.seal" light={light} />
                  <ListRowContent title={r.name} place={r.branch} detail={`${word} · #${r.number} · ${r.event}`} tone={light === "danger" ? "danger" : undefined} />
                  <ListRowEnd>
                    <Chip>{fmt.ago(r.at, now)}</Chip>
                  </ListRowEnd>
                </ListRow>
              );
            })}
          </ListSection>
        </List>
      </View>
    </Window>
  );
}
