/**
 * Журнал: что прогноз обещал и что потом намерили в Пулково.
 *
 * Нужен по двум причинам. Первая — чтобы о приложении можно было судить по его
 * собственной истории, а не по памяти. Вторая — чтобы ответить на вопрос,
 * который иначе не решается: ансамблевые прогоны Open-Meteo нельзя проверить
 * на прошлом (архива нет, по старым датам приходит null), поэтому их прогноз
 * записывается рядом с нынешним и сравнивается по мере накопления.
 */
import { fetchForecast, type Coords, type HourRaw } from '../../src/lib/api.ts';
import { fetchObservations, isFog } from '../../src/lib/observations.ts';
import { predictOne } from '../../src/lib/predict.ts';
import { series } from '../../src/lib/series.ts';
import type { Env } from './index.ts';

/** Журнал ведётся по станции: только там есть чем проверять */
export const SITE: Coords = { lat: 59.8003, lon: 30.2625, label: 'Пулково' };

/** Заблаговременности, которые записываем */
export const LEADS = [1, 3, 6] as const;

/** Запись живёт 45 суток — больше для месячной сводки не нужно */
const TTL = 45 * 86400;

export interface Entry {
  /** вероятность по шести моделям погоды, по заблаговременностям */
  multi?: Partial<Record<number, number>>;
  /** то же по ансамблю из 40 прогонов одной модели */
  ens?: Partial<Record<number, number>>;
  /** факт: был ли туман в этот час */
  fog?: boolean;
  /** видимость, км */
  vis?: number | null;
}

const hourKey = (localIso: string) => `log:${localIso.slice(0, 13)}`;

/**
 * Пишем только когда запись действительно меняется: бесплатный лимит KV —
 * тысяча записей в сутки, а наблюдения иначе переписывались бы целиком каждый час.
 */
async function merge(env: Env, localIso: string, patch: Entry): Promise<boolean> {
  const key = hourKey(localIso);
  const prev = ((await env.SUBS.get(key, 'json')) as Entry | null) ?? {};
  const next: Entry = {
    ...prev,
    ...patch,
    multi: { ...prev.multi, ...patch.multi },
    ens: { ...prev.ens, ...patch.ens },
  };
  if (!next.multi || Object.keys(next.multi).length === 0) delete next.multi;
  if (!next.ens || Object.keys(next.ens).length === 0) delete next.ens;
  const serialized = JSON.stringify(next);
  if (serialized === JSON.stringify(prev)) return false;
  await env.SUBS.put(key, serialized, { expirationTtl: TTL });
  return true;
}

/** Прогноз по шести моделям — берём уже посчитанный ряд */
export async function recordForecast(env: Env, now: number): Promise<number> {
  const forecast = await fetchForecast(SITE);
  const { hours } = series(forecast, now, 0, 12);
  let written = 0;
  for (const lead of LEADS) {
    const h = hours[lead];
    if (!h) continue;
    if (await merge(env, h.time, { multi: { [lead]: Number(h.p.toFixed(4)) } })) written++;
  }
  return written;
}

/** Факт: заполняем прошедшие часы наблюдениями. Берём последние 12 часов —
 * раньше них всё уже записано предыдущими запусками. */
export async function recordObservations(env: Env): Promise<number> {
  const obs = await fetchObservations(1);
  let written = 0;
  for (const o of obs.rows.slice(-12)) {
    if (await merge(env, o.time, { fog: isFog(o.visKm, o.code), vis: o.visKm })) written++;
  }
  return written;
}

/**
 * Ансамбль: 40 прогонов одной модели. Тянем раз в сутки — ответ приходит
 * большой, а вопрос, который он решает, медленный.
 */
