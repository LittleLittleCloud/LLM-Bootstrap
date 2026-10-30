import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { IndexError, buildIndex, loadRecordFiles, qualityGate, serializeIndex } from '../tools/leaderboard/build-index.mjs';
import { loadValidators } from '../skills/bootstrap-experiment-sop/scripts/validators.mjs';
import { commit, frozenContract, sha, syntheticResult, syntheticRun, unavailable, when } from './helpers/fixtures.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'tools', 'leaderboard', 'build-index.mjs');
const validators = await loadValidators();
const digest = text => createHash('sha256').update(text).digest('hex');
const serialize = document => `${JSON.stringify(document, null, 2)}\n`;

function result(role, engine, patch = {}) {
  const document = syntheticResult();
  Object.assign(document, { role, engine_name: engine, runtime_revision: role === 'baseline' ? commit('6') : unavailable('Not exposed by the runtime.') }, patch);
  document.environment.hardware_model = 'fixture-hardware';
  document.metrics.client_ttft_median_seconds = 0.5;
  document.resources.peak_memory_gib = 12;
  return document;
}

function put(files, path, document) {
  const text = serialize(document);
  files.set(path, text);
  return digest(text);
}

// experiment -> pinned contract hash, so a run can cite it.
function addContracts(files) {
  const base = { ...frozenContract(), experiment_id: 'exp-base' };
  const baseHash = put(files, 'experiments/exp-base/contract.json', base);
  const derived = {
    experiment_id: 'exp-derived', status: 'frozen', description: 'Synthetic derived fixture.', contract_frozen_at: when,
    extends: { path: '../exp-base/contract.json', revision: commit('5'), sha256: baseHash },
    overrides: { builder: { model: 'other-builder' } },
  };
  return { 'exp-base': baseHash, 'exp-derived': put(files, 'experiments/exp-derived/contract.json', derived) };
}

function addRun(files, hashes, experiment, runId, results, patch = {}) {
  const dir = `experiments/${experiment}/runs/${runId}`;
  const refs = results.map(item => {
    const path = `${dir}/${item.role}-${item.engine_name}.json`;
    return { role: item.role, engine_name: item.engine_name, path, sha256: put(files, path, item) };
  });
  const run = {
    ...syntheticRun(), run_id: runId, contract: { path: `experiments/${experiment}/contract.json`, revision: commit('4'), sha256: hashes[experiment] },
    evaluation_results: refs, human_interventions: [{ timestamp: when, kind: 'debugging', purpose: 'synthetic' }], ...patch,
  };
  put(files, `${dir}/run.json`, run);
}

function tree() {
  const files = new Map();
  const hashes = addContracts(files);
  addRun(files, hashes, 'exp-base', 'run-1', [result('candidate', 'fixture-engine'), result('baseline', 'fixture-baseline')]);
  addRun(files, hashes, 'exp-derived', 'run-2', [result('candidate', 'fixture-engine')], { acceptance: 'unverified' });
  return { files, hashes };
}

test('runs and their results project into one entry per result, with derived contracts resolved', () => {
  const { files } = tree();
  const index = buildIndex(files, { validators });
  assert.deepEqual(index.counts, { runs: 2, experiments: 2, entries: 3 });
  assert.equal(index.synthetic, false);
  const byId = Object.fromEntries(index.entries.map(e => [e.entry_id, e]));
  const candidate = byId['run-1/candidate/fixture-engine'];
  assert.equal(candidate.experiment_id, 'exp-base');
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
  const baseline = byId['run-1/baseline/fixture-baseline'];
  assert.equal(baseline.builder, null, 'a baseline was not built by the builder');
  assert.equal(baseline.engine.revision, commit('6'));
  const derived = byId['run-2/candidate/fixture-engine'];
  assert.equal(derived.derived_from, 'exp-base');
  assert.equal(derived.builder, 'other-builder', 'the override applies to the effective contract');
  assert.equal(derived.target_model, candidate.target_model);
});

test('the quality gate compares a verified candidate with the baselines of its run, within two standard errors', () => {
  const scored = (role, score, patch = {}) => {
    const r = result(role, role);
    r.quality.intelligence = { benchmarks: [{ benchmark_id: 'humaneval', metric: 'accuracy/pass_at_k(k=1)', score, num_samples: 164, stderr: Math.sqrt(score * (1 - score) / 164) }],
      complete: true, negative_control_verified: true, restricted_environment: true, ...patch };
    return r;
  };
  const baselines = [scored('baseline', 0.9)];
  assert.equal(qualityGate(scored('candidate', 0.9), 'completed', baselines), 'passed');
  assert.equal(qualityGate(scored('candidate', 0.86), 'completed', baselines), 'passed', 'a difference within noise passes');
  assert.equal(qualityGate(scored('candidate', 0.5), 'completed', baselines), 'failed');
  assert.equal(qualityGate(scored('candidate', 0.9), 'completed', []), 'unverified', 'a candidate without a baseline cannot be judged');
  assert.equal(qualityGate(scored('baseline', 0.1), 'completed', []), 'passed', 'a verified baseline defines the reference');
  assert.equal(qualityGate(scored('candidate', 0.9, { negative_control_verified: false }), 'completed', baselines), 'unverified');
  assert.equal(qualityGate(scored('candidate', 0.9, { restricted_environment: false }), 'completed', baselines), 'unverified');
  assert.equal(qualityGate(scored('candidate', 0.9, { complete: false }), 'completed', baselines), 'unverified');
  assert.equal(qualityGate(scored('candidate', 0.9), 'interrupted', baselines), 'unverified');
  const none = scored('candidate', 0.9);
  none.quality.intelligence = 'Not obtained';
  assert.equal(qualityGate(none, 'completed', baselines), 'unverified');
});

