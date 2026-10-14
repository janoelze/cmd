// The weather in a city (Open-Meteo, no key): the temperature now, the next hours as a
// sparkline, the days ahead as rows. The city is the window's config.

import { Window, View, Stack, Inline, Stat, Text, Sparkline, List, ListSection, ListRow, ListRowIcon, ListRowContent, ListRowEnd, Chip, useConfig, useData, cmd } from "@cmd/widget-api";

export interface Forecast {
  place: string;
  temp: number;
  code: number;
  hours: number[];
  days: { date: string; max: number; min: number; code: number }[];
}

/** WMO weather codes: words and an SF Symbol. */
const SKY: [number, string, string][] = [
  [0, "Clear", "sun.max"],
  [2, "Partly cloudy", "cloud.sun"],
  [3, "Overcast", "cloud"],
  [48, "Fog", "cloud.fog"],
  [57, "Drizzle", "cloud.drizzle"],
  [67, "Rain", "cloud.rain"],
  [77, "Snow", "cloud.snow"],
  [82, "Showers", "cloud.heavyrain"],
  [99, "Thunderstorm", "cloud.bolt"],
];
const sky = (code: number) => SKY.find(([max]) => code <= max) ?? SKY[SKY.length - 1]!;

async function json<T>(url: string): Promise<T> {
  const r = await cmd.net.fetch(url);
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  return JSON.parse(r.body) as T;
}

export async function forecast(city: string): Promise<Forecast> {
  const geo = await json<{ results?: { name: string; country_code: string; latitude: number; longitude: number }[] }>(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`);
  const at = geo.results?.[0];
  if (!at) throw new Error(`No place called ${city}`);
  const f = await json<{
    current: { temperature_2m: number; weather_code: number };
    hourly: { time: string[]; temperature_2m: number[] };
    daily: { time: string[]; temperature_2m_max: number[]; temperature_2m_min: number[]; weather_code: number[] };
  }>(`https://api.open-meteo.com/v1/forecast?latitude=${at.latitude}&longitude=${at.longitude}&current=temperature_2m,weather_code&hourly=temperature_2m&daily=temperature_2m_max,temperature_2m_min,weather_code&forecast_days=6&timezone=auto`);
  return {
    place: `${at.name}, ${at.country_code}`,
    temp: f.current.temperature_2m,
    code: f.current.weather_code,
    hours: f.hourly.temperature_2m.slice(0, 24),
    days: f.daily.time.map((date, i) => ({ date, max: f.daily.temperature_2m_max[i] ?? 0, min: f.daily.temperature_2m_min[i] ?? 0, code: f.daily.weather_code[i] ?? 0 })).slice(1),
  };
}

const deg = (n: number) => `${Math.round(n)}°`;
const weekday = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString("en", { weekday: "short" });

export default function Weather() {
  const city = useConfig<{ city: string }>().city || "Lisbon";
  const { data, error } = useData(() => forecast(city), { every: 900 });
  const status = error ? `Stale · ${error.message}` : data ? `${deg(data.temp)} · ${sky(data.code)[1]}` : null;
  const state = data ? null : error ? { kind: "error" as const, icon: "cloud", title: "No forecast", text: error.message } : { kind: "loading" as const, title: "Asking Open-Meteo…" };

  return (
    <Window status={status}>
      <View state={state}>
        {data && (
          <>
            <Stack pad="inset" gap={2}>
              <Inline justify="between">
                <Stat label={data.place} value={deg(data.temp)} />
                <Text tone="dim">{sky(data.code)[1]}</Text>
              </Inline>
              <Sparkline values={data.hours} height={48} />
              <Text tone="dim" size="sm">
                Next 24 hours · {deg(Math.min(...data.hours))} to {deg(Math.max(...data.hours))}
              </Text>
            </Stack>
            <List>
              <ListSection title="Next days" count={data.days.length}>
                {data.days.map((d) => (
                  <ListRow key={d.date}>
                    <ListRowIcon icon={sky(d.code)[2]} />
                    <ListRowContent title={weekday(d.date)} place={sky(d.code)[1]} />
                    <ListRowEnd>
                      <Text mono>
                        {deg(d.min)} / {deg(d.max)}
                      </Text>
                    </ListRowEnd>
                  </ListRow>
                ))}
              </ListSection>
            </List>
          </>
        )}
      </View>
    </Window>
  );
}
