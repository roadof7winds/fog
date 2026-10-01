// Одна модель погоды может не увидеть туман целиком (так было 1 октября 2026:
// best_match показал сухо, а icon_eu и ukmo — видимость 40–160 м).
// Скрипт проверяет на наблюдениях Пулково, что надёжнее: одна модель,
// среднее по нескольким или максимум.
import { predictHour } from '../../src/lib/predict.ts';

const ULLI = { lat: 59.8003, lon: 30.2625 };
const DAYS = 90;
const ALERT = 0.05;

const MODELS = ['best_match', 'ecmwf_ifs025', 'icon_eu', 'gfs_seamless', 'ukmo_seamless', 'meteofrance_seamless'];
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

// Запрос сразу по всем моделям сервер отклоняет как слишком тяжёлый,
// поэтому тянем по одной и склеиваем по общей шкале времени.
async function getModel(model) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${ULLI.lat}&longitude=${ULLI.lon}` +
    `&hourly=${VARS.join(',')}&models=${model}&wind_speed_unit=ms&timezone=Europe/Moscow&past_days=${DAYS}&forecast_days=1`;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) return (await res.json()).hourly;
    if (attempt >= 5) throw new Error(`${model}: ${res.status} ${await res.text()}`);
    await new Promise((r) => setTimeout(r, 4000 * attempt));
  }
}

console.log('Загружаю данные моделей…');
const raw = {};
for (const m of MODELS) {
  raw[m] = await getModel(m);
  await new Promise((r) => setTimeout(r, 1500));
}
const h = { time: raw[MODELS[0]].time };

// Низкой облачности и температуры почвы нет у части моделей — зануляем везде
const rowsFor = (model) => {
  const src = raw[model];
  // при одной модели в запросе суффикса в именах нет
  const g = (v, i) => src[`${v}_${model}`]?.[i] ?? src[v]?.[i] ?? null;
  return h.time.map((time, i) => ({
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

const perModel = {};
for (const m of MODELS) {
  const rows = rowsFor(m);
  perModel[m] = rows.map((r, i) => (r.temp == null || r.dew == null || r.wind == null || r.cloud == null ? null : predictHour(r, rows[i - 3]).p));
  const have = perModel[m].filter((x) => x != null).length;
  console.log(`  ${m.padEnd(22)} часов с данными: ${have}`);
}

// ── Истина ─────────────────────────────────────────────
const since = new Date(Date.now() - (DAYS + 1) * 86_400_000);
const until = new Date(Date.now() + 86_400_000);
const q = (n, d) => `year${n}=${d.getFullYear()}&month${n}=${d.getMonth() + 1}&day${n}=${d.getDate()}`;
const csv = await (
  await fetch(
    'https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=ULLI&data=vsby&data=wxcodes' +
      `&${q(1, since)}&${q(2, until)}&tz=Europe/Moscow&format=onlycomma&missing=empty&report_type=3`,
  )
).text();
const MILE_KM = 1.609344;
const truth = new Map();
for (const line of csv.trim().split('\n').slice(1)) {
  const [, valid, vsby, ...wx] = line.split(',');
  if (!valid) continue;
  const km = vsby === '' ? null : Number(vsby) * MILE_KM;
  const code = wx.join(',').trim();
  const fog = (km != null && km < 1) || (/(^|\s)(FZ|BC|PR)?FG(\s|$)/.test(code) && (km == null || km < 2));
  const key = valid.replace(' ', 'T').slice(0, 13);
  if (!truth.has(key) || fog) truth.set(key, { km, fog });
}

// ── Варианты объединения ───────────────────────────────
const combos = {
  ...Object.fromEntries(MODELS.map((m) => [m, (ps) => ps[m]])),
  'среднее': (ps) => {
    const v = Object.values(ps).filter((x) => x != null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  },
  'максимум': (ps) => {
    const v = Object.values(ps).filter((x) => x != null);
    return v.length ? Math.max(...v) : null;
  },
  'медиана': (ps) => {
    const v = Object.values(ps).filter((x) => x != null).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : null;
  },
  'среднее+макс пополам': (ps) => {
    const v = Object.values(ps).filter((x) => x != null);
    if (!v.length) return null;
    return 0.5 * (v.reduce((a, b) => a + b, 0) / v.length) + 0.5 * Math.max(...v);
  },
};

const samples = [];
h.time.forEach((t, i) => {
  const o = truth.get(t.slice(0, 13));
  if (!o || o.km == null) return;
  const ps = Object.fromEntries(MODELS.map((m) => [m, perModel[m][i]]));
  if (Object.values(ps).every((x) => x == null)) return;
  samples.push({ ps, y: o.fog ? 1 : 0 });
});

function auc(pairs) {
  const s = pairs.filter((x) => x.p != null).sort((a, b) => a.p - b.p);
  let sumPos = 0, nPos = 0, nNeg = 0;
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j < s.length && s[j].p === s[i].p) j++;
    const avg = (i + j + 1) / 2;
    for (let k = i; k < j; k++) {
      if (s[k].y) { sumPos += avg; nPos++; } else nNeg++;
    }
    i = j;
  }
  return nPos && nNeg ? (sumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg) : NaN;
}

console.log(`\nЧасов: ${samples.length}, с туманом: ${samples.filter((s) => s.y).length}`);
console.log(`Порог ${ALERT * 100}%\n`);
console.log('вариант                  AUC    поймано   ложных   пропущено   средняя p');
console.log('─'.repeat(74));
for (const [name, fn] of Object.entries(combos)) {
  const pairs = samples.map((s) => ({ p: fn(s.ps), y: s.y })).filter((x) => x.p != null);
  let hit = 0, miss = 0, fa = 0;
  for (const x of pairs) {
    const w = x.p >= ALERT;
    if (w && x.y) hit++;
    else if (!w && x.y) miss++;
    else if (w && !x.y) fa++;
  }
  const mean = pairs.reduce((a, x) => a + x.p, 0) / pairs.length;
  console.log(
    `${name.padEnd(22)} ${auc(pairs).toFixed(3)}  ${((100 * hit) / (hit + miss || 1)).toFixed(0).padStart(6)}%  ` +
      `${((100 * fa) / (hit + fa || 1)).toFixed(0).padStart(6)}%  ${String(miss).padStart(9)}   ${(100 * mean).toFixed(2)}%`,
  );
}
console.log('─'.repeat(74));
console.log('Данные — прошлые часы текущих прогонов каждой модели (ближе к факту, чем настоящий прогноз).');
