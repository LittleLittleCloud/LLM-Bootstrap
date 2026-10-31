import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { IndexError, buildIndex, evaluationStamp, loadRecordFiles, qualityGate, serializeIndex } from '../tools/leaderboard/build-index.mjs';
import { headlineMetrics, qualityScores } from '../evaluations/endpoint-bench/src/report.js';
import { loadValidators } from '../skills/bootstrap-experiment-sop/scripts/validators.mjs';
import { commit, frozenExperiment, syntheticReport, when } from './helpers/fixtures.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'tools', 'leaderboard', 'build-index.mjs');
const validators = await loadValidators();
const digest = text => createHash('sha256').update(text).digest('hex');
const serialize = document => `${JSON.stringify(document, null, 2)}\n`;
const at = hour => `2026-10-28T${hour}:00:00Z`;
const BASELINE = 'synthetic-baseline';

const millis = { ttft_ms_p50: 100, ttft_ms_p90: 120 };
const retrieval = (correct, attempted) => ({
  attempted, correct, failed: 0, accuracy: correct / attempted, stderr: Math.sqrt((correct / attempted) * (1 - correct / attempted) / attempted), format_compliance: 1,
  prompt_tokens_p50: 1000, ...millis, input_tokens_per_second_p50: 5000,
});
const thinking = (correct, attempted) => ({
  attempted, correct, failed: 0, accuracy: correct / attempted, stderr: Math.sqrt((correct / attempted) * (1 - correct / attempted) / attempted), format_compliance: 1,
  ttft_ms_p50: 100, ttft_ms_p95: 150, e2e_ms_p50: 900, e2e_ms_p95: 1200, reasoning_tokens_p50: 0, answer_tokens_p50: 3,
});

// A complete, schema-valid report whose numbers the tests choose. Nothing here is a measurement.
function report({ started = at('08'), conform = true, thinkingScore = [20, 20], needleScore = [20, 20], decode = 90, prefill = 900, patch = {} } = {}) {
  const base = syntheticReport(started);
  return {
    ...base,
    selected_tests: ['conform', 'speed', 'thinking', 'decode', 'prefill', 'needle', 'cache'],
    tests: {
      conform: { status: 'complete', required_passed: conform, checks: [{ id: 'models-list', title: 'Lists models', required: true, status: conform ? 'pass' : 'fail', detail: '' }] },
      speed: {
        status: 'complete', config: {}, runs: [],
        summary: { completed_runs: 5, failed_runs: 0, ttft_ms_p50: 80, ttft_ms_p90: 90, e2e_ms_p50: 1000, e2e_ms_p90: 1100, tokens_per_second_min: 80, tokens_per_second_p50: 95, tokens_per_second_max: 99 },
      },
      thinking: { status: 'complete', config: {}, variants: { default: { runs: [], summary: thinking(...thinkingScore) } } },
      decode: {
        status: 'complete', config: {},
        lengths: [{
          output_tokens: 1000, runs: [],
          summary: {
            completed_runs: 3, failed_runs: 0, decode_tokens_per_second_p50: decode, decode_tokens_per_second_p90: decode + 1, ...millis, total_latency_ms_p50: 11000,
            total_latency_ms_p90: 11500, visible_tokens_p50: 1000, reasoning_tokens_p50: 0, reasoning_required: false, fixed_length_applied: true,
          },
        }],
      },
      prefill: { status: 'complete', config: {}, sizes: [{ input_tokens: 10000, status: 'complete', runs: [], summary: { ...retrieval(1, 1), input_tokens_per_second_p50: prefill } }] },
      needle: { status: 'complete', config: {}, positions: [], summary: retrieval(...needleScore) },
      cache: {
        status: 'complete', config: {},
        variants: Object.fromEntries(['short', 'padded', 'busted'].map(name => [name, {
          cold: { ok: false, error: 'not run' }, warm: [],
          summary: {
            cache_reported: true, cache_hit_pct: name === 'padded' ? 97.5 : 0, cold_ttft_ms: 500, warm_ttft_ms_p50: 100, ttft_reduction_pct: 80, prompt_tokens: 5000,
            completed_runs: 6, failed_runs: 0, correct: 6,
          },
        }])),
      },
    },
    ...patch,
  };
}

function put(files, path, document) {
  const text = serialize(document);
  files.set(path, text);
  return text;
}

