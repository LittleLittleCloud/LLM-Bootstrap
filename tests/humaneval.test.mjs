import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadValidators } from '../skills/bootstrap-experiment-sop/scripts/validators.mjs';
import { commit, sha } from './helpers/fixtures.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const evaluationDir = join(root, 'evaluations', 'humaneval-20-pi');
const scripts = join(evaluationDir, 'scripts');
const definition = JSON.parse(readFileSync(join(evaluationDir, 'evaluation.json'), 'utf8'));
const { evaluation: evaluationValidators } = await loadValidators();
const fileHash = path => createHash('sha256').update(readFileSync(path)).digest('hex');

const python = (args, options = {}) => execFileSync('python3', args, {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  ...options,
});
const driver = (...args) => python([join(scripts, 'humaneval.py'), ...args]);
const failure = (...args) => {
  try {
    driver(...args);
  } catch (error) {
    return { status: error.status, text: `${error.stdout}${error.stderr}` };
  }
  assert.fail('the driver was expected to fail');
};
const harness = body => python(['-c', [
  'import json, sys, tempfile',
  `sys.path.insert(0, ${JSON.stringify(scripts)})`,
  'import humaneval',
  body,
].join('\n')]);

const dockerReady = (() => {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 30000 });
    return true;
  } catch {
    return false;
  }
})();
const needsDocker = { skip: dockerReady ? false : 'Docker is not available' };

const accepts = value => assert.ok(evaluationValidators.EvaluationResult(value),
  JSON.stringify(evaluationValidators.EvaluationResult.errors, null, 2));
const tmp = () => mkdtempSync(join(tmpdir(), 'llm-bootstrap-humaneval-'));

test('the HumanEval definition is released, pins its inputs, and matches the driver', () => {
  const described = JSON.parse(driver('--describe'));
  assert.ok(evaluationValidators.EvaluationDefinition(definition), JSON.stringify(evaluationValidators.EvaluationDefinition.errors));
  assert.equal(definition.status, 'released');
  assert.deepEqual(described.task_ids, definition.task_ids);
  assert.equal(definition.task_ids.length, 20);
  assert.equal(new Set(definition.task_ids).size, 20);
  assert.deepEqual(described.harness, { name: 'Pi', version: '1.4.0' });
  assert.match(definition.dataset.revision, /^[0-9a-f]{40}$/);
  assert.match(definition.dataset.sha256, /^[0-9a-f]{64}$/);
  assert.ok(definition.scripts.some(script => script.role === 'driver'));
  assert.ok(definition.scripts.some(script => script.role === 'assertion-evaluator'));
  for (const script of definition.scripts) assert.equal(script.sha256, fileHash(join(evaluationDir, script.path)), script.path);
  assert.ok(Object.values(definition.sampling_settings).every(value => ['string', 'number', 'boolean'].includes(typeof value)));
});

