// Скачивает данные для проверки точности:
//   1) наблюдения METAR аэропорта Пулково (ULLI) из архива Iowa Environmental Mesonet;
//   2) почасовой реанализ ERA5 в той же точке из архива Open-Meteo.
// Оба источника бесплатные и без ключей. Результат — data/*.json, в git не попадает.
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';

const ULLI = { lat: 59.8003, lon: 30.2625 }; // Пулково: с ним сравниваем, там же измеряют видимость
const START = '2015-01-01';
const END = '2026-09-01';
const DIR = new URL('./data/', import.meta.url);

if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });

async function get(url, asJson = true) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return asJson ? await res.json() : await res.text();
    } catch (e) {
      if (attempt >= 4) throw e;
      console.warn(`  повтор ${attempt}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
}

// ── METAR ──────────────────────────────────────────────
// vsby в статутных милях, wxcodes — коды погоды (FG — туман, BR — дымка).
function metarUrl(y1, y2) {
  const p = new URLSearchParams({
    station: 'ULLI',
    data: 'vsby,tmpc,dwpc,sknt,drct,wxcodes',
    year1: y1, month1: '1', day1: '1',
    year2: y2, month2: '1', day2: '1',
    tz: 'UTC',
    format: 'onlycomma',
    missing: 'empty',
    trace: 'empty',
    report_type: '3', // routine METAR
  });
  return `https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?${p}`;
}

const MILE_KM = 1.609344;
/** Туман по стандарту: видимость < 1 км, либо в METAR явно закодирован туман. */
function isFog(vsbyMiles, wx) {
  const codes = (wx || '').split(/\s+/).filter(Boolean);
  const fogCode = codes.some((c) => /^(\+|-)?(FZ|BC|PR|MI)?FG$/.test(c) && !c.includes('MIFG'));
  const km = vsbyMiles === '' || vsbyMiles == null ? null : Number(vsbyMiles) * MILE_KM;
  if (km != null && km < 1) return true;
  // MIFG (поземный туман) видимость на уровне глаз не снижает — за туман не считаем
  return fogCode && (km == null || km < 2);
}

async function fetchMetar() {
  const rows = new Map(); // час UTC -> наблюдение
  const y0 = Number(START.slice(0, 4));
  const y1 = Number(END.slice(0, 4)) + 1;
  for (let y = y0; y < y1; y++) {
    process.stdout.write(`METAR ${y}… `);
    const csv = await get(metarUrl(y, y + 1), false);
    const lines = csv.trim().split('\n').slice(1);
    let kept = 0;
    for (const line of lines) {
      const [, valid, vsby, tmpc, dwpc, sknt, drct, ...wxParts] = line.split(',');
      if (!valid) continue;
      const wx = wxParts.join(',').trim();
      const d = new Date(`${valid.replace(' ', 'T')}:00Z`);
      if (Number.isNaN(+d)) continue;
      // METAR выходит в начале часа или в :30; относим к ближайшему часу
      const hour = new Date(Math.round(+d / 3_600_000) * 3_600_000).toISOString().slice(0, 13);
      const vis = vsby === '' ? null : Number(vsby) * MILE_KM;
      const prev = rows.get(hour);
      // если на час пришлось несколько сводок, берём худшую видимость
      if (!prev || (vis != null && prev.visKm != null && vis < prev.visKm)) {
        rows.set(hour, {
          visKm: vis,
          wx,
          fog: isFog(vsby, wx),
          t: tmpc === '' ? null : Number(tmpc),
          td: dwpc === '' ? null : Number(dwpc),
          wind: sknt === '' ? null : Number(sknt) * 0.514444,
          dir: drct === '' ? null : Number(drct),
        });
      }
      kept++;
    }
    console.log(`${kept} строк`);
  }
  return Object.fromEntries(rows);
}

// ── ERA5 ───────────────────────────────────────────────
async function fetchEra5() {
  const p = new URLSearchParams({
    latitude: ULLI.lat,
    longitude: ULLI.lon,
    start_date: START,
    end_date: END,
    hourly: 'temperature_2m,relative_humidity_2m,dew_point_2m,wind_speed_10m,wind_direction_10m,cloud_cover',
    wind_speed_unit: 'ms',
    timezone: 'UTC',
  });
  console.log('ERA5…');
  const d = await get(`https://archive-api.open-meteo.com/v1/archive?${p}`);
  const h = d.hourly;
  const out = {};
  h.time.forEach((t, i) => {
    out[t.slice(0, 13)] = {
      temp: h.temperature_2m[i],
      rh: h.relative_humidity_2m[i],
      dew: h.dew_point_2m[i],
      wind: h.wind_speed_10m[i],
      windDir: h.wind_direction_10m[i],
      cloud: h.cloud_cover[i],
    };
  });
  console.log(`  ${h.time.length} часов`);
  return out;
}

const [metar, era5] = [await fetchMetar(), await fetchEra5()];
writeFileSync(new URL('metar.json', DIR), JSON.stringify(metar));
writeFileSync(new URL('era5.json', DIR), JSON.stringify(era5));

const fogHours = Object.values(metar).filter((m) => m.fog).length;
console.log(`\nГотово: ${Object.keys(metar).length} часов наблюдений, из них с туманом ${fogHours}`);
console.log(`ERA5: ${Object.keys(era5).length} часов`);