// Reports pin the evaluation of their experiment and carry no experiment pin of their own.
function addExperiments(files) {
  const base = { ...frozenExperiment(), experiment_id: 'exp-base' };
  const baseText = put(files, 'experiments/exp-base/experiment.json', base);
  put(files, 'experiments/exp-derived/experiment.json', {
    experiment_id: 'exp-derived', status: 'frozen', description: 'Synthetic derived fixture.', contract_frozen_at: when,
    extends_path: '../exp-base/experiment.json', extends_revision: commit('5'), extends_sha256: digest(baseText), builder_model: 'other-builder',
  });
}

function addReport(files, experiment, subject, document) {
  const path = `experiments/${experiment}/evaluation/${subject}/${evaluationStamp(document.started_at)}.json`;
  put(files, path, document);
  return path;
}

function tree() {
  const files = new Map();
  addExperiments(files);
  addReport(files, 'exp-base', 'candidate', report({ started: at('08') }));
  addReport(files, 'exp-base', BASELINE, report({ started: at('07'), decode: 80 }));
  addReport(files, 'exp-derived', 'candidate', report({ started: at('09') }));
  return files;
}

test('reports project into one entry each, with the experiment supplying engine, hardware, and model', () => {
  const index = buildIndex(tree(), { validators });
  assert.deepEqual(index.counts, { runs: 3, experiments: 2, entries: 3 });
  assert.equal(index.synthetic, false);
  const byId = Object.fromEntries(index.entries.map(entry => [entry.entry_id, entry]));
  const candidate = byId['exp-base/candidate/20261028-080000'];
  assert.equal(candidate.run_id, 'exp-base/20261028-080000');
  assert.equal(candidate.role, 'candidate');
  assert.equal(candidate.derived_from, null);
  assert.deepEqual(candidate.engine, { name: 'exp-base', revision: null });
  assert.equal(candidate.builder, 'synthetic-builder');
  assert.equal(candidate.hardware, 'Apple M5 Pro');
  assert.equal(candidate.target_model, 'mlx-community/Qwen3.6-35B-A3B-8bit');
  assert.equal(candidate.harness, 'Pi 1.4.0');
  assert.equal(candidate.evaluation, 'synthetic-evaluation');
  assert.equal(candidate.comparison_track, 'matched-configuration');
  assert.equal(candidate.profile, 'full');
  assert.equal(candidate.endpoint_class, 'loopback');
  assert.deepEqual(candidate.metrics, {
    decode_tok_s: 90, prefill_tok_s: 900, speed_tok_s: 95, ttft_ms: 80, cache_hit_pct: 97.5, needle_accuracy: 1, thinking_accuracy: 1, preliminary: false,
  });
  assert.equal(candidate.quality_gate, 'passed');
  assert.deepEqual(candidate.quality.benchmarks.map(item => item.benchmark_id), ['thinking', 'needle']);
  assert.equal(candidate.quality.conform_passed, true);
  assert.deepEqual(candidate.source, { experiment: 'experiments/exp-base/experiment.json', evaluation: 'experiments/exp-base/evaluation/candidate/20261028-080000.json' });
  const baseline = byId[`exp-base/${BASELINE}/20261028-070000`];
  assert.equal(baseline.role, 'baseline');
  assert.equal(baseline.builder, null, 'a baseline was not built by the builder');
  assert.deepEqual(baseline.engine, { name: BASELINE, revision: commit('2') });
  assert.equal(baseline.metrics.decode_tok_s, 80);
  const derived = byId['exp-derived/candidate/20261028-090000'];
  assert.equal(derived.derived_from, 'exp-base');
  assert.equal(derived.builder, 'other-builder', 'the override applies to the effective experiment');
  assert.equal(derived.target_model, candidate.target_model);
  assert.doesNotMatch(JSON.stringify(index), /autonomy|peak_memory|human_interventions/);
});

test('headline metrics and quality scores are read from the nested report', () => {
  const metrics = headlineMetrics(report({ decode: 77 }));
  assert.deepEqual(metrics, {
    conform_passed: 1, speed_tokens_per_second_p50: 95, speed_ttft_ms_p50: 80, decode_tokens_per_second_p50: 77, prefill_tokens_per_second_p50: 900,
    needle_accuracy: 1, thinking_accuracy: 1, cache_hit_pct: 97.5,
  });
  assert.equal(headlineMetrics(report({ conform: false })).conform_passed, 0);
  const sparse = { tests: { speed: { status: 'complete', summary: { tokens_per_second_p50: 50, ttft_ms_p50: 10 } } } };
  assert.deepEqual(headlineMetrics(sparse), {
    conform_passed: null, speed_tokens_per_second_p50: 50, speed_ttft_ms_p50: 10, decode_tokens_per_second_p50: null, prefill_tokens_per_second_p50: null,
    needle_accuracy: null, thinking_accuracy: null, cache_hit_pct: null,
  });
  const decode = report().tests.decode;
  decode.lengths.unshift({ output_tokens: 100, runs: [], summary: { ...decode.lengths[0].summary, decode_tokens_per_second_p50: 11 } });
  assert.equal(headlineMetrics({ tests: { decode } }).decode_tokens_per_second_p50, 90, 'the 1000-token length is the headline when it was measured');
  decode.lengths.pop();
  assert.equal(headlineMetrics({ tests: { decode } }).decode_tokens_per_second_p50, 11, 'else the longest length that has a value');
  const incomplete = report();
  incomplete.tests.needle.status = 'partial';
  assert.deepEqual(qualityScores(incomplete).map(item => item.benchmark_id), ['thinking'], 'an incomplete test is not scored');
});

