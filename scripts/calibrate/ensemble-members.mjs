// Что надёжнее: шесть разных моделей погоды (как сейчас) или 40 прогонов одной
// модели из ансамблевого API? Сравниваем на одних и тех же часах и наблюдениях
// Пулково. Ответ неочевиден: разные модели ошибаются по-разному, а прогоны
// одной модели показывают, насколько сама погода неустойчива.
import { predictOne } from '../../src/lib/predict.ts';

const ULLI = { lat: 59.8003, lon: 30.2625 };
const DAYS = 60;
const CHUNK = 15;
const ALERT = 0.05;

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
const MODELS = ['best_match', 'ecmwf_ifs025', 'icon_eu', 'gfs_seamless', 'ukmo_seamless', 'meteofrance_seamless'];

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

async function getJson(url, tries = 5) {
  for (let i = 1; ; i++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    if (i >= tries) throw new Error(`${res.status}: ${(await res.text()).slice(0, 120)}`);
    await new Promise((r) => setTimeout(r, 4000 * i));
  }
}

const rowFrom = (get, time) => ({
  time,
  temp: get('temperature_2m'),
  rh: get('relative_humidity_2m'),
  dew: get('dew_point_2m'),
  wind: get('wind_speed_10m'),
  windDir: get('wind_direction_10m'),
  gust: get('wind_gusts_10m'),
  cloud: get('cloud_cover'),
  cloudLow: null,
  precip: get('precipitation'),
  swr: get('shortwave_radiation'),
  soilT: null,
  visibility: null,
});

const valid = (r) => r.temp != null && r.dew != null && r.wind != null && r.cloud != null;

// ── Ансамбль: 40 прогонов icon_eu ──────────────────────
console.log(`Ансамблевые прогоны icon_eu, ${DAYS} дней кусками по ${CHUNK}…`);
const ensembleP = new Map(); // время → { mean, min, max }
for (let offset = DAYS; offset > 0; offset -= CHUNK) {
  const end = Date.now() - (offset - CHUNK) * 86_400_000;
  const start = Date.now() - offset * 86_400_000;
  const url =
    `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${ULLI.lat}&longitude=${ULLI.lon}` +
    `&hourly=${VARS.join(',')}&models=icon_eu&wind_speed_unit=ms&timezone=Europe/Moscow` +
    `&start_date=${iso(start)}&end_date=${iso(end)}`;
  const d = await getJson(url);
  const h = d.hourly;
  const members = [...new Set(Object.keys(h).filter((k) => k !== 'time').map((k) => (k.includes('_member') ? k.split('_member')[1] : '')))];
  for (const m of members) {
    const suffix = m ? `_member${m}` : '';
    const rows = h.time.map((t, i) => rowFrom((v) => h[`${v}${suffix}`]?.[i] ?? null, t));
    rows.forEach((r, i) => {
      if (!valid(r)) return;
      const prev = i >= 3 && valid(rows[i - 3]) ? rows[i - 3] : undefined;
      const p = predictOne(r, prev);
      const cur = ensembleP.get(r.time) ?? { list: [] };
      cur.list.push(p);
      ensembleP.set(r.time, cur);
    });
  }
  process.stdout.write(`  ${iso(start)}…${iso(end)}: ${h.time.length} ч × ${members.length} прогонов\n`);
  await new Promise((r) => setTimeout(r, 1500));
}

