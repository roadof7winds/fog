import type { Forecast } from './api.ts';
import { ALERT_P, predictEnsemble, type HourScore } from './predict.ts';

export interface Series {
  hours: HourScore[];
  /** индекс текущего часа: до него — уже прошедшие */
  currentIndex: number;
}

/**
 * Ряд часов вокруг текущего. Прошедшие часы нужны не для красоты: туман чаще
 * всего под утро, и, открыв приложение днём, человек иначе видит только ноль
 * и не понимает, что утром оценка была высокой.
 */
export function series(f: Forecast, now = Date.now(), back = 6, count = 48): Series {
  const nowLocal = now + f.utcOffsetSeconds * 1000;
  let current = f.hours.findLastIndex((h) => Date.parse(`${h.time}:00Z`) <= nowLocal);
  if (current < 0) current = 0;
  const from = Math.max(0, current - back);
  const hours: HourScore[] = [];
  for (let i = from; i < Math.min(f.hours.length, current + count); i++) {
    // три часа назад нужны для трендов; в начале массива их может не быть
    hours.push(predictEnsemble(f.hours[i], i >= 3 ? f.hours[i - 3] : undefined));
  }
  return { hours, currentIndex: current - from };
}

/** Только будущее — для уведомлений */
export function upcoming(f: Forecast, now = Date.now(), count = 48): HourScore[] {
  const s = series(f, now, 0, count);
  return s.hours;
}

export interface RiskWindow {
  start: HourScore;
  end: HourScore;
  peak: HourScore;
  startIndex: number;
  peakIndex: number;
  length: number;
}

export function riskWindows(hours: HourScore[], threshold = ALERT_P): RiskWindow[] {
  const out: RiskWindow[] = [];
  let cur: RiskWindow | null = null;
  hours.forEach((h, i) => {
    if (h.p >= threshold) {
      if (!cur) cur = { start: h, end: h, peak: h, startIndex: i, peakIndex: i, length: 0 };
      cur.end = h;
      cur.length++;
      if (h.p > cur.peak.p) {
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

/** Окно может переходить через полночь — тогда конец относится к следующему дню */
export function windowCrossesMidnight(w: RiskWindow): boolean {
  return w.end.hourOfDay + 1 >= 24 || w.end.time.slice(0, 10) !== w.start.time.slice(0, 10);
}
