import { ALERT_P, BASE_RATE, LEVEL_LABEL, TYPE_HINT, TYPE_LABEL, compass, disagrees, explain, num, pct, type HourScore } from '../lib/predict';
import { MODEL_LABEL } from '../lib/api';
import { hhmm, relDay, visibilityText } from '../format';

interface Props {
  h: HourScore;
  current: boolean;
  past: boolean;
  today: string;
  onBack: () => void;
}

/** «в 8 раз выше обычного» — без этого маленький процент читается как «тумана не будет» */
export function ratioText(ratio: number): string {
  if (ratio < 0.7) return 'реже обычного';
  if (ratio < 1.5) return 'как обычно в это время года';
  const r = Math.round(ratio);
  const mod10 = r % 10;
  const mod100 = r % 100;
  const word = mod10 === 1 && mod100 !== 11 ? 'раз' : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 'раза' : 'раз';
  return `в ${r} ${word} выше обычного`;
}

export function Hero({ h, current, past, today, onBack }: Props) {
  const typeText = h.type !== 'none' ? `${TYPE_LABEL[h.type]} туман` : h.level === 'low' ? 'туман маловероятен' : 'тип не выражен';

  return (
    <section className={`hero lvl-${h.level}`} aria-live="polite">
      <div className="hero-when">
        <span>
          {current ? `Сейчас · ${hhmm(h.time)}` : `${past ? 'было ' : ''}${relDay(h.time, today)}, ${hhmm(h.time)}`}
        </span>
        {!current && (
          <button className="link" onClick={onBack}>
            ← к текущему часу
          </button>
        )}
      </div>

      <div className="hero-main">
        <div className="pct" aria-label={`Вероятность тумана ${pct(h.p)} процентов`}>
          <span className="pct-n">{pct(h.p)}</span>
          <span className="pct-u">%</span>
        </div>
        <div className="hero-side">
          <div className="level">{LEVEL_LABEL[h.level]}</div>
          {h.nowcast && <div className="nowcast-tag">уточнено фактом станции</div>}
          <div className="ratio">{ratioText(h.ratio)}</div>
          <div className="type">{typeText}</div>
          {h.type !== 'none' && <div className="type-hint">{TYPE_HINT[h.type]}</div>}
        </div>
      </div>

      <Scale p={h.p} />

      <p className="why">{explain(h)}</p>

      {disagrees(h) && (
        <p className="disagree">
          Модели погоды расходятся: от {pct(h.pMin)}% до {pct(h.pMax)}%. Туман локален, и часть моделей его не видит —
          показано среднее.
        </p>
      )}

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
        <summary>Что повлияло на оценку</summary>
        <ul>
          {h.contributions.map((c) => (
            <li key={c.group} className={c.value > 0 ? 'pos' : 'neg'}>
              <span className="pts">{c.value > 0 ? '↑' : '↓'}</span>
              <span>{c.text}</span>
            </li>
          ))}
        </ul>
        {h.members.length > 1 && (
          <ul className="members">
            {h.members.map((m) => (
              <li key={m.model}>
                <span className="member-name">{MODEL_LABEL[m.model]}</span>
                <span className="member-bar">
                  <span style={{ width: `${Math.max(100 * scalePos(m.p), 1)}%` }} />
                </span>
                <span className="member-p">{pct(m.p)}%</span>
              </li>
            ))}
          </ul>
        )}
        <p className="fine">
          * Видимость — самая низкая из моделей, в расчёт не входит. Вероятность считает модель, обученная на
          наблюдениях Пулково; обычная частота тумана там — {pct(BASE_RATE)}% часов, тревога начинается с {Math.round(ALERT_P * 100)}%.
        </p>
      </details>
    </section>
  );
}

/** Шкала логарифмическая: иначе всё интересное сжато у нуля */
export const scalePos = (p: number) => Math.min(1, Math.max(0, Math.log10(Math.max(p, 0.001) / 0.001) / Math.log10(0.35 / 0.001)));

function Scale({ p }: { p: number }) {
  return (
    <div className="scale" aria-hidden>
      <div className="scale-seg lvl-low" style={{ flexBasis: `${100 * scalePos(0.01)}%` }} />
      <div className="scale-seg lvl-moderate" style={{ flexBasis: `${100 * (scalePos(0.03) - scalePos(0.01))}%` }} />
      <div className="scale-seg lvl-high" style={{ flexBasis: `${100 * (scalePos(ALERT_P) - scalePos(0.03))}%` }} />
      <div className="scale-seg lvl-veryHigh" style={{ flexBasis: `${100 * (1 - scalePos(ALERT_P))}%` }} />
      <div className="scale-mark" style={{ left: `${100 * scalePos(p)}%` }} />
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
