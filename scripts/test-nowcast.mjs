// Проверка поправки на факт станции. Здесь легко ошибиться на часовом поясе:
// и сводки, и прогноз приходят в местном времени, а Date.now() — в UTC.
import assert from 'node:assert/strict';
import { applyNowcast, adjust, stationState } from '../src/lib/nowcast.ts';
import { predictOne } from '../src/lib/predict.ts';

const MSK = 3 * 3600;
const SPB = { lat: 59.9386, lon: 30.3141, label: 'центр' };
const FAR = { lat: 55.75, lon: 37.62, label: 'Москва' };

/** Час прогноза с умеренной вероятностью */
const hour = (time, p) => ({
  time,
  p,
  members: [],
  pMin: p,
  pMax: p,
  level: 'low',
  type: 'none',
  spread: 3,
  hourOfDay: Number(time.slice(11, 13)),
  month: Number(time.slice(5, 7)),
  ratio: 1,
  contributions: [],
  temp: 5, dew: 2, rh: 80, wind: 1, windDir: 180, cloud: 50,
  cloudLow: null, precip: null, gust: null, swr: null, soilT: null, visibility: null,
});

const obs = (time, visKm, code = '') => ({ time, visKm, code, fog: visKm < 1 || code.includes('FG'), mist: false, temp: 5, dew: 5 });

// местное время станции 10:00 → epoch такой, что now + MSK даёт 10:00
const localToNow = (local) => Date.parse(`${local}:00Z`) - MSK * 1000;

// ── Состояние станции ──────────────────────────────────
assert.equal(stationState(obs('2026-10-01T10:00', 0.2, 'FG')), 'fog');
assert.equal(stationState(obs('2026-10-01T10:00', 2.5)), 'mist');
assert.equal(stationState(obs('2026-10-01T10:00', 6)), 'haze');
assert.equal(stationState(obs('2026-10-01T10:00', 9.99)), 'clear', '9,99 км в METAR — это обычная погода');
console.log('✓ состояние станции');

// ── Туман сейчас резко поднимает ближайшие часы ────────
assert.ok(adjust(0.02, 1, 'fog') > 0.3, 'после тумана через час вероятность должна быть высокой');
assert.ok(adjust(0.02, 1, 'fog') > adjust(0.02, 3, 'fog'), 'чем дальше час, тем слабее поправка');
assert.ok(adjust(0.02, 1, 'clear') < 0.02, 'чистая станция снижает вероятность');
console.log('✓ направление поправки: туман +, чисто −');

// ── Поправка применяется к ближайшим часам ─────────────
const rows = [obs('2026-10-01T09:00', 6), obs('2026-10-01T10:00', 0.2, 'FG')];
const hours = [10, 11, 12, 13, 17, 18].map((h) => hour(`2026-10-01T${String(h).padStart(2, '0')}:00`, 0.02));
const now = localToNow('2026-10-01T10');
const res = applyNowcast(hours, rows, SPB, MSK, now);
assert.ok(res.info, 'свежая сводка должна применяться');
assert.equal(res.info.state, 'fog');
assert.equal(res.hours[0].p, 0.02, 'час самой сводки не трогаем');
assert.ok(res.hours[1].p > 0.3, `через час должно вырасти, получено ${res.hours[1].p}`);
assert.ok(res.hours[2].p > res.hours[3].p, 'дальше — слабее');
assert.equal(res.hours[5].p, 0.02, 'за пределами шести часов поправки нет');
assert.equal(res.hours[1].nowcast, true);
console.log('✓ применение к ближайшим часам:', [1, 2, 3].map((i) => (100 * res.hours[i].p).toFixed(1) + '%').join(' → '));

// ── Устаревшая сводка не применяется ───────────────────
const stale = applyNowcast(hours, rows, SPB, MSK, localToNow('2026-10-01T14'));
assert.equal(stale.info, null, 'сводка четырёхчасовой давности — не «сейчас»');
console.log('✓ устаревшая сводка игнорируется');

// ── Далёкая точка не трогается ─────────────────────────
const far = applyNowcast(hours, rows, FAR, MSK, now);
assert.equal(far.info, null, 'за 600 км факт в Пулково ничего не говорит');
console.log('✓ далёкие координаты игнорируются');

// ── Часовой пояс: UTC-время не должно всё ломать ───────
const wrongTz = applyNowcast(hours, rows, SPB, 0, now);
assert.equal(wrongTz.info, null, 'при другом поясе сводка выглядит устаревшей — так и должно быть');
console.log('✓ часовой пояс учитывается');

// ── Прогноз остаётся вероятностью ──────────────────────
for (const state of ['fog', 'mist', 'haze', 'clear']) {
  for (let lead = 1; lead <= 6; lead++) {
    const p = adjust(0.5, lead, state);
    assert.ok(p >= 0 && p <= 1, `вероятность вне диапазона: ${p}`);
  }
}
assert.ok(predictOne, 'predictOne экспортируется для скриптов калибровки');
console.log('✓ значения остаются вероятностями');

console.log('\nВсе проверки прошли.');