test('missing metrics and an unavailable intervention log stay null, never zero', () => {
  const files = new Map();
  const hashes = addContracts(files);
  const interrupted = result('candidate', 'fixture-engine');
  Object.assign(interrupted.metrics, { prefill: 'Not obtained', decode: 'Not obtained', client_ttft_median_seconds: 'Not obtained',
    formal_repetitions: 0, preliminary: true, requests_reconciled: false });
  Object.assign(interrupted.resources, { peak_memory_gib: 'Not obtained' });
  interrupted.quality.intelligence = 'Not obtained';
  addRun(files, hashes, 'exp-base', 'run-1', [interrupted], { status: 'interrupted', human_interventions: unavailable('No log was kept.') });
  const [entry] = buildIndex(files, { validators }).entries;
  assert.equal(entry.run_status, 'interrupted');
  assert.equal(entry.quality_gate, 'unverified');
  assert.equal(entry.quality.benchmarks, null);
  assert.deepEqual([entry.metrics.decode_tok_s, entry.metrics.decode_basis, entry.metrics.prefill_tok_s, entry.metrics.client_ttft_median_s,
    entry.metrics.concurrent_output_tok_s, entry.metrics.peak_memory_gib], [null, null, null, null, null, null]);
  assert.equal(entry.autonomy.human_interventions, null);
  assert.equal(entry.autonomy.hardware_hours, null);
});

test('drafts and runs still in progress are not listed', () => {
  const files = new Map();
  const hashes = addContracts(files);
  addRun(files, hashes, 'exp-base', 'run-1', [result('candidate', 'fixture-engine')], { status: 'running', ended_at: null });
  addRun(files, hashes, 'exp-base', 'run-2', [result('candidate', 'fixture-engine')], { status: 'draft', started_at: null, ended_at: null });
  assert.equal(buildIndex(files, { validators }).entries.length, 0);
});

test('a tampered, missing, mismatched, or invalid document stops the build with a reason', () => {
  const failsWith = (change, pattern) => {
    const { files, hashes } = tree();
    change(files, hashes);
    assert.throws(() => buildIndex(files, { validators }), error => error instanceof IndexError && pattern.test(error.message), String(pattern));
  };
  failsWith(files => files.set('experiments/exp-base/runs/run-1/candidate-fixture-engine.json', `${files.get('experiments/exp-base/runs/run-1/candidate-fixture-engine.json')} `), /does not match the sha256 pinned/);
  failsWith(files => files.set('experiments/exp-base/contract.json', `${files.get('experiments/exp-base/contract.json')} `), /does not match the sha256 pinned/);
  failsWith(files => files.delete('experiments/exp-base/runs/run-1/baseline-fixture-baseline.json'), /missing file/);
  failsWith(files => {
    const path = 'experiments/exp-base/runs/run-1/run.json';
    const run = JSON.parse(files.get(path));
    delete run.interpretation;
    files.set(path, serialize(run));
  }, /not a valid ExperimentRun/);
  failsWith((files, hashes) => {
    const document = result('candidate', 'fixture-engine');
    document.evaluation = { ...document.evaluation, revision: commit('9') };
    const path = 'experiments/exp-base/runs/run-1/candidate-fixture-engine.json';
    const sha256 = put(files, path, document);
    const runPath = 'experiments/exp-base/runs/run-1/run.json';
    const run = JSON.parse(files.get(runPath));
    run.evaluation_results.find(item => item.role === 'candidate').sha256 = sha256;
    files.set(runPath, serialize(run));
  }, /cites a different evaluation/);
  failsWith((files, hashes) => {
    const draft = { ...frozenContract(), experiment_id: 'exp-base', status: 'draft-not-run' };
    hashes['exp-base'] = put(files, 'experiments/exp-base/contract.json', draft);
    const runPath = 'experiments/exp-base/runs/run-1/run.json';
    const run = JSON.parse(files.get(runPath));
    run.contract.sha256 = hashes['exp-base'];
    files.set(runPath, serialize(run));
  }, /is not frozen/);
});

test('the index serializes with one entry per line and without any time or machine detail', () => {
  const index = buildIndex(tree().files, { validators, synthetic: true });
  const text = serializeIndex(index);
  assert.deepEqual(JSON.parse(text), index);
  assert.equal(text.split('\n').filter(line => line.startsWith('{"entry_id"')).length, index.entries.length);
  assert.equal(serializeIndex(index), text, 'the output is deterministic');
  assert.doesNotMatch(text, /\b(?:\d{1,3}\.){3}\d{1,3}\b/);
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

    writeFileSync(join(dir, 'experiments/exp-base/contract.json'), '{}\n');
    run = spawnSync('node', [cli, dir, '--out', join(dir, 'bad.json')], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /does not match the sha256 pinned/);
    assert.equal(spawnSync('node', [cli], { encoding: 'utf8' }).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
