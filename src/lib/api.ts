export interface Coords {
  lat: number;
  lon: number;
  label: string;
}

export const SPB_CENTER: Coords = { lat: 59.9386, lon: 30.3141, label: 'Центр Петербурга' };

/** Пулково (ULLI) — станция, по наблюдениям которой откалибрована модель */
export const CALIBRATION_SITE = { lat: 59.8003, lon: 30.2625, label: 'Пулково' };

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

export interface Forecast {
  fetchedAt: number;
  coords: Coords;
  utcOffsetSeconds: number;
  timezone: string;
  hours: HourRaw[];
}

interface ApiResponse {
  utc_offset_seconds: number;
  timezone: string;
  hourly: Record<string, (number | null)[]> & { time: string[] };
}

const HOURLY = [
  'temperature_2m',
  'relative_humidity_2m',
  'dew_point_2m',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
  'cloud_cover',
  'cloud_cover_low',
  'precipitation',
  'shortwave_radiation',
  'soil_temperature_0_to_7cm',
  'visibility',
].join(',');

export function forecastUrl(c: Coords): string {
  const p = new URLSearchParams({
    latitude: c.lat.toFixed(4),
    longitude: c.lon.toFixed(4),
    hourly: HOURLY,
    // по умолчанию Open-Meteo отдаёт км/ч, а модель училась на м/с
    wind_speed_unit: 'ms',
    timezone: 'auto',
    // вчерашние часы нужны для трендов температуры за 3 часа
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
  const at = (key: string, i: number) => h[key]?.[i] ?? null;
  const hours = h.time
    .map(
      (time, i): HourRaw => ({
        time,
        temp: at('temperature_2m', i) ?? NaN,
        rh: at('relative_humidity_2m', i) ?? NaN,
        dew: at('dew_point_2m', i) ?? NaN,
        wind: at('wind_speed_10m', i) ?? NaN,
        windDir: at('wind_direction_10m', i) ?? NaN,
        cloud: at('cloud_cover', i) ?? NaN,
        cloudLow: at('cloud_cover_low', i),
        precip: at('precipitation', i),
        gust: at('wind_gusts_10m', i),
        swr: at('shortwave_radiation', i),
        soilT: at('soil_temperature_0_to_7cm', i),
        visibility: at('visibility', i),
      }),
    )
    .filter((x) => [x.temp, x.rh, x.dew, x.wind, x.windDir, x.cloud].every(Number.isFinite));
  return {
    fetchedAt: Date.now(),
    coords: c,
    utcOffsetSeconds: data.utc_offset_seconds,
    timezone: data.timezone,
    hours,
  };
}
