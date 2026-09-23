import type { HourRaw } from './api.ts';
import { FEATURES, featureVector, type FeatureInput, type Group } from './features.ts';
import { MODEL } from './model.ts';

export type Level = 'low' | 'moderate' | 'high' | 'veryHigh';
export type FogType = 'radiation' | 'advection' | 'mixed' | 'none';

/** Средняя доля часов с туманом в Пулково за 2015–2026 — точка отсчёта «обычного» */
export const BASE_RATE = MODEL.baseRate;

/** Порог оповещения: на проверочных годах даёт лучший CSI (0.155) */
export const ALERT_P = 0.08;

export interface Contribution {
  group: Group;
  /** вклад в логит: положительный повышает вероятность */
  value: number;
  text: string;
}

export interface HourScore extends HourRaw {
  /** вероятность тумана 0–1 */
  p: number;
  level: Level;
  type: FogType;
  spread: number;
  hourOfDay: number;
  month: number;
  /** во сколько раз вероятнее обычного */
  ratio: number;
  contributions: Contribution[];
}

export const LEVEL_LABEL: Record<Level, string> = {
  low: 'Низкая',
  moderate: 'Умеренная',
  high: 'Повышенная',
  veryHigh: 'Высокая',
};

export const TYPE_LABEL: Record<FogType, string> = {
  radiation: 'радиационный',
  advection: 'адвективный',
  mixed: 'смешанный',
  none: '—',
};

export const TYPE_HINT: Record<FogType, string> = {
  radiation: 'ночное выхолаживание при ясном небе и слабом ветре',
  advection: 'влажный воздух с залива',
  mixed: 'выхолаживание и влажный воздух с залива',
  none: '',
};

export function levelOf(p: number): Level {
  if (p >= ALERT_P) return 'veryHigh';
  if (p >= 0.03) return 'high';
  if (p >= 0.01) return 'moderate';
  return 'low';
}

const RU_POINTS = ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'];
export const compass = (deg: number) => RU_POINTS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

export const num = (n: number, digits = 1) => n.toFixed(digits).replace('.', ',').replace('-', '−');

/** Вероятность в процентах: у малых значений один знак после запятой */
export const pct = (p: number) => (p >= 0.1 ? `${Math.round(p * 100)}` : p < 0.001 ? '<0,1' : num(p * 100, 1));

const sigmoid = (t: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, t))));

/** Кусочно-линейная калибровка, подогнанная на обучающих годах */
function calibrate(pRaw: number): number {
  const iso = MODEL.isotonic;
  if (pRaw <= iso[0][0]) return iso[0][1];
  if (pRaw >= iso[iso.length - 1][0]) return iso[iso.length - 1][1];
  for (let i = 1; i < iso.length; i++) {
    if (pRaw <= iso[i][0]) {
      const [x0, y0] = iso[i - 1];
      const [x1, y1] = iso[i];
      const t = (pRaw - x0) / (x1 - x0 || 1);
      return y0 + t * (y1 - y0);
    }
  }
  return iso[iso.length - 1][1];
}

/** Человеческое описание группы признаков — чтобы число было объяснимо */
function describe(group: Group, f: FeatureInput): string {
  const spread = f.temp - f.dew;
  switch (group) {
    case 'humidity':
      if (spread <= 1) return `температура почти равна точке росы (Δ ${num(Math.max(spread, 0))}°), влажность ${Math.round(f.rh)}%`;
      if (spread <= 2.5) return `точка росы близко к температуре (Δ ${num(spread)}°)`;
      if (spread <= 4) return `точка росы недалеко (Δ ${num(spread)}°)`;
      return `воздух далёк от насыщения (Δ ${num(spread)}°)`;
    case 'wind':
      if (f.wind < 1) return `штиль (${num(f.wind)} м/с)`;
      if (f.wind <= 3) return `слабый ветер (${num(f.wind)} м/с)`;
      if (f.wind <= 5) return `умеренный ветер (${num(f.wind)} м/с)`;
      return `сильный ветер (${num(f.wind)} м/с), перемешивает воздух`;
    case 'cloud': {
      const low = f.cloudLow ?? f.cloud;
      if (f.cloud < 30) return `ясно (${Math.round(f.cloud)}%)`;
      if (low > 70) return `низкая облачность (${Math.round(low)}%)`;
      return `облачность ${Math.round(f.cloud)}%`;
    }
    case 'precip':
      return (f.precip ?? 0) > 0 ? 'идут осадки' : 'без осадков';
    case 'ground': {
      const d = (f.soilT ?? f.temp) - f.temp;
      return d < -0.5 ? `почва холоднее воздуха на ${num(-d)}°` : `почва теплее воздуха на ${num(Math.max(d, 0))}°`;
    }
    case 'trendT':
      if (f.dT3 < -0.5) return `похолодание на ${num(-f.dT3)}° за 3 часа`;
      if (f.dT3 > 0.5) return `потепление на ${num(f.dT3)}° за 3 часа`;
      return 'температура держится ровно';
    case 'trendSpread':
      // Знак вклада здесь не про физику охлаждения: модель училась на том, что
      // воздух, уже насыщенный несколько часов, даёт туман чаще, чем только что
      // приблизившийся к насыщению.
      if (f.dSpread3 < -0.5) return `воздух только приближается к насыщению (за 3 часа Δ упал на ${num(-f.dSpread3)}°)`;
      if (f.dSpread3 > 0.5) return `воздух подсыхает (за 3 часа Δ вырос на ${num(f.dSpread3)}°)`;
      return 'влажность держится ровно';
    case 'daily':
      return f.hourOfDay >= 3 && f.hourOfDay < 9 ? 'предрассветные часы' : f.hourOfDay >= 10 && f.hourOfDay < 16 ? 'дневные часы' : 'вечерние часы';
    case 'season':
      return [1, 2, 9, 10, 11].includes(f.month) ? 'туманный сезон' : 'малотуманный сезон';
    case 'gulf':
      return `ветер с залива (${compass(f.windDir)}, ${Math.round(f.windDir)}°)`;
  }
}

