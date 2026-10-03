Request: show my vpn connection status
Notes: `scutil --nc list` showed one WireGuard service, "Home"; test_source returned its text output.

{"kind":"widget","title":"VPN","loading":["Checking WireGuard…"],"source":{"type":"command","command":"scutil --nc list"},"refresh":10,"size":"s"}
---
<div class="k-stack k-fill" id="list"></div>
<script>
cmd.onData(text=>{
  const rows=String(text).split("\n").map(l=>/^\*?\s*\((\w[\w ]*)\)\s+\S+\s+\S+\s+(?:\(.*?\)\s+)?"([^"]+)"/.exec(l)).filter(Boolean);
  if(!rows.length){list.innerHTML='<div class="k-empty">No VPN services configured</div>';return;}
  list.replaceChildren(...rows.map(([,state,name])=>{
    const on=state==="Connected",busy=/Connecting|Disconnecting/.test(state);
    const e=document.createElement("div");e.className="k-row";
    e.innerHTML=`<span class="k-dot ${on?"k-good":busy?"k-warn":""}"></span><div class="k-stack" style="gap:0"><div class="k-big">${on?"Connected":busy?state:"Off"}</div><div class="k-dim">${name}</div></div>`;
    return e;
  }));
});
</script>
