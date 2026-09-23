import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchForecast, SPB_CENTER, type Coords, type Forecast } from './lib/api';
import { kvGet, kvSet } from './lib/db';
import { ALERT_P, BASE_RATE, LEVEL_LABEL, TYPE_LABEL, pct } from './lib/predict';
import { riskWindows, upcoming, windowEndLabel, type RiskWindow } from './lib/series';
import { LOOKAHEAD_HOURS, maybeNotify } from './lib/notify';
import { clock, hhmm, relDay } from './format';
import { Hero, scalePos } from './components/Hero';
import { Timeline } from './components/Timeline';
import { HourList } from './components/HourList';
import { Settings, type NotifState } from './components/Settings';
import { Observed } from './components/Observed';
import { fetchObservations, OBS_SITE, type Observations } from './lib/observations';
import { distanceKm } from './lib/geo';

type Status = 'loading' | 'ok' | 'offline' | 'error';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
}

const REFRESH_MS = 30 * 60_000;
const sameCoords = (a: Coords, b: Coords) => a.lat === b.lat && a.lon === b.lon;
const notifSupported = typeof Notification !== 'undefined';
const standalone =
  window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

async function showNotification(title: string, options: NotificationOptions) {
  const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined;
  if (reg) await reg.showNotification(title, options);
  else new Notification(title, options);
}

