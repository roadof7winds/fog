export interface Coords {
  lat: number;
  lon: number;
  label: string;
}

export const SPB_CENTER: Coords = { lat: 59.9386, lon: 30.3141, label: 'Центр Петербурга' };

/** Пулково (ULLI) — станция, по наблюдениям которой откалибрована модель */
export const CALIBRATION_SITE = { lat: 59.8003, lon: 30.2625, label: 'Пулково' };

/**
 * Одна модель погоды может не увидеть туман целиком: 1 октября 2026 в центре
 * была видимость 200 м, а best_match показывал сухой воздух, тогда как icon_eu
 * и ukmo давали видимость 40–160 м. Поэтому спрашиваем несколько моделей сразу
 * и усредняем вероятность: на наблюдениях Пулково среднее не хуже лучшей
 * одиночной модели, а при расхождении это видно пользователю.
 */
export const MODELS = ['best_match', 'ecmwf_ifs025', 'icon_eu', 'gfs_seamless', 'ukmo_seamless', 'meteofrance_seamless'] as const;
export type ModelId = (typeof MODELS)[number];

export const MODEL_LABEL: Record<ModelId, string> = {
  best_match: 'Open-Meteo',
  ecmwf_ifs025: 'ECMWF',
  icon_eu: 'ICON-EU',
  gfs_seamless: 'GFS',
  ukmo_seamless: 'UKMO',
  meteofrance_seamless: 'Météo-France',
};

export interface HourRaw {
  /** Местное время точки, формат Open-Meteo: "2026-09-22T03:00" */
  time: string;
  temp: number;
  rh: number;
  dew: number;
  /** м/с */
  wind: number;
  /** откуда дует, градусы */
  windDir: number;
  cloud: number;
  /** нет у части моделей; модель училась без него, когда его нет */
  cloudLow: number | null;
  /** мм за час */
  precip: number | null;
  /** порывы, м/с */
  gust: number | null;
  /** приток солнечной радиации, Вт/м² */
  swr: number | null;
  /** температура почвы 0–7 см */
  soilT: number | null;
  /** м, модельная оценка; в расчёт вероятности не входит */
  visibility: number | null;
}

/** Один час глазами всех моделей сразу */
export interface HourMembers {
  time: string;
  members: { model: ModelId; h: HourRaw }[];
}

export interface Forecast {
  fetchedAt: number;
  coords: Coords;
  utcOffsetSeconds: number;
  timezone: string;
  hours: HourMembers[];
}

type Hourly = Record<string, (number | null)[] | string[]>;

interface ApiResponse {
  utc_offset_seconds: number;
  timezone: string;
  hourly: Hourly & { time: string[] };
}

const HOURLY = [
  'temperature_2m',
  'relative_humidity_2m',
  'dew_point_2m',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
  'cloud_cover',
  'precipitation',
  'shortwave_radiation',
  'visibility',
].join(',');

export function forecastUrl(c: Coords): string {
  const p = new URLSearchParams({
    latitude: c.lat.toFixed(4),
    longitude: c.lon.toFixed(4),
    hourly: HOURLY,
    models: MODELS.join(','),
    // по умолчанию Open-Meteo отдаёт км/ч, а модель училась на м/с
    wind_speed_unit: 'ms',
    timezone: 'auto',
    // вчерашние часы нужны и для трендов, и чтобы показать, что было утром
    past_days: '1',
    // 3 дня, чтобы и поздним вечером хватало 48 часов вперёд
    forecast_days: '3',
  });
  return `https://api.open-meteo.com/v1/forecast?${p}`;
}

export async function fetchForecast(c: Coords, signal?: AbortSignal): Promise<Forecast> {
  const res = await fetch(forecastUrl(c), { signal });
  if (!res.ok) throw new Error(`Open-Meteo ответил ${res.status}`);
  const data = (await res.json()) as ApiResponse;
  const h = data.hourly;

  const num = (key: string, i: number): number | null => {
    const col = h[key] as (number | null)[] | undefined;
    const v = col?.[i];
    return typeof v === 'number' ? v : null;
  };

  const hours: HourMembers[] = h.time.map((time, i) => {
    const members: HourMembers['members'] = [];
    for (const model of MODELS) {
      // при нескольких моделях Open-Meteo добавляет суффикс к каждому полю
      const g = (v: string) => num(`${v}_${model}`, i);
      const raw: HourRaw = {
        time,
        temp: g('temperature_2m') ?? NaN,
        rh: g('relative_humidity_2m') ?? NaN,
        dew: g('dew_point_2m') ?? NaN,
        wind: g('wind_speed_10m') ?? NaN,
        windDir: g('wind_direction_10m') ?? NaN,
        cloud: g('cloud_cover') ?? NaN,
        // низкой облачности и температуры почвы нет у части моделей,
        // поэтому не используем их ни у одной — чтобы модели были сравнимы
        cloudLow: null,
        precip: g('precipitation'),
        gust: g('wind_gusts_10m'),
        swr: g('shortwave_radiation'),
        soilT: null,
        visibility: g('visibility'),
      };
      if ([raw.temp, raw.rh, raw.dew, raw.wind, raw.windDir, raw.cloud].every(Number.isFinite)) members.push({ model, h: raw });
    }
    return { time, members };
  });

  return {
    fetchedAt: Date.now(),
    coords: c,
    utcOffsetSeconds: data.utc_offset_seconds,
    timezone: data.timezone,
    hours: hours.filter((x) => x.members.length > 0),
  };
}
