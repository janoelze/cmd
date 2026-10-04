Request: memory, disk and load at a glance
Notes: test_source returned text: three sysctl lines (cores, memory in bytes, load averages), then vm_stat, then df -k /.

{"kind":"widget","title":"System","loading":["Reading memory and disk…"],"source":{"type":"command","command":"sysctl -n hw.ncpu hw.memsize vm.loadavg; vm_stat; df -k /"},"refresh":5,"size":"m"}
---
<style>.m td{vertical-align:middle}.m .l{width:1%;white-space:nowrap}.m .b{width:100%}.m .k-num{white-space:nowrap}</style>
<div class="k-panes">
  <div class="k-pane">
    <table class="k-table m"><tbody>
      <tr><td class="k-text l">Memory</td><td class="b"><div class="k-bar"><i id="memBar"></i></div></td><td class="k-num" id="mem">–</td><td class="k-num k-dim k-hide-narrow" id="memNote"></td></tr>
      <tr><td class="k-text l">Disk</td><td class="b"><div class="k-bar"><i id="diskBar"></i></div></td><td class="k-num" id="disk">–</td><td class="k-num k-dim k-hide-narrow" id="diskNote"></td></tr>
      <tr><td class="k-text l">Load</td><td class="b"><div class="k-bar"><i id="loadBar"></i></div></td><td class="k-num" id="load">–</td><td class="k-num k-dim k-hide-narrow" id="loadNote"></td></tr>
    </tbody></table>
  </div>
  <div class="k-pane">
    <div class="k-title k-between">Memory used<span>last 5 min</span></div>
    <div class="k-chart" id="chart"></div>
  </div>
</div>
<script>
const bar=(el,p)=>{el.style.setProperty("--v",Math.min(100,p)+"%");el.style.setProperty("--c",p>90?"var(--bad)":p>75?"var(--warn)":"var(--c1)");};
cmd.onData(text=>{
  const t=String(text),L=t.split("\n");
  const cores=+L[0],total=+L[1],avg=+(/[\d.]+/.exec(L[2])||[])[0];
  const page=+(/page size of (\d+)/.exec(t)||[])[1]||16384;
  const pages=k=>+(new RegExp(`^Pages ${k}:\\s+(\\d+)`,"m").exec(t)||[])[1]||0;
  const used=(pages("active")+pages("wired down")+pages("occupied by compressor"))*page;
  const df=(L.find(l=>/\s\/$/.test(l))||"").trim().split(/\s+/),size=+df[1]*1024,free=+df[3]*1024;
  const mp=used/total*100;
  mem.textContent=cmd.fmt.bytes(used);memNote.textContent=`${cmd.fmt.pct(mp)} of ${cmd.fmt.bytes(total)}`;bar(memBar,mp);
  disk.textContent=cmd.fmt.bytes(free)+" free";diskNote.textContent=`of ${cmd.fmt.bytes(size)}`;bar(diskBar,(size-free)/size*100);
  load.textContent=cmd.fmt.num(avg,2);loadNote.textContent=`${cores} cores`;bar(loadBar,avg/cores*100);
  cmd.chart(chart,{type:"line",area:true,series:[{name:"Memory",values:cmd.history("mem",mp)}],format:x=>cmd.fmt.pct(x)});
});
</script>