export default function App() {
  const [coords, setCoords] = useState<Coords | null>(null);
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [selectedTime, setSelectedTime] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [notif, setNotif] = useState<NotifState>(notifSupported ? Notification.permission : 'unsupported');
  const [installEvt, setInstallEvt] = useState<BeforeInstallPromptEvent | null>(null);
  const [obs, setObs] = useState<Observations | null>(null);

  // Сохранённое место
  useEffect(() => {
    kvGet<Coords>('coords').then((c) => setCoords(c ?? SPB_CENTER));
  }, []);

  // Факт с метеостанции грузим отдельно: если он недоступен, прогноз всё равно нужен
  const loadObs = useCallback(async () => {
    const cached = await kvGet<Observations>('obs');
    if (cached) setObs(cached);
    try {
      const o = await fetchObservations(2);
      setObs(o);
      await kvSet('obs', o);
    } catch {
      // архив наблюдений недоступен — панель просто покажет последнее сохранённое
    }
  }, []);

  const load = useCallback(async (c: Coords) => {
    setStatus((s) => (s === 'ok' ? 'ok' : 'loading'));
    const cached = await kvGet<Forecast>('forecast');
    if (cached && sameCoords(cached.coords, c)) setForecast((f) => f ?? cached);
    try {
      const f = await fetchForecast(c);
      setForecast(f);
      setStatus('ok');
      setError(null);
      await kvSet('forecast', f);
      if (notifSupported && Notification.permission === 'granted') await maybeNotify(upcoming(f), c, showNotification);
    } catch (e) {
      if (cached && sameCoords(cached.coords, c)) {
        setForecast(cached);
        setStatus('offline');
      } else {
        setStatus('error');
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  }, []);

  useEffect(() => {
    if (coords) load(coords);
  }, [coords, load]);

  useEffect(() => {
    loadObs();
  }, [loadObs]);

  // Обновление по таймеру и при возвращении в приложение
  useEffect(() => {
    if (!coords) return;
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    const refresh = setInterval(() => load(coords), REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      setNow(Date.now());
      load(coords);
      loadObs();
    };
    const onOnline = () => {
      load(coords);
      loadObs();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    return () => {
      clearInterval(tick);
      clearInterval(refresh);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
    };
  }, [coords, load, loadObs]);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setInstallEvt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  const hours = useMemo(() => (forecast ? upcoming(forecast, now) : []), [forecast, now]);
  const today = forecast ? new Date(now + forecast.utcOffsetSeconds * 1000).toISOString().slice(0, 10) : '';
  const windows = useMemo(() => riskWindows(hours), [hours]);
  const alert = windows.find((w) => w.startIndex < LOOKAHEAD_HOURS);

  const selIdx = Math.max(0, selectedTime ? hours.findIndex((h) => h.time === selectedTime) : 0);
  const selected = hours[selIdx];
  const select = (i: number) => setSelectedTime(i === 0 ? null : hours[i].time);

  // Плотность «тумана» на фоне следует за выбранным часом
  const density = selected ? 0.12 + scalePos(selected.p) * 0.88 : 0.3;

  async function changeCoords(c: Coords) {
    setCoords(c);
    setForecast(null);
    setSelectedTime(null);
    await kvSet('coords', c);
  }

  async function enableNotif() {
    if (!notifSupported) return;
    const p = await Notification.requestPermission();
    setNotif(p);
    if (p !== 'granted') return;
    const reg = await navigator.serviceWorker?.getRegistration();
    // Фоновая проверка: Chrome на Android для установленного PWA
    const periodic = (reg as (ServiceWorkerRegistration & { periodicSync?: { register: (tag: string, o: object) => Promise<void> } }) | undefined)?.periodicSync;
    try {
      await periodic?.register('fog-check', { minInterval: 3 * 60 * 60_000 });
    } catch {
      // браузер не дал разрешение на periodic sync — останутся проверки при открытии
    }
    if (hours.length && coords) await maybeNotify(hours, coords, showNotification);
  }

  async function install() {
    if (!installEvt) return;
    await installEvt.prompt();
    setInstallEvt(null);
  }

  const stale = forecast && now - forecast.fetchedAt > 3 * 60 * 60_000;

  return (
    <>
      <div className="fog" style={{ ['--density' as string]: density }} aria-hidden>
        <i />
        <i />
        <i />
        <i />
      </div>

      <main className="app">
        <header className="top">
          <div>
            <h1>Туман</h1>
            <a className="place" href="#settings">
              {coords?.label ?? '…'}
            </a>
          </div>
          <div className="status">
            {status === 'loading' && <span className="dot pulse" />}
            {status === 'offline' && <span className="badge">офлайн</span>}
            {forecast && <span className="muted">обновлено {clock(forecast.fetchedAt)}</span>}
            <button className="icon-btn" onClick={() => coords && load(coords)} aria-label="Обновить прогноз" title="Обновить">
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
                <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        </header>

        {status === 'offline' && (
          <p className="notice">Нет сети — показываю сохранённый прогноз{stale ? ', он уже устарел' : ''}.</p>
        )}

        {alert && <AlertBanner w={alert} today={today} onSelect={select} />}

        {!selected && status === 'error' && (
          <section className="panel">
            <p className="error">Не удалось загрузить прогноз: {error}</p>
            <button className="btn" onClick={() => coords && load(coords)}>
              Повторить
            </button>
          </section>
        )}
        {!selected && status === 'loading' && <section className="hero skeleton" aria-busy="true" />}

        {selected && (
          <>
            <Hero h={selected} current={selIdx === 0} today={today} onBack={() => select(0)} />

            <section className="panel">
              <h2>Ближайшие {hours.length} ч</h2>
              <Timeline hours={hours} selected={selIdx} onSelect={select} />
              <RiskList windows={windows} today={today} onSelect={select} />
            </section>

            {obs && coords && <Observed obs={obs} distanceKm={distanceKm(coords, OBS_SITE)} today={today} />}

            <section className="panel">
              <h2>По часам</h2>
              <HourList hours={hours} selected={selIdx} today={today} onSelect={(i) => { select(i); window.scrollTo({ top: 0, behavior: 'smooth' }); }} />
            </section>
          </>
        )}

        {coords && (
          <Settings
            key={`${coords.lat},${coords.lon}`}
            coords={coords}
            onCoords={changeCoords}
            notif={notif}
            onEnableNotif={enableNotif}
            standalone={standalone}
            canInstall={!!installEvt}
            onInstall={install}
          />
        )}

        <footer className="foot">
          Прогноз: <a href="https://open-meteo.com/">Open-Meteo.com</a> (CC BY 4.0). Вероятность считает модель, обученная
          на наблюдениях аэропорта Пулково за 2015–2026 (<a href="https://mesonet.agron.iastate.edu/request/download.phtml">IEM</a>).
          Это не официальный прогноз.
        </footer>
      </main>
    </>
  );
}

function AlertBanner({ w, today, onSelect }: { w: RiskWindow; today: string; onSelect: (i: number) => void }) {
  const when = w.startIndex === 0 ? 'уже сейчас' : `${relDay(w.start.time, today)} с ${hhmm(w.start.time)}`;
  return (
    <button className="alert" onClick={() => onSelect(w.peakIndex)}>
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
        <path d="M3 9h11M5 13h13M3 17h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <circle cx="19" cy="7" r="3" fill="currentColor" />
      </svg>
      <span>
        <strong>
          {LEVEL_LABEL[w.peak.level]} вероятность тумана {when}
        </strong>
        <span>
          до {windowEndLabel(w)} · пик {pct(w.peak.p)}% в {hhmm(w.peak.time)}
          {w.peak.type !== 'none' ? ` · ${TYPE_LABEL[w.peak.type]}` : ''}
        </span>
      </span>
    </button>
  );
}

function RiskList({ windows, today, onSelect }: { windows: RiskWindow[]; today: string; onSelect: (i: number) => void }) {
  if (!windows.length)
    return <p className="muted risk-none">Часов с вероятностью выше {Math.round(ALERT_P * 100)}% впереди нет. Обычная частота тумана — {pct(BASE_RATE)}% часов.</p>;
  return (
    <ul className="risks">
      {windows.map((w) => (
        <li key={w.start.time}>
          <button className={`risk lvl-${w.peak.level}`} onClick={() => onSelect(w.peakIndex)}>
            <span className="risk-when">
              {relDay(w.start.time, today)},{' '}
              <span className="nowrap">
                {hhmm(w.start.time)}–{windowEndLabel(w)}
              </span>
            </span>
            <span className="risk-peak">до {pct(w.peak.p)}%</span>
            <span className="risk-type">{w.peak.type !== 'none' ? TYPE_LABEL[w.peak.type] : `${w.length} ч`}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
