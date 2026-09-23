import type { Forecast } from './api.ts';
import { ALERT_P, predictHour, type HourScore } from './predict.ts';

/** Часы начиная с текущего (по местному времени точки прогноза) */
export function upcoming(f: Forecast, now = Date.now(), count = 48): HourScore[] {
  const nowLocal = now + f.utcOffsetSeconds * 1000;
  let start = f.hours.findLastIndex((h) => Date.parse(`${h.time}:00Z`) <= nowLocal);
  if (start < 0) start = 0;
  const out: HourScore[] = [];
  for (let i = start; i < Math.min(f.hours.length, start + count); i++) {
    // три часа назад нужны для тренда; в начале массива их может не быть
    out.push(predictHour(f.hours[i], i >= 3 ? f.hours[i - 3] : undefined));
  }
  return out;
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
