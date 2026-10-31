import { useState } from 'react';
import { GROUPS, METRICS, conformance, formatValue, frontier, lineageRoots, trendSeries } from './lib/model.js';

const PALETTE = ['#2f5bea', '#e0701f', '#14a36b', '#b5469b', '#d9a300', '#3aa7d9', '#7a5195', '#8a8f98'];
const SHAPES = ['circle', 'square', 'triangle', 'diamond'];
const DAY = 86400000;
const W = 960;
const H = 360;
const M = { left: 52, right: 12, top: 12, bottom: 30 };

function niceTicks(max, count = 5) {
  const raw = max / count || 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normal = raw / magnitude;
  const step = (normal <= 1 ? 1 : normal <= 2 ? 2 : normal <= 5 ? 5 : 10) * magnitude;
  const ticks = [];
  for (let value = 0; value < max + step * 0.999; value += step) ticks.push(Number(value.toPrecision(12)));
  return ticks;
}

function Marker({ shape, x, y, size = 4.2, ...rest }) {
  if (shape === 'square') return <rect x={x - size} y={y - size} width={size * 2} height={size * 2} {...rest} />;
  if (shape === 'triangle') return <path d={`M${x} ${y - size * 1.2}L${x + size * 1.15} ${y + size * 0.85}L${x - size * 1.15} ${y + size * 0.85}Z`} {...rest} />;
  if (shape === 'diamond') return <path d={`M${x} ${y - size * 1.3}L${x + size * 1.3} ${y}L${x} ${y + size * 1.3}L${x - size * 1.3} ${y}Z`} {...rest} />;
  return <circle cx={x} cy={y} r={size} {...rest} />;
}

const month = ms => new Date(ms).toLocaleDateString('en', { month: 'short', year: 'numeric', timeZone: 'UTC' });

export function Trends({ runs, filtered, state, patch }) {
  const [hidden, setHidden] = useState(() => new Set());
  const spec = METRICS[state.metric];
  const { series, hidden: more } = trendSeries(filtered, { metric: state.metric, groupBy: state.groupBy, roots: lineageRoots(runs) });
  const styled = series.map((item, index) => ({ ...item, color: PALETTE[index % PALETTE.length], shape: SHAPES[index % SHAPES.length] }));
  const visible = styled.filter(item => !hidden.has(item.label));
  const best = state.frontier ? frontier(filtered, state.metric) : [];
  const points = [...visible.flatMap(item => item.points), ...best];
  const toggle = label => setHidden(current => { const next = new Set(current); if (next.has(label)) next.delete(label); else next.add(label); return next; });

  let chart = <p className="empty">No runs to plot.</p>;
  if (points.length) {
    const xMin = Math.min(...points.map(p => p.t)) - DAY * 3;
    const xMax = Math.max(...points.map(p => p.t)) + DAY * 3;
    const ticks = niceTicks(Math.max(...points.map(p => p.value)) * 1.06);
    const x = t => M.left + ((t - xMin) / (xMax - xMin)) * (W - M.left - M.right);
    const y = value => H - M.bottom - (value / ticks.at(-1)) * (H - M.top - M.bottom);
    const months = [];
    const first = new Date(xMin);
    for (let at = Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1); at < xMax; at = Date.UTC(new Date(at).getUTCFullYear(), new Date(at).getUTCMonth() + 1, 1)) months.push(at);
    const steps = best.map((p, i) => (i ? `H${x(p.t)}V${y(p.value)}` : `M${x(p.t)} ${y(p.value)}`)).join('');
    const connect = ['lineage', 'engine'].includes(state.groupBy);
    chart = (
      <svg viewBox={`0 0 ${W} ${H}`} role="img" className="chart" aria-label={`${spec.label} over time`}>
        {ticks.map(tick => (
          <g key={tick}>
            <line x1={M.left} x2={W - M.right} y1={y(tick)} y2={y(tick)} className="grid" />
            <text x={M.left - 8} y={y(tick) + 4} textAnchor="end" className="tick">{Number(tick).toFixed(spec.digits)}</text>
          </g>
        ))}
        {months.map(at => <text key={at} x={x(at)} y={H - 10} textAnchor="middle" className="tick">{month(at)}</text>)}
        {best.length > 0 && <path d={`${steps}H${x(xMax)}`} className="frontier" />}
        {connect && visible.map(item => (
          <polyline key={item.label} points={item.points.map(p => `${x(p.t)},${y(p.value)}`).join(' ')} fill="none" stroke={item.color} strokeWidth="1.5" opacity="0.5" />
        ))}
        {visible.flatMap(item => item.points.map(point => {
          const failed = conformance(point.run) === 'failed';
          return (
            <Marker key={point.run.entry_id} shape={item.shape} x={x(point.t)} y={y(point.value)} className="pt"
              fill={failed ? 'var(--surface)' : item.color} stroke={item.color} strokeWidth={failed ? 1.8 : 1}>
              <title>{`${point.run.entry_id} · ${point.run.date}\n${item.label}\n${formatValue(state.metric, point.value)}`}</title>
            </Marker>
          );
        }))}
      </svg>
    );
  }

  return (
    <div className="trends">
      <div className="controls sub">
        <label className="select">
          <span>Group</span>
          <select value={state.groupBy} onChange={event => patch({ groupBy: event.target.value })}>
            {Object.entries(GROUPS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={state.frontier} onChange={event => patch({ frontier: event.target.checked })} />
          Best so far
        </label>
      </div>
      <div className="card">{chart}</div>
      <ul className="legend">
        {styled.map(item => (
          <li key={item.label}>
            <button type="button" aria-pressed={!hidden.has(item.label)} onClick={() => toggle(item.label)}>
              <svg viewBox="0 0 14 14" aria-hidden="true"><Marker shape={item.shape} x={7} y={7} size={4.5} fill={item.color} /></svg>
              {item.label} <span>{item.points.length}</span>
            </button>
          </li>
        ))}
        {more > 0 && <li className="muted">+{more} smaller groups</li>}
      </ul>
    </div>
  );
}
