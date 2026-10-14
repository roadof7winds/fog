/**
 * Сервер рассылки: раз в час просыпается, смотрит, у кого из подписчиков
 * наступило окно доставки, считает прогноз той же моделью, что и приложение,
 * и шлёт push. Нужен потому, что без сервера уведомление приходит, только если
 * приложение открыто или браузер соизволил разбудить фоновую проверку.
 *
 * Хранит минимум: адрес подписки, округлённые до километра координаты и
 * часовой пояс. Ни имени, ни истории.
 */
import { buildPushPayload, type PushSubscription as WebPushSubscription } from '@block65/webcrypto-web-push';
import { fetchForecast, type Coords } from '../../src/lib/api.ts';
import { fetchObservations } from '../../src/lib/observations.ts';
import { applyNowcast } from '../../src/lib/nowcast.ts';
import { BASE_RATE, LEVEL_LABEL, TYPE_LABEL, pct } from '../../src/lib/predict.ts';
import { riskWindows, series, windowEndLabel } from '../../src/lib/series.ts';
import { localHourAt, slotFor } from '../../src/lib/slots.ts';
import { recordEnsemble, recordForecast, recordObservations, summary } from './journal.ts';

export interface Env {
  SUBS: KVNamespace;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;
}

interface Record_ {
  subscription: WebPushSubscription;
  lat: number;
  lon: number;
  utcOffsetSeconds: number;
  createdAt: number;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...cors() } });

const cors = () => ({
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
});

/** Ключ подписки — хэш адреса: сам адрес длинный и в ключ не помещается */
async function keyFor(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });

    if (url.pathname === '/health') return json({ ok: true });

    // Журнал: что обещали и что сбылось. Считается по станции Пулково —
    // только там есть чем проверять.
    if (url.pathname === '/stats') {
      const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days') ?? 30)));
      const threshold = Math.min(0.5, Math.max(0.01, Number(url.searchParams.get('threshold') ?? 0.05)));
      return json(await summary(env, days, threshold));
    }

    if (url.pathname === '/subscribe' && request.method === 'POST') {
      const body = (await request.json()) as Partial<Record_>;
      const endpoint = body.subscription?.endpoint;
      if (!endpoint || typeof body.lat !== 'number' || typeof body.lon !== 'number') return json({ error: 'bad request' }, 400);
      const record: Record_ = {
        subscription: body.subscription as WebPushSubscription,
        lat: Number(body.lat.toFixed(2)),
        lon: Number(body.lon.toFixed(2)),
        utcOffsetSeconds: Number(body.utcOffsetSeconds ?? 0),
        createdAt: Date.now(),
      };
      await env.SUBS.put(await keyFor(endpoint), JSON.stringify(record));
      return json({ ok: true });
    }

    // Проверочное уведомление: после развёртывания надо как-то убедиться,
    // что push вообще доходит до телефона
    if (url.pathname === '/test' && request.method === 'POST') {
      const { endpoint } = (await request.json()) as { endpoint?: string };
      if (!endpoint) return json({ error: 'bad request' }, 400);
      const raw = await env.SUBS.get(await keyFor(endpoint));
      if (!raw) return json({ error: 'подписка не найдена' }, 404);
      const rec = JSON.parse(raw) as Record_;
      try {
        await send(env, rec.subscription, {
          title: 'Проверка связи',
          body: 'Уведомления доходят. Настоящие придут вечером и утром, когда будет туман.',
        });
        return json({ ok: true });
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 502);
      }
    }

    if (url.pathname === '/unsubscribe' && request.method === 'POST') {
      const { endpoint } = (await request.json()) as { endpoint?: string };
      if (endpoint) await env.SUBS.delete(await keyFor(endpoint));
      return json({ ok: true });
    }

    return json({ error: 'not found' }, 404);
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(run(env));
    ctx.waitUntil(keepJournal(env));
  },
};

