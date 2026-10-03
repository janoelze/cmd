Request: bitcoin price today
Notes: test_source returned {"prices": [[ms, usd], …]} with 288 points over 24 h.

{"kind":"widget","title":"Bitcoin · 24 h","loading":["Asking CoinGecko…"],"source":{"type":"fetch","url":"https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=1"},"refresh":300,"size":"m"}
---
<div class="k-stack k-fill">
  <div class="k-grid">
    <div class="k-stat"><div class="k-stat-label">Price</div><div class="k-stat-value" id="now">–</div><div class="k-delta" id="chg"></div></div>
    <div class="k-stat"><div class="k-stat-label">24 h range</div><div class="k-stat-value k-dim" id="range" style="font-size:15px">–</div></div>
  </div>
  <div class="k-chart" id="chart" style="flex:1"></div>
</div>
<script>
const usd=n=>cmd.fmt.num(n,0);
cmd.onData(d=>{
  const p=d.prices.map(x=>x[1]),first=p[0],last=p.at(-1),pct=(last-first)/first*100;
  now.innerHTML=`${usd(last)}<span class="k-unit">USD</span>`;
  chg.className="k-delta "+(pct>=0?"k-up":"k-down");
  chg.textContent=`${pct>=0?"▲":"▼"} ${cmd.fmt.pct(Math.abs(pct))}`;
  range.textContent=`${usd(Math.min(...p))} – ${usd(Math.max(...p))}`;
  cmd.chart(chart,{type:"line",area:true,labels:d.prices.map(x=>cmd.fmt.time(x[0])),series:[{name:"USD",values:p}],format:usd});
});
</script>
