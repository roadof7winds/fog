// Старая эвристическая формула приложения (баллы 0–100).
// В приложении больше не используется — оставлена, чтобы можно было
// воспроизвести сравнение «эвристика против обученной модели».




/** Порог «высокой» вероятности — с него начинаются окна риска и алерты */
export const HIGH = 55;

const LEVEL_LABEL = {
  low: 'Низкая',
  moderate: 'Умеренная',
  high: 'Высокая',
  veryHigh: 'Очень высокая',
};

const TYPE_LABEL = {
  radiation: 'радиационный',
  advection: 'адвективный',
  mixed: 'смешанный',
  none: '—',
};

const TYPE_HINT = {
  radiation: 'ночное выхолаживание земли при ясном небе и слабом ветре',
  advection: 'влажный воздух натекает с Финского залива',
  mixed: 'выхолаживание и влажный воздух с залива одновременно',
  none: '',
};

function levelOf(score) {
  if (score >= 75) return 'veryHigh';
  if (score >= HIGH) return 'high';
  if (score >= 30) return 'moderate';
  return 'low';
}

const RU_POINTS = ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'];
const compass = (deg) => RU_POINTS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

const num = (n, digits = 1) => n.toFixed(digits).replace('.', ',').replace('-', '−');

const HUMID = 90;

/** Ветер с залива: для центра СПб это ЮЗ–З (200–280°). При штиле направление ничего не значит. */
const isGulfWind = (h) => h.windDir >= 200 && h.windDir <= 280 && h.wind >= 0.5;

export function scoreHour(h) {
  const f = [];
  const spread = h.temp - h.dew;
  const hourOfDay = Number(h.time.slice(11, 13));
  const d = `Δ ${num(Math.max(spread, 0))}°`;

  // 1. Дефицит точки росы
  if (spread <= 1) f.push({ key: 'spread', points: 40, label: `Температура почти равна точке росы (${d})`, short: 'точка росы почти равна температуре' });
  else if (spread <= 2.5) f.push({ key: 'spread', points: 25, label: `Точка росы близко к температуре (${d})`, short: 'точка росы близко к температуре' });
  else if (spread <= 4) f.push({ key: 'spread', points: 10, label: `Точка росы недалеко (${d})`, short: 'точка росы недалеко' });
  else f.push({ key: 'spread', points: 0, label: `Воздух далёк от насыщения (${d})`, short: 'воздух далёк от насыщения' });

  // 2. Ветер
  const w = `${num(h.wind)} м/с`;
  if (h.wind < 1) f.push({ key: 'wind', points: 25, label: `Штиль (${w})`, short: 'штиль' });
  else if (h.wind <= 3) f.push({ key: 'wind', points: 15, label: `Слабый ветер (${w})`, short: 'слабый ветер' });
  else if (h.wind <= 5) f.push({ key: 'wind', points: 5, label: `Умеренный ветер (${w})`, short: 'умеренный ветер' });
  else f.push({ key: 'wind', points: -20, label: `Сильный ветер разгоняет туман (${w})`, short: 'сильный ветер' });

  // 3. Влажность
  const rh = `${Math.round(h.rh)}%`;
  if (h.rh >= 95) f.push({ key: 'rh', points: 20, label: `Влажность ${rh}`, short: `влажность ${rh}` });
  else if (h.rh >= HUMID) f.push({ key: 'rh', points: 12, label: `Высокая влажность (${rh})`, short: `влажность ${rh}` });
  else f.push({ key: 'rh', points: 0, label: `Влажность ниже 90% (${rh})`, short: 'суховато' });

  // 4. Облачность (важна для радиационного тумана)
  const cc = `${Math.round(h.cloud)}%`;
  if (h.cloud < 30) f.push({ key: 'cloud', points: 15, label: `Ясно (${cc}) — земля быстро остывает`, short: 'ясно' });
  else if (h.cloud <= 70) f.push({ key: 'cloud', points: 5, label: `Переменная облачность (${cc})`, short: 'переменная облачность' });
  else f.push({ key: 'cloud', points: 0, label: `Пасмурно (${cc}) — облака держат тепло`, short: 'пасмурно' });

  // 5. Адвекция с залива — не зависит от облачности
  const gulf = isGulfWind(h) && h.rh >= HUMID;
  if (gulf) f.push({ key: 'advection', points: 10, label: `Влажный ветер с залива (${compass(h.windDir)}, ${Math.round(h.windDir)}°)`, short: 'ветер с залива' });

  // 6. Окно радиационного тумана
  if (hourOfDay >= 3 && hourOfDay < 9) f.push({ key: 'night', points: 10, label: 'Предрассветное окно 03:00–09:00', short: 'предрассветные часы' });

  const score = Math.max(0, Math.min(100, f.reduce((s, x) => s + x.points, 0)));
  const radiation = h.cloud < 30 && h.wind <= 3;
  const type = radiation && gulf ? 'mixed' : radiation ? 'radiation' : gulf ? 'advection' : 'none';

  return { ...h, score, level: levelOf(score), type, spread, hourOfDay, factors: f };
}

