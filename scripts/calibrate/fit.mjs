// Обучает логистическую регрессию предсказывать наблюдённый туман в Пулково
// и сравнивает её с текущей эвристикой. Обучение на 2015–2022, честная
// проверка на 2023–2026 (эти годы модель не видит).
import { readFileSync, writeFileSync } from 'node:fs';
import { scoreHour } from './legacy-score.mjs';
import { FEATURES, featureVector } from '../../src/lib/features.ts';

const DIR = new URL('./data/', import.meta.url);
const load = (f) => JSON.parse(readFileSync(new URL(f, DIR), 'utf8'));
const metar = load('metar.json');
const era5 = load('era5.json');
const extra = load('era5-extra.json');

const MSK = 3;
const hourKey = (iso) => iso.slice(0, 13);

// ── Сборка выборки ─────────────────────────────────────
const samples = [];
for (const [utc, obs] of Object.entries(metar)) {
  if (obs.visKm == null) continue;
  const e = era5[utc];
  const x = extra[utc];
  if (!e || e.temp == null || e.dew == null || e.wind == null || e.cloud == null) continue;

  const t0 = new Date(`${utc}:00:00Z`).getTime();
  const prev = era5[hourKey(new Date(t0 - 3 * 3_600_000).toISOString())];
  const local = new Date(t0 + MSK * 3_600_000);

  const f = {
    ...e,
    cloudLow: x?.cloudLow ?? null,
    precip: x?.precip ?? null,
    gust: x?.gust ?? null,
    swr: x?.swr ?? null,
    soilT: x?.soilT ?? null,
    spread: e.temp - e.dew,
    hourOfDay: local.getUTCHours(),
    month: Number(utc.slice(5, 7)),
    dT3: prev ? e.temp - prev.temp : 0,
    dSpread3: prev ? e.temp - e.dew - (prev.temp - prev.dew) : 0,
  };
  const heur = scoreHour({ ...e, time: local.toISOString().slice(0, 16), visibility: null });
  const vec = featureVector(f);
  if (vec.some((v) => !Number.isFinite(v))) continue;
  samples.push({ year: Number(utc.slice(0, 4)), vec, y: obs.fog ? 1 : 0, heur: heur.score });
}

const train = samples.filter((s) => s.year <= 2022);
const test = samples.filter((s) => s.year >= 2023);
console.log(`Обучение: ${train.length} часов (туманов ${train.filter((s) => s.y).length})`);
console.log(`Проверка: ${test.length} часов (туманов ${test.filter((s) => s.y).length})\n`);

// ── Стандартизация ─────────────────────────────────────
const n = FEATURES.length;
const mean = Array(n).fill(0);
const std = Array(n).fill(0);
for (const s of train) for (let i = 0; i < n; i++) mean[i] += s.vec[i] / train.length;
for (const s of train) for (let i = 0; i < n; i++) std[i] += (s.vec[i] - mean[i]) ** 2 / train.length;
for (let i = 0; i < n; i++) std[i] = Math.sqrt(std[i]) || 1;
const norm = (v) => v.map((x, i) => (x - mean[i]) / std[i]);
for (const s of samples) s.z = norm(s.vec);

// ── Обучение: градиентный спуск с моментом и L2 ────────
const sigmoid = (t) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, t))));
let w = Array(n).fill(0);
let b = Math.log(train.filter((s) => s.y).length / train.filter((s) => !s.y).length); // старт от базовой частоты
let vw = Array(n).fill(0);
let vb = 0;
const lr = 0.5;
const l2 = 1e-4;
const momentum = 0.9;

for (let iter = 0; iter < 4000; iter++) {
  const gw = Array(n).fill(0);
  let gb = 0;
  for (const s of train) {
    const p = sigmoid(s.z.reduce((acc, x, i) => acc + x * w[i], b));
    const err = p - s.y;
    for (let i = 0; i < n; i++) gw[i] += (err * s.z[i]) / train.length;
    gb += err / train.length;
  }
  for (let i = 0; i < n; i++) {
    vw[i] = momentum * vw[i] - lr * (gw[i] + l2 * w[i]);
    w[i] += vw[i];
  }
  vb = momentum * vb - lr * gb;
  b += vb;
}

const predict = (s) => sigmoid(s.z.reduce((acc, x, i) => acc + x * w[i], b));
for (const s of samples) s.pRaw = predict(s);

// ── Изотоническая калибровка (PAV) на обучающих годах ──
// Логистическая модель занижает вероятность на верхнем конце; PAV чинит это,
// не трогая порядок часов, поэтому AUC не меняется.
function fitIsotonic(set) {
  const pts = [...set].sort((a, c) => a.pRaw - c.pRaw).map((s) => ({ x: s.pRaw, y: s.y, n: 1 }));
  const stack = [];
  for (const pt of pts) {
    let cur = { sx: pt.x, sy: pt.y, n: 1 };
    while (stack.length && stack.at(-1).sy / stack.at(-1).n > cur.sy / cur.n) {
      const prev = stack.pop();
      cur = { sx: prev.sx + cur.sx, sy: prev.sy + cur.sy, n: prev.n + cur.n };
    }
    stack.push(cur);
  }
  return stack.map((b2) => ({ x: b2.sx / b2.n, y: b2.sy / b2.n }));
}
const iso = fitIsotonic(train);
function applyIsotonic(p) {
  let lo = 0, hi = iso.length - 1;
  if (p <= iso[0].x) return iso[0].y;
  if (p >= iso[hi].x) return iso[hi].y;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (iso[mid].x <= p) lo = mid; else hi = mid;
  }
  const t = (p - iso[lo].x) / (iso[hi].x - iso[lo].x || 1);
  return iso[lo].y + t * (iso[hi].y - iso[lo].y);
}
for (const s of samples) s.p = applyIsotonic(s.pRaw);

