import { LEVEL_LABEL, TYPE_HINT, TYPE_LABEL, compass, explain, num, type HourScore } from '../lib/fog';
import { hhmm, relDay, visibilityText } from '../format';

interface Props {
  h: HourScore;
  current: boolean;
  today: string;
  onBack: () => void;
}

export function Hero({ h, current, today, onBack }: Props) {
  const typeText =
    h.type !== 'none' ? `${TYPE_LABEL[h.type]} туман` : h.level === 'low' ? 'туман не ожидается' : 'тип не выражен';

  return (
    <section className={`hero lvl-${h.level}`} aria-live="polite">
      <div className="hero-when">
        <span>{current ? `Сейчас · ${hhmm(h.time)}` : `${relDay(h.time, today)}, ${hhmm(h.time)}`}</span>
        {!current && (
          <button className="link" onClick={onBack}>
            ← к текущему часу
          </button>
        )}
      </div>

      <div className="hero-main">
        <div className="pct" aria-label={`Вероятность тумана ${h.score} процентов`}>
          <span className="pct-n">{h.score}</span>
          <span className="pct-u">%</span>
        </div>
        <div className="hero-side">
          <div className="level">{LEVEL_LABEL[h.level]}</div>
          <div className="type">{typeText}</div>
          {h.type !== 'none' && <div className="type-hint">{TYPE_HINT[h.type]}</div>}
        </div>
      </div>

      <Scale score={h.score} />

      <p className="why">{explain(h)}</p>

      <dl className="metrics">
        <div>
          <dt>Темп.</dt>
          <dd>{num(h.temp)}°</dd>
        </div>
        <div>
          <dt>Точка росы</dt>
          <dd>{num(h.dew)}°</dd>
        </div>
        <div>
          <dt>Влажность</dt>
          <dd>{Math.round(h.rh)}%</dd>
        </div>
        <div>
          <dt>Ветер</dt>
          <dd>
            <WindArrow dir={h.windDir} /> {num(h.wind)} м/с {compass(h.windDir)}
          </dd>
        </div>
        <div>
          <dt>Облачность</dt>
          <dd>{Math.round(h.cloud)}%</dd>
        </div>
        <div>
          <dt>Видимость*</dt>
          <dd>{visibilityText(h.visibility)}</dd>
        </div>
      </dl>

      <details className="breakdown">
        <summary>Из чего сложился балл</summary>
        <ul>
          {h.factors.map((f) => (
            <li key={f.key} className={f.points > 0 ? 'pos' : f.points < 0 ? 'neg' : 'zero'}>
              <span className="pts">{f.points > 0 ? `+${f.points}` : f.points < 0 ? `−${-f.points}` : '0'}</span>
              <span>{f.label}</span>
            </li>
          ))}
        </ul>
        <p className="fine">* Видимость — модельная оценка Open-Meteo, в балл не входит.</p>
      </details>
    </section>
  );
}

function Scale({ score }: { score: number }) {
  return (
    <div className="scale" aria-hidden>
      <div className="scale-seg lvl-low" style={{ flexBasis: '30%' }} />
      <div className="scale-seg lvl-moderate" style={{ flexBasis: '25%' }} />
      <div className="scale-seg lvl-high" style={{ flexBasis: '20%' }} />
      <div className="scale-seg lvl-veryHigh" style={{ flexBasis: '25%' }} />
      <div className="scale-mark" style={{ left: `${score}%` }} />
    </div>
  );
}

/** Стрелка показывает, куда дует ветер (направление в данных — откуда) */
export function WindArrow({ dir }: { dir: number }) {
  return (
    <svg className="wind-arrow" viewBox="0 0 12 12" width="12" height="12" style={{ transform: `rotate(${dir + 180}deg)` }} aria-hidden>
      <path d="M6 1 L9.5 10 L6 8 L2.5 10 Z" fill="currentColor" />
    </svg>
  );
}