// ── Шесть моделей, как в приложении ────────────────────
console.log('Шесть разных моделей…');
const multiP = new Map();
for (const model of MODELS) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${ULLI.lat}&longitude=${ULLI.lon}` +
    `&hourly=${VARS.join(',')}&models=${model}&wind_speed_unit=ms&timezone=Europe/Moscow&past_days=${DAYS}&forecast_days=1`;
  const h = (await getJson(url)).hourly;
  const rows = h.time.map((t, i) => rowFrom((v) => h[`${v}_${model}`]?.[i] ?? h[v]?.[i] ?? null, t));
  rows.forEach((r, i) => {
    if (!valid(r)) return;
    const prev = i >= 3 && valid(rows[i - 3]) ? rows[i - 3] : undefined;
    const cur = multiP.get(r.time) ?? { list: [] };
    cur.list.push(predictOne(r, prev));
    multiP.set(r.time, cur);
  });
  await new Promise((r) => setTimeout(r, 1200));
}

// ── Истина ─────────────────────────────────────────────
const q = (n, d) => `year${n}=${d.getFullYear()}&month${n}=${d.getMonth() + 1}&day${n}=${d.getDate()}`;
const csv = await (
  await fetch(
    'https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=ULLI&data=vsby&data=wxcodes' +
      `&${q(1, new Date(Date.now() - (DAYS + 1) * 86_400_000))}&${q(2, new Date(Date.now() + 86_400_000))}` +
      '&tz=Europe/Moscow&format=onlycomma&missing=empty&report_type=3',
  )
).text();
const MILE_KM = 1.609344;
const truth = new Map();
for (const line of csv.trim().split('\n').slice(1)) {
  const [, vt, vsby, ...wx] = line.split(',');
  if (!vt) continue;
  const km = vsby === '' ? null : Number(vsby) * MILE_KM;
  const code = wx.join(',').trim();
  const fog = (km != null && km < 1) || (/(^|\s)(FZ|BC|PR)?FG(\s|$)/.test(code) && (km == null || km < 2));
  const key = vt.replace(' ', 'T').slice(0, 16);
  if (!truth.has(key) || fog) truth.set(key, { km, fog });
}

// ── Сравнение ──────────────────────────────────────────
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
console.log('размеры наборов: ансамбль', ensembleP.size, '| шесть моделей', multiP.size, '| наблюдения', truth.size);
console.log('пример ключей:', [...ensembleP.keys()].slice(0, 2), [...multiP.keys()].slice(0, 2), [...truth.keys()].slice(0, 2));
const samples = [];
for (const [time, o] of truth) {
  if (o.km == null) continue;
  const e = ensembleP.get(time);
  const m = multiP.get(time);
  if (!e || !m) continue;
  samples.push({
    y: o.fog ? 1 : 0,
    'шесть моделей (сейчас)': mean(m.list),
    'ансамбль 40 прогонов': mean(e.list),
    'оба пополам': 0.5 * mean(m.list) + 0.5 * mean(e.list),
    'максимум из двух': Math.max(mean(m.list), mean(e.list)),
  });
}

function auc(pairs) {
  const s = [...pairs].sort((a, b) => a.p - b.p);
  let sum = 0, nPos = 0, nNeg = 0;
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j < s.length && s[j].p === s[i].p) j++;
    const avg = (i + j + 1) / 2;
    for (let k = i; k < j; k++) {
      if (s[k].y) { sum += avg; nPos++; } else nNeg++;
    }
    i = j;
  }
  return nPos && nNeg ? (sum - (nPos * (nPos + 1)) / 2) / (nPos * nNeg) : NaN;
}

console.log(`\nЧасов в сравнении: ${samples.length}, с туманом: ${samples.filter((s) => s.y).length}`);
console.log('\nвариант                     AUC    поймано   ложных    пропущено');
console.log('─'.repeat(66));
for (const key of ['шесть моделей (сейчас)', 'ансамбль 40 прогонов', 'оба пополам', 'максимум из двух']) {
  const pairs = samples.map((s) => ({ p: s[key], y: s.y }));
  let hit = 0, miss = 0, fa = 0;
  for (const x of pairs) {
    const w = x.p >= ALERT;
    if (w && x.y) hit++;
    else if (!w && x.y) miss++;
    else if (w && !x.y) fa++;
  }
  console.log(
    `${key.padEnd(26)} ${auc(pairs).toFixed(3)}  ${((100 * hit) / (hit + miss || 1)).toFixed(0).padStart(6)}%  ` +
      `${((100 * fa) / (hit + fa || 1)).toFixed(0).padStart(6)}%  ${String(miss).padStart(10)}`,
  );
}
console.log('─'.repeat(66));
console.log('Данные — прошлые часы текущих прогонов, то есть ближе к факту, чем настоящий прогноз.');