// ── Метрики ────────────────────────────────────────────
function auc(set, key) {
  const sorted = [...set].sort((a, b2) => a[key] - b2[key]);
  let rank = 0, sumPos = 0, nPos = 0, nNeg = 0;
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j < sorted.length && sorted[j][key] === sorted[i][key]) j++;
    const avgRank = (i + j + 1) / 2; // средний ранг для связок
    for (let k = i; k < j; k++) {
      if (sorted[k].y) { sumPos += avgRank; nPos++; } else nNeg++;
    }
    rank = j;
    i = j;
  }
  void rank;
  return (sumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

function metrics(set, pred) {
  let hit = 0, miss = 0, fa = 0;
  for (const s of set) {
    const p = pred(s);
    if (p && s.y) hit++;
    else if (!p && s.y) miss++;
    else if (p && !s.y) fa++;
  }
  const pod = hit / (hit + miss || 1);
  const far = fa / (hit + fa || 1);
  return { hit, miss, fa, pod, far, csi: hit / (hit + miss + fa || 1) };
}

const brier = (set, key) => set.reduce((a, s) => a + (s[key] - s.y) ** 2, 0) / set.length;

console.log('── Различающая способность на проверочных годах ──');
console.log(`AUC текущей эвристики : ${auc(test, 'heur').toFixed(3)}`);
console.log(`AUC модели            : ${auc(test, 'p').toFixed(3)}`);
console.log(`Brier сырой модели    : ${brier(test, 'pRaw').toFixed(5)}`);
console.log(`Brier после калибровки: ${brier(test, 'p').toFixed(5)} (базовая частота ${(100 * test.filter((s) => s.y).length / test.length).toFixed(2)}%)\n`);

console.log('── Модель: рабочие точки на проверочных годах ──');
const pctf = (x) => (100 * x).toFixed(1).padStart(5);
for (const t of [0.03, 0.05, 0.08, 0.1, 0.15, 0.2, 0.3]) {
  const m = metrics(test, (s) => s.p >= t);
  console.log(`p ≥ ${String(Math.round(t * 100)).padStart(2)}%   POD ${pctf(m.pod)}%  FAR ${pctf(m.far)}%  CSI ${m.csi.toFixed(3)}  (попаданий ${m.hit}, пропусков ${m.miss}, ложных ${m.fa})`);
}

console.log('\n── Текущая эвристика на тех же годах ──');
for (const t of [55, 70, 80, 90]) {
  const m = metrics(test, (s) => s.heur >= t);
  console.log(`балл ≥ ${String(t).padStart(2)}  POD ${pctf(m.pod)}%  FAR ${pctf(m.far)}%  CSI ${m.csi.toFixed(3)}  (попаданий ${m.hit}, пропусков ${m.miss}, ложных ${m.fa})`);
}

console.log('\n── Надёжность модели: обещано против наблюдённого (проверочные годы) ──');
console.log('предсказано    часов   туманов   наблюдалось');
for (const [lo, hi] of [[0, 0.01], [0.01, 0.03], [0.03, 0.06], [0.06, 0.1], [0.1, 0.2], [0.2, 0.35], [0.35, 0.5], [0.5, 1.01]]) {
  const bin = test.filter((s) => s.p >= lo && s.p < hi);
  if (!bin.length) continue;
  const f = bin.filter((s) => s.y).length;
  const share = (100 * f) / bin.length;
  console.log(`${(100 * lo).toFixed(0).padStart(3)}–${(100 * hi).toFixed(0).padEnd(3)}% ${String(bin.length).padStart(9)} ${String(f).padStart(9)}   ${share.toFixed(1).padStart(5)}%  ${'█'.repeat(Math.round(share / 2))}`);
}

console.log('\n── Вес признаков (стандартизованные) ──');
FEATURES.map((f2, i) => [f2.name, w[i]])
  .sort((a, b2) => Math.abs(b2[1]) - Math.abs(a[1]))
  .forEach(([name, weight]) => console.log(`${name.padEnd(20)} ${weight >= 0 ? '+' : '−'}${Math.abs(weight).toFixed(3)}`));

writeFileSync(
  new URL('model.json', DIR),
  JSON.stringify(
    {
      features: FEATURES.map((f2) => f2.name),
      mean, std, w, b,
      // кусочно-линейная калибровка, прорежённая до ~40 точек для переноса в приложение
      isotonic: iso.filter((_, i) => i % Math.ceil(iso.length / 40) === 0 || i === iso.length - 1).map((q) => [Number(q.x.toFixed(5)), Number(q.y.toFixed(5))]),
      trained: new Date().toISOString(),
      aucTest: Number(auc(test, 'p').toFixed(4)),
      baseRate: Number((test.filter((s2) => s2.y).length / test.length).toFixed(5)),
    },
    null, 2,
  ),
);
console.log('\nМодель сохранена в data/model.json');
