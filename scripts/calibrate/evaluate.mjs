// Считает, насколько балл тумана совпадает с наблюдениями в Пулково.
// Node 24 умеет импортировать .ts напрямую (стирание типов), поэтому берём
// ровно ту же формулу, что работает в приложении.
import { readFileSync } from 'node:fs';
import { scoreHour } from './legacy-score.mjs';

const DIR = new URL('./data/', import.meta.url);
const metar = JSON.parse(readFileSync(new URL('metar.json', DIR), 'utf8'));
const era5 = JSON.parse(readFileSync(new URL('era5.json', DIR), 'utf8'));

const MSK_OFFSET_H = 3; // Europe/Moscow — без перехода на летнее время с 2014 года

/** Пары «прогнозные условия ERA5 → наблюдался ли туман» */
const samples = [];
for (const [utcHour, obs] of Object.entries(metar)) {
  if (obs.visKm == null) continue; // без видимости нет истины
  const e = era5[utcHour];
  if (!e || e.temp == null || e.dew == null || e.wind == null || e.cloud == null) continue;
  const local = new Date(`${utcHour}:00:00Z`);
  local.setUTCHours(local.getUTCHours() + MSK_OFFSET_H);
  const h = { time: local.toISOString().slice(0, 16), ...e, visibility: null };
  samples.push({ utcHour, year: Number(utcHour.slice(0, 4)), month: Number(utcHour.slice(5, 7)), s: scoreHour(h), fog: obs.fog });
}

const fogTotal = samples.filter((s) => s.fog).length;
console.log(`Совпавших часов: ${samples.length}, из них с туманом: ${fogTotal} (${((100 * fogTotal) / samples.length).toFixed(2)}%)`);
console.log(`Период: ${samples[0].utcHour} … ${samples.at(-1).utcHour}\n`);

function metrics(set, predicate) {
  let hit = 0, miss = 0, fa = 0, cn = 0;
  for (const s of set) {
    const p = predicate(s);
    if (p && s.fog) hit++;
    else if (!p && s.fog) miss++;
    else if (p && !s.fog) fa++;
    else cn++;
  }
  const pod = hit / (hit + miss || 1); // доля пойманных туманов
  const far = fa / (hit + fa || 1); // доля ложных тревог среди предупреждений
  const csi = hit / (hit + miss + fa || 1);
  const bias = (hit + fa) / (hit + miss || 1);
  return { hit, miss, fa, cn, pod, far, csi, bias };
}

const pct = (x) => (100 * x).toFixed(1).padStart(5);
const row = (name, m) => console.log(`${name.padEnd(22)} POD ${pct(m.pod)}%  FAR ${pct(m.far)}%  CSI ${m.csi.toFixed(3)}  bias ${m.bias.toFixed(2)}  (попаданий ${m.hit}, пропусков ${m.miss}, ложных ${m.fa})`);

console.log('── Текущая формула, порог по баллу ──');
for (const t of [30, 40, 50, 55, 60, 65, 70, 75, 80]) {
  row(`score ≥ ${t}`, metrics(samples, (s) => s.s.score >= t));
}

console.log('\n── Простые правила для сравнения ──');
row('Δt ≤ 1 и ветер < 2', metrics(samples, (s) => s.s.spread <= 1 && s.s.wind < 2));
row('Δt ≤ 0,5', metrics(samples, (s) => s.s.spread <= 0.5));
row('влажность ≥ 97%', metrics(samples, (s) => s.s.rh >= 97));
row('Δt ≤ 1', metrics(samples, (s) => s.s.spread <= 1));

console.log('\n── Калибровка: что реально означает балл ──');
console.log('балл        часов   туманов   наблюдаемая частота');
for (let lo = 0; lo < 100; lo += 10) {
  const bin = samples.filter((s) => s.s.score >= lo && s.s.score < lo + 10);
  if (!bin.length) continue;
  const f = bin.filter((s) => s.fog).length;
  const share = (100 * f) / bin.length;
  const bar = '█'.repeat(Math.round(share / 2));
  console.log(`${String(lo).padStart(3)}–${String(lo + 9).padEnd(3)} ${String(bin.length).padStart(8)} ${String(f).padStart(9)}   ${share.toFixed(1).padStart(5)}%  ${bar}`);
}

console.log('\n── Частота тумана по месяцам (наблюдения) ──');
for (let m = 1; m <= 12; m++) {
  const bin = samples.filter((s) => s.month === m);
  if (!bin.length) continue;
  const f = bin.filter((s) => s.fog).length;
  console.log(`${String(m).padStart(2)}  ${((100 * f) / bin.length).toFixed(2).padStart(5)}%  (${f} из ${bin.length})`);
}

console.log('\n── Частота тумана по часам суток, местное время ──');
for (let h = 0; h < 24; h++) {
  const bin = samples.filter((s) => s.s.hourOfDay === h);
  if (!bin.length) continue;
  const f = bin.filter((s) => s.fog).length;
  console.log(`${String(h).padStart(2)}:00  ${((100 * f) / bin.length).toFixed(2).padStart(5)}%  (${f} из ${bin.length})`);
}
