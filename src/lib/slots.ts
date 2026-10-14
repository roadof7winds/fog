/**
 * Окна доставки уведомлений. Туман почти всегда ночью и под утро, поэтому
 * сообщения приходят не в момент пересечения порога, а вечером (про ближайшую
 * ночь) и утром (повтор, если риск ещё впереди). Ночью не беспокоим.
 *
 * Этим пользуются и приложение, и сервер рассылки — правило должно быть одно.
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

/** Местный час в точке по её смещению от UTC */
export const localHourAt = (utcOffsetSeconds: number, now = Date.now()) =>
  new Date(now + utcOffsetSeconds * 1000).getUTCHours();
