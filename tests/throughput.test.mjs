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
const harness = body => python(['-c', [
  'import json, sys',
  `sys.path.insert(0, ${JSON.stringify(scripts)})`,
  'import throughput, workload',
  'from reference_engine import ReferenceEngine',
  body,
].join('\n')]);
const withReference = (body, { faults = [], prefill = 40000 } = {}) => harness([
  `with ReferenceEngine(${prefill}.0, 800.0, ${JSON.stringify(faults)}) as engine:`,
  ...body.split('\n').map(line => `    ${line}`),
].join('\n'));

const accepts = value => assert.ok(evaluationValidators.EvaluationResult(value), JSON.stringify(evaluationValidators.EvaluationResult.errors, null, 2));
const rejects = (value, why) => assert.equal(evaluationValidators.EvaluationResult(value), false, why);
const tmp = () => mkdtempSync(join(tmpdir(), 'llm-bootstrap-throughput-'));
const mutate = (value, change) => {
  const copy = structuredClone(value);
  change(copy);
  return copy;
};

function assertConsistent(aggregate, label) {
  assert.ok(Math.abs(aggregate.tokens_per_second - aggregate.total_tokens / aggregate.total_seconds) < 1e-9, `${label} is a ratio of sums`);
}
function assertAllAggregatesConsistent(result) {
  for (const name of ['prefill', 'decode']) {
    assert.notEqual(result.metrics[name], 'Not obtained', name);
    assertConsistent(result.metrics[name], name);
  }
  for (const item of result.workloads) {
    for (const key of ['prefill', 'decode', 'aggregate_output']) {
      if (item[key] !== undefined && item[key] !== 'Not obtained') assertConsistent(item[key], `${item.workload_id} ${key}`);
    }
  }
}

test('the throughput definition lists exactly the driver workloads and limits', () => {
  const described = JSON.parse(driver('--describe'));
  assert.deepEqual(definition.task_ids, described.task_ids);
  assert.equal(definition.limits.max_output_tokens_per_request, described.limits.max_output_tokens_per_request);
  assert.equal(definition.limits.request_concurrency, described.limits.request_concurrency);
  assert.equal(definition.result_schema, 'EvaluationResult');
  assert.ok(described.limits.max_input_tokens + described.limits.max_output_tokens_per_request < definition.limits.context_window, 'the largest request fits the context window');
  const lengths = Object.values(described.workloads).filter(w => w.kind === 'prefill').map(w => w.input_tokens);
  assert.deepEqual(lengths, [2048, 4096, 8192, 216 * 1024]);
  for (const [id, workload] of Object.entries(described.workloads)) {
    const k = value => (value % 1024 === 0 ? `${value / 1024}k` : `${value}`);
    assert.ok(id.includes(`${workload.kind === 'agent' ? 'p' : 'in'}${k(workload.input_tokens)}`), `${id} names its input length`);
    if (workload.kind !== 'agent') assert.ok(id.endsWith(`out${workload.output_tokens}`), `${id} names its output length`);
  }
  assert.ok(Object.values(described.workloads).some(w => w.kind === 'agent'), 'an agent workflow workload exists');
  assert.deepEqual(Object.values(described.workloads).filter(w => w.kind === 'batch').map(w => w.concurrency), [1, 2, 4, 8]);
});

test('prompts start with a nonce, and agent turns extend an identical prefix', () => {
  const out = JSON.parse(harness([
    'a = workload.build_prompt("prefill.in2k.out1", "aaaa", 300, 0)',
    'b = workload.build_prompt("prefill.in2k.out1", "bbbb", 300, 0)',
    'name = "agent.p32k.s256.t5"',
    'turns = [workload.build_prompt(name, "cccc", 400, 0, turn, 50) for turn in range(1, 5)]',
    'footer = "\\n\\nReply with the single word ok."',
    'print(json.dumps({"nonce_first": a.split()[1] != b.split()[1] and a.split()[2:] == b.split()[2:],',
    '                  "shared": [turns[i + 1].startswith(turns[i][:-len(footer)]) for i in range(3)],',
    '                  "grows": [len(t) for t in turns]}))',
  ].join('\n')));
  assert.equal(out.nonce_first, true, 'only the nonce differs between sessions');
  assert.deepEqual(out.shared, [true, true, true], 'each turn contains the previous turn up to its footer');
  assert.ok(out.grows.every((length, i, all) => i === 0 || length > all[i - 1]));
});

