import { useCallback, useEffect, useReducer, useRef } from 'react';

const WINDOW_MS = 1000;
const KEEP_CHARS = 1600;
const KEEP_REQUESTS = 6;
const W = 1000;
const H = 180;

const blank = (recent, ratio = 1) => ({ test: '', message: '', startAt: null, firstAt: null, endAt: null, times: [], segments: [], chars: 0, state: 'idle', result: null, recent, ratio });

// Keeps the newest request in a mutable record and repaints on a timer, so a fast stream never costs a render per token.
export function useLive(running) {
  const ref = useRef(blank([]));
  const [, repaint] = useReducer(count => count + 1, 0);

  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(repaint, 100);
    return () => clearInterval(timer);
  }, [running]);

  const onStream = useCallback(event => {
    const live = ref.current;
    if (event.type === 'start') {
      ref.current = { ...blank(live.recent, live.ratio), test: event.test, message: event.message, startAt: event.at, state: 'waiting' };
      return;
    }
    if (event.type === 'delta') {
      live.firstAt ??= event.at;
      live.state = 'streaming';
      live.times.push(event.at - live.startAt);
      const last = live.segments.at(-1);
      if (last?.kind === event.kind) last.text += event.text;
      else live.segments.push({ kind: event.kind, text: event.text });
      live.chars += event.text.length;
      while (live.chars > KEEP_CHARS && live.segments.length) {
        const excess = live.chars - KEEP_CHARS;
        const first = live.segments[0];
        if (first.text.length <= excess) { live.chars -= first.text.length; live.segments.shift(); } else { first.text = first.text.slice(excess); live.chars -= excess; }
      }
      return;
    }
    live.endAt = event.at;
    live.state = event.ok ? 'done' : 'failed';
    const tokens = event.tokens ?? live.times.length;
    const seconds = live.firstAt == null ? 0 : (event.at - live.firstAt) / 1000;
    live.result = {
      label: `${live.test}: ${live.message}`, ok: event.ok, error: event.error, tokens,
      ttft: live.firstAt == null ? null : live.firstAt - live.startAt,
      tps: seconds > 0 && tokens > 1 ? tokens / seconds : null,
      input: event.promptTokens, inputTps: event.promptTokens && live.firstAt != null ? event.promptTokens / ((live.firstAt - live.startAt) / 1000) : null,
    };
    live.recent = [live.result, ...live.recent].slice(0, KEEP_REQUESTS);
    // Servers may put several tokens in one chunk; the last exact count calibrates the live estimate.
    if (event.ok && tokens > 1 && live.times.length > 0) live.ratio = tokens / live.times.length;
  }, []);

  const reset = useCallback(() => { ref.current = blank([]); }, []);

  return { live: ref, onStream, reset };
}

// Tokens per second over a sliding one-second window, sampled along the request.
function curve(times, end, ratio) {
  if (times.length < 2) return [];
  const step = Math.max(250, Math.ceil(end / 240 / 50) * 50);
  const points = [];
  let lo = 0;
  let hi = 0;
  for (let t = step; t < end + step; t += step) {
    while (hi < times.length && times[hi] <= t) hi += 1;
    const from = Math.max(0, t - WINDOW_MS);
    while (lo < hi && times[lo] <= from) lo += 1;
    points.push([Math.min(t, end), ratio * (hi - lo) / ((Math.min(t, end) - from) / 1000)]);
  }
  return points;
}

const niceMax = value => {
  const power = 10 ** Math.floor(Math.log10(Math.max(value, 1)));
  return [1, 2, 5, 10].map(step => step * power).find(step => step >= value) ?? value;
};

function Curve({ points, end }) {
  const top = niceMax(Math.max(...points.map(point => point[1]), 1));
  const x = ms => (ms / Math.max(end, 1)) * W;
  const y = value => H - (value / top) * (H - 8) - 1;
  const line = points.map(([ms, value]) => `${x(ms).toFixed(1)},${y(value).toFixed(1)}`).join(' ');
  return (
    <svg className="live-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Tokens per second over the request">
      <line className="grid" x1="0" x2={W} y1={y(top)} y2={y(top)} />
      <line className="grid" x1="0" x2={W} y1={y(top / 2)} y2={y(top / 2)} />
      {points.length > 1 && <polygon className="area" points={`0,${H} ${line} ${W},${H}`} />}
      <polyline className="line" points={line} />
      <text className="tick" x="4" y="12">{top} tok/s</text>
      <text className="tick" x={W - 4} y={H - 6} textAnchor="end">{(end / 1000).toFixed(1)} s</text>
    </svg>
  );
}

const fmt = (value, digits = 1) => (value == null || !Number.isFinite(value) ? '—' : Number(value).toLocaleString('en', { maximumFractionDigits: digits }));
const seconds = ms => `${(ms / 1000).toFixed(1)} s`;

export function LivePanel({ live }) {
  const data = live.current;
  if (data.state === 'idle') return <section className="live" aria-label="Live request"><p className="muted">Waiting for the first request…</p></section>;
  const active = data.state === 'waiting' || data.state === 'streaming';
  const now = active ? performance.now() - data.startAt : (data.endAt ?? 0) - data.startAt;
  const points = curve(data.times, Math.max(now, 1), data.ratio);
  const lastSecond = data.times.filter(time => time > now - WINDOW_MS).length * data.ratio;
  const speed = data.state === 'streaming' ? lastSecond / Math.min(WINDOW_MS, Math.max(now, 1)) * 1000 : data.result?.tps ?? null;
  const ttft = data.firstAt == null ? null : data.firstAt - data.startAt;
  const tokens = data.result?.tokens ?? Math.round(data.times.length * data.ratio);

  return (
    <section className="live" aria-label="Live request">
      <header>
        <b>{data.test}</b><span>{data.message}</span>
        <em className={data.state === 'failed' ? 'bad' : active ? 'warn' : 'good'}>{data.state === 'waiting' ? 'waiting for the first token' : data.state}</em>
      </header>
      <dl className="stats">
        <div><dd>{fmt(speed)}</dd><dt>{active ? 'tok/s now ≈' : 'tok/s'}</dt></div>
        <div><dd>{ttft == null ? (active ? seconds(now) : '—') : seconds(ttft)}</dd><dt>{ttft == null && active ? 'waiting' : 'to first token'}</dt></div>
        <div><dd>{fmt(tokens, 0)}{data.result ? '' : '≈'}</dd><dt>{data.result ? 'output tokens' : 'tokens so far'}</dt></div>
        <div><dd>{seconds(now)}</dd><dt>elapsed</dt></div>
      </dl>
      <Curve points={points} end={Math.max(now, 1000)} />
      <Snapshot segments={data.segments} />
      {data.recent.length > 0 && (
        <ol className="recent" aria-label="Recent requests">
          {data.recent.map((item, index) => (
            <li key={`${item.label}-${index}`} className={item.ok ? '' : 'bad'}>
              <span>{item.label}</span>
              <span>{item.ok ? `${fmt(item.tps)} tok/s` : item.error}</span>
              <span>{item.ttft == null ? '—' : `${fmt(item.ttft, 0)} ms`}</span>
              <span>{item.input ? `${fmt(item.input, 0)} in` : ''}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Snapshot({ segments }) {
  const box = useRef(null);
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; });
  return (
    <pre className="snapshot" ref={box} aria-label="Streamed output">
      {segments.length === 0 ? <span className="muted">No output yet.</span> : segments.map((segment, index) => <span key={index} className={segment.kind === 'reasoning' ? 'thought' : ''}>{segment.text}</span>)}
    </pre>
  );
}