async function run(env: Env): Promise<void> {
  const now = Date.now();
  const list = await env.SUBS.list({ limit: 1000, prefix: '' });
  const stats = { всего: 0, вОкне: 0, ужеОтправлено: 0, безРиска: 0, отправлено: 0, ошибок: 0 };
  // прогноз для одной и той же точки тянем один раз на всех
  const forecasts = new Map<string, Awaited<ReturnType<typeof fetchForecast>>>();
  let observations: Awaited<ReturnType<typeof fetchObservations>> | null = null;
  let obsTried = false;

  for (const { name } of list.keys) {
    const raw = await env.SUBS.get(name);
    if (!raw) continue;
    if (name.startsWith('sent:')) continue;
    const rec = JSON.parse(raw) as Record_;
    stats.всего++;

    const slot = slotFor(localHourAt(rec.utcOffsetSeconds, now));
    if (!slot) continue;
    stats.вОкне++;

    const today = new Date(now + rec.utcOffsetSeconds * 1000).toISOString().slice(0, 10);
    const sentKey = `sent:${name}:${today}:${slot.kind}`;
    if (await env.SUBS.get(sentKey)) {
      stats.ужеОтправлено++;
      continue;
    }

    const placeKey = `${rec.lat},${rec.lon}`;
    try {
      if (!forecasts.has(placeKey)) {
        const coords: Coords = { lat: rec.lat, lon: rec.lon, label: placeKey };
        forecasts.set(placeKey, await fetchForecast(coords));
      }
      const forecast = forecasts.get(placeKey)!;
      if (!obsTried) {
        obsTried = true;
        observations = await fetchObservations(1).catch(() => null);
      }

      const base = series(forecast, now, 0, 48);
      const coords: Coords = { lat: rec.lat, lon: rec.lon, label: placeKey };
      const hours = observations
        ? applyNowcast(base.hours, observations.rows, coords, forecast.utcOffsetSeconds, now).hours
        : base.hours;

      const w = riskWindows(hours.slice(0, slot.lookahead))[0];
      if (!w) {
        stats.безРиска++;
        continue;
      }

      const from = w.startIndex === 0 ? 'уже сейчас' : `с ${w.start.time.slice(11, 16)}`;
      const type = w.peak.type === 'none' ? '' : ` · ${TYPE_LABEL[w.peak.type]}`;
      const title =
        slot.kind === 'evening' ? 'Ночью возможен туман' : w.startIndex === 0 ? 'Сейчас возможен туман' : 'Утром возможен туман';

      await send(env, rec.subscription, {
        title,
        body: `${from} до ${windowEndLabel(w)} · до ${pct(w.peak.p)}% в ${w.peak.time.slice(11, 16)} (обычно ${pct(BASE_RATE)}%)${type}`,
        level: LEVEL_LABEL[w.peak.level],
      });
      // метка живёт двое суток: столько же, сколько окно доставки имеет смысл
      await env.SUBS.put(sentKey, '1', { expirationTtl: 172800 });
      stats.отправлено++;
    } catch (e) {
      stats.ошибок++;
      console.error('подписка', name, e instanceof Error ? e.message : e);
    }
  }
  console.log('рассылка:', JSON.stringify(stats));
}

/** Журнал ведём каждый час; ансамбль тянем раз в сутки — ответ большой */
async function keepJournal(env: Env): Promise<void> {
  const now = Date.now();
  const stats: Record<string, number | string> = {};
  try {
    stats.прогноз = await recordForecast(env, now);
    stats.факт = await recordObservations(env);
    if (new Date(now).getUTCHours() === 3) stats.ансамбль = await recordEnsemble(env, now);
  } catch (e) {
    stats.ошибка = e instanceof Error ? e.message : String(e);
  }
  console.log('журнал:', JSON.stringify(stats));
}

async function send(env: Env, subscription: WebPushSubscription, payload: object): Promise<void> {
  const init = await buildPushPayload(
    { data: JSON.stringify(payload), options: { ttl: 6 * 3600, urgency: 'normal' } },
    subscription,
    { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY },
  );
  const res = await fetch(subscription.endpoint, init);
  // 404 и 410 означают, что подписка мертва — чистим
  if (res.status === 404 || res.status === 410) await env.SUBS.delete(await keyFor(subscription.endpoint));
  else if (!res.ok) throw new Error(`push ${res.status}`);
}
