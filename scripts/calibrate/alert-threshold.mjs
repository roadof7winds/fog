// Выбор порога оповещения. Считает не по часам, а по событиям — так, как это
// чувствует человек: сколько уведомлений в год придёт, сколько из них окажутся
// с туманом и сколько туманов будет пропущено.
// Только проверочные годы (2023+), которых модель не видела.
import { readFileSync } from 'node:fs';
import { predictHour } from '../../src/lib/predict.ts';

const DIR = new URL('./data/', import.meta.url);
const load = (f) => JSON.parse(readFileSync(new URL(f, DIR), 'utf8'));
const metar = load('metar.json');
const era5 = load('era5.json');
const extra = load('era5-extra.json');

const MSK = 3;
const FROM_YEAR = 2023;

const hours = [];
for (const [utc, obs] of Object.entries(metar).sort()) {
  if (Number(utc.slice(0, 4)) < FROM_YEAR) continue;
  if (obs.visKm == null) continue;
  const e = era5[utc];
  const x = extra[utc] ?? {};
  if (!e || e.temp == null || e.dew == null || e.wind == null || e.cloud == null) continue;
  const t0 = Date.parse(`${utc}:00:00Z`);
  const prevUtc = new Date(t0 - 3 * 3_600_000).toISOString().slice(0, 13);
  const mk = (src) =>
    src && {
      time: new Date(Date.parse(`${(src === e ? utc : prevUtc)}:00:00Z`) + MSK * 3_600_000).toISOString().slice(0, 16),
      temp: src.temp, rh: src.rh, dew: src.dew, wind: src.wind, windDir: src.windDir, cloud: src.cloud,
      cloudLow: x.cloudLow ?? null, precip: x.precip ?? null, gust: x.gust ?? null, swr: x.swr ?? null, soilT: x.soilT ?? null,
      visibility: null,
    };
  const row = mk(e);
  hours.push({ utc, t: t0, p: predictHour(row, mk(era5[prevUtc])).p, fog: obs.fog });
}

const years = (hours.at(-1).t - hours[0].t) / (365.25 * 86_400_000);
const fogEvents = [];
for (let i = 0; i < hours.length; i++) {
  if (!hours[i].fog) continue;
  if (i > 0 && hours[i - 1].fog && hours[i].t - hours[i - 1].t <= 2 * 3_600_000) continue;
  fogEvents.push(i);
}
console.log(`Проверочный период: ${hours[0].utc} … ${hours.at(-1).utc} (${years.toFixed(1)} года)`);
console.log(`Часов: ${hours.length}, с туманом: ${hours.filter((h) => h.fog).length}, отдельных туманов: ${fogEvents.length}`);
console.log(`Туманов в год: ${(fogEvents.length / years).toFixed(0)}\n`);

/** Одно уведомление на непрерывное окно, как в приложении */
function simulate(T) {
  const alerts = [];
  let cur = null;
  for (const h of hours) {
    if (h.p >= T) {
      if (!cur || h.t - cur.end > 3 * 3_600_000) {
        cur = { start: h.t, end: h.t, fog: false };
        alerts.push(cur);
      }
      cur.end = h.t;
      if (h.fog) cur.fog = true;
    }
  }
  // туман считается пойманным, если он попал в окно тревоги
  let caught = 0;
  for (const i of fogEvents) {
    const t = hours[i].t;
    if (alerts.some((a) => t >= a.start - 3_600_000 && t <= a.end + 3_600_000)) caught++;
  }
  const justified = alerts.filter((a) => a.fog).length;
  return {
    perYear: alerts.length / years,
    justifiedShare: alerts.length ? justified / alerts.length : NaN,
    caughtShare: caught / fogEvents.length,
    missedPerYear: (fogEvents.length - caught) / years,
  };
}

console.log('порог   уведомлений в год   из них с туманом   поймано туманов   пропущено в год');
console.log('─'.repeat(82));
for (const T of [0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.1, 0.12, 0.15, 0.2, 0.25]) {
  const r = simulate(T);
  console.log(
    `${String(Math.round(T * 100)).padStart(4)}%   ${r.perYear.toFixed(0).padStart(15)}   ${(100 * r.justifiedShare).toFixed(0).padStart(15)}%   ` +
      `${(100 * r.caughtShare).toFixed(0).padStart(14)}%   ${r.missedPerYear.toFixed(0).padStart(14)}`,
  );
}
console.log('─'.repeat(82));
console.log('Считано на реанализе. В настоящем прогнозе на сутки вперёд доля пойманных примерно');
console.log('на треть ниже, а ложных тревог больше — см. forecast-skill.mjs.');