test('the quality gate needs conformance, compares a candidate with the best baseline within two standard errors, and lets a baseline define the reference', () => {
  const scored = (subject, options) => ({ ...report(options), subject });
  const baselines = [scored('baseline', { thinkingScore: [18, 20], needleScore: [20, 20] })];
  assert.equal(qualityGate(scored('candidate', { thinkingScore: [18, 20] }), baselines), 'passed');
  assert.equal(qualityGate(scored('candidate', { thinkingScore: [17, 20] }), baselines), 'passed', 'a difference within noise passes');
  assert.equal(qualityGate(scored('candidate', { thinkingScore: [4, 20] }), baselines), 'failed');
  assert.equal(qualityGate(scored('candidate', { needleScore: [2, 20] }), baselines), 'failed');
  assert.equal(qualityGate(scored('candidate', {}), []), 'unverified', 'a candidate without a baseline cannot be judged');
  assert.equal(qualityGate(scored('baseline', { thinkingScore: [1, 20] }), []), 'passed', 'a verified baseline defines the reference');
  assert.equal(qualityGate(scored('candidate', { conform: false }), baselines), 'failed', 'a required conformance check failed');
  const unconformed = scored('candidate', {});
  delete unconformed.tests.conform;
  assert.equal(qualityGate(unconformed, baselines), 'unverified');
  const noScores = scored('candidate', {});
  delete noScores.tests.thinking;
  delete noScores.tests.needle;
  assert.equal(qualityGate(noScores, baselines), 'unverified');
  const partial = scored('candidate', {});
  partial.tests.conform.status = 'partial';
  assert.equal(qualityGate(partial, baselines), 'unverified');
});

test('tests that were not selected leave their metrics null, and a reduced profile or an incomplete report is preliminary', () => {
  const files = new Map();
  addExperiments(files);
  const quick = report({ started: at('10'), patch: { profile: 'quick' } });
  addReport(files, 'exp-base', 'candidate', quick);
  const speedOnly = { ...syntheticReport(at('11')), selected_tests: ['speed'], tests: { speed: report().tests.speed } };
  addReport(files, 'exp-base', 'candidate', speedOnly);
  const entries = Object.fromEntries(buildIndex(files, { validators }).entries.map(entry => [entry.date + entry.entry_id.slice(-6), entry]));
  const [reduced, partial] = Object.values(entries).sort((a, b) => a.entry_id.localeCompare(b.entry_id));
  assert.equal(reduced.metrics.preliminary, true);
  assert.equal(reduced.profile, 'quick');
  assert.equal(partial.metrics.speed_tok_s, 95);
  assert.deepEqual([partial.metrics.decode_tok_s, partial.metrics.prefill_tok_s, partial.metrics.cache_hit_pct, partial.metrics.needle_accuracy, partial.metrics.thinking_accuracy], [null, null, null, null, null]);
  assert.equal(partial.quality_gate, 'unverified');
  assert.equal(partial.quality.conform_passed, null);
  assert.deepEqual(partial.quality.benchmarks, []);
});

test('an experiment that pins a retired evaluation is named, not listed, and does not fail the build', () => {
  const files = tree();
  const current = buildIndex(files, { validators, evaluationIds: new Set(['synthetic-evaluation']) });
  assert.equal(current.counts.entries, 3);
  assert.deepEqual(current.retired_runs, []);
  const retired = buildIndex(files, { validators, evaluationIds: new Set(['another-evaluation']) });
  assert.equal(retired.counts.entries, 0);
  assert.deepEqual(retired.retired_runs, [
    'experiments/exp-base/evaluation/candidate/20261028-080000.json', `experiments/exp-base/evaluation/${BASELINE}/20261028-070000.json`,
    'experiments/exp-derived/evaluation/candidate/20261028-090000.json',
  ]);
  assert.equal('retired_runs' in buildIndex(files, { validators }), false, 'without a filter every report is listed');
});

