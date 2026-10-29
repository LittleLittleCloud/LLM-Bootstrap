import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const example = join(root, 'tests', 'fixtures', 'draft-contract.json');
const cli = join(root, 'skills', 'bootstrap-experiment-sop', 'scripts', 'check-experiment.mjs');
const check = path => {
  const run = spawnSync('node', [cli, path], { encoding: 'utf8' });
  return { status: run.status, text: run.stdout + run.stderr };
};

const fileHash = path => createHash('sha256').update(readFileSync(path)).digest('hex');

const derived = (hash, overrides, extra = {}) => ({
  experiment_id: 'synthetic-derived',
  status: 'draft-not-run',
  description: 'Synthetic derived fixture; not an experiment.',
  contract_frozen_at: null,
  extends: { path: 'base.json', revision: '1'.repeat(40), sha256: hash },
  overrides,
  ...extra,
});

test('a draft contract lists its unresolved fields and passes the schema', () => {
  const result = check(example);
  assert.equal(result.status, 0, result.text);
  assert.match(result.text, /status: draft-not-run/);
  assert.match(result.text, /unresolved fields \(\d+\):.*goal\.primary_metric/);
  assert.match(result.text, /schema: valid ExperimentContract/);
});

test('a frozen contract with unresolved fields is not ready', () => {
  const dir = mkdtempSync(join(tmpdir(), 'llm-bootstrap-check-'));
  try {
    const path = join(dir, 'contract.json');
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(example, 'utf8')), status: 'frozen' }));
    const result = check(path);
    assert.equal(result.status, 1, result.text);
    assert.match(result.text, /PROBLEM: a frozen contract has \d+ unresolved fields/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a derived contract lists exactly what it changes from its base', () => {
  const dir = mkdtempSync(join(tmpdir(), 'llm-bootstrap-check-'));
  try {
    cpSync(example, join(dir, 'base.json'));
    const path = join(dir, 'derived.json');
    writeFileSync(path, JSON.stringify(derived(fileHash(join(dir, 'base.json')), {
      goal: { primary_metric: 'decode tok/s', self_hosting_in_scope: true },
      budget: { wall_clock_hours: 8 },
    })));
    const result = check(path);
    assert.equal(result.status, 0, result.text);
    assert.match(result.text, /changes from the base \(3\)/);
    assert.match(result.text, /~ goal\.primary_metric: null -> "decode tok\/s"/);
    assert.match(result.text, /~ goal\.self_hosting_in_scope: false -> true/);
    assert.match(result.text, /~ budget\.wall_clock_hours: null -> 8/);
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

    writeFileSync(path, JSON.stringify(derived('0'.repeat(64), {})));
    let result = check(path);
    assert.equal(result.status, 2, result.text);
    assert.match(result.text, /sha256/);

    writeFileSync(path, JSON.stringify(derived(hash, { target_model: { repository: 'other/model' } })));
    result = check(path);
    assert.equal(result.status, 2, result.text);
    assert.match(result.text, /target_model/);

    writeFileSync(path, JSON.stringify(derived(hash, { hardwre: { power: 'x' } })));
    result = check(path);
    assert.equal(result.status, 1, result.text);
    assert.match(result.text, /PROBLEM: schema:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
