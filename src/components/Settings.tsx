import { useState } from 'react';
import { CALIBRATION_SITE, SPB_CENTER, type Coords } from '../lib/api';
import { MODEL } from '../lib/model';
import { ALERT_P } from '../lib/predict';

export type NotifState = NotificationPermission | 'unsupported';

interface Props {
  coords: Coords;
  onCoords: (c: Coords) => void;
  notif: NotifState;
  onEnableNotif: () => void;
  standalone: boolean;
  canInstall: boolean;
  onInstall: () => void;
}

const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);

/** Расстояние по большому кругу, км */
function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(s));
}

export function Settings({ coords, onCoords, notif, onEnableNotif, standalone, canInstall, onInstall }: Props) {
  const [geoBusy, setGeoBusy] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [lat, setLat] = useState(String(coords.lat));
  const [lon, setLon] = useState(String(coords.lon));

  const isDefault = coords.lat === SPB_CENTER.lat && coords.lon === SPB_CENTER.lon;

  function locate() {
    if (!('geolocation' in navigator)) {
      setGeoError('Браузер не поддерживает геолокацию');
      return;
    }
    setGeoBusy(true);
    setGeoError(null);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setGeoBusy(false);
        const c = { lat: +p.coords.latitude.toFixed(4), lon: +p.coords.longitude.toFixed(4), label: 'Моё местоположение' };
        setLat(String(c.lat));
        setLon(String(c.lon));
        onCoords(c);
      },
      (err) => {
        setGeoBusy(false);
        setGeoError(err.code === err.PERMISSION_DENIED ? 'Доступ к геолокации запрещён' : 'Не удалось определить местоположение');
      },
      { enableHighAccuracy: false, timeout: 15_000, maximumAge: 10 * 60_000 },
    );
  }

  function saveManual(e: React.FormEvent) {
    e.preventDefault();
    const la = Number(lat.replace(',', '.'));
    const lo = Number(lon.replace(',', '.'));
    if (!(Math.abs(la) <= 90 && Math.abs(lo) <= 180)) {
      setGeoError('Проверьте координаты: широта от −90 до 90, долгота от −180 до 180');
      return;
    }
    setGeoError(null);
    onCoords({ lat: la, lon: lo, label: 'Свои координаты' });
  }

  function reset() {
    setLat(String(SPB_CENTER.lat));
    setLon(String(SPB_CENTER.lon));
    setGeoError(null);
    onCoords(SPB_CENTER);
  }

  return (
    <section className="panel settings" id="settings">
      <h2>Место</h2>
      <p className="muted">
        {coords.label} · {coords.lat.toFixed(4)}, {coords.lon.toFixed(4)}
      </p>
      <div className="row">
        <button className="btn" onClick={locate} disabled={geoBusy}>
          {geoBusy ? 'Определяю…' : 'Определить моё местоположение'}
        </button>
        {!isDefault && (
          <button className="btn ghost" onClick={reset}>
            Центр СПб
          </button>
        )}
      </div>
      <form className="coords" onSubmit={saveManual}>
        <label>
          Широта
          <input inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} />
        </label>
        <label>
          Долгота
          <input inputMode="decimal" value={lon} onChange={(e) => setLon(e.target.value)} />
        </label>
        <button className="btn ghost" type="submit">
          Сохранить
        </button>
      </form>
      {geoError && <p className="error">{geoError}</p>}
      <p className="fine">
        Модель обучена на наблюдениях аэропорта Пулково ({CALIBRATION_SITE.lat}, {CALIBRATION_SITE.lon}) — это единственная точка
        рядом с городом, где измеряют видимость. Выбранное место в {Math.round(distanceKm(coords, CALIBRATION_SITE))} км от него:
        {distanceKm(coords, CALIBRATION_SITE) > 60
          ? ' там туман образуется по другим правилам, и оценке верить нельзя.'
          : ' условия близкие, но у воды и в низинах туман бывает чаще, чем на Пулковских высотах.'}
      </p>

      <h2>Уведомления</h2>
      {notif === 'granted' && <p className="muted">Включены. Сообщу, когда в ближайшие 12 часов вероятность дойдёт до высокой.</p>}
      {notif === 'default' && (
        <>
          <p className="muted">
            Сообщу, когда в ближайшие 12 часов вероятность тумана дойдёт до {Math.round(ALERT_P * 100)}% — это примерно
            в {Math.round(ALERT_P / MODEL.baseRate)} раз выше обычного.
          </p>
          <button className="btn" onClick={onEnableNotif}>
            Включить уведомления
          </button>
        </>
      )}
      {notif === 'denied' && <p className="muted">Уведомления запрещены в настройках браузера. Остаётся алерт на главном экране.</p>}
      {notif === 'unsupported' &&
        (isIos && !standalone ? (
          <p className="muted">На iPhone уведомления работают только у приложения на экране «Домой».</p>
        ) : (
          <p className="muted">Этот браузер не поддерживает уведомления. Остаётся алерт на главном экране.</p>
        ))}
      <p className="fine">
        Проверено на наблюдениях 2023–2026, которых модель не видела: из всех предупреждений верными оказываются около
        каждого пятого, а поймать удаётся примерно половину туманов (AUC {MODEL.aucTest}). Туман плохо прогнозируется в
        принципе — это уровень научных методик, а не недоработка.
      </p>
      <p className="fine">
        Сервера нет, поэтому проверка идёт при открытии приложения, а на Android у установленного приложения ещё и в фоне, раз в несколько часов (как часто, решает браузер).
      </p>

      {!standalone && (
        <>
          <h2>На экран телефона</h2>
          {canInstall ? (
            <button className="btn" onClick={onInstall}>
              Установить приложение
            </button>
          ) : isIos ? (
            <p className="muted">В Safari: «Поделиться» → «На экран „Домой“».</p>
          ) : (
            <p className="muted">В меню браузера: «Установить приложение» или «Добавить на главный экран».</p>
          )}
        </>
      )}
    </section>
  );
}
