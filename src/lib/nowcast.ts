import { CALIBRATION_SITE, type Coords } from './api.ts';
import { distanceKm } from './geo.ts';
import { NOWCAST } from './nowcast-model.ts';
import { isFog, type Obs } from './observations.ts';
import { BASE_RATE, levelOf, type HourScore } from './predict.ts';

/** Дальше какого расстояния факт в Пулково перестаёт говорить о погоде у вас */
export const NOWCAST_RADIUS_KM = 60;

/** Старее этого сводка уже не «сейчас» */
const MAX_AGE_HOURS = 2;

/** На сколько часов вперёд поправка обучена */
export const MAX_LEAD = 6;

export type StationState = 'fog' | 'mist' | 'haze' | 'clear';

/**
 * Видимость 9,99 км в METAR — это «не меньше», то есть обычная погода,
 * а не лёгкое ухудшение.
 */
const CLEAR_KM = 9.9;

export function stationState(o: Obs): StationState {
  if (isFog(o.visKm, o.code)) return 'fog';
  if (o.visKm != null && o.visKm < 4) return 'mist';
  if (o.visKm != null && o.visKm < CLEAR_KM) return 'haze';
  return 'clear';
}

const logit = (p: number) => Math.log(Math.max(p, 1e-6) / Math.max(1 - p, 1e-6));
const sigmoid = (t: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, t))));

/** Прогноз с учётом того, что на станции прямо сейчас */
export function adjust(p: number, lead: number, state: StationState): number {
  const m = NOWCAST[lead];
  if (!m) return p;
  const flags = [state === 'fog' ? 1 : 0, state === 'mist' ? 1 : 0, state === 'haze' ? 1 : 0];
  return sigmoid(m.b + m.w[0] * logit(p) + m.w[1] * flags[0] + m.w[2] * flags[1] + m.w[3] * flags[2]);
}

export interface NowcastInfo {
  state: StationState;
  obsTime: string;
  /** сколько часов ряда поправлено */
  adjusted: number;
}

/**
 * Подмешивает факт со станции в ближайшие часы прогноза. Туман очень
 * «липкий»: через час после тумана он остаётся более чем в половине случаев,
 * и ни одна модель погоды этого не знает.
 */
export function applyNowcast(
  hours: HourScore[],
  rows: Obs[],
  coords: Coords,
  /** смещение часового пояса точки: сводки и прогноз приходят в местном времени */
  utcOffsetSeconds: number,
  now = Date.now(),
): { hours: HourScore[]; info: NowcastInfo | null } {
  const last = rows.at(-1);
  if (!last) return { hours, info: null };
  if (distanceKm(coords, CALIBRATION_SITE) > NOWCAST_RADIUS_KM) return { hours, info: null };

  // И сводки, и прогноз приходят в местном времени, поэтому «сейчас» тоже
  // надо брать местное: иначе возраст сводки уедет на размер часового пояса.
  const obsMs = Date.parse(`${last.time}:00Z`);
  const nowLocalMs = now + utcOffsetSeconds * 1000;
  const ageHours = (nowLocalMs - obsMs) / 3_600_000;
  if (!(ageHours >= -1 && ageHours <= MAX_AGE_HOURS)) return { hours, info: null };

  const state = stationState(last);
  let adjusted = 0;
  const out = hours.map((h) => {
    const lead = Math.round((Date.parse(`${h.time}:00Z`) - obsMs) / 3_600_000);
    if (lead < 1 || lead > MAX_LEAD) return h;
    const p = adjust(h.p, lead, state);
    adjusted++;
    return { ...h, p, level: levelOf(p), ratio: p / BASE_RATE, nowcast: true as const };
  });
  return { hours: out, info: { state, obsTime: last.time, adjusted } };
}

export const STATE_TEXT: Record<StationState, string> = {
  fog: 'в Пулково сейчас туман',
  mist: 'в Пулково сейчас дымка',
  haze: 'в Пулково видимость снижена',
  clear: 'в Пулково сейчас чисто',
};
