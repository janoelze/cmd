import type { Data } from "./data.ts";

const $ = (id: string) => document.getElementById(id)!;

function td(cls: string, ...kids: (Node | string)[]): HTMLTableCellElement {
  const e = document.createElement("td");
  e.className = cls;
  e.append(...kids);
  return e;
}
function pathCell(p: string): HTMLTableCellElement {
  const i = p.lastIndexOf("/");
  const box = document.createElement("div");
  box.className = "path";
  const dir = document.createElement("span");
  dir.className = "k-dim k-ellipsis";
  dir.textContent = p.slice(0, i + 1);
  const name = document.createElement("b");
  name.textContent = p.slice(i + 1);
  box.append(dir, name);
  return td("k-grow", box);
}
function lines(added: number, removed: number): HTMLTableCellElement {
  const a = document.createElement("span");
  a.className = "add";
  a.textContent = added ? `+${added}` : "";
  const r = document.createElement("span");
  r.className = "del";
  r.textContent = removed ? ` −${removed}` : "";
  return td("k-num", a, r);
}
function rows(el: HTMLElement, items: HTMLTableRowElement[], empty: string) {
  if (items.length) return el.replaceChildren(...items);
  const tr = document.createElement("tr");
  tr.append(td("k-text k-dim", empty));
  el.replaceChildren(tr);
}
const row = (...cells: HTMLTableCellElement[]) => {
  const tr = document.createElement("tr");
  tr.append(...cells);
  return tr;
};

cmd.onData<Data>((d) => {
  $("branch").textContent = d.branch;
  const sync = !d.upstream ? "no upstream" : d.ahead || d.behind ? `↑${d.ahead} ↓${d.behind} vs ${d.upstream}` : `in sync with ${d.upstream}`;
  $("facts").textContent = `${sync} · ${d.changes.length ? `${d.changes.length} uncommitted` : "clean"}`;
  $("dot").className = "k-dot " + (d.behind || d.changes.length ? "k-warn" : "k-good");
  $("nChanges").textContent = d.changes.length ? String(d.changes.length) : "";
  rows($("changes"), d.changes.map((f) => row(td(`st ${f.status === "?" ? "k-dim" : f.status === "D" ? "k-bad" : "k-warn"}`, f.status), pathCell(f.path), lines(f.added, f.removed))), "Nothing uncommitted");
  $("nRemote").textContent = d.vsRemote.length ? String(d.vsRemote.length) : "";
  rows($("remote"), d.vsRemote.map((f) => row(pathCell(f.path), lines(f.added, f.removed))), d.upstream ? "Same as the remote" : "No upstream branch");
  rows($("hot"), d.hot.map((h) => row(pathCell(h.path), td("k-num k-dim", String(h.commits)))), "No commits yet");
});
