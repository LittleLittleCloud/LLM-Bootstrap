import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { generate } from '../site/scripts/generate-mock-data.mjs';
import {
  collapse, defaultState, deriveDeltas, facetCounts, filterRuns, frontier, hashToState, largestCohort, lineageRoots,
  mixedConditions, orderRows, rankRuns, stateToHash, summarize, trendSeries,
} from '../site/js/model.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const site = join(root, 'site');
const mock = JSON.parse(readFileSync(join(site, 'data', 'runs.mock.json'), 'utf8'));

let counter = 0;
const run = (overrides = {}) => ({
  run_id: `r${++counter}`, experiment_id: 'e1', derived_from: null, date: '2026-07-01', role: 'candidate', comparison_track: 'matched',
  engine: { name: 'eng', revision: 'a'.repeat(40), backend: 'native' }, hardware: 'hw1', target_model: 'm1', builder: 'b1', harness: 'h1',
  evaluation: 'ev1', metrics: { decode_tok_s: 100, prefill_tok_s: 1000, ttft_ms_p50: 200, peak_memory_gib: 10 },
  quality_gate: 'passed', quality: { task_pass: 20, task_total: 20, numerical_max_abs_error: 0.001 },
  autonomy: { human_interventions: 1, hardware_hours: 1, builder_tokens_m: 1, self_hosting: false }, evidence: 'public', synthetic: false,
  ...overrides,
});
const decode = value => ({ metrics: { decode_tok_s: value, prefill_tok_s: 1, ttft_ms_p50: 1000 / value, peak_memory_gib: 1 } });

test('the mock data is synthetic everywhere, internally consistent, and reproducible', () => {
  assert.equal(mock.synthetic, true);
  assert.equal(generate(), readFileSync(join(site, 'data', 'runs.mock.json'), 'utf8'), 'regenerate with site/scripts/generate-mock-data.mjs');
  assert.ok(mock.runs.length > 100);
  assert.equal(new Set(mock.runs.map(r => r.run_id)).size, mock.runs.length);
  const models = new Map();
  const experiments = new Set(mock.runs.map(r => r.experiment_id));
  for (const r of mock.runs) {
    assert.equal(r.synthetic, true, r.run_id);
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(r.engine.revision, /^[0-9a-f]{40}$/);
    assert.ok(['passed', 'failed'].includes(r.quality_gate));
    assert.ok(Object.values(r.metrics).every(v => typeof v === 'number' && v > 0), r.run_id);
    if (r.derived_from) assert.ok(experiments.has(r.derived_from), `${r.run_id} derives from an unknown experiment`);
    models.set(r.experiment_id, new Set([...(models.get(r.experiment_id) ?? []), r.target_model]));
  }
  // The protocol forbids changing the target model in a derived experiment.
  const parentOf = new Map(mock.runs.map(r => [r.experiment_id, r.derived_from]));
  for (const [experiment, parent] of parentOf) {
    if (parent) assert.deepEqual([...models.get(experiment)], [...models.get(parent)], `${experiment} changes the target model`);
  }
  assert.ok(mock.runs.some(r => r.quality_gate === 'failed'), 'the demo should include gate failures');
});

