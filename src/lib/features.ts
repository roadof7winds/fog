// Признаки модели. Этот файл используют и обучение (scripts/calibrate/fit.mjs),
// и приложение — иначе прогноз считался бы не по тому, на чём училась модель.

export interface FeatureInput {
  temp: number;
  dew: number;
  rh: number;
  wind: number;
  windDir: number;
  cloud: number;
  cloudLow: number | null;
  precip: number | null;
  gust: number | null;
  swr: number | null;
  soilT: number | null;
  /** местный час 0–23 */
  hourOfDay: number;
  /** месяц 1–12 */
  month: number;
  /** изменение температуры за 3 часа */
  dT3: number;
  /** изменение дефицита точки росы за 3 часа */
  dSpread3: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** Группы для объяснения: несколько признаков описывают одно и то же явление */
export type Group = 'humidity' | 'wind' | 'cloud' | 'precip' | 'ground' | 'trendT' | 'trendSpread' | 'daily' | 'season' | 'gulf';

export const FEATURES: { name: string; group: Group; get: (f: FeatureInput) => number }[] = [
  { name: 'spread', group: 'humidity', get: (f) => Math.min(f.temp - f.dew, 8) },
  { name: 'spread≤1', group: 'humidity', get: (f) => (f.temp - f.dew <= 1 ? 1 : 0) },
  { name: 'spread≤2.5', group: 'humidity', get: (f) => (f.temp - f.dew <= 2.5 ? 1 : 0) },
  { name: 'rh', group: 'humidity', get: (f) => f.rh / 100 },
  { name: 'rh≥95', group: 'humidity', get: (f) => (f.rh >= 95 ? 1 : 0) },
  { name: 'wind', group: 'wind', get: (f) => Math.min(f.wind, 12) },
  { name: 'штиль<1', group: 'wind', get: (f) => (f.wind < 1 ? 1 : 0) },
  { name: 'порывы', group: 'wind', get: (f) => Math.min(f.gust ?? f.wind, 20) },
  { name: 'облачность', group: 'cloud', get: (f) => f.cloud / 100 },
  { name: 'низкая облачность', group: 'cloud', get: (f) => (f.cloudLow ?? f.cloud) / 100 },
  { name: 'осадки', group: 'precip', get: (f) => ((f.precip ?? 0) > 0 ? 1 : 0) },
  { name: 'радиация', group: 'cloud', get: (f) => Math.min(f.swr ?? 0, 600) / 600 },
  { name: 'почва−воздух', group: 'ground', get: (f) => clamp((f.soilT ?? f.temp) - f.temp, -8, 8) },
  { name: 'ветер с залива', group: 'gulf', get: (f) => (f.windDir >= 200 && f.windDir <= 280 && f.wind >= 0.5 ? 1 : 0) },
  { name: 'ΔT за 3ч', group: 'trendT', get: (f) => clamp(f.dT3, -8, 8) },
  { name: 'Δspread за 3ч', group: 'trendSpread', get: (f) => clamp(f.dSpread3, -8, 8) },
  { name: 'час sin', group: 'daily', get: (f) => Math.sin((2 * Math.PI * f.hourOfDay) / 24) },
  { name: 'час cos', group: 'daily', get: (f) => Math.cos((2 * Math.PI * f.hourOfDay) / 24) },
  { name: 'месяц sin', group: 'season', get: (f) => Math.sin((2 * Math.PI * (f.month - 1)) / 12) },
  { name: 'месяц cos', group: 'season', get: (f) => Math.cos((2 * Math.PI * (f.month - 1)) / 12) },
];

export const featureVector = (f: FeatureInput): number[] => FEATURES.map((x) => x.get(f));
