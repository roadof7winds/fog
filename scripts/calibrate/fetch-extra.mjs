// Догружает предикторы ERA5, которых не хватало в первом заходе:
// низкая облачность (для радиационного тумана важнее общей), осадки,
// порывы, давление, температура почвы и приток солнечной радиации.
import { writeFileSync } from 'node:fs';

const ULLI = { lat: 59.8003, lon: 30.2625 };
const DIR = new URL('./data/', import.meta.url);

const p = new URLSearchParams({
  latitude: ULLI.lat,
  longitude: ULLI.lon,
  start_date: '2015-01-01',
  end_date: '2026-09-01',
  hourly: [
    'cloud_cover_low',
    'precipitation',
    'pressure_msl',
    'wind_gusts_10m',
    'soil_temperature_0_to_7cm',
    'shortwave_radiation',
    'surface_pressure',
  ].join(','),
  wind_speed_unit: 'ms',
  timezone: 'UTC',
});

console.log('ERA5 (дополнительные поля)…');
const res = await fetch(`https://archive-api.open-meteo.com/v1/archive?${p}`);
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const d = await res.json();
const h = d.hourly;
const out = {};
h.time.forEach((t, i) => {
  out[t.slice(0, 13)] = {
    cloudLow: h.cloud_cover_low[i],
    precip: h.precipitation[i],
    pmsl: h.pressure_msl[i],
    gust: h.wind_gusts_10m[i],
    soilT: h.soil_temperature_0_to_7cm[i],
    swr: h.shortwave_radiation[i],
  };
});
writeFileSync(new URL('era5-extra.json', DIR), JSON.stringify(out));
console.log(`  ${h.time.length} часов сохранено`);
