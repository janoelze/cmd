Request: memory, disk and load at a glance
Notes: test_source returned text: three sysctl lines (cores, memory in bytes, load averages), then vm_stat, then df -k /.

{"kind":"widget","title":"System","loading":["Reading memory and disk…"],"source":{"type":"command","command":"sysctl -n hw.ncpu hw.memsize vm.loadavg; vm_stat; df -k /"},"refresh":5,"size":"m"}
---
<style>.k-stat .k-bar{margin:4px 0 2px}</style>
<div class="k-stack k-fill">
  <div class="k-grid">
    <div class="k-stat"><div class="k-stat-label">Memory</div><div class="k-stat-value" id="mem">–</div><div class="k-bar"><i id="memBar"></i></div><div class="k-stat-note" id="memNote">–</div></div>
    <div class="k-stat"><div class="k-stat-label">Disk</div><div class="k-stat-value" id="disk">–</div><div class="k-bar"><i id="diskBar"></i></div><div class="k-stat-note" id="diskNote">–</div></div>
    <div class="k-stat"><div class="k-stat-label">Load</div><div class="k-stat-value" id="load">–</div><div class="k-bar"><i id="loadBar"></i></div><div class="k-stat-note" id="loadNote">–</div></div>
  </div>
  <div class="k-stack k-hide-short" style="gap:4px;flex:1;min-height:0"><div class="k-between"><span class="k-title">Memory used</span><span class="k-dim k-small">last 5 min</span></div><div class="k-chart" id="chart" style="flex:1;min-height:48px"></div></div>
</div>
<script>
const unit=s=>s.replace(/ (\S+)$/,'<span class="k-unit">$1</span>');
const bar=(el,p)=>{el.style.setProperty("--v",Math.min(100,p)+"%");el.style.setProperty("--c",p>90?"var(--bad)":p>75?"var(--warn)":"var(--c1)");};
cmd.onData(text=>{
  const t=String(text),L=t.split("\n");
  const cores=+L[0],total=+L[1],avg=+(/[\d.]+/.exec(L[2])||[])[0];
  const page=+(/page size of (\d+)/.exec(t)||[])[1]||16384;
  const pages=k=>+(new RegExp(`^Pages ${k}:\\s+(\\d+)`,"m").exec(t)||[])[1]||0;
  const used=(pages("active")+pages("wired down")+pages("occupied by compressor"))*page;
  const df=(L.find(l=>/\s\/$/.test(l))||"").trim().split(/\s+/),size=+df[1]*1024,free=+df[3]*1024;
  const mp=used/total*100,dp=(size-free)/size*100;
  mem.innerHTML=unit(cmd.fmt.bytes(used));memNote.textContent=`${cmd.fmt.pct(mp)} of ${cmd.fmt.bytes(total)}`;bar(memBar,mp);
  disk.innerHTML=unit(cmd.fmt.bytes(free));diskNote.textContent=`free of ${cmd.fmt.bytes(size)}`;bar(diskBar,dp);
  load.textContent=cmd.fmt.num(avg,2);loadNote.textContent=`1 min · ${cores} cores`;bar(loadBar,avg/cores*100);
  cmd.chart(chart,{type:"line",area:true,series:[{name:"Memory",values:cmd.history("mem",mp)}],format:x=>cmd.fmt.pct(x)});
});
</script>