test('the negative control passes and emits a valid, consistent EvaluationResult', () => {
  const dir = tmp();
  try {
    const output = join(dir, 'result.json');
    assert.match(driver('--self-test', '--emit-result', output, '--evaluation-revision', commit('9')), /self-test: ok/);
    const result = JSON.parse(readFileSync(output, 'utf8'));
    accepts(result);
    assertAllAggregatesConsistent(result);
    assert.equal(result.evaluation.sha256, fileHash(join(evaluationDir, 'evaluation.json')));
    assert.equal(result.metrics.requests_reconciled, true);
    assert.deepEqual(result.repetitions.map(r => `${r.phase}:${r.outcome}`), ['formal:succeeded', 'formal:succeeded']);
    assert.equal(result.quality.application.passed, result.quality.application.total);
    assert.equal(result.quality.application.negative_control_verified, true);

    const byId = Object.fromEntries(result.workloads.map(w => [w.workload_id, w]));
    assert.ok(result.workloads.every(w => definition.task_ids.includes(w.workload_id)));
    assert.deepEqual(result.metrics.prefill, byId['prefill.in2k.out1'].prefill, 'the headline prefill is the 2k workload');
    assert.deepEqual(result.metrics.decode, byId['decode.in128.out256'].decode, 'the headline decode is the shallow decode workload');
    assert.equal(result.metrics.client_ttft_median_seconds, byId['prefill.in2k.out1'].ttft_median_seconds);
    assert.equal(byId['batch.c8.in512.out64'].aggregate_output.basis, 'concurrent-window-output-tokens');
    assert.equal(byId['batch.c8.in512.out64'].requests, 2 * 8 * 4);
    assert.ok(byId['batch.c8.in512.out64'].aggregate_output.tokens_per_second > byId['batch.c1.in512.out64'].aggregate_output.tokens_per_second, 'concurrency raises the aggregate');
    assert.ok(byId['batch.c8.in512.out64'].decode.tokens_per_second < byId['batch.c1.in512.out64'].decode.tokens_per_second, 'and lowers the per-request speed');
    assert.equal(byId['prefill.in2k.out1'].variability.values.length, 2);
    assert.equal(typeof byId['prefill.in2k.out1'].variability.sample_stddev, 'number');

    rejects(mutate(result, r => { r.workloads[0].kind = 'other'; }), 'a workload kind is one of four');
    rejects(mutate(result, r => { delete r.workloads[0].ttft_median_seconds; }), 'a workload needs its ttft field');
    rejects(mutate(result, r => { r.workloads[0].prefill = { ...r.workloads[0].prefill, basis: 'made-up' }; }), 'a throughput basis is one of the known ones');
    accepts(mutate(result, r => { delete r.workloads; }));

    const evidencePath = join(dir, 'result.requests.evidence');
    assert.equal(result.metrics.per_request_evidence.sha256, fileHash(evidencePath));
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    assert.ok(evidence.requests.some(r => r.phase === 'calibration'));
    assert.ok(evidence.requests.every(r => !('prompt' in r) && !('content' in r)), 'no prompts or model output in the evidence');
    const nonces = evidence.requests.map(r => r.nonce);
    assert.equal(new Set(nonces).size, nonces.length, 'every request in this run has its own nonce');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the real command line measures a reference engine, including an agent session and a closed-loop batch', () => {
  const dir = tmp();
  try {
    const output = join(dir, 'result.json');
    const args = [
      '--endpoint', '@ORIGIN@', '--model', 'reference-model', '--role', 'candidate', '--engine-name', 'reference',
      '--workloads', 'prefill.in2k.out1,decode.in128.out256,agent.p32k.s256.t5,batch.c2.in512.out64',
      '--warmup', '1', '--repetitions', '2', '--evaluation-revision', commit('9'), '--artifact', `engine=${sha('a')}`,
      '--hardware-model', 'test hardware', '--toolchain', 'test toolchain', '--power-mode', 'test power', '--thermal-observations', 'none',
      '--exclusive-gpu', '--request-field', 'top_k=1', '--output', output,
    ];
    const argv = ['throughput.py', ...args].map(arg => (arg === '@ORIGIN@' ? 'engine.origin' : JSON.stringify(arg))).join(', ');
    withReference(`sys.argv = [${argv}]\nraise SystemExit(throughput.main())`);
    const result = JSON.parse(readFileSync(output, 'utf8'));
    accepts(result);
    assertAllAggregatesConsistent(result);
    assert.deepEqual(result.repetitions.map(r => r.phase), ['warm-up', 'formal', 'formal']);
    assert.equal(result.settings['request_field.top_k'], 1);
    assert.equal(result.settings.workloads, 'prefill.in2k.out1,decode.in128.out256,agent.p32k.s256.t5,batch.c2.in512.out64');
    assert.equal(result.settings.endpoint_host_class, 'loopback');
    assert.equal(result.environment.exclusive_gpu, true);
    assert.equal(result.metrics.formal_repetitions, 2);
    assert.equal(result.metrics.preliminary, false);
    assert.deepEqual(result.workloads.map(w => w.kind), ['prefill', 'decode', 'agent', 'batch']);
    const agent = result.workloads.find(w => w.kind === 'agent');
    assert.ok(agent.cache.hit_ratio >= 0.9 && agent.cache.speedup > 2, JSON.stringify(agent.cache));
    assert.equal(agent.requests, 2 * 5);
    assert.ok(existsSync(join(dir, 'result.requests.evidence')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('injected faults fail their instances or withhold the metric instead of being measured', () => {
  const run = (fault, workloads) => JSON.parse(withReference([
    `run = throughput.execute(engine.origin, engine.model, None, 60.0, 0, 2, {}, 0, "test", workloads=${JSON.stringify(workloads)})`,
    'print(json.dumps({"passes": run["passes"], "summary": throughput.summarize(run)}))',
  ].join('\n'), { faults: [fault], prefill: 400000 }));
  const shapes = ['prefill.in2k.out1', 'decode.in128.out256', 'agent.p32k.s256.t5'];
  const byId = out => Object.fromEntries(out.summary.workloads.map(w => [w.workload_id, w]));

  const cached = run('reports_cached', shapes);
  assert.ok(cached.passes.every(p => p.outcome === 'failed' && p.failure_description.includes('cached prompt tokens')));
  assert.equal(cached.summary.prefill, 'Not obtained');
  assert.equal(cached.summary.formal_repetitions, 0);

  const nocache = run('no_prefix_cache', shapes);
  assert.ok(nocache.passes.every(p => p.outcome === 'failed' && p.failure_description.includes('repeated prefix')));
  assert.equal(byId(nocache)['agent.p32k.s256.t5'].cache, undefined);
  assert.notEqual(byId(nocache)['prefill.in2k.out1'].prefill, 'Not obtained', 'the other workloads are still measured');

  const short = run('stops_early', shapes);
  assert.ok(short.passes.every(p => p.outcome === 'failed' && p.failure_description.includes('output tokens')));
  assert.equal(byId(short)['decode.in128.out256'].decode, 'Not obtained');
  assert.ok(byId(short)['decode.in128.out256'].succeeded_requests < byId(short)['decode.in128.out256'].requests);

  const coalesced = run('coalesced_chunks', shapes);
  assert.ok(coalesced.passes.every(p => p.outcome === 'succeeded'));
  assert.equal(byId(coalesced)['decode.in128.out256'].decode, 'Not obtained');
  assert.match(coalesced.summary.notes['decode_not_obtained_reason.decode.in128.out256'], /chunks per token/);
  assert.notEqual(byId(coalesced)['prefill.in2k.out1'].prefill, 'Not obtained');
});

test('the driver refuses what the evaluation fixes, unknown workloads, remote plain http, and a missing option', () => {
  const dir = tmp();
  try {
    const base = [
      '--endpoint', 'http://127.0.0.1:9', '--model', 'm', '--role', 'baseline', '--engine-name', 'e', '--warmup', '0', '--repetitions', '1',
      '--evaluation-revision', commit('9'), '--artifact', `engine=${sha('a')}`, '--hardware-model', 'h', '--toolchain', 't',
      '--power-mode', 'p', '--thermal-observations', 'n', '--output', join(dir, 'result.json'),
    ];
    assert.match(failure(...base, '--request-field', 'max_tokens=5').text, /fixed by the evaluation/);
    assert.match(failure(...base, '--request-field', 'top_k=[1]').text, /scalar/);
    assert.match(failure(...base, '--workloads', 'prefill.in2k.out1,prefill.in99k.out1').text, /Unknown workload\(s\): prefill\.in99k\.out1/);
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
