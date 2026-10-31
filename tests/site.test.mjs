import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  collapse, defaultState, deriveDeltas, facetCounts, filterRuns, frontier, hashToState, largestCohort, lineageRoots,
  conformance, mixedConditions, orderRows, rankRuns, stateToHash, summarize, trendSeries, unrankedReason,
} from '../site/src/lib/model.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const site = join(root, 'site');
const mock = JSON.parse(readFileSync(join(site, 'public', 'data', 'leaderboard.mock.json'), 'utf8'));

let counter = 0;
const entry = (overrides = {}) => {
  counter += 1;
  return {
    entry_id: `e${counter}/eng/stamp`, run_id: `r${counter}`, experiment_id: 'e1', derived_from: null, date: '2026-07-01',
    comparison_track: 'matched-configuration', engine: { name: 'eng', revision: '1'.repeat(40) }, hardware: 'hw1', target_model: 'm1', weights: 'q4',
    evaluation: 'ev1', profile: 'full', endpoint_class: 'loopback', context_window: { tokens: 32768, source: 'models-metadata' },
    metrics: {
      decode_tok_s: 100, prefill_tok_s: 1000, speed_tok_s: 98, ttft_ms: 200, cache_hit_pct: 90, needle_accuracy: 1, thinking_accuracy: 1, preliminary: false,
    },
    quality: { conform_passed: true, benchmarks: [] }, failures: [], source: { experiment: 'x', evaluation: 'y' }, ...overrides,
  };
};
const decode = (value, extra = {}) => entry({ metrics: { ...entry().metrics, decode_tok_s: value, ttft_ms: 20000 / value }, ...extra });