test('an experiment without reports has nothing to list', () => {
  const files = new Map();
  addExperiments(files);
  assert.equal(buildIndex(files, { validators }).entries.length, 0);
});

test('a mismatched, misnamed, or invalid document stops the build with a reason', () => {
  const failsWith = (change, pattern) => {
    const files = tree();
    change(files);
    assert.throws(() => buildIndex(files, { validators }), error => error instanceof IndexError && pattern.test(error.message), String(pattern));
  };
  const candidate = 'experiments/exp-base/evaluation/candidate/20261028-080000.json';
  failsWith(files => files.set(candidate, `${files.get(candidate)}{`), /is not valid JSON/);
  failsWith(files => {
    const document = JSON.parse(files.get(candidate));
    delete document.tests;
    files.set(candidate, serialize(document));
  }, /not a valid EvaluationReport/);
  failsWith(files => files.set(candidate, serialize({ ...JSON.parse(files.get(candidate)), experiment_id: 'exp-base' })), /not a valid EvaluationReport/);
  failsWith(files => {
    files.set('experiments/exp-base/evaluation/candidate/20261028-123456.json', files.get(candidate));
    files.delete(candidate);
  }, /is not named after its started_at/);
  failsWith(files => files.set('experiments/exp-base/evaluation/candidate/latest.json', files.get(candidate)), /is not named <subject>\/<YYYYMMDD-HHMMSS>\.json/);
  failsWith(files => files.set('experiments/exp-base/evaluation/20261028-080000.json', files.get(candidate)), /is not named <subject>\/<YYYYMMDD-HHMMSS>\.json/);
  failsWith(files => files.set('experiments/exp-base/evaluation/unknown-engine/20261028-080000.json', files.get(candidate)), /neither candidate nor a baseline engine/);
  failsWith(files => files.set(candidate, serialize({ ...JSON.parse(files.get(candidate)), evaluation_revision: commit('9') })), /cites a different evaluation/);
  failsWith(files => files.set('experiments/exp-base/experiment.json', serialize({ ...frozenExperiment(), experiment_id: 'exp-base', status: 'draft-not-run' })), /is not frozen/);
  failsWith(files => {
    put(files, 'experiments/exp-other/experiment.json', { ...frozenExperiment(), experiment_id: 'exp-mismatch' });
    files.set(`experiments/exp-other/evaluation/${BASELINE}/20261028-080000.json`, files.get(candidate));
  }, /not its directory name/);
});

test('the index serializes with one entry per line and without any time or machine detail', () => {
  const index = buildIndex(tree(), { validators, synthetic: true });
  const text = serializeIndex(index);
  assert.deepEqual(JSON.parse(text), index);
  assert.equal(text.split('\n').filter(line => line.startsWith('{"entry_id"')).length, index.entries.length);
  assert.equal(serializeIndex(index), text, 'the output is deterministic');
  assert.doesNotMatch(text, /\b(?:\d{1,3}\.){3}\d{1,3}\b/);
});

test('the report file name is the started_at time in UTC', () => {
  assert.equal(evaluationStamp('2026-10-28T08:00:00Z'), '20261028-080000');
  assert.equal(evaluationStamp('2026-10-28T08:00:00+00:00'), '20261028-080000');
  assert.equal(evaluationStamp('2026-10-28T00:00:00+08:00'), '20261027-160000');
});

test('the command reads experiments/ from a repository root and writes the index', () => {
  const dir = mkdtempSync(join(tmpdir(), 'llm-bootstrap-index-'));
  try {
    const files = tree();
    for (const [path, text] of files) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    assert.equal(loadRecordFiles(dir).size, files.size);
    const out = join(dir, 'index.json');
    let run = spawnSync('node', [cli, dir, '--out', out, '--synthetic', '--require-validation'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const index = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(index.synthetic, true);
    assert.equal(index.counts.entries, 3);

    const empty = mkdtempSync(join(tmpdir(), 'llm-bootstrap-empty-'));
    run = spawnSync('node', [cli, empty, '--out', join(empty, 'index.json')], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.equal(JSON.parse(readFileSync(join(empty, 'index.json'), 'utf8')).counts.entries, 0, 'a repository without reports yields an empty index');
    rmSync(empty, { recursive: true, force: true });

    writeFileSync(join(dir, 'experiments/exp-base/experiment.json'), '{}\n');
    run = spawnSync('node', [cli, dir, '--out', join(dir, 'bad.json')], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /not a valid Experiment/);
    assert.equal(spawnSync('node', [cli], { encoding: 'utf8' }).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
