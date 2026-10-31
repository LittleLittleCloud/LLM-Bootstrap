import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  collapse, defaultState, deriveDeltas, facetCounts, filterRuns, frontier, hashToState, largestCohort, lineageRoots,
  mixedConditions, orderRows, rankRuns, stateToHash, summarize, trendSeries, unrankedReason,
} from '../site/src/lib/model.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const site = join(root, 'site');
const mock = JSON.parse(readFileSync(join(site, 'public', 'data', 'leaderboard.mock.json'), 'utf8'));

let counter = 0;
const entry = (overrides = {}) => {
  counter += 1;
  return {
    entry_id: `e${counter}/candidate/eng`, run_id: `r${counter}`, experiment_id: 'e1', derived_from: null, date: '2026-07-01', role: 'candidate',
    comparison_track: 'matched-configuration', engine: { name: 'eng', revision: null }, hardware: 'hw1', target_model: 'm1', weights: 'q4', builder: 'b1',
    harness: 'h 1', evaluation: 'ev1', profile: 'full', endpoint_class: 'loopback', context_window: { tokens: 32768, source: 'models-metadata' },
    metrics: {
      decode_tok_s: 100, prefill_tok_s: 1000, speed_tok_s: 98, ttft_ms: 200, cache_hit_pct: 90, needle_accuracy: 1, thinking_accuracy: 1, preliminary: false,
    },
    quality_gate: 'passed', quality: { conform_passed: true, benchmarks: [] }, failures: [], source: { experiment: 'x', evaluation: 'y' }, ...overrides,
  };
};
const decode = (value, extra = {}) => entry({ metrics: { ...entry().metrics, decode_tok_s: value, ttft_ms: 20000 / value }, ...extra });

test('the synthetic demo index is flagged, internally consistent, and covers the awkward cases', () => {
  assert.equal(mock.synthetic, true);
  assert.equal(mock.schema_version, '1.0.0');
  assert.equal(mock.counts.entries, mock.entries.length);
  assert.equal(new Set(mock.entries.map(e => e.entry_id)).size, mock.entries.length);
  assert.equal(new Set(mock.entries.map(e => e.run_id)).size, mock.counts.runs);
  const experiments = new Set(mock.entries.map(e => e.experiment_id));
  assert.equal(experiments.size, mock.counts.experiments);
  const models = new Map(mock.entries.map(e => [e.experiment_id, e.target_model]));
  for (const e of mock.entries) {
    assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(['passed', 'failed', 'unverified'].includes(e.quality_gate));
    assert.ok(['baseline', 'candidate'].includes(e.role));
    assert.ok(['full', 'quick'].includes(e.profile));
    assert.equal(e.evaluation, 'endpoint-bench');
    assert.ok(['loopback', 'private-network', 'remote'].includes(e.endpoint_class));
    assert.ok(e.context_window.tokens > 0);
    if (e.derived_from) {
      assert.ok(experiments.has(e.derived_from), `${e.entry_id} derives from an unknown experiment`);
      // The protocol forbids changing the target model in a derived experiment.
      assert.equal(models.get(e.derived_from), e.target_model, `${e.experiment_id} changes the target model`);
    }
    if (e.role === 'baseline') assert.equal(e.builder, null);
    if (e.quality_gate === 'passed') assert.equal(e.quality.conform_passed, true, `${e.entry_id} passed without conformance`);
  }
  assert.ok(mock.entries.some(e => e.quality_gate === 'failed'));
  assert.ok(mock.entries.some(e => e.quality_gate === 'unverified'));
  assert.ok(mock.entries.some(e => e.metrics.decode_tok_s === null), 'a missing measurement stays null');
  assert.ok(mock.entries.some(e => e.profile === 'quick'));
  assert.doesNotMatch(JSON.stringify(mock), /autonomy|human_interventions|peak_memory|\b(?:\d{1,3}\.){3}\d{1,3}\b/);
});