test('the synthetic demo index is flagged, internally consistent, and covers the awkward cases', () => {
  assert.equal(mock.synthetic, true);
  assert.equal(mock.schema_version, '1.0.0');
  assert.equal(mock.counts.entries, mock.entries.length);
  assert.equal(new Set(mock.entries.map(e => e.entry_id)).size, mock.entries.length);
  assert.equal(new Set(mock.entries.map(e => e.run_id)).size, mock.counts.runs);
  for (const e of mock.entries) {
    const stamp = e.entry_id.split('/').at(-1);
    assert.equal(e.entry_id, `${e.experiment_id}/${stamp}`, 'an entry id is <experiment>/<YYYYMMDD-HHMMSS>');
    assert.match(stamp, /^\d{8}-\d{6}$/);
    assert.equal(e.run_id, e.entry_id, 'one report is one run');
    assert.deepEqual(e.source, { experiment: `experiments/${e.experiment_id}/experiment.json`, evaluation: `experiments/${e.experiment_id}/evaluation/${stamp}.json` });
    assert.ok(stamp.startsWith(e.date.replaceAll('-', '')), `${e.entry_id} is not named after its date`);
  }
  const experiments = new Set(mock.entries.map(e => e.experiment_id));
  assert.equal(experiments.size, mock.counts.experiments);
  const models = new Map(mock.entries.map(e => [e.experiment_id, e.target_model]));
  const engineOf = new Map();
  for (const e of mock.entries) {
    const key = `${e.engine.name}@${e.engine.revision}`;
    assert.equal(engineOf.get(e.experiment_id) ?? key, key, `${e.experiment_id} measures more than one engine`);
    engineOf.set(e.experiment_id, key);
  }
  for (const e of mock.entries) {
    assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/);
    for (const key of ['role', 'builder', 'harness', 'quality_gate']) assert.equal(key in e, false, `${e.entry_id} still has ${key}`);
    assert.match(e.engine.revision, /^[0-9a-f]{40}$/, `${e.entry_id} has no engine revision`);
    assert.ok(['full', 'quick'].includes(e.profile));
    assert.equal(e.evaluation, 'endpoint-bench');
    assert.ok(['loopback', 'private-network', 'remote'].includes(e.endpoint_class));
    assert.ok(e.context_window.tokens > 0);
    if (e.derived_from) {
      assert.ok(experiments.has(e.derived_from), `${e.entry_id} derives from an unknown experiment`);
      // The protocol forbids changing the target model in a derived experiment.
      assert.equal(models.get(e.derived_from), e.target_model, `${e.experiment_id} changes the target model`);
    }
  }
  assert.ok(mock.entries.some(e => e.quality.conform_passed === null), 'an unchecked conformance stays null');
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

test('every entry is listed whatever its conformance, and a facet\'s counts leave its own filter out', () => {
  const failed = { quality: { conform_passed: false, benchmarks: [] } };
  const runs = [entry({ hardware: 'a' }), entry({ hardware: 'b' }), entry({ hardware: 'b', ...failed }), entry({ hardware: 'a', engine: { name: 'other', revision: '2'.repeat(40) } }),
    entry({ hardware: 'a', quality: { conform_passed: null, benchmarks: [] } })];
  assert.equal(filterRuns(runs, defaultState()).length, 5);
  const state = { ...defaultState(), filters: { hardware: ['a'], engine: ['eng'] } };
  assert.deepEqual(filterRuns(runs, state).map(r => r.hardware), ['a', 'a']);
  assert.deepEqual([...facetCounts(runs, state, 'hardware')], [['a', 2], ['b', 2]]);
  assert.deepEqual([...facetCounts(runs, state, 'engine')], [['eng', 2], ['other', 1]]);
  assert.equal(filterRuns(runs, { ...defaultState(), query: 'NOPE' }).length, 0);
  assert.equal(filterRuns(runs, { ...defaultState(), from: '2026-07-02' }).length, 0);
  const quick = [entry({ profile: 'quick' }), entry()];
  assert.equal(filterRuns(quick, { ...defaultState(), filters: { profile: ['quick'] } }).length, 1);
});

test('ranking uses competition ranks and honors direction, keeps a failed conformance, and unranked entries say why', () => {
  const a = decode(100);
  const b = decode(100, { date: '2026-07-02' });
  const c = decode(90);
  const nonconforming = decode(500, { quality: { conform_passed: false, benchmarks: [] } });
  const missing = entry({ metrics: { ...entry().metrics, decode_tok_s: null } });
  const ranks = rankRuns([c, nonconforming, b, a, missing], 'decode_tok_s');
  assert.deepEqual([nonconforming, a, b, c].map(r => ranks.get(r)), [1, 2, 2, 4]);
  assert.equal(ranks.size, 4);
  assert.equal(conformance(nonconforming), 'failed');
  assert.equal(conformance(entry({ quality: { conform_passed: null, benchmarks: [] } })), 'unchecked');
  assert.equal(conformance(a), 'passed');
  assert.match(unrankedReason(missing, 'decode_tok_s'), /No Decode tok\/s was measured/);
  assert.equal(unrankedReason(a, 'decode_tok_s'), null);
  assert.equal(unrankedReason(nonconforming, 'decode_tok_s'), null, 'a regression or a failed check is still ranked');
  const lower = rankRuns([a, c], 'ttft_ms');
  assert.ok(lower.get(a) < lower.get(c), 'a lower TTFT must rank first');
  assert.deepEqual(orderRows([c, missing, a], rankRuns([c, missing, a], 'decode_tok_s'), 'rank'), [a, c, missing]);
});

test('collapsing keeps the best entry per engine in each experiment, whatever its conformance', () => {
  const low = decode(80, { experiment_id: 'x' });
  const high = decode(120, { experiment_id: 'x', date: '2026-07-05' });
  const regression = decode(60, { experiment_id: 'x', date: '2026-07-09' });
  assert.deepEqual(collapse([low, regression, high], 'decode_tok_s', 'best'), [high], 'a later regression does not replace the best');
  const unmeasured = entry({ experiment_id: 'y', metrics: { ...entry().metrics, decode_tok_s: null }, date: '2026-07-09' });
  assert.equal(collapse([unmeasured, decode(70, { experiment_id: 'y' })], 'decode_tok_s', 'best')[0].metrics.decode_tok_s, 70, 'a run without the metric never wins');
  assert.equal(collapse([low, high], 'decode_tok_s', 'all').length, 2);
  const other = decode(90, { experiment_id: 'x', engine: { name: 'other', revision: '2'.repeat(40) } });
  const sameName = decode(95, { experiment_id: 'z' });
  const kept = collapse([low, high, other, sameName], 'decode_tok_s', 'best');
  assert.equal(kept.length, 3, 'one entry per engine per experiment');
});

test('summaries, mixed-condition detection (including the profile), and the largest cohort', () => {
  const runs = [decode(100), decode(200, { experiment_id: 'e2' }), decode(50, { engine: { name: 'other', revision: '2'.repeat(40) } })];
  const summary = summarize(runs, 'decode_tok_s');
  assert.deepEqual([summary.runs, summary.experiments, summary.engines], [3, 2, 2]);
  assert.equal(summary.median, 100);
  assert.equal(summary.best.metrics.decode_tok_s, 200);
  assert.deepEqual(mixedConditions(runs), []);
  assert.deepEqual(mixedConditions([...runs, entry({ profile: 'quick' })]), [{ name: 'profile', count: 2 }]);
  assert.deepEqual(mixedConditions([...runs, entry({ weights: 'q8' })]), [{ name: 'weights', count: 2 }]);
  const cohort = largestCohort([...runs, entry({ hardware: 'hw2' }), entry({ profile: 'quick' })]);
  assert.deepEqual(cohort, { hardware: ['hw1'], target_model: ['m1'], evaluation: ['ev1'], comparison_track: ['matched-configuration'], profile: ['full'] });
});

test('lineage roots, trend series, and a best-so-far frontier', () => {
  const runs = [
    decode(60, { experiment_id: 'r', date: '2026-06-01' }),
    decode(55, { experiment_id: 'r', date: '2026-06-10' }),
    decode(80, { experiment_id: 'r-d1', derived_from: 'r', date: '2026-07-01' }),
    decode(70, { experiment_id: 'r-d2', derived_from: 'r-d1', date: '2026-08-01' }),
    decode(90, { experiment_id: 'q', date: '2026-07-15' }),
    decode(95, { experiment_id: 'q', date: '2026-07-16' }),
  ];
  const roots = lineageRoots(runs);
  assert.deepEqual(['r', 'r-d1', 'r-d2', 'q'].map(e => roots.get(e)), ['r', 'r', 'r', 'q']);
  const { series, hidden } = trendSeries(runs, { metric: 'decode_tok_s', groupBy: 'lineage', roots, max: 1 });
  assert.deepEqual([series.length, hidden, series[0].label, series[0].points.length], [1, 1, 'r', 4]);
  assert.ok(series[0].points.every((p, i, all) => !i || all[i - 1].t <= p.t));
  assert.deepEqual(frontier(runs, 'decode_tok_s').map(p => p.value), [60, 80, 90, 95]);
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
    ...defaultState(), page: 'leaderboard', metric: 'ttft_ms', tab: 'trends', groupBy: 'engine', frontier: false,
    query: 'a&b=c', from: '2026-06-01', to: '2026-09-30', filters: { hardware: ['Mock · 48 GiB', 'x'], engine: ['eng'], profile: ['quick'] },
  };
  assert.deepEqual(hashToState(`#${stateToHash(state)}`), state);
  assert.equal(stateToHash(defaultState()), '');
  assert.deepEqual(hashToState('#metric=__proto__&tab=evil&page=admin&from=yesterday&f.nonsense=1'), defaultState());
  assert.equal(hashToState('#page=evaluate').page, 'evaluate');
});
