/// <reference lib="webworker" />
import { fetchForecast, SPB_CENTER, type Coords } from '../lib/api';
import { kvGet, kvSet } from '../lib/db';
import { upcoming } from '../lib/series';
import { maybeNotify } from '../lib/notify';

declare const __BUILD__: string;

interface PeriodicSyncEvent extends ExtendableEvent {
  tag: string;
}

const sw = self as unknown as ServiceWorkerGlobalScope;
const PREFIX = 'fog-shell-';
const CACHE = PREFIX + __BUILD__;
const FONTS = 'fog-fonts';
const SHELL = ['./manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];
const INDEX = new URL('./index.html', sw.registration.scope).href;

async function precache() {
  const cache = await caches.open(CACHE);
  await cache.addAll(SHELL);
  // Хэшированные бандлы Vite берём прямо из свежего index.html
  const res = await fetch(INDEX, { cache: 'no-cache' });
  await cache.put(INDEX, res.clone());
  const html = await res.text();
  const assets = [...html.matchAll(/(?:src|href)="([^"]*assets\/[^"]+)"/g)].map((m) => new URL(m[1], sw.registration.scope).href);
  await cache.addAll(assets);
}

sw.addEventListener('install', (e) => {
  e.waitUntil(precache().then(() => sw.skipWaiting()));
});

sw.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
      await sw.clients.claim();
    })(),
  );
});

async function networkFirstPage(req: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) await cache.put(INDEX, res.clone());
    return res;
  } catch {
    return (await cache.match(INDEX)) ?? Response.error();
  }
}

async function cacheFirst(req: Request, cacheName: string): Promise<Response> {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') await cache.put(req, res.clone());
  return res;
}

sw.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Прогноз не кэшируем здесь: свежесть и офлайн-копию ведёт приложение через IndexedDB
  if (url.hostname.endsWith('open-meteo.com')) return;
  if (req.mode === 'navigate') e.respondWith(networkFirstPage(req));
  else if (url.origin === sw.location.origin) e.respondWith(cacheFirst(req, CACHE));
  else if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') e.respondWith(cacheFirst(req, FONTS));
});

// Фоновая проверка (Chrome/Android для установленного PWA): раз в несколько часов
async function backgroundCheck() {
  const coords = (await kvGet<Coords>('coords')) ?? SPB_CENTER;
  const f = await fetchForecast(coords);
  await kvSet('forecast', f);
  if (Notification.permission !== 'granted') return;
  await maybeNotify(upcoming(f), coords, (title, opts) => sw.registration.showNotification(title, opts));
}

sw.addEventListener('periodicsync', (e) => {
  const ev = e as PeriodicSyncEvent;
  if (ev.tag === 'fog-check') ev.waitUntil(backgroundCheck().catch(() => undefined));
});

// Push от сервера рассылки: всё содержимое уже посчитано там
sw.addEventListener('push', (e) => {
  const event = e as PushEvent;
  event.waitUntil(
    (async () => {
      let title = 'Туман';
      let body = 'Откройте приложение, чтобы увидеть прогноз';
      try {
        const data = event.data?.json() as { title?: string; body?: string } | undefined;
        if (data?.title) title = data.title;
        if (data?.body) body = data.body;
      } catch {
        // payload не разобрался — покажем общее сообщение, молчать нельзя:
        // браузер иначе сам покажет «сайт обновился в фоне»
      }
      await sw.registration.showNotification(title, {
        body,
        tag: 'fog-alert',
        icon: 'icons/icon-192.png',
        badge: 'icons/icon-192.png',
      });
    })(),
  );
});

sw.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    (async () => {
      const all = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = all[0];
      if (open) await open.focus();
      else await sw.clients.openWindow(sw.registration.scope);
    })(),
  );
});
