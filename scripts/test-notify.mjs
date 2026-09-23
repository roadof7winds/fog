// Проверка доставки уведомлений: когда молчим, когда шлём и не шлём ли дважды.
// Скриншотом это не проверить, а ошибка здесь означает будильник в четыре утра.
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { maybeNotify, slotFor } from '../src/lib/notify.ts';
import { predictHour } from '../src/lib/predict.ts';

const COORDS = { lat: 59.9386, lon: 30.3141, label: 'тест' };

/** Ряд часов от заданного времени: туманные часы получают условия, дающие высокую вероятность */
function makeHours(startIso, count, fogAt = []) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const t = new Date(Date.parse(`${startIso}:00Z`) + i * 3_600_000);
    const time = t.toISOString().slice(0, 16);
    const foggy = fogAt.includes(i);
    rows.push({
      time,
      temp: foggy ? 5 : 15,
      dew: foggy ? 4.9 : 4,
      rh: foggy ? 99 : 50,
      wind: foggy ? 0.4 : 6,
      windDir: 180,
      gust: foggy ? 0.8 : 10,
      cloud: foggy ? 5 : 50,
      cloudLow: foggy ? 0 : 40,
      precip: 0,
      swr: 0,
      soilT: foggy ? 4 : 15,
      visibility: null,
    });
  }
  return rows.map((h, i) => predictHour(h, rows[i - 3]));
}

let sent = [];
const show = async (title, opts) => {
  sent.push({ title, body: opts.body });
};
const reset = () => {
  sent = [];
};

// ── Окна доставки ──────────────────────────────────────
assert.equal(slotFor(20).kind, 'evening');
assert.equal(slotFor(23).kind, 'evening');
assert.equal(slotFor(7).kind, 'morning');
assert.equal(slotFor(4), null, 'в четыре утра не будим');
assert.equal(slotFor(14), null, 'днём не шлём');
assert.equal(slotFor(19), null);
console.log('✓ окна доставки');

// ── Вечером предупреждаем про ночь ─────────────────────
reset();
const evening = makeHours('2026-10-15T20:00', 16, [6, 7, 8, 9]); // туман в 02:00–05:00
assert.equal(await maybeNotify(evening, COORDS, show), true);
assert.equal(sent.length, 1);
assert.match(sent[0].title, /Ночью возможен туман/);
console.log('✓ вечернее уведомление:', sent[0].title, '—', sent[0].body);

// ── Повторно в тот же вечер молчим ─────────────────────
reset();
assert.equal(await maybeNotify(evening, COORDS, show), false, 'второй раз за вечер слать нельзя');
assert.equal(sent.length, 0);
console.log('✓ повтор в то же окно не отправляется');

// ── Утром того же дня — это другое окно, повтор уместен ─
reset();
const morning = makeHours('2026-10-16T07:00', 8, [0, 1]); // туман уже идёт
assert.equal(await maybeNotify(morning, COORDS, show), true);
assert.match(sent[0].title, /Сейчас возможен туман/);
console.log('✓ утренний повтор:', sent[0].title, '—', sent[0].body);

// ── Ночью молчим, даже если туман ──────────────────────
reset();
const night = makeHours('2026-10-17T04:00', 8, [0, 1, 2]);
assert.equal(await maybeNotify(night, COORDS, show), false, 'в 4 утра будить нельзя');
assert.equal(sent.length, 0);
console.log('✓ ночью не будит');

// ── Вечер без риска — молчим ───────────────────────────
reset();
const clear = makeHours('2026-10-18T20:00', 16, []);
assert.equal(await maybeNotify(clear, COORDS, show), false);
assert.equal(sent.length, 0);
console.log('✓ без риска уведомления нет');

// ── Утро без риска впереди — молчим ────────────────────
reset();
const morningClear = makeHours('2026-10-19T07:00', 8, [7]); // риск за пределами окна в 6 часов
assert.equal(await maybeNotify(morningClear, COORDS, show), false);
console.log('✓ утром молчим, если риск за пределами ближайших часов');

console.log('\nВсе проверки прошли.');
