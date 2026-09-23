// Сверка модели с фактом за конкретные сутки:
//   node scripts/calibrate/retro.mjs 2026-09-22
// Три колонки слева — что модель сказала бы за двое суток, за сутки и по уже
// случившейся погоде. Справа — что намерили в Пулково.
// Open-Meteo хранит прошлые часы и прошлые прогоны 92 дня.
import { predictHour, pct } from '../../src/lib/predict.ts';

const day = process.argv[2] ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const ULLI = { lat: 59.8003, lon: 30.2625 };

const daysAgo = Math.round((Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00Z`) - Date.parse(`${day}T00:00Z`)) / 86_400_000);
if (daysAgo > 90) throw new Error('Open-Meteo отдаёт прошлые часы только за 92 дня');

// Низкой облачности и температуры почвы в архиве прошлых прогонов нет,
// поэтому во всех колонках зануляем их: сравниваем заблаговременность, а не набор полей.
const VARS = [
  'temperature_2m',
  'relative_humidity_2m',
  'dew_point_2m',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
  'cloud_cover',
  'precipitation',
  'shortwave_radiation',
];

const past = Math.max(daysAgo + 1, 2);
const base = `latitude=${ULLI.lat}&longitude=${ULLI.lon}&wind_speed_unit=ms&timezone=Europe/Moscow&past_days=${past}&forecast_days=1`;

const [analysis, prev, metarCsv] = await Promise.all([
  fetch(`https://api.open-meteo.com/v1/forecast?${base}&hourly=${VARS.join(',')}`).then((r) => r.json()),
  fetch(
    `https://previous-runs-api.open-meteo.com/v1/forecast?${base}&hourly=${VARS.flatMap((v) => [`${v}_previous_day1`, `${v}_previous_day2`]).join(',')}`,
  ).then((r) => r.json()),
  fetch(
    'https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=ULLI&data=vsby&data=wxcodes' +
      `&year1=${day.slice(0, 4)}&month1=${+day.slice(5, 7)}&day1=${+day.slice(8, 10)}` +
      `&year2=${day.slice(0, 4)}&month2=${+day.slice(5, 7)}&day2=${+day.slice(8, 10) + 2}` +
      '&tz=Europe/Moscow&format=onlycomma&missing=empty&report_type=3',
  ).then((r) => r.text()),
]);

const MILE_KM = 1.609344;
const obs = new Map();
for (const line of metarCsv.trim().split('\n').slice(1)) {
  const [, valid, vsby, ...wx] = line.split(',');
  if (!valid) continue;
  const key = valid.replace(' ', 'T').slice(0, 13);
  const km = vsby === '' ? null : Number(vsby) * MILE_KM;
  const code = wx.join(',').trim();
  const prevRow = obs.get(key);
  if (!prevRow || (km != null && prevRow.km != null && km < prevRow.km)) obs.set(key, { km, code });
}

const rowsFrom = (hourly, suffix = '') => {
  const g = (v, i) => hourly[`${v}${suffix}`]?.[i] ?? null;
  return hourly.time.map((time, i) => ({
    time,
    temp: g('temperature_2m', i),
    rh: g('relative_humidity_2m', i),
    dew: g('dew_point_2m', i),
    wind: g('wind_speed_10m', i),
    windDir: g('wind_direction_10m', i),
    gust: g('wind_gusts_10m', i),
    cloud: g('cloud_cover', i),
    cloudLow: null,
    precip: g('precipitation', i),
    swr: g('shortwave_radiation', i),
    soilT: null,
    visibility: null,
  }));
};

const columns = {
  d2: rowsFrom(prev.hourly, '_previous_day2'),
  d1: rowsFrom(prev.hourly, '_previous_day1'),
  an: rowsFrom(analysis.hourly),
};

const p = (rows, i) => (rows[i]?.temp == null ? '  —' : pct(predictHour(rows[i], rows[i - 3]).p) + '%');

console.log(`\nПулково, ${day} (время местное)\n`);
console.log('час     за 2 суток  за сутки   по факту погоды │ видимость   явление');
console.log('─'.repeat(74));
let fogHours = 0;
const caught = { d2: 0, d1: 0, an: 0 };
for (let i = 0; i < columns.an.length; i++) {
  const r = columns.an[i];
  if (!r.time.startsWith(day)) continue;
  const o = obs.get(r.time.slice(0, 13));
  const fog = o && ((o.km != null && o.km < 1) || (/(^|\s)(FZ|BC|PR)?FG(\s|$)/.test(o.code) && (o.km == null || o.km < 2)));
  if (fog) {
    fogHours++;
    for (const key of ['d2', 'd1', 'an']) {
      const rows = columns[key];
      if (rows[i]?.temp != null && predictHour(rows[i], rows[i - 3]).p >= 0.08) caught[key]++;
    }
  }
  const vis = o?.km == null ? '—' : o.km < 1 ? `${Math.round(o.km * 1000)} м` : `${o.km.toFixed(1)} км`;
  console.log(
    `${r.time.slice(11, 16)}  ${p(columns.d2, i).padStart(9)}  ${p(columns.d1, i).padStart(9)}  ${p(columns.an, i).padStart(12)} │ ` +
      `${vis.padStart(8)}   ${fog ? 'ТУМАН ' : ''}${o?.code ?? ''}`,
  );
}
console.log('─'.repeat(74));
console.log(`Часов с туманом: ${fogHours}`);
console.log(`Предупреждено при пороге 8%: за 2 суток ${caught.d2}, за сутки ${caught.d1}, по факту погоды ${caught.an}`);
