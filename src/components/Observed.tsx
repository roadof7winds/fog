import { conditionText, fogSpells, visibilityText, type Observations } from '../lib/observations';
import { hhmm, relDay } from '../format';

interface Props {
  obs: Observations;
  /** расстояние от выбранного места до станции, км */
  distanceKm: number;
  today: string;
}

/** Конец отрезка — час последней сводки плюс час, иначе один час выглядит как «23:00–23:00» */
const endLabel = (time: string) => `${String((Number(time.slice(11, 13)) + 1) % 24).padStart(2, '0')}:00`;

/** Факт: что на самом деле намерили в Пулково. Прогноз без этого не с чем сверить. */
export function Observed({ obs, distanceKm, today }: Props) {
  const last = obs.rows.at(-1);
  if (!last) return null;
  const spells = fogSpells(obs.rows);
  const nowFog = last.fog || last.mist;

  return (
    <section className="panel observed">
      <h2>Факт · Пулково</h2>

      <div className={`obs-now${last.fog ? ' obs-fog' : ''}`}>
        <div className="obs-vis">{visibilityText(last.visKm)}</div>
        <div className="obs-meta">
          <div className="obs-cond">{conditionText(last)}</div>
          <div className="muted">
            {hhmm(last.time)}
            {last.temp != null && last.dew != null && ` · ${Math.round(last.temp)}° / точка росы ${Math.round(last.dew)}°`}
          </div>
        </div>
      </div>

      {spells.length > 0 ? (
        <ul className="spells">
          {spells.map((s) => (
            <li key={s.from.time}>
              <span className="spell-when">
                {relDay(s.from.time, today)}, {hhmm(s.from.time)}–{endLabel(s.to.time)}
              </span>
              <span className="spell-vis">до {visibilityText(s.minVisKm)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{nowFog ? 'Сейчас видимость ухудшена.' : 'За последние двое суток тумана не было.'}</p>
      )}

      <p className="fine">
        Измерения аэропорта в {Math.round(distanceKm)} км от выбранного места — ближайшая точка, где видимость меряют
        приборами. В городе у воды туман бывает чаще. Источник: Iowa Environmental Mesonet, сводки METAR.
      </p>
    </section>
  );
}