/** Признаки часа. prev3 — тот же пункт три часа назад, для трендов. */
export function toFeatureInput(h: HourRaw, prev3: HourRaw | undefined): FeatureInput {
  return {
    temp: h.temp,
    dew: h.dew,
    rh: h.rh,
    wind: h.wind,
    windDir: h.windDir,
    cloud: h.cloud,
    cloudLow: h.cloudLow,
    precip: h.precip,
    gust: h.gust,
    swr: h.swr,
    soilT: h.soilT,
    hourOfDay: Number(h.time.slice(11, 13)),
    month: Number(h.time.slice(5, 7)),
    dT3: prev3 ? h.temp - prev3.temp : 0,
    dSpread3: prev3 ? h.temp - h.dew - (prev3.temp - prev3.dew) : 0,
  };
}

export function predictHour(h: HourRaw, prev3: HourRaw | undefined): HourScore {
  const f = toFeatureInput(h, prev3);
  const vec = featureVector(f);
  const z = vec.map((x, i) => (x - MODEL.mean[i]) / MODEL.std[i]);
  const logit = z.reduce((acc, x, i) => acc + x * MODEL.w[i], MODEL.b);
  const p = calibrate(sigmoid(logit));

  // вклад каждой группы признаков в логит — это и есть объяснение числа
  const byGroup = new Map<Group, number>();
  FEATURES.forEach((feat, i) => byGroup.set(feat.group, (byGroup.get(feat.group) ?? 0) + z[i] * MODEL.w[i]));
  // Признак «ветер с залива» двоичный: когда он выключен, его вклад существует,
  // но объяснять его фразой про залив нельзя — она была бы неправдой.
  const gulfOn = f.windDir >= 200 && f.windDir <= 280 && f.wind >= 0.5;
  const contributions: Contribution[] = [...byGroup]
    .map(([group, value]) => ({ group, value, text: describe(group, f) }))
    .filter((c) => Math.abs(c.value) > 0.05 && (c.group !== 'gulf' || gulfOn))
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

  const spread = h.temp - h.dew;
  const radiation = h.cloud < 30 && h.wind <= 3;
  const gulf = h.windDir >= 200 && h.windDir <= 280 && h.wind >= 0.5 && h.rh >= 90;
  const type: FogType = radiation && gulf ? 'mixed' : radiation ? 'radiation' : gulf ? 'advection' : 'none';

  return {
    ...h,
    p,
    level: levelOf(p),
    type,
    spread,
    hourOfDay: f.hourOfDay,
    month: f.month,
    ratio: p / BASE_RATE,
    contributions,
  };
}

/** Строка «почему» из самых весомых факторов */
export function explain(h: HourScore): string {
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const pos = h.contributions.filter((c) => c.value > 0).slice(0, 3);
  const neg = h.contributions.filter((c) => c.value < 0).slice(0, 2);
  // При низкой вероятности ведущими должны быть доводы против тумана,
  // иначе «слабый ветер, влажно» читается как предупреждение.
  if (h.level === 'low') {
    if (!neg.length) return 'Условия для тумана слабые.';
    return `Тумана не ждём: ${neg.map((c) => c.text).join(', ')}.`;
  }
  if (!pos.length) return cap(neg.map((c) => c.text).join(', ') || 'условия для тумана слабые') + '.';
  let s = cap(pos.map((c) => c.text).join(', '));
  if (neg.length) s += `, но ${neg[0].text}`;
  return s + '.';
}
