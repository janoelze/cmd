// Widgets cmd makes without a model: the JSON view for pasted JSON (static.json
// as its data).

export const JSON_VIEW_HTML = `<style>.t{font:12px/1.5 var(--font-mono)}.t details{padding-left:14px}.t summary{cursor:default;list-style:none;margin-left:-14px}.t summary::before{content:"▸ ";color:var(--text-dim)}.t details[open]>summary::before{content:"▾ "}.k{color:var(--chart-1)}.s{color:var(--chart-2)}.n{color:var(--chart-3)}.b{color:var(--chart-4)}</style>
<div class="t" id="root"></div>
`;

export const JSON_VIEW_TS = `const root = document.getElementById("root")!;
const esc = (s: unknown) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
function node(k: string | number | null, v: unknown, open: boolean): HTMLElement {
  const key = k === null ? "" : '<span class="k">' + esc(k) + "</span>: ";
  if (v && typeof v === "object") {
    const arr = Array.isArray(v);
    const n = arr ? v.length : Object.keys(v).length;
    const d = document.createElement("details");
    d.open = open;
    d.innerHTML = "<summary>" + key + '<span class="k-dim">' + (arr ? "[" + n + "]" : "{" + n + "}") + "</span></summary>";
    for (const [ck, cv] of Object.entries(v)) d.append(node(arr ? Number(ck) : ck, cv, false));
    return d;
  }
  const e = document.createElement("div");
  const cls = typeof v === "string" ? "s" : typeof v === "number" ? "n" : "b";
  e.innerHTML = key + '<span class="' + cls + '">' + esc(JSON.stringify(v)) + "</span>";
  return e;
}
cmd.onData<unknown>((d) => root.replaceChildren(node(null, d, true)));
`;
