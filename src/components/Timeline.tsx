import { Fragment, useEffect, useRef } from 'react';
import { HIGH, TYPE_LABEL, type HourScore } from '../lib/fog';
import { hhmm, weekdayShort } from '../format';

interface Props {
  hours: HourScore[];
  selected: number;
  onSelect: (i: number) => void;
}

export function Timeline({ hours, selected, onSelect }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // Держим выбранный столбик в зоне видимости
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>('.bar.sel');
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [selected]);

  return (
    <div className="strip-wrap" ref={ref}>
      <div className="strip" role="listbox" aria-label="Вероятность тумана по часам">
        <div className="strip-line" style={{ bottom: `calc(var(--label-h) + var(--bar-h) * ${HIGH / 100})` }}>
          <span>высокая</span>
        </div>
        {hours.map((h, i) => (
          <Fragment key={h.time}>
            {i > 0 && h.hourOfDay === 0 && (
              <div className="strip-day" aria-hidden>
                <span>{weekdayShort(h.time)}</span>
              </div>
            )}
            <button
              role="option"
              aria-selected={i === selected}
              className={`bar lvl-${h.level}${i === selected ? ' sel' : ''}`}
              onClick={() => onSelect(i)}
              aria-label={`${hhmm(h.time)}: ${h.score}%${h.type !== 'none' ? `, ${TYPE_LABEL[h.type]}` : ''}`}
            >
              <span className="bar-track">
                <span className="bar-fill" style={{ height: `${Math.max(h.score, 3)}%` }} />
              </span>
              <span className="bar-h">{i === 0 ? 'сейч' : h.hourOfDay % 3 === 0 ? String(h.hourOfDay).padStart(2, '0') : ''}</span>
            </button>
          </Fragment>
        ))}
      </div>
    </div>
  );
}
