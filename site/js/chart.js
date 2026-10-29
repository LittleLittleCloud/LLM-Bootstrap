// Dependency-free SVG line chart for the trend dashboard.
const NS = 'http://www.w3.org/2000/svg';

export const PALETTE = ['#0072B2', '#D55E00', '#009E73', '#CC79A7', '#E69F00', '#56B4E9', '#7A5195', '#8a8a8a'];
export const SHAPES = ['circle', 'square', 'triangle', 'diamond'];

const el = (tag, attrs = {}, ...children) => {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  node.append(...children);
  return node;
};

export function styleFor(index) {
  return { color: PALETTE[index % PALETTE.length], shape: SHAPES[index % SHAPES.length] };
}

export function marker(shape, x, y, size, attrs) {
  if (shape === 'square') return el('rect', { x: x - size, y: y - size, width: size * 2, height: size * 2, ...attrs });
  if (shape === 'triangle') return el('path', { d: `M${x} ${y - size * 1.2}L${x + size * 1.15} ${y + size * 0.85}L${x - size * 1.15} ${y + size * 0.85}Z`, ...attrs });
  if (shape === 'diamond') return el('path', { d: `M${x} ${y - size * 1.3}L${x + size * 1.3} ${y}L${x} ${y + size * 1.3}L${x - size * 1.3} ${y}Z`, ...attrs });
  return el('circle', { cx: x, cy: y, r: size, ...attrs });
}

function niceTicks(max, count = 5) {
  const raw = max / count || 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normal = raw / magnitude;
  const step = (normal <= 1 ? 1 : normal <= 2 ? 2 : normal <= 5 ? 5 : 10) * magnitude;
  const ticks = [];
  for (let value = 0; value < max + step * 0.999; value += step) ticks.push(Number(value.toPrecision(12)));
  return ticks;
}

const month = ms => new Date(ms).toLocaleDateString('en', { month: 'short', year: 'numeric', timeZone: 'UTC' });

// series: [{ label, color, shape, points: [{ t, value, run }] }]; frontier: [{ t, value }]. Failed runs draw hollow.
export function lineChart({ series, frontier = [], connect = true, format, formatPoint = format, describe, onSelect, width = 920, height = 380 }) {
  const margin = { left: 58, right: 18, top: 14, bottom: 34 };
  const points = [...series.flatMap(item => item.points), ...frontier];
  if (!points.length) return null;
  const day = 86400000;
  const xMin = Math.min(...points.map(p => p.t)) - day * 3;
  const xMax = Math.max(...points.map(p => p.t)) + day * 3;
  const ticks = niceTicks(Math.max(...points.map(p => p.value)) * 1.06);
  const yMax = ticks.at(-1);
  const x = t => margin.left + ((t - xMin) / (xMax - xMin)) * (width - margin.left - margin.right);
  const y = value => height - margin.bottom - (value / yMax) * (height - margin.top - margin.bottom);

  const root = el('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', class: 'chart', 'aria-label': describe });
  for (const tick of ticks) {
    root.append(el('line', { x1: margin.left, x2: width - margin.right, y1: y(tick), y2: y(tick), class: 'grid' }));
    const label = el('text', { x: margin.left - 8, y: y(tick) + 4, class: 'tick', 'text-anchor': 'end' });
    label.textContent = format(tick);
    root.append(label);
  }
  const first = new Date(xMin);
  for (let cursor = Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1); cursor < xMax; cursor = Date.UTC(new Date(cursor).getUTCFullYear(), new Date(cursor).getUTCMonth() + 1, 1)) {
    root.append(el('line', { x1: x(cursor), x2: x(cursor), y1: margin.top, y2: height - margin.bottom, class: 'grid vertical' }));
    const label = el('text', { x: x(cursor), y: height - 12, class: 'tick', 'text-anchor': 'middle' });
    label.textContent = month(cursor);
    root.append(label);
  }

  if (frontier.length) {
    const steps = frontier.map((p, i) => `${i ? `H${x(p.t)}V${y(p.value)}` : `M${x(p.t)} ${y(p.value)}`}`).join('');
    root.append(el('path', { d: `${steps}H${x(xMax)}`, class: 'frontier' }));
  }
  for (const item of series) {
    if (!connect) break;
    root.append(el('polyline', { points: item.points.map(p => `${x(p.t)},${y(p.value)}`).join(' '), fill: 'none', stroke: item.color, 'stroke-width': 1.6, opacity: 0.55 }));
  }
  for (const item of series) {
    for (const point of item.points) {
      const failed = point.run.quality_gate !== 'passed';
      const node = marker(item.shape, x(point.t), y(point.value), 4.2, {
        class: 'pt', fill: failed ? 'var(--surface)' : item.color, stroke: item.color, 'stroke-width': failed ? 1.8 : 1,
      });
      node.append(el('title', {}, `${point.run.run_id} · ${point.run.date}\n${item.label}\n${formatPoint(point.value)}${failed ? '\nfailed the quality gate' : ''}`));
      node.addEventListener('click', () => onSelect(point.run));
      root.append(node);
    }
  }
  return root;
}
