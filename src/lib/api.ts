export interface Coords {
  lat: number;
  lon: number;
  label: string;
}

export const SPB_CENTER: Coords = { lat: 59.9386, lon: 30.3141, label: 'Центр Петербурга' };

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
  /** м, может отсутствовать у модели */
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
  hourly: {
    time: string[];
    temperature_2m: (number | null)[];
    relative_humidity_2m: (number | null)[];
    dew_point_2m: (number | null)[];
    wind_speed_10m: (number | null)[];
    wind_direction_10m: (number | null)[];
    cloud_cover: (number | null)[];
    visibility: (number | null)[];
  };
}

const HOURLY = [
  'temperature_2m',
  'relative_humidity_2m',
  'dew_point_2m',
  'wind_speed_10m',
  'wind_direction_10m',
  'cloud_cover',
  'visibility',
].join(',');

export function forecastUrl(c: Coords): string {
  const p = new URLSearchParams({
    latitude: c.lat.toFixed(4),
    longitude: c.lon.toFixed(4),
    hourly: HOURLY,
    // по умолчанию Open-Meteo отдаёт км/ч, а пороги формулы — в м/с
    wind_speed_unit: 'ms',
    timezone: 'auto',
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
  const hours = h.time
    .map(
      (time, i): HourRaw => ({
        time,
        temp: h.temperature_2m[i] ?? NaN,
        rh: h.relative_humidity_2m[i] ?? NaN,
        dew: h.dew_point_2m[i] ?? NaN,
        wind: h.wind_speed_10m[i] ?? NaN,
        windDir: h.wind_direction_10m[i] ?? NaN,
        cloud: h.cloud_cover[i] ?? NaN,
        visibility: h.visibility[i] ?? null,
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
