Request: what's eating my cpu
Notes: test_source returned the text of `ps`, a header line then one process per line.

{"kind":"widget","title":"Top processes","loading":["Reading the process list…"],"source":{"type":"command","command":"ps -Ao pid,pcpu,rss,comm -r | head -9"},"refresh":3,"size":"m"}
---
<style>.bar{width:72px}</style>
<table class="k-table"><thead><tr><th>Process</th><th class="k-num">CPU</th><th></th><th class="k-num">Memory</th></tr></thead><tbody id="rows"></tbody></table>
<script>
cmd.onData(text=>{
  const procs=String(text).trim().split("\n").slice(1).map(l=>{const m=l.trim().split(/\s+/);return{cpu:+m[1],rss:+m[2]*1024,name:m.slice(3).join(" ").split("/").pop()}});
  rows.replaceChildren(...procs.map(p=>{
    const tr=document.createElement("tr");
    tr.innerHTML=`<td class="k-ellipsis" style="max-width:220px">${p.name}</td><td class="k-num">${cmd.fmt.pct(p.cpu)}</td><td><div class="k-bar bar"><i style="--v:${Math.min(100,p.cpu)}%;--c:${p.cpu>80?"var(--bad)":"var(--c1)"}"></i></div></td><td class="k-num k-dim">${cmd.fmt.bytes(p.rss)}</td>`;
    return tr;
  }));
});
</script>
