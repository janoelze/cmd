Request: weather in Lisbon
Notes: no looking around needed; test_source showed `current` and `daily` objects.

{"kind":"widget","title":"Weather · Lisbon","loading":["Asking Open-Meteo…"],"source":{"type":"fetch","url":"https://api.open-meteo.com/v1/forecast?latitude=38.72&longitude=-9.14&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=auto&forecast_days=5"},"refresh":900,"size":"m"}
---
<style>.now{align-items:flex-end;gap:12px}.days{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;text-align:center}</style>
<div class="k-stack k-fill">
  <div class="k-row now"><div class="k-huge" id="t">–</div><div class="k-stack" style="gap:2px"><div id="w"></div><div class="k-dim k-small" id="f"></div></div></div>
  <div class="k-spacer"></div>
  <div class="days" id="days"></div>
</div>
<script>
const W={0:"Clear",1:"Mostly clear",2:"Partly cloudy",3:"Overcast",45:"Fog",48:"Fog",51:"Drizzle",53:"Drizzle",55:"Drizzle",61:"Rain",63:"Rain",65:"Heavy rain",71:"Snow",73:"Snow",75:"Heavy snow",80:"Showers",81:"Showers",82:"Heavy showers",95:"Thunderstorm",96:"Thunderstorm",99:"Thunderstorm"};
cmd.onData(d=>{
  const c=d.current;
  t.textContent=Math.round(c.temperature_2m)+"°";
  w.textContent=W[c.weather_code]??"";
  f.textContent=`Feels ${Math.round(c.apparent_temperature)}° · wind ${Math.round(c.wind_speed_10m)} km/h`;
  days.replaceChildren(...d.daily.time.map((day,i)=>{
    const e=document.createElement("div");e.className="k-stack";e.style.gap="2px";
    e.innerHTML=`<div class="k-dim k-small">${i?cmd.fmt.date(day).split(" ")[0]:"Today"}</div><div>${Math.round(d.daily.temperature_2m_max[i])}°</div><div class="k-dim k-small">${Math.round(d.daily.temperature_2m_min[i])}°</div>`;
    return e;
  }));
});
</script>
