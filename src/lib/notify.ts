import type { Coords } from './api.ts';
import { kvGet, kvSet } from './db.ts';
import { LEVEL_LABEL, TYPE_LABEL, pct, type HourScore } from './predict.ts';
import { riskWindows, windowEndLabel } from './series.ts';

export const LOOKAHEAD_HOURS = 12;

interface Notified {
  place: string;
  end: string;
}

const placeKey = (c: Coords) => `${c.lat.toFixed(2)},${c.lon.toFixed(2)}`;

type Show = (title: string, options: NotificationOptions) => Promise<void>;

/**
 * Уведомляет о первом окне повышенного риска в ближайшие 12 часов.
 * Одно окно — одно уведомление: пока окно пересекается с уже объявленным,
 * повторно не беспокоим.
 */
export async function maybeNotify(hours: HourScore[], coords: Coords, show: Show): Promise<boolean> {
  const w = riskWindows(hours.slice(0, LOOKAHEAD_HOURS))[0];
  if (!w) return false;
  const place = placeKey(coords);
  const last = await kvGet<Notified>('lastNotified');
  if (last && last.place === place && w.start.time <= last.end) return false;

  const from = w.startIndex === 0 ? 'уже сейчас' : `с ${w.start.time.slice(11, 16)}`;
  const type = w.peak.type === 'none' ? '' : `, ${TYPE_LABEL[w.peak.type]}`;
  await show(`Туман: ${LEVEL_LABEL[w.peak.level].toLowerCase()} вероятность`, {
    body: `${from} до ${windowEndLabel(w)} · до ${pct(w.peak.p)}% в ${w.peak.time.slice(11, 16)} (обычно ${pct(0.0108)}%)${type}`,
    tag: 'fog-alert',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
  });
  await kvSet('lastNotified', { place, end: w.end.time } satisfies Notified);
  return true;
}