test('the negative control passes and emits a valid, consistent EvaluationResult', needsDocker, () => {
  const dir = tmp();
  try {
    const output = join(dir, 'result.json');
    assert.match(driver('--self-test', '--emit-result', output, '--evaluation-revision', commit('9')), /self-test: ok/);
    const result = JSON.parse(readFileSync(output, 'utf8'));
    accepts(result);
    assert.equal(result.evaluation.sha256, fileHash(join(evaluationDir, 'evaluation.json')));
    for (const name of ['prefill', 'decode']) {
      const aggregate = result.metrics[name];
      assert.notEqual(aggregate, 'Not obtained', name);
      assert.ok(Math.abs(aggregate.tokens_per_second - aggregate.total_tokens / aggregate.total_seconds) < 1e-9, `${name} is a ratio of sums`);
    }
    assert.equal(result.metrics.requests_reconciled, true);
    assert.deepEqual(result.repetitions.map(r => `${r.phase}:${r.outcome}`), ['formal:succeeded', 'formal:succeeded']);
    assert.equal(result.quality.application.passed, result.quality.application.total);
    assert.equal(result.quality.application.negative_control_verified, true);
    assert.equal(result.quality.application.restricted_environment, true);
    assert.equal(result.settings.thinking, 'off');

    const evidencePath = join(dir, 'result.requests.evidence');
    assert.equal(result.metrics.per_request_evidence.sha256, fileHash(evidencePath));
    const evidenceText = readFileSync(evidencePath, 'utf8');
    const evidence = JSON.parse(evidenceText);
    assert.equal(evidence.tasks.length, 6);
    assert.ok(evidence.tasks.every(task => task.assertion.status === 'passed'));
    assert.ok(evidence.tasks.every(task => !('_solution' in task) && !('prompt' in task)), 'no prompts or solutions in the evidence');
    assert.ok(!evidenceText.includes('lorem0'), 'no prompt text in the evidence');
    assert.equal(new Set(evidence.tasks.map(task => task.nonce)).size, evidence.tasks.length, 'every task has its own nonce');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('faults are scored or caught, never passed off as measurements', needsDocker, () => {
  const out = JSON.parse(harness([
    'rows = dict(list(humaneval.synthetic_rows().items())[:2])',
    'with tempfile.TemporaryDirectory() as staging:',
    '    wrong = humaneval.reference_run(rows, staging, fault="wrong_solution")',
    '    silent = humaneval.reference_run(rows, staging, fault="no_solution")',
    '    mismatch = humaneval.reference_run(rows, staging, fault="usage_mismatch")',
    '    down = humaneval.reference_run(rows, staging, engine_faults=("http_error",))',
    'def digest(run):',
    '    s = humaneval.summarize(run)',
    '    return {"passed": s["passed"], "total": s["total"], "reconciled": s["requests_reconciled"], "formal": s["formal_repetitions"],',
    '            "problems": [r["problem"] for r in run["results"]]}',
    'print(json.dumps({k: digest(v) for k, v in {"wrong": wrong, "silent": silent, "mismatch": mismatch, "down": down}.items()}))',
  ].join('\n')));
  assert.deepEqual([out.wrong.passed, out.wrong.total, out.wrong.formal], [0, 2, 1], 'a wrong solution runs cleanly and fails its test');
  assert.equal(out.wrong.reconciled, true);
  assert.deepEqual([out.silent.passed, out.silent.total, out.silent.formal], [0, 2, 1], 'a missing solution fails the task, not the pass');
  assert.equal(out.mismatch.reconciled, false, 'usage that disagrees with the wire is unreconciled');
  assert.equal(out.mismatch.passed, 2);
  assert.deepEqual([out.down.passed, out.down.formal], [0, 0]);
});

test('the driver refuses a missing option, a bad endpoint, a wrong Pi version, and unknown tasks', () => {
  const dir = tmp();
  try {
    const fakePi = (name, version) => {
      const path = join(dir, name);
      writeFileSync(path, `#!/bin/sh\necho ${version}\n`);
      chmodSync(path, 0o755);
      return path;
    };
    const pinnedPi = fakePi('pi-pinned', '1.4.0');
    const otherPi = fakePi('pi-other', '9.9.9');
    const base = [
      '--endpoint', 'http://127.0.0.1:9', '--model', 'm', '--role', 'baseline', '--engine-name', 'e', '--warmup', '0',
      '--repetitions', '1', '--evaluation-revision', commit('9'), '--artifact', `engine=${sha('a')}`, '--hardware-model', 'h',
      '--toolchain', 't', '--power-mode', 'p', '--thermal-observations', 'n', '--output', join(dir, 'result.json'),
      '--pi', pinnedPi,
    ];
    assert.match(failure(...base.map(arg => (arg === pinnedPi ? otherPi : arg))).text, /pins Pi 1\.4\.0/);
    assert.match(failure(...base, '--tasks', 'HumanEval/156,HumanEval/0').text, /Unknown task\(s\): HumanEval\/0/);
    assert.match(failure(...base.map(arg => (arg === 'http://127.0.0.1:9' ? 'http://example.com' : arg))).text, /Plain http/);
    assert.match(failure(...base.map(arg => (arg === 'http://127.0.0.1:9' ? 'https://example.com' : arg))).text, /not on loopback/);
    assert.match(failure(...base.slice(2)).text, /Missing required options: --endpoint/);
    assert.match(failure(...base.map(arg => (arg === '1' ? '0' : arg))).text, /--repetitions must be 1 or more/);
    assert.match(failure(...base.map(arg => (arg === `engine=${sha('a')}` ? 'engine=zz' : arg))).text, /--artifact must look like/);
    writeFileSync(join(dir, 'result.json'), '{}');
    assert.match(failure(...base).text, /must be new files/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a modified script no longer matches its recorded hash and is refused', () => {
  const dir = tmp();
  try {
    const copy = join(dir, 'humaneval-20-pi');
    cpSync(evaluationDir, copy, { recursive: true });
    writeFileSync(join(copy, 'scripts', 'assertions.py'), `${readFileSync(join(copy, 'scripts', 'assertions.py'), 'utf8')}\n# changed\n`);
    try {
      python([join(copy, 'scripts', 'humaneval.py'), '--endpoint', 'http://127.0.0.1:9']);
      assert.fail('the driver was expected to fail');
    } catch (error) {
      assert.match(`${error.stderr}`, /does not match its recorded hash/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
