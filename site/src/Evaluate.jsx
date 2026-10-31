import { useEffect, useMemo, useRef, useState } from 'react';
import definitionText from '../../evaluations/endpoint-bench/evaluation.json?raw';
import { newCompat, normalizeBase } from '../../evaluations/endpoint-bench/src/client.js';
import { TESTS, validateConfig } from '../../evaluations/endpoint-bench/src/config.js';
import { loadModels } from '../../evaluations/endpoint-bench/src/models.js';
import { runEvaluation } from '../../evaluations/endpoint-bench/src/run.js';
import { sha256Hex } from '../../evaluations/endpoint-bench/src/util.js';
import { LivePanel, useLive } from './Live.jsx';

const definition = JSON.parse(definitionText);
const STORAGE = 'endpoint-bench-form';
const HINTS = {
  conform: 'API behavior', speed: 'Output tok/s', thinking: 'Reasoning accuracy', decode: 'Tok/s by length',
  prefill: 'Long-prompt tok/s', needle: 'Recall by depth', cache: 'Prompt cache',
};
const INITIAL = { endpoint: '', model: '', tests: TESTS, profile: 'full' };

const fmt = (value, digits = 1) => (value == null ? '—' : Number(value).toLocaleString('en', { maximumFractionDigits: digits }));
const pct = value => (value == null ? '—' : `${(value * 100).toFixed(0)}%`);
const change = reduction => (reduction == null ? '—' : `${reduction > 0 ? '−' : reduction < 0 ? '+' : ''}${fmt(Math.abs(reduction))}%`);
const ms = value => (value == null ? '—' : value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`);

const download = (name, text) => {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
};

const reach = message => (/failed to fetch|networkerror|load failed/i.test(message)
  ? 'The browser could not reach the endpoint. It must allow cross-origin requests (CORS), and Safari blocks an http endpoint from an https page.' : message);

function Table({ head, rows }) {
  return (
    <div className="tablewrap">
      <table>
        <thead><tr>{head.map(label => <th key={label}>{label}</th>)}</tr></thead>
        <tbody>{rows.map(row => <tr key={row[0]}>{row.map((cell, index) => <td key={index}>{cell}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

const SUMMARIES = {
  conform: test => {
    const failed = test.checks.filter(check => check.status !== 'pass');
    return (
      <>
        <p>{test.checks.length - failed.length} of {test.checks.length} checks passed. {test.required_passed ? 'Every required check passed.' : 'A required check failed.'}</p>
        {failed.length > 0 && <ul className="problems">{failed.map(check => <li key={check.id}>{check.required ? 'Required' : 'Optional'}: {check.title}. {check.detail}</li>)}</ul>}
      </>
    );
  },
  speed: test => (
    <dl className="stats">
      <div><dd>{fmt(test.summary.tokens_per_second_p50)}</dd><dt>tok/s p50</dt></div>
      <div><dd>{ms(test.summary.ttft_ms_p50)}</dd><dt>TTFT p50</dt></div>
      <div><dd>{ms(test.summary.e2e_ms_p50)}</dd><dt>Latency p50</dt></div>
    </dl>
  ),
  thinking: test => (
    <Table
      head={['Variant', 'Accuracy', 'Format', 'TTFT p50', 'Latency p50', 'Reasoning tok', 'Answer tok']}
      rows={Object.entries(test.variants).map(([name, variant]) => [name, `${pct(variant.summary.accuracy)} (${variant.summary.correct}/${variant.summary.attempted})`, pct(variant.summary.format_compliance), ms(variant.summary.ttft_ms_p50), ms(variant.summary.e2e_ms_p50), fmt(variant.summary.reasoning_tokens_p50, 0), fmt(variant.summary.answer_tokens_p50, 0)])}
    />
  ),
  decode: test => (
    <Table
      head={['Output tokens', 'Decode tok/s p50', 'p90', 'TTFT p50', 'Latency p50']}
      rows={test.lengths.map(item => [item.output_tokens, fmt(item.summary.decode_tokens_per_second_p50), fmt(item.summary.decode_tokens_per_second_p90), ms(item.summary.ttft_ms_p50), ms(item.summary.total_latency_ms_p50)])}
    />
  ),
  prefill: test => (
    <Table
      head={['Input tokens', 'Input tok/s p50', 'TTFT p50', 'Recall']}
      rows={test.sizes.map(item => [fmt(item.input_tokens, 0), item.status === 'skipped' ? 'skipped' : fmt(item.summary.input_tokens_per_second_p50, 0), ms(item.summary.ttft_ms_p50), item.status === 'skipped' ? '—' : pct(item.summary.accuracy)])}
    />
  ),
  needle: test => (
    <>
      <p>{pct(test.summary.accuracy)} recall ({test.summary.correct}/{test.summary.attempted}) in a {fmt(test.config.input_tokens, 0)}-token document.</p>
      <Table
        head={['Depth', 'Recall', 'TTFT p50', 'Input tok/s p50']}
        rows={test.positions.map(item => [`${item.percent}%`, pct(item.summary.accuracy), ms(item.summary.ttft_ms_p50), fmt(item.summary.input_tokens_per_second_p50, 0)])}
      />
    </>
  ),
  cache: test => (
    <Table
      head={['Prompt', 'Cache hit', 'Cold TTFT', 'Warm TTFT p50', 'TTFT change']}
      rows={Object.entries(test.variants).map(([name, variant]) => [name, variant.summary.cache_reported ? `${fmt(variant.summary.cache_hit_pct)}%` : 'not reported', ms(variant.summary.cold_ttft_ms), ms(variant.summary.warm_ttft_ms_p50), change(variant.summary.ttft_reduction_pct)])}
    />
  ),
};

function Result({ name, test }) {
  const ready = ['complete', 'partial'].includes(test.status) || (name === 'prefill' && test.status === 'skipped');
  return (
    <section className="result">
      <h3><u className={test.status === 'complete' ? 'good' : test.status === 'partial' ? 'warn' : 'bad'} />{name}<span>{test.status}</span></h3>
      {ready ? SUMMARIES[name](test) : <p className="muted">{test.error ?? 'No measurements.'}</p>}
    </section>
  );
}

export default function Evaluate() {
  const [form, setForm] = useState(() => {
    try { return { ...INITIAL, ...JSON.parse(localStorage.getItem(STORAGE) ?? '{}') }; } catch { return INITIAL; }
  });
  const [token, setToken] = useState('');
  const [models, setModels] = useState({ status: 'idle', list: [], message: '' });
  const [pin, setPin] = useState(null);
  const [status, setStatus] = useState('idle');
  const [progress, setProgress] = useState(null);
  const [message, setMessage] = useState('');
  const [result, setResult] = useState(null);
  const controller = useRef(null);

  useEffect(() => {
    sha256Hex(definitionText).then(sha256 => setPin({ id: definition.evaluation_id, revision: __EVALUATION_REVISION__, sha256, dirty: __EVALUATION_DIRTY__ }));
  }, []);
  useEffect(() => { localStorage.setItem(STORAGE, JSON.stringify(form)); }, [form]);

  const config = useMemo(() => ({ endpoint: form.endpoint.trim(), apiKey: token, model: form.model, tests: form.tests, profile: form.profile }), [form, token]);
  const problems = useMemo(() => validateConfig(config), [config]);
  const running = status === 'running';
  const live = useLive(running);
  const patch = changes => setForm(current => ({ ...current, ...changes }));
  const toggle = test => patch({ tests: form.tests.includes(test) ? form.tests.filter(item => item !== test) : TESTS.filter(item => item === test || form.tests.includes(item)) });

  const load = async () => {
    setModels({ status: 'loading', list: [], message: '' });
    try {
      const env = { fetch: (...args) => fetch(...args), now: () => performance.now(), base: normalizeBase(form.endpoint), apiKey: token.trim(), compat: newCompat() };
      const loaded = await loadModels(env);
      if (!loaded.ok) throw new Error(loaded.error);
      setModels({ status: 'ready', list: loaded.models, message: '' });
      if (!loaded.models.some(model => model.id === form.model)) patch({ model: loaded.models[0]?.id ?? '' });
    } catch (error) {
      setModels({ status: 'error', list: [], message: reach(String(error.message ?? error)) });
    }
  };

  const start = async () => {
    controller.current = new AbortController();
    setStatus('running');
    setResult(null);
    setMessage('');
    live.reset();
    try {
      setResult(await runEvaluation({ config, definition, pin, signal: controller.current.signal, onProgress: setProgress, onStream: live.onStream }));
      setStatus('done');
    } catch (error) {
      setStatus('failed');
      setMessage(reach(String(error.message ?? error)));
    }
  };

  const report = result?.report;
  const text = report ? `${JSON.stringify(report, null, 2)}\n` : '';

  return (
    <main className="band evaluate">
      <header className="evhead">
        <h1>Evaluate</h1>
        <p className="muted">Point it at an OpenAI-compatible endpoint. Everything runs in this browser.</p>
        <p className="pin" title="The evaluator build must equal the experiment's pinned evaluation revision and hash.">
          <span>Revision {pin ? pin.revision.slice(0, 12) : '…'}</span>
          <span>Definition {pin ? pin.sha256.slice(0, 12) : '…'}</span>
          {pin?.dirty && <span className="warn">Uncommitted changes</span>}
        </p>
      </header>

      <form className="connect" onSubmit={event => { event.preventDefault(); if (!running) load(); }}>
        <label className="field wide"><span>Endpoint URL</span>
          <input value={form.endpoint} onChange={event => patch({ endpoint: event.target.value })} placeholder="http://127.0.0.1:8080/v1" autoComplete="off" disabled={running} />
        </label>
        <label className="field"><span>Token (optional, never saved or exported)</span>
          <input type="password" value={token} onChange={event => setToken(event.target.value)} autoComplete="off" disabled={running} />
        </label>
        <button type="submit" className="ghost" disabled={running || models.status === 'loading' || !form.endpoint.trim()}>Load models</button>
        <label className="field"><span>Model</span>
          {models.list.length > 0
            ? <select value={form.model} onChange={event => patch({ model: event.target.value })} disabled={running}>{models.list.map(model => <option key={model.id} value={model.id}>{model.id}</option>)}</select>
            : <input value={form.model} onChange={event => patch({ model: event.target.value })} autoComplete="off" disabled={running} />}
        </label>
        {models.status === 'error' && <p className="problems wide">{models.message}</p>}
      </form>

      <div className="picks">
        <div className="chips" role="group" aria-label="Tests">
          {TESTS.map(test => (
            <button key={test} type="button" aria-pressed={form.tests.includes(test)} disabled={running} onClick={() => toggle(test)}>
              <b>{test}</b><small>{HINTS[test]}</small>
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Profile">
          {[['full', 'Full'], ['quick', 'Quick']].map(([key, label]) => (
            <button key={key} type="button" aria-selected={form.profile === key} disabled={running} onClick={() => patch({ profile: key })}>{label}</button>
          ))}
        </div>
      </div>

      {running && <LivePanel live={live.live} />}

      <section className="runbar" aria-label="Run">
        {running
          ? <button type="button" className="primary" onClick={() => controller.current.abort()}>Stop</button>
          : <button type="button" className="primary" disabled={problems.length > 0 || !pin} onClick={start}>Run evaluation</button>}
        <span role="status" className="muted">
          {running ? `${progress?.test ?? ''}${progress?.message ? `: ${progress.message}` : ''}${progress?.total > 1 ? ` (${progress.done}/${progress.total})` : ''}` : message || (problems.length ? problems[0] : 'Ready')}
        </span>
        {running && progress?.total > 0 && <progress value={progress.done} max={progress.total} />}
      </section>

      {report && (
        <section className="report" aria-label="Report">
          <p className={report.status === 'complete' ? 'good' : 'warn'}>
            Report {report.status} · {report.model} · {report.profile} profile · context window {fmt(report.context_window.tokens, 0)} tokens ({report.context_window.source === 'assumed' ? 'assumed, the endpoint did not report it' : 'reported by the endpoint'})
          </p>
          {report.failures.length > 0 && <ul className="problems">{report.failures.map(failure => <li key={failure}>{failure}</li>)}</ul>}
          {report.selected_tests.map(name => <Result key={name} name={name} test={report.tests[name]} />)}
          <div className="actions">
            <button type="button" className="primary" onClick={() => download(result.fileName, text)}>Download report</button>
            <button type="button" className="ghost" onClick={() => navigator.clipboard.writeText(text)}>Copy report</button>
          </div>
          <p className="muted">Commit it as experiments/&lt;experiment-id&gt;/evaluation/&lt;candidate or baseline name&gt;/{result.fileName}.</p>
          <details><summary>Report JSON</summary><pre>{text}</pre></details>
        </section>
      )}
    </main>
  );
}