export async function recordEnsemble(env: Env, now: number): Promise<number> {
  const vars = [
    'temperature_2m',
    'relative_humidity_2m',
    'dew_point_2m',
    'wind_speed_10m',
    'wind_direction_10m',
    'wind_gusts_10m',
    'cloud_cover',
    'precipitation',
    'shortwave_radiation',
  ];
  const url =
    `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${SITE.lat}&longitude=${SITE.lon}` +
    `&hourly=${vars.join(',')}&models=icon_eu&wind_speed_unit=ms&timezone=Europe/Moscow&forecast_days=2`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ensemble ${res.status}`);
  const h = (await res.json()).hourly as Record<string, (number | null)[]> & { time: string[] };

  const suffixes = [...new Set(Object.keys(h).filter((k) => k.includes('_member')).map((k) => `_member${k.split('_member')[1]}`))];
  suffixes.push(''); // нулевой прогон идёт без суффикса

  const byHour = new Map<string, number[]>();
  for (const suffix of suffixes) {
    const rows: (HourRaw | null)[] = h.time.map((time, i) => {
      const g = (v: string) => h[`${v}${suffix}`]?.[i] ?? null;
      const row: HourRaw = {
        time,
        temp: g('temperature_2m') ?? NaN,
        rh: g('relative_humidity_2m') ?? NaN,
        dew: g('dew_point_2m') ?? NaN,
        wind: g('wind_speed_10m') ?? NaN,
        windDir: g('wind_direction_10m') ?? NaN,
        cloud: g('cloud_cover') ?? NaN,
        cloudLow: null,
        precip: g('precipitation'),
        gust: g('wind_gusts_10m'),
        swr: g('shortwave_radiation'),
        soilT: null,
        visibility: null,
      };
      return [row.temp, row.rh, row.dew, row.wind, row.windDir, row.cloud].every(Number.isFinite) ? row : null;
    });
    rows.forEach((row, i) => {
      if (!row) return;
      const prev = i >= 3 ? rows[i - 3] ?? undefined : undefined;
      const list = byHour.get(row.time) ?? [];
      list.push(predictOne(row, prev));
      byHour.set(row.time, list);
    });
  }

  // пишем те же заблаговременности, что и для шести моделей
  const nowHour = new Date(now + 3 * 3_600_000).toISOString().slice(0, 13);
  let written = 0;
  for (const [time, list] of byHour) {
    const lead = Math.round((Date.parse(`${time}:00Z`) - Date.parse(`${nowHour}:00:00Z`)) / 3_600_000);
    if (!LEADS.includes(lead as (typeof LEADS)[number])) continue;
    const mean = list.reduce((a, b) => a + b, 0) / list.length;
    if (await merge(env, time, { ens: { [lead]: Number(mean.toFixed(4)) } })) written++;
  }
  return written;
}

export interface Stats {
  since: string;
  hours: number;
  fogHours: number;
  rows: { source: 'multi' | 'ens'; lead: number; n: number; hit: number; miss: number; falseAlarm: number }[];
}

/** Сводка за последние дни: сколько обещали и сколько сбылось */
export async function summary(env: Env, days: number, threshold: number): Promise<Stats> {
  const cacheKey = `stats:${days}:${threshold}`;
  const cached = (await env.SUBS.get(cacheKey, 'json')) as Stats | null;
  if (cached) return cached;

  const list = await env.SUBS.list({ prefix: 'log:', limit: 1000 });
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 13);
  const rows = new Map<string, { n: number; hit: number; miss: number; falseAlarm: number }>();
  let hours = 0;
  let fogHours = 0;

  for (const { name } of list.keys) {
    const stamp = name.slice(4);
    if (stamp < since) continue;
    const e = (await env.SUBS.get(name, 'json')) as Entry | null;
    if (!e || e.fog === undefined) continue; // факта ещё нет — считать нечего
    hours++;
    if (e.fog) fogHours++;
    for (const source of ['multi', 'ens'] as const) {
      for (const lead of LEADS) {
        const p = e[source]?.[lead];
        if (p === undefined) continue;
        const key = `${source}:${lead}`;
        const r = rows.get(key) ?? { n: 0, hit: 0, miss: 0, falseAlarm: 0 };
        r.n++;
        const warned = p >= threshold;
        if (warned && e.fog) r.hit++;
        else if (!warned && e.fog) r.miss++;
        else if (warned && !e.fog) r.falseAlarm++;
        rows.set(key, r);
      }
    }
  }

  const stats: Stats = {
    since,
    hours,
    fogHours,
    rows: [...rows].map(([key, r]) => {
      const [source, lead] = key.split(':');
      return { source: source as 'multi' | 'ens', lead: Number(lead), ...r };
    }),
  };
  await env.SUBS.put(cacheKey, JSON.stringify(stats), { expirationTtl: 1800 });
  return stats;
}
