Request: how many commits did I make this month
Notes: the workspace ~/src/shop is a git repository; test_source returned one commit date per line (YYYY-MM-DD), newest first.

{"kind":"widget","title":"Commits · 30 days","loading":["Reading the git log…"],"source":{"type":"command","command":"git log --since=30.days --format=%cs"},"refresh":300,"size":"m"}
---
<div class="k-stack k-fill">
  <div class="k-row k-wrap" style="gap:4px 14px"><span><b id="sum">–</b> <span class="k-dim">commits</span></span><span><b id="active">–</b> <span class="k-dim">of 30 days active</span></span><span class="k-hide-narrow k-dim" id="best"></span></div>
  <div class="k-chart" id="chart" style="flex:1"></div>
</div>
<script>
const key=d=>d.toLocaleDateString("en-CA");
cmd.onData(text=>{
  const n={};for(const d of String(text).split("\n").filter(Boolean))n[d]=(n[d]||0)+1;
  const days=Array.from({length:30},(_,i)=>new Date(Date.now()-(29-i)*864e5));
  const v=days.map(d=>n[key(d)]||0),top=Math.max(...v);
  sum.textContent=v.reduce((a,b)=>a+b,0);
  active.textContent=v.filter(Boolean).length;
  best.textContent=top?`busiest ${cmd.fmt.date(days[v.indexOf(top)])} (${top})`:"";
  cmd.chart(chart,{type:"bar",labels:days.map(d=>d.toLocaleDateString("en-GB",{day:"numeric",month:"short"})),series:[{name:"Commits",values:v}],format:x=>cmd.fmt.num(x,0)});
});
</script>
