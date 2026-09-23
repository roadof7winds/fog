import type { Forecast, HourRaw } from './api';

export type Level = 'low' | 'moderate' | 'high' | 'veryHigh';
export type FogType = 'radiation' | 'advection' | 'mixed' | 'none';

export interface Factor {
  key: 'spread' | 'wind' | 'rh' | 'cloud' | 'advection' | 'night';
  points: number;
  /** Подробная подпись для разбора баллов */
  label: string;
  /** Короткая формулировка для строки «почему» */
  short: string;
}

export interface HourScore extends HourRaw {
  score: number;
  level: Level;
  type: FogType;
  spread: number;
  hourOfDay: number;
  factors: Factor[];
}

/** Порог «высокой» вероятности — с него начинаются окна риска и алерты */
export const HIGH = 55;

export const LEVEL_LABEL: Record<Level, string> = {
  low: 'Низкая',
  moderate: 'Умеренная',
  high: 'Высокая',
  veryHigh: 'Очень высокая',
};

export const TYPE_LABEL: Record<FogType, string> = {
  radiation: 'радиационный',
  advection: 'адвективный',
  mixed: 'смешанный',
  none: '—',
};

export const TYPE_HINT: Record<FogType, string> = {
  radiation: 'ночное выхолаживание земли при ясном небе и слабом ветре',
  advection: 'влажный воздух натекает с Финского залива',
  mixed: 'выхолаживание и влажный воздух с залива одновременно',
  none: '',
};

export function levelOf(score: number): Level {
  if (score >= 75) return 'veryHigh';
  if (score >= HIGH) return 'high';
  if (score >= 30) return 'moderate';
  return 'low';
}

const RU_POINTS = ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'];
export const compass = (deg: number) => RU_POINTS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

export const num = (n: number, digits = 1) => n.toFixed(digits).replace('.', ',').replace('-', '−');

const HUMID = 90;

/** Ветер с залива: для центра СПб это ЮЗ–З (200–280°). При штиле направление ничего не значит. */
export const isGulfWind = (h: HourRaw) => h.windDir >= 200 && h.windDir <= 280 && h.wind >= 0.5;

export function scoreHour(h: HourRaw): HourScore {
  const f: Factor[] = [];
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
  const type: FogType = radiation && gulf ? 'mixed' : radiation ? 'radiation' : gulf ? 'advection' : 'none';

  return { ...h, score, level: levelOf(score), type, spread, hourOfDay, factors: f };
}

/** Одна строка «почему» для главного экрана */
export function explain(h: HourScore): string {
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  if (h.level === 'low') {
    const limits = h.factors.filter((x) => x.points <= 0 && x.key !== 'cloud').map((x) => x.short);
    return limits.length ? `Тумана не ждём: ${limits.join(', ')}.` : 'Условия для тумана слабые.';
  }
  const pos = h.factors
    .filter((x) => x.points > 0)
    .sort((a, b) => b.points - a.points)
    .slice(0, 4)
    .map((x) => x.short);
  const neg = h.factors.filter((x) => x.points < 0).map((x) => x.short);
  let s = cap(pos.join(', '));
  if (neg.length) s += `, но ${neg.join(', ')}`;
  return s + '.';
}

/** Часы начиная с текущего (по местному времени точки прогноза) */
export function upcoming(f: Forecast, now = Date.now(), count = 48): HourScore[] {
  const nowLocal = now + f.utcOffsetSeconds * 1000;
  let start = f.hours.findLastIndex((h) => Date.parse(`${h.time}:00Z`) <= nowLocal);
  if (start < 0) start = 0;
  return f.hours.slice(start, start + count).map(scoreHour);
}

export interface RiskWindow {
  start: HourScore;
  end: HourScore;
  peak: HourScore;
  startIndex: number;
  peakIndex: number;
  length: number;
}

export function riskWindows(hours: HourScore[], threshold = HIGH): RiskWindow[] {
  const out: RiskWindow[] = [];
  let cur: RiskWindow | null = null;
  hours.forEach((h, i) => {
    if (h.score >= threshold) {
      if (!cur) cur = { start: h, end: h, peak: h, startIndex: i, peakIndex: i, length: 0 };
      cur.end = h;
      cur.length++;
      if (h.score > cur.peak.score) {
        cur.peak = h;
        cur.peakIndex = i;
      }
    } else if (cur) {
      out.push(cur);
      cur = null;
    }
  });
  if (cur) out.push(cur);
  return out;
}

/** Конец окна как время «до»: последний час + 1 */
export function windowEndLabel(w: RiskWindow): string {
  const h = (w.end.hourOfDay + 1) % 24;
  return `${String(h).padStart(2, '0')}:00`;
}
