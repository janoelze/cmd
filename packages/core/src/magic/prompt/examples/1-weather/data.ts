import { s, fetchJson, type Infer } from "cmd";

export const schema = s.object({
  place: s.string(),
  temp: s.number(),
  feels: s.number(),
  wind: s.number(),
  code: s.number(),
  days: s.array(s.object({ date: s.string(), max: s.number(), min: s.number(), code: s.number() })),
});
export type Data = Infer<typeof schema>;

type Geo = { results?: { name: string; country_code: string; latitude: number; longitude: number }[] };
type Forecast = {
  current: { temperature_2m: number; apparent_temperature: number; wind_speed_10m: number; weather_code: number };
  daily: { time: string[]; temperature_2m_max: number[]; temperature_2m_min: number[]; weather_code: number[] };
};

export default async function data(config: { city: string }): Promise<Data> {
  const geo = await fetchJson<Geo>(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(config.city)}`);
  const at = geo.results?.[0];
  if (!at) throw new Error(`No place called "${config.city}"`);
  const f = await fetchJson<Forecast>(
    `https://api.open-meteo.com/v1/forecast?latitude=${at.latitude}&longitude=${at.longitude}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=auto&forecast_days=5`,
  );
  return {
    place: `${at.name}, ${at.country_code}`,
    temp: f.current.temperature_2m,
    feels: f.current.apparent_temperature,
    wind: f.current.wind_speed_10m,
    code: f.current.weather_code,
    days: f.daily.time.map((date, i) => ({ date, max: f.daily.temperature_2m_max[i]!, min: f.daily.temperature_2m_min[i]!, code: f.daily.weather_code[i]! })),
  };
}
