// Поправка на факт: если в Пулково прямо сейчас туман, ближайшие часы надо
// оценивать иначе, чем по одному прогнозу. Туман очень «липкий»: через час
// после тумана он остаётся в 57% случаев при обычной частоте 1%.
// Скрипт обучает смесь «прогноз + факт» и проверяет её на годах, которых не видел.
import { readFileSync, writeFileSync } from 'node:fs';
import { predictOne } from '../../src/lib/predict.ts';

const DIR = new URL('./data/', import.meta.url);
const load = (f) => JSON.parse(readFileSync(new URL(f, DIR), 'utf8'));
const metar = load('metar.json');
const era5 = load('era5.json');
const extra = load('era5-extra.json');

const MSK = 3;
const LEADS = [1, 2, 3, 4, 5, 6];
const ALERT = 0.05;

/** Видимость 9,99 км — это «максимум», который пишут в сводке, а не плохая видимость */
const CLEAR_KM = 9.9;

const hourKey = (ms) => new Date(ms).toISOString().slice(0, 13);

function modelP(utc) {
  const e = era5[utc];
  if (!e || e.temp == null || e.dew == null || e.wind == null || e.cloud == null) return null;
  const x = extra[utc] ?? {};
  const t0 = Date.parse(`${utc}:00:00Z`);
  const mk = (src, key) =>
    src && {
      time: new Date(Date.parse(`${key}:00:00Z`) + MSK * 3_600_000).toISOString().slice(0, 16),
      temp: src.temp, rh: src.rh, dew: src.dew, wind: src.wind, windDir: src.windDir, cloud: src.cloud,
      cloudLow: x.cloudLow ?? null, precip: x.precip ?? null, gust: x.gust ?? null, swr: x.swr ?? null, soilT: x.soilT ?? null,
      visibility: null,
    };
  const prevKey = hourKey(t0 - 3 * 3_600_000);
  return predictOne(mk(e, utc), mk(era5[prevKey], prevKey));
}

// ── Выборка: что наблюдали в час t и что случилось в t+k ──
const cache = new Map();
const pAt = (utc) => {
  if (!cache.has(utc)) cache.set(utc, modelP(utc));
  return cache.get(utc);
};

const samples = { };
for (const lead of LEADS) samples[lead] = [];

for (const [utc, obs] of Object.entries(metar)) {
  if (obs.visKm == null) continue;
  const t0 = Date.parse(`${utc}:00:00Z`);
  for (const lead of LEADS) {
    const futureKey = hourKey(t0 + lead * 3_600_000);
    const future = metar[futureKey];
    if (!future || future.visKm == null) continue;
    const p = pAt(futureKey);
    if (p == null) continue;
    samples[lead].push({
      year: Number(utc.slice(0, 4)),
      p,
      fogNow: obs.fog ? 1 : 0,
      mistNow: !obs.fog && obs.visKm < 4 ? 1 : 0,
      hazeNow: !obs.fog && obs.visKm >= 4 && obs.visKm < CLEAR_KM ? 1 : 0,
      y: future.fog ? 1 : 0,
    });
  }
}

const logit = (p) => Math.log(Math.max(p, 1e-6) / Math.max(1 - p, 1e-6));
const sigmoid = (t) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, t))));

function loglik(X, y, beta) {
  let s = 0;
  for (let i = 0; i < X.length; i++) {
    const eta = Math.max(-30, Math.min(30, X[i].reduce((a, x, j) => a + x * beta[j], 0)));
    s += y[i] * eta - Math.log(1 + Math.exp(eta));
  }
  return s;
}

/** Решение системы методом Гаусса — нужно для шага Ньютона */
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => (Math.abs(M[i][i]) < 1e-12 ? 0 : row[n] / M[i][i]));
}

/**
 * Логистическая смесь «прогноз + факт», обучается методом Ньютона (IRLS):
 * туман — событие редкое, и обычный градиентный спуск на нём сходится слишком
 * медленно, занижая вклад наблюдения.
 */
