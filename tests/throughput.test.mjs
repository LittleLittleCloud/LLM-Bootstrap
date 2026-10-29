import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadValidators } from '../skills/bootstrap-experiment-sop/scripts/validators.mjs';
import { commit, sha } from './helpers/fixtures.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const evaluationDir = join(root, 'evaluations', 'engine-throughput');
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
const driver = (...args) => python([join(scripts, 'throughput.py'), ...args]);
const failure = (...args) => {
  try {
    driver(...args);
  } catch (error) {
    return { status: error.status, text: `${error.stdout}${error.stderr}` };
  }
  assert.fail('the driver was expected to fail');
};
const withReference = (body, faults = []) => python(['-c', [
  'import json, sys',
  `sys.path.insert(0, ${JSON.stringify(scripts)})`,
  'import throughput',
  'from reference_engine import ReferenceEngine',
  `with ReferenceEngine(40000.0, 800.0, ${JSON.stringify(faults)}) as engine:`,
  ...body.split('\n').map(line => `    ${line}`),
].join('\n')]);

const accepts = value => assert.ok(evaluationValidators.EvaluationResult(value), JSON.stringify(evaluationValidators.EvaluationResult.errors, null, 2));
const tmp = () => mkdtempSync(join(tmpdir(), 'llm-bootstrap-throughput-'));

function assertConsistent(result) {
  for (const name of ['prefill', 'decode']) {
    const aggregate = result.metrics[name];
    assert.notEqual(aggregate, 'Not obtained', name);
    assert.ok(Math.abs(aggregate.tokens_per_second - aggregate.total_tokens / aggregate.total_seconds) < 1e-9, `${name} is a ratio of sums`);
  }
}

test('the throughput definition lists exactly the driver workloads and limits', () => {
  const described = JSON.parse(driver('--describe'));
  assert.deepEqual(definition.task_ids, described.task_ids);
  assert.equal(definition.limits.max_output_tokens_per_request, described.limits.max_output_tokens_per_request);
  assert.equal(definition.limits.request_concurrency, described.limits.request_concurrency);
  assert.equal(definition.result_schema, 'EvaluationResult');
  for (const [id, workload] of Object.entries(described.workloads)) {
    assert.ok(id.includes(`in${workload.input_tokens}`) && id.endsWith(`out${workload.output_tokens}`), `${id} names its lengths`);
    assert.ok(workload.input_tokens + workload.output_tokens < definition.limits.context_window, `${id} fits the context window`);
  }
});

