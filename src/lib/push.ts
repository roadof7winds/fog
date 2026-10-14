import type { Coords } from './api.ts';

/** Открытый ключ VAPID: он и должен быть публичным, им подписи только проверяются */
export const VAPID_PUBLIC_KEY = 'BEi9jogWRp-Av7cPB1DT03Ehl3x7WyhyC7fBRkQJ6VBWnTpDjvVRwEixnQhPxBMLMMfRJStHDz91ye4qAZadJvM';

/** Адрес сервера рассылки; пусто — значит сервера нет и push недоступен */
export const PUSH_SERVER = (import.meta.env.VITE_PUSH_URL ?? '').replace(/\/$/, '');

export const pushSupported = () =>
  PUSH_SERVER !== '' && 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  if (!('serviceWorker' in navigator)) return undefined;
  return navigator.serviceWorker.getRegistration();
}

export async function pushEnabled(): Promise<boolean> {
  const reg = await registration();
  return !!(await reg?.pushManager.getSubscription());
}

/**
 * Подписывает устройство на рассылку. Координаты уходят на сервер округлёнными
 * до сотых (примерно километр) — больше для прогноза не нужно.
 */
export async function enablePush(coords: Coords, utcOffsetSeconds: number): Promise<void> {
  const reg = await registration();
  if (!reg) throw new Error('Сервис-воркер не зарегистрирован');
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as BufferSource,
    }));

  const res = await fetch(`${PUSH_SERVER}/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      subscription: sub.toJSON(),
      lat: Number(coords.lat.toFixed(2)),
      lon: Number(coords.lon.toFixed(2)),
      utcOffsetSeconds,
    }),
  });
  if (!res.ok) throw new Error(`Сервер рассылки ответил ${res.status}`);
}

export async function disablePush(): Promise<void> {
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await fetch(`${PUSH_SERVER}/unsubscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  }).catch(() => undefined);
  await sub.unsubscribe();
}

/** Проверочное уведомление: единственный способ убедиться, что push доходит */
export async function sendTestPush(): Promise<void> {
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) throw new Error('Подписка не оформлена');
  const res = await fetch(`${PUSH_SERVER}/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  });
  if (!res.ok) {
    const info = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(info.error ?? `Сервер ответил ${res.status}`);
  }
}

/** Если место изменилось, подписку надо переоформить на новые координаты */
export async function updatePushPlace(coords: Coords, utcOffsetSeconds: number): Promise<void> {
  if (!(await pushEnabled())) return;
  await enablePush(coords, utcOffsetSeconds);
}
