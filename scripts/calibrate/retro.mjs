// Сверка модели с фактом за конкретные сутки:
//   node scripts/calibrate/retro.mjs 2026-09-22
// Слева — что показала бы модель, справа — что намерили в Пулково.
// Open-Meteo хранит прошлые часы до 92 дней назад.
import { predictHour, pct } from '../../src/lib/predict.ts';

const day = process.argv[2] ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const ULLI = { lat: 59.8003, lon: 30.2625 };

const daysAgo = Math.round((Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00Z`) - Date.parse(`${day}T00:00Z`)) / 86_400_000);
if (daysAgo > 90) throw new Error('Open-Meteo отдаёт прошлые часы только за 92 дня');

const HOURLY = 'temperature_2m,relative_humidity_2m,dew_point_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,cloud_cover_low,precipitation,shortwave_radiation,soil_temperature_0_to_7cm,visibility';
const weather = await (
  await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${ULLI.lat}&longitude=${ULLI.lon}&hourly=${HOURLY}` +
      `&wind_speed_unit=ms&timezone=Europe/Moscow&past_days=${Math.max(daysAgo + 1, 2)}&forecast_days=1`,
  )
).json();

// METAR за сутки по местному времени: берём с запасом и фильтруем
const metarCsv = await (
  await fetch(
    'https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=ULLI&data=vsby&data=wxcodes' +
      `&year1=${day.slice(0, 4)}&month1=${+day.slice(5, 7)}&day1=${+day.slice(8, 10)}` +
      `&year2=${day.slice(0, 4)}&month2=${+day.slice(5, 7)}&day2=${+day.slice(8, 10) + 2}` +
      '&tz=Europe/Moscow&format=onlycomma&missing=empty&report_type=3',
  )
).text();

const MILE_KM = 1.609344;
const obs = new Map();
for (const line of metarCsv.trim().split('\n').slice(1)) {
  const [, valid, vsby, ...wx] = line.split(',');
  if (!valid) continue;
  const key = valid.replace(' ', 'T').slice(0, 13);
  const km = vsby === '' ? null : Number(vsby) * MILE_KM;
  const code = wx.join(',').trim();
  const prev = obs.get(key);
  if (!prev || (km != null && prev.km != null && km < prev.km)) obs.set(key, { km, code });
}

const h = weather.hourly;
const rows = h.time.map((time, i) => ({
  time,
  temp: h.temperature_2m[i],
  rh: h.relative_humidity_2m[i],
  dew: h.dew_point_2m[i],
  wind: h.wind_speed_10m[i],
  windDir: h.wind_direction_10m[i],
  gust: h.wind_gusts_10m[i],
  cloud: h.cloud_cover[i],
  cloudLow: h.cloud_cover_low[i],
  precip: h.precipitation[i],
  swr: h.shortwave_radiation[i],
  soilT: h.soil_temperature_0_to_7cm[i],
  visibility: h.visibility[i],
}));

console.log(`\nПулково, ${day} (время местное)\n`);
console.log('час     модель        Δт  ветер  обл%   видимость факт   явление');
console.log('─'.repeat(72));
let hits = 0;
let fogHours = 0;
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  if (!r.time.startsWith(day)) continue;
  const p = predictHour(r, rows[i - 3]);
  const o = obs.get(r.time.slice(0, 13));
  const fog = o && ((o.km != null && o.km < 1) || /(^|\s)(FZ|BC|PR)?FG(\s|$)/.test(o.code));
  if (fog) fogHours++;
  if (fog && p.p >= 0.08) hits++;
  const visText = o?.km == null ? '—' : o.km < 1 ? `${Math.round(o.km * 1000)} м` : `${o.km.toFixed(1)} км`;
  console.log(
    `${r.time.slice(11, 16)}  ${(pct(p.p) + '%').padStart(6)}  ${fog ? '← ТУМАН' : '       '}  ` +
      `${(r.temp - r.dew).toFixed(1).padStart(4)}  ${r.wind.toFixed(1).padStart(4)}  ${String(r.cloud).padStart(4)}  ` +
      `${visText.padStart(10)}   ${o?.code ?? ''}`,
  );
}
console.log('─'.repeat(72));
console.log(`Часов с туманом: ${fogHours}, из них предупреждено (p ≥ 8%): ${hits}`);
