Request: world clock for Berlin, New York and Tokyo
Notes: nothing to look up; no source. The person's own time zone leads, big; the others follow as table rows.

{"kind":"widget","title":"World clock","size":"s"}
---
<style>.now{font-size:clamp(28px,16vmin,56px)}</style>
<div class="k-stack k-fill">
  <div class="k-stack" style="gap:2px"><div class="k-huge k-mono now" id="now">–</div><div class="k-dim k-ellipsis" id="sub">–</div></div>
  <div class="k-spacer"></div>
  <table class="k-table k-hide-short"><tbody id="rows"></tbody></table>
</div>
<script>
const Z=[["Berlin","Europe/Berlin"],["New York","America/New_York"],["Tokyo","Asia/Tokyo"]];
const HERE=Intl.DateTimeFormat().resolvedOptions().timeZone;
const time=(d,tz,sec)=>d.toLocaleTimeString("en-GB",{timeZone:tz,hour:"2-digit",minute:"2-digit",second:sec?"2-digit":undefined});
const wall=(d,tz)=>new Date(d.toLocaleString("en-US",{timeZone:tz}));
function draw(){
  const d=new Date();
  now.textContent=time(d,HERE,true);
  sub.textContent=d.toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long"})+" · "+HERE.split("/").pop().replace(/_/g," ");
  rows.replaceChildren(...Z.filter(([,tz])=>tz!==HERE).map(([name,tz])=>{
    const h=Math.round((wall(d,tz)-wall(d,HERE))/36e5);
    const day=wall(d,tz).getDate()-wall(d,HERE).getDate();
    const tr=document.createElement("tr");
    tr.innerHTML=`<td class="k-text">${name}</td><td class="k-text k-dim k-small">${h?(h>0?"+":"")+h+" h":"same time"}${day>0?" · tomorrow":day<0?" · yesterday":""}</td><td class="k-num">${time(d,tz)}</td>`;
    return tr;
  }));
}
setInterval(draw,1000);draw();
</script>
