import { useEffect, useState } from 'react';
import { ALERT_P } from '../lib/predict';
import { PUSH_SERVER } from '../lib/push';

interface Row {
  source: 'multi' | 'ens';
  lead: number;
  n: number;
  hit: number;
  miss: number;
  falseAlarm: number;
}

interface Stats {
  since: string;
  hours: number;
  fogHours: number;
  rows: Row[];
}

const SOURCE_LABEL: Record<Row['source'], string> = {
  multi: 'шесть моделей',
  ens: 'ансамбль прогонов',
};

/**
 * Как прогноз сбывался на самом деле. Считается по станции Пулково: только там
 * есть чем проверять. Сервер пишет журнал каждый час, поэтому первые
 * осмысленные числа появляются через несколько дней.
 */
export function TrackRecord() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!PUSH_SERVER) return;
    fetch(`${PUSH_SERVER}/stats?days=30&threshold=${ALERT_P}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(setStats)
      .catch(() => setFailed(true));
  }, []);

  if (!PUSH_SERVER || failed || !stats) return null;

  const main = stats.rows.filter((r) => r.source === 'multi').sort((a, b) => a.lead - b.lead);
  const ens = stats.rows.filter((r) => r.source === 'ens' && r.n >= 100);
  if (!main.length) {
    return (
      <section className="panel">
        <h2>Как сбывалось</h2>
        <p className="muted">
          Журнал только начат: записано {stats.hours} ч наблюдений. Первые выводы появятся, когда накопятся прогнозы и
          факты за одни и те же часы.
        </p>
      </section>
    );
  }

  return (
    <section className="panel">
      <h2>Как сбывалось</h2>
      <p className="muted">
        За последние 30 дней в Пулково: {stats.hours} ч с наблюдениями, из них с туманом {stats.fogHours}.
      </p>
      <table className="record">
        <thead>
          <tr>
            <th>заранее</th>
            <th>предупреждений</th>
            <th>сбылось</th>
            <th>пропущено</th>
          </tr>
        </thead>
        <tbody>
          {main.map((r) => {
            const warned = r.hit + r.falseAlarm;
            return (
              <tr key={r.lead}>
                <td>за {r.lead} ч</td>
                <td>{warned}</td>
                <td>
                  {r.hit}
                  {warned > 0 && <span className="muted"> ({Math.round((100 * r.hit) / warned)}%)</span>}
                </td>
                <td>{r.miss}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {ens.length > 0 && (
        <p className="fine">
          Параллельно записывается прогноз по ансамблю из 40 прогонов одной модели ({SOURCE_LABEL.ens}):{' '}
          {ens.map((r) => `за ${r.lead} ч — ${r.hit} из ${r.hit + r.falseAlarm}`).join(', ')}. Когда данных хватит, станет
          видно, стоит ли на него переходить.
        </p>
      )}
      <p className="fine">
        Это история самого приложения, а не оценка по учебнику: сервер записывает прогноз заранее и сверяет его с
        измерениями аэропорта.
      </p>
    </section>
  );
}
