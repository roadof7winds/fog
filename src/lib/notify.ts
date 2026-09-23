import type { Coords } from './api.ts';
import { kvGet, kvSet } from './db.ts';
import { BASE_RATE, TYPE_LABEL, pct, type HourScore } from './predict.ts';
import { riskWindows, windowEndLabel } from './series.ts';

/** На сколько часов вперёд смотрит плашка на главном экране */
export const BANNER_LOOKAHEAD = 12;

/**
 * Туман почти всегда ночью и под утро, поэтому уведомления приходят не в момент
 * пересечения порога, а в два окна: вечером — про ближайшую ночь, утром —
 * повтор, если риск ещё впереди.
 */
export interface Slot {
  kind: 'evening' | 'morning';
  /** сколько ближайших часов проверяем */
  lookahead: number;
}

export function slotFor(localHour: number): Slot | null {
  if (localHour >= 20 && localHour <= 23) return { kind: 'evening', lookahead: 14 };
  if (localHour >= 7 && localHour < 9) return { kind: 'morning', lookahead: 6 };
  return null;
}

const placeKey = (c: Coords) => `${c.lat.toFixed(2)},${c.lon.toFixed(2)}`;

type Show = (title: string, options: NotificationOptions) => Promise<void>;

/**
 * Отправляет не больше одного уведомления на окно доставки: вечернее и утреннее
 * за сутки, даже если приложение открывали несколько раз.
 */
export async function maybeNotify(hours: HourScore[], coords: Coords, show: Show): Promise<boolean> {
  if (!hours.length) return false;
  const slot = slotFor(hours[0].hourOfDay);
  if (!slot) return false;

  const w = riskWindows(hours.slice(0, slot.lookahead))[0];
  if (!w) return false;

  const key = `${placeKey(coords)}|${hours[0].time.slice(0, 10)}|${slot.kind}`;
  if ((await kvGet<string>('lastNotifiedSlot')) === key) return false;

  const at = w.peak.time.slice(11, 16);
  const type = w.peak.type === 'none' ? '' : ` · ${TYPE_LABEL[w.peak.type]}`;
  const title =
    slot.kind === 'evening'
      ? 'Ночью возможен туман'
      : w.startIndex === 0
        ? 'Сейчас возможен туман'
        : 'Утром возможен туман';
  const from = w.startIndex === 0 ? 'уже сейчас' : `с ${w.start.time.slice(11, 16)}`;

  await show(title, {
    body: `${from} до ${windowEndLabel(w)} · до ${pct(w.peak.p)}% в ${at} (обычно ${pct(BASE_RATE)}%)${type}`,
    tag: 'fog-alert',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
  });
  await kvSet('lastNotifiedSlot', key);
  return true;
}
