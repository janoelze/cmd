import type { Data } from "./data.ts";

const $ = (id: string) => document.getElementById(id)!;
const cell = (text: string, cls = "") => {
  const td = document.createElement("td");
  td.className = cls;
  td.textContent = text;
  return td;
};

cmd.onData<Data>((d) => {
  const active = d.services.find((x) => x.state === "Connected");
  $("dot").className = "k-dot " + (d.connected ? "k-good" : "");
  $("state").textContent = d.connected ? "Connected" : "Off";
  $("sub").textContent = active ? `${active.name} · ${active.type}` : d.tunnels[0] ? `${d.tunnels[0].name} · client unknown` : `${d.services.length} configured`;
  const rows = d.tunnels.map((t) => {
    const tr = document.createElement("tr");
    tr.append(cell(t.name), cell(t.address, "k-grow"), cell(t.routes.slice(0, 2).join(", ") || "–", "k-num k-dim k-hide-narrow"));
    return tr;
  });
  for (const x of d.services.filter((x) => x.state !== "Connected")) {
    const tr = document.createElement("tr");
    tr.append(cell(x.name, "k-text k-dim"), cell(x.type, "k-grow k-dim"), cell(x.state, "k-num k-dim k-hide-narrow"));
    rows.push(tr);
  }
  $("rows").replaceChildren(...rows);
});
