import type { Data } from "./data.ts";

const WEATHER: Record<number, string> = { 0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Fog", 48: "Fog", 51: "Drizzle", 53: "Drizzle", 55: "Drizzle", 61: "Rain", 63: "Rain", 65: "Heavy rain", 71: "Snow", 73: "Snow", 75: "Heavy snow", 80: "Showers", 81: "Showers", 82: "Heavy showers", 95: "Thunderstorm", 96: "Thunderstorm", 99: "Thunderstorm" };
const $ = (id: string) => document.getElementById(id)!;

cmd.onData<Data>((d) => {
  $("temp").textContent = Math.round(d.temp) + "°";
  $("what").textContent = WEATHER[d.code] ?? "";
  $("more").textContent = `${d.place} · feels ${Math.round(d.feels)}° · wind ${Math.round(d.wind)} km/h`;
  cmd.chart($("hours"), {
    type: "line",
    area: true,
    labels: d.hours.map((h) => h.time.slice(11, 16)),
    series: [{ name: "°C", values: d.hours.map((h) => h.temp) }],
    format: (n) => Math.round(n) + "°",
  });
  $("days").replaceChildren(
    ...d.days.map((day, i) => {
      const e = document.createElement("div");
      e.className = "k-stack";
      e.style.gap = "2px";
      const name = document.createElement("div");
      name.className = "k-dim k-small";
      name.textContent = i ? new Date(day.date).toLocaleDateString(undefined, { weekday: "short" }) : "Today";
      const hi = document.createElement("div");
      hi.className = "k-mono";
      hi.textContent = Math.round(day.max) + "°";
      const lo = document.createElement("div");
      lo.className = "k-dim k-small k-mono";
      lo.textContent = Math.round(day.min) + "°";
      e.append(name, hi, lo);
      return e;
    }),
  );
});
