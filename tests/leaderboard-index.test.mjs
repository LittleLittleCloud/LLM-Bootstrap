import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { IndexError, benchmarksOf, buildIndex, evaluationStamp, loadRecordFiles, qualityGate, serializeIndex } from '../tools/leaderboard/build-index.mjs';
import { loadValidators } from '../skills/bootstrap-experiment-sop/scripts/validators.mjs';
import { commit, frozenExperiment, startedAt, syntheticResult, when } from './helpers/fixtures.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'tools', 'leaderboard', 'build-index.mjs');
const validators = await loadValidators();
const digest = text => createHash('sha256').update(text).digest('hex');
const serialize = document => `${JSON.stringify(document, null, 2)}\n`;
const at = hour => `2026-10-28T${hour}:00:00Z`;
const recordPath = (experiment, document) => `experiments/${experiment}/evaluation/${evaluationStamp(document.started_at)}.json`;

function result(role, engine, patch = {}, started = startedAt) {
  return {
    ...syntheticResult(started), role, engine_name: engine, runtime_revision: role === 'baseline' ? commit('6') : 'Unavailable: Not exposed by the runtime.',
    environment_hardware_model: 'fixture-hardware', client_ttft_median_seconds: 0.5, peak_memory_gib: 12, ...patch,
  };
}

function put(files, path, document) {
  const text = serialize(document);
  files.set(path, text);
  return digest(text);
}

// experiment -> hash of its experiment.json, so a record can pin it.
function addExperiments(files) {
  const base = { ...frozenExperiment(), experiment_id: 'exp-base' };
  const baseHash = put(files, 'experiments/exp-base/experiment.json', base);
  const derived = {
    experiment_id: 'exp-derived', status: 'frozen', description: 'Synthetic derived fixture.', contract_frozen_at: when,
    extends_path: '../exp-base/experiment.json', extends_revision: commit('5'), extends_sha256: baseHash, builder_model: 'other-builder',
  };
  return { 'exp-base': baseHash, 'exp-derived': put(files, 'experiments/exp-derived/experiment.json', derived) };
}

function addRecord(files, hashes, experiment, document) {
  const pinned = { ...document, experiment_id: experiment, experiment_sha256: hashes[experiment] };
  const path = recordPath(experiment, pinned);
  put(files, path, pinned);
  return path;
}

function tree() {
  const files = new Map();
  const hashes = addExperiments(files);
  addRecord(files, hashes, 'exp-base', result('candidate', 'fixture-engine', { human_interventions: 1 }, at('08')));
  addRecord(files, hashes, 'exp-base', result('baseline', 'fixture-baseline', {}, at('07')));
  addRecord(files, hashes, 'exp-derived', result('candidate', 'fixture-engine', {}, at('09')));
  return { files, hashes };
}

test('evaluation records project into one entry each, with derived experiments resolved', () => {
  const { files } = tree();
  const index = buildIndex(files, { validators });
  assert.deepEqual(index.counts, { runs: 3, experiments: 2, entries: 3 });
  assert.equal(index.synthetic, false);
  const byId = Object.fromEntries(index.entries.map(e => [e.entry_id, e]));
  const candidate = byId['exp-base/20261028-080000/candidate/fixture-engine'];
  assert.equal(candidate.experiment_id, 'exp-base');
  assert.equal(candidate.run_id, 'exp-base/20261028-080000');
  assert.equal(candidate.derived_from, null);
  assert.equal(candidate.builder, 'synthetic-builder');
  assert.equal(candidate.hardware, 'fixture-hardware');
  assert.equal(candidate.target_model, 'mlx-community/Qwen3.6-35B-A3B-8bit');
  assert.equal(candidate.harness, 'Pi 1.4.0');
  assert.equal(candidate.evaluation, 'synthetic-evaluation');
  assert.equal(candidate.comparison_track, 'matched-configuration');
  assert.equal(candidate.engine.revision, null, 'an unavailable runtime revision stays null');
  assert.deepEqual([candidate.metrics.decode_tok_s, candidate.metrics.decode_basis, candidate.metrics.client_ttft_median_s, candidate.metrics.peak_memory_gib], [9, 'n-minus-1-intervals', 0.5, 12]);
  assert.equal(candidate.autonomy.human_interventions, 1);
  assert.equal(candidate.quality_gate, 'passed');
  assert.deepEqual(candidate.source, { experiment: 'experiments/exp-base/experiment.json', evaluation: 'experiments/exp-base/evaluation/20261028-080000.json' });
  const baseline = byId['exp-base/20261028-070000/baseline/fixture-baseline'];
  assert.equal(baseline.builder, null, 'a baseline was not built by the builder');
  assert.equal(baseline.engine.revision, commit('6'));
  const derived = byId['exp-derived/20261028-090000/candidate/fixture-engine'];
  assert.equal(derived.derived_from, 'exp-base');
  assert.equal(derived.builder, 'other-builder', 'the override applies to the effective experiment');
  assert.equal(derived.target_model, candidate.target_model);
});