test('the page loads nothing from outside the site and never injects markup', () => {
  const html = readFileSync(join(site, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /(?:src|href)="(?:https?:)?\/\//);
  for (const file of readdirSync(join(site, 'src'), { recursive: true }).filter(name => /\.(?:jsx?|css)$/.test(name))) {
    const code = readFileSync(join(site, 'src', file), 'utf8');
    assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|dangerouslySetInnerHTML|document\.write|\beval\(|new Function/, file);
    assert.doesNotMatch(code, /https?:\/\/(?!www\.w3\.org|github\.com\/LittleLittleCloud\/LLM-Bootstrap|127\.0\.0\.1)[a-z0-9]/i, `${file} references an external URL`);
  }
  // The evaluator runs in the page, so it follows the same rules. It stores nothing and sends nothing but the requests of the test.
  const evaluator = join(root, 'evaluations', 'endpoint-bench');
  for (const file of readdirSync(evaluator, { recursive: true }).filter(name => name.endsWith('.js'))) {
    assert.doesNotMatch(readFileSync(join(evaluator, file), 'utf8'), /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|localStorage|sendBeacon|XMLHttpRequest|WebSocket/, file);
  }
});

test('entries that did not pass the gate are hidden by default, and a facet\'s counts leave its own filter out', () => {
  const runs = [entry({ hardware: 'a' }), entry({ hardware: 'b' }), entry({ hardware: 'b', quality_gate: 'failed' }), entry({ hardware: 'a', builder: 'b2' }),
    entry({ hardware: 'a', quality_gate: 'unverified' })];
  assert.equal(filterRuns(runs, defaultState()).length, 3);
  assert.equal(filterRuns(runs, { ...defaultState(), includeNotPassed: true }).length, 5);
  const state = { ...defaultState(), filters: { hardware: ['a'], builder: ['b1'] } };
  assert.deepEqual(filterRuns(runs, state).map(r => r.hardware), ['a']);
  assert.deepEqual([...facetCounts(runs, state, 'hardware')], [['a', 1], ['b', 1]]);
  assert.deepEqual([...facetCounts(runs, state, 'builder')], [['b1', 1], ['b2', 1]]);
  assert.equal(filterRuns(runs, { ...defaultState(), query: 'NOPE' }).length, 0);
  assert.equal(filterRuns(runs, { ...defaultState(), from: '2026-07-02' }).length, 0);
  const quick = [entry({ profile: 'quick' }), entry()];
  assert.equal(filterRuns(quick, { ...defaultState(), filters: { profile: ['quick'] } }).length, 1);
});

test('ranking uses competition ranks and honors direction, and unranked entries say why', () => {
  const a = decode(100);
  const b = decode(100, { date: '2026-07-02' });
  const c = decode(90);
  const failed = decode(500, { quality_gate: 'failed' });
  const unverified = decode(400, { quality_gate: 'unverified' });
  const missing = entry({ metrics: { ...entry().metrics, decode_tok_s: null } });
  const ranks = rankRuns([c, failed, b, a, unverified, missing], 'decode_tok_s');
  assert.deepEqual([a, b, c].map(r => ranks.get(r)), [1, 1, 3]);
  assert.equal(ranks.size, 3);
  assert.match(unrankedReason(failed, 'decode_tok_s'), /Failed the quality gate/);
  assert.match(unrankedReason(unverified, 'decode_tok_s'), /could not be verified/);
  assert.match(unrankedReason(missing, 'decode_tok_s'), /No Decode tok\/s was measured/);
  assert.equal(unrankedReason(a, 'decode_tok_s'), null);
  const lower = rankRuns([a, c], 'ttft_ms');
  assert.ok(lower.get(a) < lower.get(c), 'a lower TTFT must rank first');
  assert.deepEqual(orderRows([c, failed, a], rankRuns([c, failed, a], 'decode_tok_s'), 'rank'), [a, c, failed]);
});

test('collapsing keeps the best entry per experiment and shows each baseline once per cohort', () => {
  const low = decode(80, { experiment_id: 'x' });
  const high = decode(120, { experiment_id: 'x', date: '2026-07-05' });
  const bad = decode(300, { experiment_id: 'x', quality_gate: 'failed', date: '2026-07-09' });
  assert.deepEqual(collapse([low, bad, high], 'decode_tok_s', 'best'), [high]);
  const onlyFailed = [entry({ experiment_id: 'y', quality_gate: 'failed' }), entry({ experiment_id: 'y', quality_gate: 'failed', date: '2026-07-09' })];
  assert.equal(collapse(onlyFailed, 'decode_tok_s', 'best')[0].date, '2026-07-09');
  assert.equal(collapse([low, high], 'decode_tok_s', 'all').length, 2);
  const baseline = (experiment, value) => decode(value, { experiment_id: experiment, role: 'baseline', builder: null, engine: { name: 'ref', revision: null } });
  const kept = collapse([baseline('x', 90), baseline('z', 95), high], 'decode_tok_s', 'best');
  assert.equal(kept.length, 2, 'the same baseline, measured in two experiments, appears once');
  assert.equal(kept.find(e => e.role === 'baseline').metrics.decode_tok_s, 95);
});

test('summaries, mixed-condition detection (including the profile), and the largest cohort', () => {
  const runs = [decode(100), decode(200, { experiment_id: 'e2' }), decode(50, { quality_gate: 'failed' })];
  const summary = summarize(runs, 'decode_tok_s');
  assert.deepEqual([summary.runs, summary.experiments, summary.notPassed], [3, 2, 1]);
  assert.equal(summary.median, 150);
  assert.equal(summary.best.metrics.decode_tok_s, 200);
  assert.equal(Math.round(summary.passRate * 100), 67);
  assert.deepEqual(mixedConditions(runs), []);
  assert.deepEqual(mixedConditions([...runs, entry({ profile: 'quick' })]), [{ name: 'profile', count: 2 }]);
  assert.deepEqual(mixedConditions([...runs, entry({ weights: 'q8' })]), [{ name: 'weights', count: 2 }]);
  const cohort = largestCohort([...runs, entry({ hardware: 'hw2' }), entry({ profile: 'quick' })]);
  assert.deepEqual(cohort, { hardware: ['hw1'], target_model: ['m1'], evaluation: ['ev1'], comparison_track: ['matched-configuration'], profile: ['full'] });
});

test('lineage roots, trend series, and a best-so-far frontier that ignores unranked entries', () => {
  const runs = [
    decode(60, { experiment_id: 'r', date: '2026-06-01' }),
    decode(55, { experiment_id: 'r', date: '2026-06-10' }),
    decode(80, { experiment_id: 'r-d1', derived_from: 'r', date: '2026-07-01' }),
    decode(70, { experiment_id: 'r-d2', derived_from: 'r-d1', date: '2026-08-01' }),
    decode(90, { experiment_id: 'q', date: '2026-07-15', quality_gate: 'failed' }),
    decode(95, { experiment_id: 'q', date: '2026-07-16', quality_gate: 'unverified' }),
  ];
  const roots = lineageRoots(runs);
  assert.deepEqual(['r', 'r-d1', 'r-d2', 'q'].map(e => roots.get(e)), ['r', 'r', 'r', 'q']);
  const { series, hidden } = trendSeries(runs, { metric: 'decode_tok_s', groupBy: 'lineage', roots, max: 1 });
  assert.deepEqual([series.length, hidden, series[0].label, series[0].points.length], [1, 1, 'r', 4]);
  assert.ok(series[0].points.every((p, i, all) => !i || all[i - 1].t <= p.t));
  assert.deepEqual(frontier(runs, 'decode_tok_s').map(p => p.value), [60, 80]);
});

test('derived experiments are compared with their base, with positive meaning better, and a changed profile is flagged', () => {
  const runs = [decode(100, { experiment_id: 'base' }), decode(125, { experiment_id: 'child', derived_from: 'base', hardware: 'hw2' })];
  const [fast] = deriveDeltas(runs, 'decode_tok_s');
  assert.equal(Math.round(fast.change), 25);
  assert.deepEqual(fast.differs, ['hardware']);
  const slower = [entry({ experiment_id: 'base' }), entry({ experiment_id: 'child', derived_from: 'base', metrics: { ...entry().metrics, ttft_ms: 250 } })];
  assert.equal(Math.round(deriveDeltas(slower, 'ttft_ms')[0].change), -25);
  assert.ok(deriveDeltas(runs, 'ttft_ms')[0].change > 0, 'a lower TTFT is better');
  assert.equal(deriveDeltas(runs.slice(1), 'decode_tok_s')[0].change, null, 'no base entry, no comparison');
  const reduced = [decode(100, { experiment_id: 'base' }), decode(125, { experiment_id: 'child', derived_from: 'base', profile: 'quick' })];
  assert.deepEqual(deriveDeltas(reduced, 'decode_tok_s')[0].differs, ['profile']);
});

test('the URL hash round-trips the view state and ignores unknown or malformed values', () => {
  const state = {
    ...defaultState(), page: 'leaderboard', metric: 'ttft_ms', tab: 'trends', groupBy: 'engine', frontier: false, includeNotPassed: true,
    query: 'a&b=c', from: '2026-06-01', to: '2026-09-30', filters: { hardware: ['Mock · 48 GiB', 'x'], role: ['baseline'], profile: ['quick'] },
  };
  assert.deepEqual(hashToState(`#${stateToHash(state)}`), state);
  assert.equal(stateToHash(defaultState()), '');
  assert.deepEqual(hashToState('#metric=__proto__&tab=evil&page=admin&from=yesterday&f.nonsense=1'), defaultState());
  assert.equal(hashToState('#page=evaluate').page, 'evaluate');
});