test('the negative control passes and emits a valid, consistent EvaluationResult', () => {
  const dir = tmp();
  try {
    const output = join(dir, 'result.json');
    assert.match(driver('--self-test', '--emit-result', output, '--evaluation-revision', commit('9')), /self-test: ok/);
    const result = JSON.parse(readFileSync(output, 'utf8'));
    accepts(result);
    assertConsistent(result);
    assert.equal(result.evaluation.sha256, fileHash(join(evaluationDir, 'evaluation.json')));
    assert.equal(result.metrics.prefill.basis, 'processed-input-tokens');
    assert.equal(result.metrics.decode.basis, 'n-minus-1-intervals');
    assert.equal(result.metrics.requests_reconciled, true);
    assert.deepEqual(result.repetitions.map(r => `${r.phase}:${r.outcome}`), ['warm-up:succeeded', 'formal:succeeded', 'formal:succeeded']);
    assert.equal(result.quality.application.passed, result.quality.application.total);
    assert.equal(result.quality.application.negative_control_verified, true);

    const evidencePath = join(dir, 'result.requests.evidence');
    assert.equal(result.metrics.per_request_evidence.sha256, fileHash(evidencePath));
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    assert.ok(evidence.requests.some(r => r.phase === 'calibration'));
    assert.ok(evidence.requests.every(r => !('prompt' in r) && !('content' in r)), 'no prompts or model output in the evidence');
    assert.equal(new Set(evidence.requests.map(r => r.nonce)).size, evidence.requests.length, 'every prompt has its own nonce');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the real command line measures a reference engine and records the request fields it added', () => {
  const dir = tmp();
  try {
    const output = join(dir, 'result.json');
    const args = [
      '--endpoint', '@ORIGIN@', '--model', 'reference-model', '--role', 'candidate', '--engine-name', 'reference',
      '--warmup', '0', '--repetitions', '2', '--evaluation-revision', commit('9'), '--artifact', `engine=${sha('a')}`,
      '--hardware-model', 'test hardware', '--toolchain', 'test toolchain', '--power-mode', 'test power', '--thermal-observations', 'none',
      '--exclusive-gpu', '--request-field', 'top_k=1', '--output', output,
    ];
    const argv = ['throughput.py', ...args].map(arg => (arg === '@ORIGIN@' ? 'engine.origin' : JSON.stringify(arg))).join(', ');
    withReference(`sys.argv = [${argv}]\nraise SystemExit(throughput.main())`);
    const result = JSON.parse(readFileSync(output, 'utf8'));
    accepts(result);
    assertConsistent(result);
    assert.equal(result.role, 'candidate');
    assert.equal(result.settings['request_field.top_k'], 1);
    assert.equal(result.settings.endpoint_host_class, 'loopback');
    assert.equal(result.environment.exclusive_gpu, true);
    assert.equal(result.metrics.formal_repetitions, 2);
    assert.equal(result.metrics.preliminary, false);
    assert.ok(existsSync(join(dir, 'result.requests.evidence')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('injected faults fail their passes or withhold the metric instead of being measured', () => {
  const run = fault => JSON.parse(withReference([
    'run = throughput.execute(engine.origin, engine.model, None, 30.0, 0, 2, {}, 0, "test")',
    'summary = throughput.summarize(run)',
    'print(json.dumps({"passes": run["passes"], "summary": summary}))',
  ].join('\n'), [fault]));

  const cached = run('reports_cached');
  assert.ok(cached.passes.every(p => p.outcome === 'failed' && p.failure_description.includes('cached')));
  assert.equal(cached.summary.prefill, 'Not obtained');
  assert.equal(cached.summary.formal_repetitions, 0);

  const short = run('stops_early');
  assert.ok(short.passes.every(p => p.outcome === 'failed' && p.failure_description.includes('output tokens')));
  assert.equal(short.summary.decode, 'Not obtained');
  assert.ok(short.summary.passed_requests < short.summary.total_requests);

  const coalesced = run('coalesced_chunks');
  assert.ok(coalesced.passes.every(p => p.outcome === 'succeeded'));
  assert.equal(coalesced.summary.decode, 'Not obtained');
  assert.match(coalesced.summary.notes.decode_not_obtained_reason, /chunks per token/);
  assert.notEqual(coalesced.summary.prefill, 'Not obtained');
});

test('the driver refuses what the evaluation fixes, remote plain http, and a missing option', () => {
  const dir = tmp();
  try {
    const base = [
      '--endpoint', 'http://127.0.0.1:9', '--model', 'm', '--role', 'baseline', '--engine-name', 'e', '--warmup', '0', '--repetitions', '1',
      '--evaluation-revision', commit('9'), '--artifact', `engine=${sha('a')}`, '--hardware-model', 'h', '--toolchain', 't',
      '--power-mode', 'p', '--thermal-observations', 'n', '--output', join(dir, 'result.json'),
    ];
    assert.match(failure(...base, '--request-field', 'max_tokens=5').text, /fixed by the evaluation/);
    assert.match(failure(...base, '--request-field', 'top_k=[1]').text, /scalar/);
    assert.match(failure(...base.map(arg => (arg === 'http://127.0.0.1:9' ? 'http://example.com' : arg))).text, /Plain http/);
    assert.match(failure(...base.map(arg => (arg === 'http://127.0.0.1:9' ? 'https://example.com' : arg))).text, /not on loopback/);
    assert.match(failure(...base.slice(2)).text, /Missing required options: --endpoint/);
    assert.match(failure(...base.map(arg => (arg === '1' ? '0' : arg))).text, /--repetitions must be 1 or more/);
    writeFileSync(join(dir, 'result.json'), '{}');
    assert.match(failure(...base).text, /must be new files/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a modified script no longer matches its recorded hash and is refused', () => {
  const dir = tmp();
  try {
    const copy = join(dir, 'engine-throughput');
    cpSync(evaluationDir, copy, { recursive: true });
    writeFileSync(join(copy, 'scripts', 'workload.py'), `${readFileSync(join(copy, 'scripts', 'workload.py'), 'utf8')}\n# changed\n`);
    try {
      python([join(copy, 'scripts', 'throughput.py'), '--endpoint', 'http://127.0.0.1:9']);
      assert.fail('the driver was expected to fail');
    } catch (error) {
      assert.match(`${error.stderr}`, /does not match its recorded hash/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