test('the quality gate compares a verified candidate with the baselines of its experiment, within two standard errors', () => {
  const scored = (role, score, patch = {}) => {
    const record = Object.fromEntries(Object.entries(result(role, role)).filter(([key]) => !key.startsWith('intelligence.')));
    return {
      ...record, 'intelligence.humaneval.metric': 'accuracy/pass_at_k(k=1)', 'intelligence.humaneval.score': score,
      'intelligence.humaneval.num_samples': 164, 'intelligence.humaneval.stderr': Math.sqrt(score * (1 - score) / 164), ...patch,
    };
  };
  const baselines = [scored('baseline', 0.9)];
  assert.deepEqual(benchmarksOf(baselines[0]).map(item => item.benchmark_id), ['humaneval']);
  assert.equal(qualityGate(scored('candidate', 0.9), baselines), 'passed');
  assert.equal(qualityGate(scored('candidate', 0.86), baselines), 'passed', 'a difference within noise passes');
  assert.equal(qualityGate(scored('candidate', 0.5), baselines), 'failed');
  assert.equal(qualityGate(scored('candidate', 0.9), []), 'unverified', 'a candidate without a baseline cannot be judged');
  assert.equal(qualityGate(scored('baseline', 0.1), []), 'passed', 'a verified baseline defines the reference');
  assert.equal(qualityGate(scored('candidate', 0.9, { negative_control_verified: false }), baselines), 'unverified');
  assert.equal(qualityGate(scored('candidate', 0.9, { restricted_environment: false }), baselines), 'unverified');
  assert.equal(qualityGate(scored('candidate', 0.9, { intelligence_complete: false }), baselines), 'unverified');
  const none = Object.fromEntries(Object.entries(scored('candidate', 0.9)).filter(([key]) => !key.startsWith('intelligence.')));
  assert.equal(qualityGate(none, baselines), 'unverified');
});

test('missing metrics and an unavailable intervention log stay null, never zero', () => {
  const files = new Map();
  const hashes = addExperiments(files);
  const interrupted = result('candidate', 'fixture-engine', {
    prefill_tokens_per_second: 'Not obtained', prefill_basis: 'Not obtained', decode_tokens_per_second: 'Not obtained', decode_basis: 'Not obtained',
    client_ttft_median_seconds: 'Not obtained', peak_memory_gib: 'Not obtained', formal_passes_succeeded: 0, formal_passes_failed: 1,
    failures: ['formal pass 0 interrupted: interrupted'], preliminary: true, requests_reconciled: false, intelligence_complete: false,
  });
  for (const key of Object.keys(interrupted)) if (key.startsWith('intelligence.')) delete interrupted[key];
  addRecord(files, hashes, 'exp-base', interrupted);
  const [entry] = buildIndex(files, { validators }).entries;
  assert.equal(entry.quality_gate, 'unverified');
  assert.equal(entry.quality.benchmarks, null);
  assert.deepEqual([entry.metrics.decode_tok_s, entry.metrics.decode_basis, entry.metrics.prefill_tok_s, entry.metrics.client_ttft_median_s,
    entry.metrics.concurrent_output_tok_s, entry.metrics.peak_memory_gib], [null, null, null, null, null, null]);
  assert.equal(entry.autonomy.human_interventions, null);
  assert.equal(entry.autonomy.hardware_hours, null);
});

test('an experiment that pins a retired evaluation is named, not listed, and does not fail the build', () => {
  const { files } = tree();
  const current = buildIndex(files, { validators, evaluationIds: new Set(['synthetic-evaluation']) });
  assert.equal(current.counts.entries, 3);
  assert.deepEqual(current.retired_runs, []);
  const retired = buildIndex(files, { validators, evaluationIds: new Set(['another-evaluation']) });
  assert.equal(retired.counts.entries, 0);
  assert.deepEqual(retired.retired_runs, [
    'experiments/exp-base/evaluation/20261028-070000.json', 'experiments/exp-base/evaluation/20261028-080000.json',
    'experiments/exp-derived/evaluation/20261028-090000.json',
  ]);
  assert.equal('retired_runs' in buildIndex(files, { validators }), false, 'without a filter every record is listed');
});

