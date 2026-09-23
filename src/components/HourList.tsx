import { TYPE_LABEL, compass, num, type HourScore } from '../lib/fog';
import { hhmm, relDay } from '../format';
import { WindArrow } from './Hero';

interface Props {
  hours: HourScore[];
  selected: number;
  today: string;
  onSelect: (i: number) => void;
}

export function HourList({ hours, selected, today, onSelect }: Props) {
  return (
    <ol className="hours">
      {hours.map((h, i) => (
        <li key={h.time}>
          {(i === 0 || h.hourOfDay === 0) && <div className="hours-day">{relDay(h.time, today)}</div>}
          <button className={`hour lvl-${h.level}${i === selected ? ' sel' : ''}`} onClick={() => onSelect(i)}>
            <span className="hour-t">{hhmm(h.time)}</span>
            <span className="hour-bar">
              <span style={{ width: `${Math.max(h.score, 2)}%` }} />
            </span>
            <span className="hour-p">{h.score}%</span>
            <span className="hour-meta">
              <span>Δ{num(Math.max(h.spread, 0))}°</span>
              <span>
                <WindArrow dir={h.windDir} /> {num(h.wind)} {compass(h.windDir)}
              </span>
              <span>{Math.round(h.cloud)}% обл.</span>
            </span>
            {h.type !== 'none' && h.level !== 'low' && <span className="hour-type">{TYPE_LABEL[h.type]}</span>}
          </button>
        </li>
      ))}
    </ol>
  );
}
