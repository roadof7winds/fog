// Время в прогнозе — местное время точки без смещения. Разбираем как UTC
// и форматируем с timeZone: 'UTC', чтобы часовой пояс телефона не вмешивался.
const asDate = (time: string) => new Date(`${time}:00Z`);

export const hhmm = (time: string) => time.slice(11, 16);

const weekdayFmt = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', timeZone: 'UTC' });
const dateFmt = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

export const weekdayShort = (time: string) => weekdayFmt.format(asDate(time));

/** «сегодня», «завтра», «послезавтра» или дата относительно текущего местного дня */
export function relDay(time: string, todayIso: string): string {
  const diff = Math.round((Date.parse(`${time.slice(0, 10)}T00:00Z`) - Date.parse(`${todayIso}T00:00Z`)) / 86_400_000);
  if (diff === 0) return 'сегодня';
  if (diff === 1) return 'завтра';
  if (diff === 2) return 'послезавтра';
  return dateFmt.format(asDate(time));
}

export const longDay = (time: string) => dateFmt.format(asDate(time));

export const clock = (ms: number) => new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

export function visibilityText(m: number | null): string {
  if (m == null) return '—';
  if (m >= 10_000) return '> 10 км';
  if (m >= 1000) return `${(m / 1000).toFixed(1).replace('.', ',')} км`;
  return `${Math.round(m / 10) * 10} м`;
}
