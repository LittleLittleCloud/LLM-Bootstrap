import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  collapse, defaultState, deriveDeltas, facetCounts, filterRuns, frontier, hashToState, largestCohort, lineageRoots,
  conformance, mixedConditions, orderRows, rankRuns, stateToHash, summarize, trendSeries, unrankedReason,
} from '../site/src/lib/model.js';
import { buildIndex, loadEvaluationIds, loadRecordFiles, serializeIndex } from '../tools/leaderboard/build-index.mjs';
import { loadValidators } from '../skills/bootstrap-experiment-sop/scripts/validators.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const site = join(root, 'site');

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

test('the committed leaderboard index is built from the experiment records and holds no synthetic data', async () => {
  const path = join(site, 'public', 'data', 'leaderboard.json');
  const text = readFileSync(path, 'utf8');
  const index = JSON.parse(text);
  assert.equal(index.schema_version, '1.0.0');
  assert.equal('synthetic' in index, false);
  assert.equal(existsSync(join(site, 'public', 'data', 'leaderboard.mock.json')), false, 'no demo index is shipped');
  const validators = await loadValidators();
  const rebuilt = buildIndex(loadRecordFiles(root), { validators, evaluationIds: loadEvaluationIds(root) });
  assert.equal(serializeIndex(rebuilt), text, 'rebuild it with: node tools/leaderboard/build-index.mjs . --out site/public/data/leaderboard.json --require-validation');
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
