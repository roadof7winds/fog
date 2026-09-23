// Сколько точности теряется при переходе от «погоды, которая уже случилась»
// к настоящему прогнозу. Сравниваем на одних и тех же часах:
//   анализ   — данные текущего прогона модели для прошлых часов;
//   прогноз  — что тот же Open-Meteo говорил про эти часы сутки и двое назад.
// Истина — METAR Пулково. Open-Meteo хранит прошлые часы 92 дня.
import { predictHour } from '../../src/lib/predict.ts';

const ULLI = { lat: 59.8003, lon: 30.2625 };
const DAYS = 90;
const ALERT = 0.08;

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

const base = `latitude=${ULLI.lat}&longitude=${ULLI.lon}&wind_speed_unit=ms&timezone=Europe/Moscow&past_days=${DAYS}&forecast_days=1`;

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

console.log('Загружаю анализ и прошлые прогоны…');
const analysis = await getJson(`https://api.open-meteo.com/v1/forecast?${base}&hourly=${VARS.join(',')}`);
const prev = await getJson(
  `https://previous-runs-api.open-meteo.com/v1/forecast?${base}&hourly=${VARS.flatMap((v) => [`${v}_previous_day1`, `${v}_previous_day2`]).join(',')}`,
);

// Низкой облачности и температуры почвы в прошлых прогонах нет, поэтому
// зануляем их во всех вариантах — сравниваем заблаговременность, а не набор полей.
function rowsFrom(hourly, suffix = '') {
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
}

const variants = {
  'анализ (что было)': rowsFrom(analysis.hourly),
  'прогноз на сутки': rowsFrom(prev.hourly, '_previous_day1'),
  'прогноз на двое суток': rowsFrom(prev.hourly, '_previous_day2'),
};

// ── Истина: METAR ──────────────────────────────────────
const since = new Date(Date.now() - (DAYS + 1) * 86_400_000);
const until = new Date(Date.now() + 86_400_000);
const q = (d) => `year${d[0]}=${d[1].getFullYear()}&month${d[0]}=${d[1].getMonth() + 1}&day${d[0]}=${d[1].getDate()}`;
const csv = await (
  await fetch(
    'https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=ULLI&data=vsby&data=wxcodes' +
      `&${q([1, since])}&${q([2, until])}&tz=Europe/Moscow&format=onlycomma&missing=empty&report_type=3`,
  )
).text();

const MILE_KM = 1.609344;
const truth = new Map();
for (const line of csv.trim().split('\n').slice(1)) {
  const [, valid, vsby, ...wx] = line.split(',');
  if (!valid) continue;
  const key = valid.replace(' ', 'T').slice(0, 13);
  const km = vsby === '' ? null : Number(vsby) * MILE_KM;
  const code = wx.join(',').trim();
  const fog = (km != null && km < 1) || /(^|\s)(FZ|BC|PR)?FG(\s|$)/.test(code);
  const prevRow = truth.get(key);
  if (!prevRow || fog) truth.set(key, { km, fog });
}

// ── Оценка ─────────────────────────────────────────────
function auc(pairs) {
  const sorted = [...pairs].sort((a, b) => a.p - b.p);
  let sumPos = 0, nPos = 0, nNeg = 0;
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j < sorted.length && sorted[j].p === sorted[i].p) j++;
    const avg = (i + j + 1) / 2;
    for (let k = i; k < j; k++) {
      if (sorted[k].y) { sumPos += avg; nPos++; } else nNeg++;
    }
    i = j;
  }
  return nPos && nNeg ? (sumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg) : NaN;
}

const results = {};
for (const [name, rows] of Object.entries(variants)) {
  const pairs = [];
  rows.forEach((r, i) => {
    if (r.temp == null || r.dew == null || r.wind == null || r.cloud == null) return;
    const t = truth.get(r.time.slice(0, 13));
    if (!t || t.km == null) return;
    pairs.push({ p: predictHour(r, rows[i - 3]).p, y: t.fog ? 1 : 0, time: r.time });
  });
  results[name] = pairs;
}

// сравниваем строго на пересечении часов, где есть все три варианта
const common = new Set(Object.values(results)[0].map((x) => x.time));
for (const pairs of Object.values(results)) {
  const has = new Set(pairs.map((x) => x.time));
  for (const t of [...common]) if (!has.has(t)) common.delete(t);
}

const fogHours = results['анализ (что было)'].filter((x) => common.has(x.time) && x.y).length;
console.log(`\nЧасов в сравнении: ${common.size}, из них с туманом: ${fogHours}`);
console.log(`Порог тревоги: ${ALERT * 100}%\n`);
console.log('вариант                  AUC    поймано   ложных   тревог   пропущено');
console.log('─'.repeat(72));
for (const [name, all] of Object.entries(results)) {
  const pairs = all.filter((x) => common.has(x.time));
  let hit = 0, miss = 0, fa = 0;
  for (const x of pairs) {
    const warn = x.p >= ALERT;
    if (warn && x.y) hit++;
    else if (!warn && x.y) miss++;
    else if (warn && !x.y) fa++;
  }
  const pod = hit + miss ? (100 * hit) / (hit + miss) : NaN;
  const far = hit + fa ? (100 * fa) / (hit + fa) : NaN;
  console.log(
    `${name.padEnd(24)} ${auc(pairs).toFixed(3)}  ${pod.toFixed(0).padStart(6)}%  ${far.toFixed(0).padStart(6)}%  ${String(hit + fa).padStart(7)}  ${String(miss).padStart(10)}`,
  );
}
console.log('─'.repeat(72));
console.log('Выборка за 90 дней короткая и летняя: туманов мало, цифры ориентировочные.');
