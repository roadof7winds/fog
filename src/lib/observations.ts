// Факт: сводки METAR аэропорта Пулково из архива Iowa Environmental Mesonet.
// Сервер отдаёт Access-Control-Allow-Origin: *, поэтому бэкенд не нужен.
// Это единственная точка рядом с городом, где видимость измеряют приборами.

export const OBS_SITE = {
  icao: 'ULLI',
  label: 'Пулково',
  lat: 59.8003,
  lon: 30.2625,
  /** сводки приходят по московскому времени — станция всегда в этом поясе */
  tz: 'Europe/Moscow',
};

export interface Obs {
  /** местное время станции, "2026-09-22T05:00" */
  time: string;
  visKm: number | null;
  /** коды явлений METAR: FG — туман, BR — дымка */
  code: string;
  fog: boolean;
  mist: boolean;
  temp: number | null;
  dew: number | null;
}

export interface Observations {
  fetchedAt: number;
  rows: Obs[];
}

const MILE_KM = 1.609344;
const FOG_RE = /(^|\s)(FZ|BC|PR)?FG(\s|$)/;

/**
 * Ровно то же определение, по которому размечались обучающие данные:
 * видимость меньше 1 км либо код FG при видимости ниже 2 км. Код без падения
 * видимости (PRFG — туман клочьями где-то на поле) туманом не считаем,
 * иначе факт в приложении расходился бы с тем, на чём училась модель.
 */
export const isFog = (visKm: number | null, code: string) =>
  (visKm != null && visKm < 1) || (FOG_RE.test(code) && (visKm == null || visKm < 2));

function csvUrl(days: number): string {
  const d = (offset: number) => new Date(Date.now() + offset * 86_400_000);
  const from = d(-days);
  const to = d(1);
  const p = new URLSearchParams({
    station: OBS_SITE.icao,
    tz: OBS_SITE.tz,
    format: 'onlycomma',
    missing: 'empty',
    trace: 'empty',
    report_type: '3',
    year1: String(from.getFullYear()),
    month1: String(from.getMonth() + 1),
    day1: String(from.getDate()),
    year2: String(to.getFullYear()),
    month2: String(to.getMonth() + 1),
    day2: String(to.getDate()),
  });
  // data=... повторяется для каждого поля
  const fields = ['vsby', 'wxcodes', 'tmpc', 'dwpc'].map((f) => `data=${f}`).join('&');
  return `https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?${p}&${fields}`;
}

export async function fetchObservations(days = 2, signal?: AbortSignal): Promise<Observations> {
  const res = await fetch(csvUrl(days), { signal });
  if (!res.ok) throw new Error(`Архив наблюдений ответил ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split('\n');
  const rows: Obs[] = [];
  for (const line of lines.slice(1)) {
    const [, valid, vsby, wxcodes, tmpc, dwpc] = line.split(',');
    if (!valid) continue;
    const visKm = vsby ? Number(vsby) * MILE_KM : null;
    const code = (wxcodes ?? '').trim();
    rows.push({
      time: valid.replace(' ', 'T').slice(0, 16),
      visKm: Number.isFinite(visKm as number) ? visKm : null,
      code,
      fog: isFog(visKm, code),
      mist: !isFog(visKm, code) && /(^|\s)BR(\s|$)/.test(code),
      temp: tmpc ? Number(tmpc) : null,
      dew: dwpc ? Number(dwpc) : null,
    });
  }
  rows.sort((a, b) => a.time.localeCompare(b.time));
  return { fetchedAt: Date.now(), rows };
}

export function visibilityText(km: number | null): string {
  if (km == null) return '—';
  if (km >= 10) return '> 10 км';
  if (km >= 1) return `${km.toFixed(1).replace('.', ',')} км`;
  return `${Math.round((km * 1000) / 10) * 10} м`;
}

/** Короткое название явления для строки факта */
export function conditionText(o: Obs): string {
  if (o.fog) return 'туман';
  if (o.mist) return 'дымка';
  if (o.visKm != null && o.visKm < 4) return 'ухудшенная видимость';
  return 'без тумана';
}

/** Непрерывные отрезки с туманом — чтобы показать «когда был» */
export function fogSpells(rows: Obs[]): { from: Obs; to: Obs; minVisKm: number | null }[] {
  const out: { from: Obs; to: Obs; minVisKm: number | null }[] = [];
  let cur: { from: Obs; to: Obs; minVisKm: number | null } | null = null;
  for (const r of rows) {
    if (r.fog) {
      if (!cur) cur = { from: r, to: r, minVisKm: r.visKm };
      cur.to = r;
      if (r.visKm != null && (cur.minVisKm == null || r.visKm < cur.minVisKm)) cur.minVisKm = r.visKm;
    } else if (cur) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}