test('an experiment without evaluation records has nothing to list', () => {
  const files = new Map();
  addExperiments(files);
  assert.equal(buildIndex(files, { validators }).entries.length, 0);
});

test('a tampered, mismatched, misnamed, or invalid document stops the build with a reason', () => {
  const failsWith = (change, pattern) => {
    const { files, hashes } = tree();
    change(files, hashes);
    assert.throws(() => buildIndex(files, { validators }), error => error instanceof IndexError && pattern.test(error.message), String(pattern));
  };
  const candidatePath = 'experiments/exp-base/evaluation/20261028-080000.json';
  failsWith(files => files.set('experiments/exp-base/experiment.json', `${files.get('experiments/exp-base/experiment.json')} `), /sha256 pinned/);
  failsWith(files => files.set(candidatePath, `${files.get(candidatePath)} `.replace(/\n $/, '\n{')), /is not valid JSON/);
  failsWith(files => {
    const record = JSON.parse(files.get(candidatePath));
    delete record.evidence_sha256;
    files.set(candidatePath, serialize(record));
  }, /not a valid EvaluationResult/);
  failsWith(files => {
    files.set('experiments/exp-base/evaluation/20261028-123456.json', files.get(candidatePath));
    files.delete(candidatePath);
  }, /is not named after its started_at/);
  failsWith(files => {
    files.set('experiments/exp-base/evaluation/latest.json', files.get(candidatePath));
  }, /is not named <YYYYMMDD-HHMMSS>\.json/);
  failsWith(files => {
    const record = JSON.parse(files.get(candidatePath));
    files.set(candidatePath, serialize({ ...record, experiment_id: 'exp-derived' }));
  }, /sha256 pinned/);
  failsWith(files => {
    const record = JSON.parse(files.get(candidatePath));
    files.set(candidatePath, serialize({ ...record, evaluation_revision: commit('9') }));
  }, /cites a different evaluation/);
  failsWith((files, hashes) => {
    hashes['exp-base'] = put(files, 'experiments/exp-base/experiment.json', { ...frozenExperiment(), experiment_id: 'exp-base', status: 'draft-not-run' });
    for (const path of [...files.keys()].filter(item => item.startsWith('experiments/exp-base/evaluation/'))) {
      files.set(path, serialize({ ...JSON.parse(files.get(path)), experiment_sha256: hashes['exp-base'] }));
    }
  }, /is not frozen/);
  failsWith(files => {
    put(files, 'experiments/exp-other/experiment.json', { ...frozenExperiment(), experiment_id: 'exp-mismatch' });
    files.set('experiments/exp-other/evaluation/20261028-080000.json', files.get(candidatePath));
  }, /not its directory name/);
});

test('the index serializes with one entry per line and without any time or machine detail', () => {
  const index = buildIndex(tree().files, { validators, synthetic: true });
  const text = serializeIndex(index);
  assert.deepEqual(JSON.parse(text), index);
  assert.equal(text.split('\n').filter(line => line.startsWith('{"entry_id"')).length, index.entries.length);
  assert.equal(serializeIndex(index), text, 'the output is deterministic');
  assert.doesNotMatch(text, /\b(?:\d{1,3}\.){3}\d{1,3}\b/);
});

test('the evaluation file name is the started_at time in UTC', () => {
  assert.equal(evaluationStamp('2026-10-28T08:00:00Z'), '20261028-080000');
  assert.equal(evaluationStamp('2026-10-28T08:00:00+00:00'), '20261028-080000');
  assert.equal(evaluationStamp('2026-10-28T00:00:00+08:00'), '20261027-160000');
});

test('the command reads experiments/ from a repository root and writes the index', () => {
  const dir = mkdtempSync(join(tmpdir(), 'llm-bootstrap-index-'));
  try {
    for (const [path, text] of tree().files) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    assert.equal(loadRecordFiles(dir).size, tree().files.size);
    const out = join(dir, 'index.json');
    let run = spawnSync('node', [cli, dir, '--out', out, '--synthetic', '--require-validation'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const index = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(index.synthetic, true);
    assert.equal(index.counts.entries, 3);

    const empty = mkdtempSync(join(tmpdir(), 'llm-bootstrap-empty-'));
    run = spawnSync('node', [cli, empty, '--out', join(empty, 'index.json')], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.equal(JSON.parse(readFileSync(join(empty, 'index.json'), 'utf8')).counts.entries, 0, 'a repository without records yields an empty index');
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
