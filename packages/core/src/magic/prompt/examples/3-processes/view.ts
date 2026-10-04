import type { Data } from "./data.ts";

const $ = (id: string) => document.getElementById(id)!;

cmd.onData<Data>((d) => {
  $("total").textContent = cmd.fmt.pct(d.total);
  cmd.spark($("spark"), cmd.history("total", d.total));
  $("rows").replaceChildren(
    ...d.procs.map((p) => {
      const tr = document.createElement("tr");
      const name = document.createElement("td");
      name.className = "k-grow";
      name.textContent = p.name;
      const cpu = document.createElement("td");
      cpu.className = "k-num";
      cpu.textContent = cmd.fmt.pct(p.cpu);
      const bar = document.createElement("td");
      bar.className = "k-hide-narrow";
      bar.innerHTML = `<div class="k-bar bar"><i style="--v:${Math.min(100, p.cpu)}%;--c:${p.cpu > 80 ? "var(--bad)" : "var(--c1)"}"></i></div>`;
      const mem = document.createElement("td");
      mem.className = "k-num k-dim";
      mem.textContent = cmd.fmt.bytes(p.rss);
      tr.append(name, cpu, bar, mem);
      return tr;
    }),
  );
});
