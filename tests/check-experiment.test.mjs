import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const example = join(root, 'tests', 'fixtures', 'draft-experiment.json');
const cli = join(root, 'skills', 'bootstrap-experiment-sop', 'scripts', 'check-experiment.mjs');
const check = path => {
  const run = spawnSync('node', [cli, path], { encoding: 'utf8' });
  return { status: run.status, text: run.stdout + run.stderr };
};

const fileHash = path => createHash('sha256').update(readFileSync(path)).digest('hex');

const derived = (hash, overrides = {}) => ({
  experiment_id: 'synthetic-derived',
  status: 'draft-not-run',
  description: 'Synthetic derived fixture; not an experiment.',
  contract_frozen_at: null,
  extends_path: 'base.json',
  extends_revision: '1'.repeat(40),
  extends_sha256: hash,
  ...overrides,
});

test('a draft experiment lists its unresolved fields and passes the schema', () => {
  const result = check(example);
  assert.equal(result.status, 0, result.text);
  assert.match(result.text, /status: draft-not-run/);
  assert.match(result.text, /unresolved fields \(\d+\):.*goal_thresholds/);
  assert.match(result.text, /schema: valid Experiment/);
});

test('a frozen experiment with unresolved fields is not ready', () => {
  const dir = mkdtempSync(join(tmpdir(), 'llm-bootstrap-check-'));
  try {
    const path = join(dir, 'experiment.json');
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(example, 'utf8')), status: 'frozen' }));
    const result = check(path);
    assert.equal(result.status, 1, result.text);
    assert.match(result.text, /PROBLEM: a frozen experiment has \d+ unresolved fields/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a derived experiment lists exactly what it changes from its base', () => {
  const dir = mkdtempSync(join(tmpdir(), 'llm-bootstrap-check-'));
  try {
    cpSync(example, join(dir, 'base.json'));
    const path = join(dir, 'derived.json');
    writeFileSync(path, JSON.stringify(derived(fileHash(join(dir, 'base.json')), {
      goal_thresholds: ['decode_tokens_per_second_p50 >= 100'],
      hardware_memory_gib: 64,
      engine_name: 'mine',
    })));
    const result = check(path);
    assert.equal(result.status, 0, result.text);
    assert.match(result.text, /changes from the base \(3\)/);
    assert.match(result.text, /~ goal_thresholds: null -> \["decode_tokens_per_second_p50 >= 100"\]/);
    assert.match(result.text, /~ hardware_memory_gib: 48 -> 64/);
    assert.match(result.text, /~ engine_name: null -> "mine"/);
    assert.doesNotMatch(result.text, /experiment_id/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a changed base, an overridden target model, and a misspelled override are all refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'llm-bootstrap-check-'));
  try {
    cpSync(example, join(dir, 'base.json'));
    const hash = fileHash(join(dir, 'base.json'));
    const path = join(dir, 'derived.json');

    writeFileSync(path, JSON.stringify(derived('0'.repeat(64))));
    let result = check(path);
    assert.equal(result.status, 2, result.text);
    assert.match(result.text, /sha256/);

    writeFileSync(path, JSON.stringify(derived(hash, { target_repository: 'other/model' })));
    result = check(path);
    assert.equal(result.status, 2, result.text);
    assert.match(result.text, /target_repository/);

    writeFileSync(path, JSON.stringify(derived(hash, { hardware_powr: 'x' })));
    result = check(path);
    assert.equal(result.status, 1, result.text);
    assert.match(result.text, /PROBLEM: schema:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