test('the page loads nothing from outside the site and builds the DOM without markup injection', () => {
  const html = readFileSync(join(site, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /(?:src|href)="(?:https?:)?\/\//);
  for (const [, path] of html.matchAll(/(?:src|href)="([^"#]+)"/g)) assert.ok(existsSync(join(site, path)), `missing ${path}`);
  for (const file of readdirSync(join(site, 'js'))) {
    const code = readFileSync(join(site, 'js', file), 'utf8');
    assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/, file);
    assert.doesNotMatch(code, /https?:\/\/(?!www\.w3\.org)/, `${file} references an external URL`);
  }
});

test('failed runs are excluded by default, and faceting leaves a facet\'s own filter out of its counts', () => {
  const runs = [run({ hardware: 'a' }), run({ hardware: 'b' }), run({ hardware: 'b', quality_gate: 'failed' }), run({ hardware: 'a', builder: 'b2' })];
  assert.equal(filterRuns(runs, defaultState()).length, 3);
  assert.equal(filterRuns(runs, { ...defaultState(), includeFailed: true }).length, 4);
  const state = { ...defaultState(), filters: { hardware: ['a'], builder: ['b1'] } };
  assert.deepEqual(filterRuns(runs, state).map(r => r.hardware), ['a']);
  assert.deepEqual([...facetCounts(runs, state, 'hardware')], [['a', 1], ['b', 1]]);
  assert.deepEqual([...facetCounts(runs, state, 'builder')], [['b1', 1], ['b2', 1]]);
  assert.equal(filterRuns(runs, { ...defaultState(), query: 'HW1' }).length, 0);
  assert.equal(filterRuns(runs, { ...defaultState(), from: '2026-07-02' }).length, 0);
});

test('ranking uses competition ranks, honors direction, and never ranks failed runs', () => {
  const a = run({ ...decode(100) });
  const b = run({ ...decode(100), date: '2026-07-02' });
  const c = run({ ...decode(90) });
  const failed = run({ ...decode(500), quality_gate: 'failed' });
  const ranks = rankRuns([c, failed, b, a], 'decode_tok_s');
  assert.deepEqual([a, b, c].map(r => ranks.get(r)), [1, 1, 3]);
  assert.equal(ranks.has(failed), false);
  const lower = rankRuns([a, c], 'ttft_ms_p50');
  assert.equal(lower.get(a) > lower.get(c), false, 'a lower TTFT must rank first');
  assert.deepEqual(orderRows([c, failed, a], rankRuns([c, failed, a], 'decode_tok_s'), 'rank'), [a, c, failed]);
});

test('collapsing keeps the best passing run per experiment and falls back to the latest failure', () => {
  const low = run({ experiment_id: 'x', ...decode(80) });
  const high = run({ experiment_id: 'x', ...decode(120), date: '2026-07-05' });
  const bad = run({ experiment_id: 'x', ...decode(300), quality_gate: 'failed', date: '2026-07-09' });
  assert.deepEqual(collapse([low, bad, high], 'decode_tok_s', 'best'), [high]);
  const onlyFailed = [run({ experiment_id: 'y', quality_gate: 'failed' }), run({ experiment_id: 'y', quality_gate: 'failed', date: '2026-07-09' })];
  assert.equal(collapse(onlyFailed, 'decode_tok_s', 'best')[0].date, '2026-07-09');
  assert.equal(collapse([low, high], 'decode_tok_s', 'all').length, 2);
  const other = run({ experiment_id: 'x', role: 'baseline', engine: { name: 'ref', revision: 'b'.repeat(40), backend: 'reference' } });
  assert.equal(collapse([high, other], 'decode_tok_s', 'best').length, 2, 'baselines are separate entries');
});

test('summaries, mixed-condition detection, and the largest cohort', () => {
  const runs = [run({ ...decode(100) }), run({ ...decode(200), experiment_id: 'e2' }), run({ ...decode(50), quality_gate: 'failed' })];
  const summary = summarize(runs, 'decode_tok_s');
  assert.deepEqual([summary.runs, summary.experiments, summary.failed], [3, 2, 1]);
  assert.equal(summary.median, 150);
  assert.equal(summary.best.metrics.decode_tok_s, 200);
  assert.equal(Math.round(summary.passRate * 100), 67);
  assert.deepEqual(mixedConditions(runs), []);
  assert.deepEqual(mixedConditions([...runs, run({ hardware: 'hw2' })]), [{ name: 'hardware', count: 2 }]);
  const cohort = largestCohort([...runs, run({ hardware: 'hw2' })]);
  assert.deepEqual(cohort, { hardware: ['hw1'], target_model: ['m1'], evaluation: ['ev1'] });
});

test('lineage roots, trend series, and the best-so-far frontier', () => {
  const runs = [
    run({ experiment_id: 'r', ...decode(60), date: '2026-06-01' }),
    run({ experiment_id: 'r', ...decode(55), date: '2026-06-10' }),
    run({ experiment_id: 'r-d1', derived_from: 'r', ...decode(80), date: '2026-07-01' }),
    run({ experiment_id: 'r-d2', derived_from: 'r-d1', ...decode(70), date: '2026-08-01' }),
    run({ experiment_id: 'q', ...decode(90), date: '2026-07-15', quality_gate: 'failed' }),
  ];
  const roots = lineageRoots(runs);
  assert.deepEqual(['r', 'r-d1', 'r-d2', 'q'].map(e => roots.get(e)), ['r', 'r', 'r', 'q']);
  const { series, hidden } = trendSeries(runs, { metric: 'decode_tok_s', groupBy: 'lineage', roots, max: 1 });
  assert.deepEqual([series.length, hidden, series[0].label, series[0].points.length], [1, 1, 'r', 4]);
  assert.ok(series[0].points.every((p, i, all) => !i || all[i - 1].t <= p.t));
  assert.deepEqual(frontier(runs, 'decode_tok_s').map(p => p.value), [60, 80], 'failed and non-improving runs are skipped');
});

test('derived experiments are compared against their base, with positive meaning better for either direction', () => {
  const runs = [
    run({ experiment_id: 'base', ...decode(100) }),
    run({ experiment_id: 'child', derived_from: 'base', ...decode(125), hardware: 'hw2' }),
  ];
  const [fast] = deriveDeltas(runs, 'decode_tok_s');
  assert.equal(Math.round(fast.change), 25);
  assert.deepEqual(fast.differs, ['hardware']);
  const slower = [run({ experiment_id: 'base' }), run({ experiment_id: 'child', derived_from: 'base', metrics: { ...run().metrics, ttft_ms_p50: 250 } })];
  assert.equal(deriveDeltas(slower, 'ttft_ms_p50')[0].change, -25, 'a higher TTFT is worse');
  assert.ok(deriveDeltas(runs, 'ttft_ms_p50')[0].change > 0, 'a lower TTFT is better');
  assert.equal(deriveDeltas(runs.slice(1), 'decode_tok_s')[0].change, null, 'no base run, no comparison');
});

test('the URL hash round-trips the view state and ignores unknown or malformed values', () => {
  const state = {
    ...defaultState(), metric: 'ttft_ms_p50', tab: 'trends', groupBy: 'engine', frontier: false, includeFailed: true, selfHosting: true,
    query: 'a&b=c', from: '2026-06-01', to: '2026-09-30', filters: { hardware: ['Mock · 48 GiB', 'x'], role: ['baseline'] },
  };
  assert.deepEqual(hashToState(`#${stateToHash(state)}`), state);
  assert.equal(stateToHash(defaultState()), '');
  const bad = hashToState('#metric=__proto__&tab=evil&from=yesterday&f.nonsense=1');
  assert.deepEqual(bad, defaultState());
});
