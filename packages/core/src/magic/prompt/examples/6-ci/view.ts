import type { Data } from "./data.ts";

type State = Data["runs"][number]["state"];
const DOT: Record<State, string> = { passed: "k-good", failed: "k-bad", running: "k-warn", queued: "k-warn", cancelled: "" };
const WORD: Record<State, string> = { passed: "Passed", failed: "Failed", running: "Running", queued: "Queued", cancelled: "Cancelled" };
const $ = (id: string) => document.getElementById(id)!;

cmd.onData<Data>((d) => {
  const last = d.runs[0];
  $("dot").className = "k-dot " + (last ? DOT[last.state] : "");
  $("result").textContent = last ? WORD[last.state] : "No runs";
  $("subject").textContent = last ? `${last.workflow} #${last.number} · ${last.branch}` : `${d.repo} has no workflow runs yet`;
  $("rows").replaceChildren(
    ...d.runs.map((r) => {
      const tr = document.createElement("tr");
      const dot = document.createElement("td");
      dot.innerHTML = `<span class="k-dot ${DOT[r.state]}"></span>`;
      const title = document.createElement("td");
      title.className = "k-text k-grow";
      const a = document.createElement("a");
      a.href = r.url;
      a.textContent = r.title;
      title.append(a);
      const branch = document.createElement("td");
      branch.className = "k-hide-narrow k-dim";
      branch.textContent = r.branch;
      const when = document.createElement("td");
      when.className = "k-num k-dim";
      when.textContent = cmd.fmt.ago(r.createdAt);
      tr.append(dot, title, branch, when);
      return tr;
    }),
  );
});