function fit(rows) {
  const X = rows.map((r) => [1, logit(r.p), r.fogNow, r.mistNow, r.hazeNow]);
  const y = rows.map((r) => r.y);
  const d = 5;
  let beta = Array(d).fill(0);
  beta[1] = 1;
  for (let it = 0; it < 25; it++) {
    const A = Array.from({ length: d }, () => Array(d).fill(0));
    const g = Array(d).fill(0);
    for (let i = 0; i < X.length; i++) {
      const eta = X[i].reduce((a, x, j) => a + x * beta[j], 0);
      const mu = sigmoid(eta);
      const wgt = Math.max(mu * (1 - mu), 1e-7);
      const resid = y[i] - mu;
      for (let j = 0; j < d; j++) {
        g[j] += X[i][j] * resid;
        for (let k = j; k < d; k++) A[j][k] += X[i][j] * X[i][k] * wgt;
      }
    }
    for (let j = 0; j < d; j++) {
      A[j][j] += 1e-3; // регуляризация: без неё система вырождается на редких признаках
      for (let k = 0; k < j; k++) A[j][k] = A[k][j];
    }
    const step = solve(A, g);
    // Шаг Ньютона на редком событии может улететь в бесконечность, поэтому
    // принимаем его только если правдоподобие выросло, иначе уполовиниваем.
    const before = loglik(X, y, beta);
    let scale = 1;
    let next = beta;
    for (let tries = 0; tries < 20; tries++) {
      next = beta.map((v, j) => v + scale * step[j]);
      if (next.every(Number.isFinite) && loglik(X, y, next) >= before) break;
      scale /= 2;
    }
    const maxStep = Math.max(...next.map((v, j) => Math.abs(v - beta[j])));
    beta = next;
    if (maxStep < 1e-7) break;
  }
  return { b: beta[0], w: beta.slice(1) };
}

const apply = (model, r) =>
  sigmoid(model.b + model.w[0] * logit(r.p) + model.w[1] * (r.fogNow ?? 0) + model.w[2] * (r.mistNow ?? 0) + model.w[3] * (r.hazeNow ?? 0));

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

const score = (pairs) => {
  let hit = 0, miss = 0, fa = 0;
  for (const x of pairs) {
    const w = x.p >= ALERT;
    if (w && x.y) hit++;
    else if (!w && x.y) miss++;
    else if (w && !x.y) fa++;
  }
  return { pod: hit / (hit + miss || 1), far: fa / (hit + fa || 1), csi: hit / (hit + miss + fa || 1) };
};

const models = {};
console.log('lead   прогноз: AUC  CSI    с поправкой: AUC  CSI     поймано      ложных');
console.log('─'.repeat(78));
for (const lead of LEADS) {
  const train = samples[lead].filter((r) => r.year <= 2022);
  const test = samples[lead].filter((r) => r.year >= 2023);
  const m = fit(train);
  models[lead] = m;

  const base = test.map((r) => ({ p: r.p, y: r.y }));
  const blend = test.map((r) => ({ p: apply(m, r), y: r.y }));
  const sb = score(base);
  const sm = score(blend);
  console.log(
    `+${lead}ч        ${auc(base).toFixed(3)} ${sb.csi.toFixed(3)}            ${auc(blend).toFixed(3)} ${sm.csi.toFixed(3)}    ` +
      `${(100 * sb.pod).toFixed(0)}% → ${(100 * sm.pod).toFixed(0)}%   ${(100 * sb.far).toFixed(0)}% → ${(100 * sm.far).toFixed(0)}%`,
  );
}

// ── Насколько поправка меняет число в типичных случаях ──
console.log('\nПримеры (прогноз 2% на час вперёд):');
for (const lead of [1, 2, 3]) {
  const m = models[lead];
  const show = (name, r) => console.log(`  +${lead}ч, ${name.padEnd(16)} → ${(100 * apply(m, { p: 0.02, ...r })).toFixed(1)}%`);
  show('сейчас ясно', { fogNow: 0, mistNow: 0, hazeNow: 0 });
  show('сейчас дымка', { fogNow: 0, mistNow: 1, hazeNow: 0 });
  show('сейчас туман', { fogNow: 1, mistNow: 0, hazeNow: 0 });
}

writeFileSync(
  new URL('nowcast.json', DIR),
  JSON.stringify(
    Object.fromEntries(Object.entries(models).map(([lead, m]) => [lead, { w: m.w.map((x) => Number(x.toFixed(5))), b: Number(m.b.toFixed(5)) }])),
    null,
    2,
  ),
);
console.log('\nКоэффициенты сохранены в data/nowcast.json');
