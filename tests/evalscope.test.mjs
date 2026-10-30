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
const evaluationDir = join(root, 'evaluations', 'engine-evalscope');
const scripts = join(evaluationDir, 'scripts');
const definition = JSON.parse(readFileSync(join(evaluationDir, 'evaluation.json'), 'utf8'));
const { evaluation: evaluationValidators } = await loadValidators();
const fileHash = path => createHash('sha256').update(readFileSync(path)).digest('hex');

const venvPython = join(root, '.venv-evalscope', 'bin', 'python');
const python = (args, options = {}) => execFileSync('python3', args, {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  ...options,
});
const driver = (...args) => python([join(scripts, 'evaluate.py'), ...args]);
const failure = (...args) => {
  try {
    driver(...args);
  } catch (error) {
    return { status: error.status, text: `${error.stdout}${error.stderr}` };
  }
  assert.fail('the driver was expected to fail');
};
const harness = body => JSON.parse(python(['-c', [
  'import json, sys',
  `sys.path.insert(0, ${JSON.stringify(scripts)})`,
  'import evaluate, perf, intelligence',
  body,
].join('\n')]));

const accepts = value => assert.ok(evaluationValidators.EvaluationResult(value), JSON.stringify(evaluationValidators.EvaluationResult.errors, null, 2));
const tmp = () => mkdtempSync(join(tmpdir(), 'llm-bootstrap-evalscope-'));

// What EvalScope's own summary files look like, for the arithmetic and the gates.
const FIXTURE = `
def level(workload_id='w', kind='prefill', parallel=1, number=4, input_tokens=2048, output_tokens=1, ttft_ms=500.0, tpot_ms=10.0,
          avg_input=2050.0, avg_output=None, hit=0.0, duration=4.0, failed=0, spread=False):
    avg_output = output_tokens if avg_output is None else avg_output
    success = number - failed
    summary = {'Test Duration (s)': duration, 'Total Requests': number, 'Success Requests': success, 'Failed Requests': failed,
               'Avg Input Tokens': avg_input, 'Avg Output Tokens': avg_output, 'Avg TTFT (ms)': ttft_ms, 'Avg TPOT (ms)': tpot_ms,
               'Output Throughput (tok/s)': success * avg_output / duration, 'KV Cache Hit Rate (%)': hit}
    rows = {'min': {'Output tokens': avg_output - (1 if spread else 0)}, '99%': {'Output tokens': avg_output},
            '50%': {'TTFT (ms)': ttft_ms}}
    return {'item': {'id': workload_id, 'kind': kind, 'input_tokens': input_tokens, 'output_tokens': output_tokens, 'levels': [{'parallel': parallel, 'number': number, 'warmup': 0}]},
            'level': {'parallel': parallel, 'number': number, 'warmup': 0}, 'measured': {'summary': summary, 'percentile': rows}}
`;

test('the definition is released, pins its tool, datasets, and sandbox, and agrees with the driver', () => {
  assert.ok(evaluationValidators.EvaluationDefinition(definition), JSON.stringify(evaluationValidators.EvaluationDefinition.errors));
  const described = JSON.parse(driver('--describe'));
  assert.equal(definition.status, 'released');
  assert.deepEqual(described.task_ids, definition.task_ids);
  assert.deepEqual(definition.harness, { name: 'EvalScope', version: '1.14.1' });
  assert.deepEqual(definition.task_ids, [
    ...definition.plan.throughput.map(item => `throughput.${item.id}`), ...definition.plan.intelligence.map(item => `intelligence.${item.id}`)]);
  for (const id of ['prefill.in2k.out1', 'decode.in128.out256']) assert.ok(definition.plan.throughput.some(item => item.id === id && item.levels.some(l => l.parallel === 1)), `the headline workload ${id} exists`);
  assert.ok(definition.plan.throughput.some(item => item.kind === 'multi-turn'), 'a multi-turn workload exercises the prefix cache');
  const concurrency = definition.plan.throughput.find(item => item.id === 'concurrency.in512.out64');
  assert.deepEqual(concurrency.levels.map(l => l.parallel), [1, 2, 4, 8]);
  assert.match(definition.plan.sandbox.image, /@sha256:[0-9a-f]{64}$/);
  assert.equal(definition.plan.sandbox.network, 'disabled');
  assert.deepEqual(definition.plan.intelligence.map(item => item.id), ['humaneval', 'gsm8k']);
  assert.ok(definition.datasets.every(dataset => dataset.files.every(file => /^[0-9a-f]{64}$/.test(file.sha256))));
  for (const script of definition.scripts) assert.equal(script.sha256, fileHash(join(evaluationDir, script.path)), script.path);
  assert.ok(definition.scripts.some(script => script.role === 'dependency-lock' && script.path === 'requirements.lock'));
  const lock = readFileSync(join(evaluationDir, 'requirements.lock'), 'utf8');
  assert.match(lock, /^evalscope==1\.14\.1 \\/m);
  assert.ok(lock.match(/--hash=sha256:/g).length > 50, 'every dependency is pinned by hash');
  assert.ok(Object.values(definition.sampling_settings).every(value => ['string', 'number', 'boolean'].includes(typeof value)));
});

test('a level counts only if every request succeeded and reached its input and output lengths', () => {
  const out = harness(`${FIXTURE}
def problems(**kwargs):
    entry = level(**kwargs)
    return perf.level_problems(entry['item'], entry['level'], entry['measured'])
print(json.dumps({
  'clean': problems(),
  'failed': problems(failed=1),
  'short_output': problems(kind='decode', output_tokens=256, avg_output=10.0),
  'ragged_output': problems(kind='decode', output_tokens=256, spread=True),
  'wrong_input': problems(avg_input=3000.0),
  'cached_unique': problems(hit=20.0),
  'cached_multi_turn': problems(kind='multi-turn', hit=60.0, avg_input=9000.0),
}))`);
  assert.deepEqual(out.clean, []);
  assert.match(out.failed.join(' '), /1 of 4 requests failed/);
  assert.match(out.short_output.join(' '), /output length was 10\.00 tokens/);
  assert.match(out.ragged_output.join(' '), /min 255/);
  assert.match(out.wrong_input.join(' '), /prompts had 3000 tokens/);
  assert.match(out.cached_unique.join(' '), /20\.0% cached prompt tokens for unique prompts/);
  assert.deepEqual(out.cached_multi_turn, [], 'a multi-turn workload reuses its own turns');
});

test('throughput aggregates are ratios of sums, exclude gated levels, and form a valid EvaluationResult', () => {
  const doc = harness(`${FIXTURE}
import copy
plan = [level('prefill.in2k.out1', 'prefill', ttft_ms=500.0, avg_input=2000.0)['item'],
        level('decode.in128.out256', 'decode', input_tokens=128, output_tokens=256, avg_input=130.0)['item'],
        level('multi-turn.in8k.t5', 'kind-placeholder')['item']]
plan[2].update(kind='multi-turn', turns=5, input_tokens=8192, output_tokens=64)
def record(workload_id, kind, entry, problems=None, phase='formal', index=0):
    summary = entry['measured']['summary']
    return {'phase': phase, 'pass': index, 'id': workload_id, 'kind': kind, 'parallel': 1, 'number': entry['level']['number'], 'seed': 1,
            'status': 'failed' if problems else 'ok', 'problems': problems or [], 'summary': summary,
            'p50': {'TTFT (ms)': summary['Avg TTFT (ms)']}, 'p99': {}}
passes = []
for index, (ttft, hit) in enumerate([(500.0, 0.0), (250.0, 0.0), (125.0, 0.0)]):
    records = [record('prefill.in2k.out1', 'prefill', level('prefill.in2k.out1', 'prefill', ttft_ms=ttft, avg_input=2000.0), index=index),
               record('decode.in128.out256', 'decode', level('decode.in128.out256', 'decode', input_tokens=128, output_tokens=256, avg_input=130.0, ttft_ms=20.0, tpot_ms=5.0), index=index)]
    multi = level('multi-turn.in8k.t5', 'multi-turn', input_tokens=8192, output_tokens=64, avg_input=20000.0, hit=60.0, ttft_ms=300.0)
    multi['measured']['summary'].update({'Avg First-Turn TTFT (ms)': 900.0, 'Avg Subsequent-Turn TTFT (ms)': 150.0})
    records.append(record('multi-turn.in8k.t5', 'multi-turn', multi, index=index))
    if index == 2:
        records[0]['problems'] = ['1 of 4 requests failed']; records[0]['status'] = 'failed'
    passes.append({'phase': 'formal', 'index': index, 'records': records, 'outcome': evaluate.pass_outcome(records), 'failure_description': evaluate.pass_failures(records)})
results = evaluate.summarize_throughput(plan, passes)
run = {'plan': plan, 'passes': passes, 'formal_seconds': 1.0, 'peak_memory_gib': None, 'swap_out_delta_bytes': None}
info = {'role': 'candidate', 'engine_name': 'fixture', 'warmup': 0, 'repetitions': 3, 'parts': ['throughput'], 'scheme': 'http', 'host_class': 'loopback',
        'fields': {}, 'salt': 'x', 'tokenizer_sha256': 'a' * 64, 'evaluation_revision': '9' * 40,
        'runtime_revision': 'Unavailable: fixture', 'artifacts': [{'name': 'e', 'sha256': 'b' * 64}], 'commands': ['x'],
        'started_at': '2026-10-28T08:00:00+00:00', 'experiment_id': 'fixture', 'experiment_revision': '8' * 40, 'experiment_sha256': 'd' * 64,
        'declared': evaluate.parse_declarations([]),
        'environment': {'hardware_model': 'h', 'os_version': 'o', 'toolchain': 't', 'power_mode': 'p', 'thermal_observations': 'n', 'exclusive_gpu': True, 'deviations_from_contract': []}}
control = {'verified': True, 'restricted': False, 'notes': [], 'problems': []}
evidence = {'description': 'fixture', 'access': 'local-only', 'sha256': 'c' * 64, 'access_limitation': 'fixture'}
result = evaluate.build_result(info, evaluate.load_definition(), run, None, control, evidence)
print(json.dumps({'results': results, 'result': result}))`);
  const prefill = doc.results.find(item => item.workload_id === 'prefill.in2k.out1');
  // Passes 0 and 1 count; pass 2 failed a gate. Sums: tokens 2 * 4 * 2000, seconds 4 * (0.5 + 0.25).
  assert.equal(prefill.prefill.total_tokens, 16000);
  assert.ok(Math.abs(prefill.prefill.total_seconds - 3) < 1e-9);
  assert.ok(Math.abs(prefill.prefill.tokens_per_second - 16000 / 3) < 1e-6, 'a ratio of sums, not the mean of per-pass rates');
  assert.equal(prefill.requests, 12, 'every dispatched request is counted, including the excluded pass');
  assert.equal(prefill.succeeded_requests, 12, 'EvalScope reports its own success count; the gate excludes a level from the metrics, not from the count');
  assert.deepEqual(prefill.variability.values.length, 2);
  const decode = doc.results.find(item => item.workload_id === 'decode.in128.out256');
  assert.ok(Math.abs(decode.decode.tokens_per_second - 200) < 1e-6, '1000 / TPOT of 5 ms');
  const multi = doc.results.find(item => item.kind === 'multi-turn');
  assert.equal(multi.cache_hit_ratio, 0.6);
  assert.equal(multi.first_turn_ttft_seconds, 0.9);
  assert.equal(multi.subsequent_turn_ttft_seconds, 0.15);
  for (const item of doc.results) for (const key of ['prefill', 'decode']) {
    if (item[key] !== 'Not obtained') assert.ok(Math.abs(item[key].tokens_per_second - item[key].total_tokens / item[key].total_seconds) < 1e-9, `${item.workload_id} ${key}`);
  }
  accepts(doc.result);
  assert.deepEqual([doc.result.formal_passes_succeeded, doc.result.formal_passes_failed], [2, 1]);
  assert.equal(doc.result.failures.length, 1);
  assert.match(doc.result.failures[0], /formal pass 2 failed: prefill\.in2k\.out1 at concurrency 1: 1 of 4 requests failed/);
  assert.equal(doc.result.requests_reconciled, false, 'a gated level makes the requests unreconciled');
  assert.equal(doc.result.intelligence_complete, false);
  assert.ok(!Object.keys(doc.result).some(key => key.startsWith('intelligence.')), 'no benchmark was scored');
  assert.equal(doc.result.prefill_tokens_per_second, prefill.prefill.tokens_per_second, 'the headline prefill is the 2k workload');
  assert.equal(doc.result['throughput.prefill.in2k.out1.c1.prefill_tokens_per_second'], prefill.prefill.tokens_per_second);
  assert.equal(doc.result.prefill_basis, 'processed-input-tokens');
  assert.equal(doc.result['throughput.multi-turn.in8k.t5.c1.cache_hit_ratio'], 0.6);
  assert.equal(doc.result['throughput.prefill.in2k.out1.c1.pass_tokens_per_second'].length, 2);
  for (const [key, value] of Object.entries(doc.result)) {
    const flat = ['string', 'number', 'boolean'].includes(typeof value) || (Array.isArray(value) && value.every(item => ['string', 'number'].includes(typeof item)));
    assert.ok(flat, `${key} is not a scalar or an array of scalars`);
  }
});

test('benchmark scores come from EvalScope reports, with a standard error, and must cover the expected samples', () => {
  const dir = tmp();
  try {
    const out = harness(`
import pathlib
run = pathlib.Path(${JSON.stringify(dir)}) / 'run'
(run / 'reports' / 'm').mkdir(parents=True)
metric = lambda name, aggregation, dimensions, score, num: {'identity': {'name': name, 'aggregation': aggregation, 'dimensions': dimensions}, 'score': score, 'num': num}
(run / 'reports' / 'm' / 'humaneval.json').write_text(json.dumps({'metrics': [
    metric('accuracy', 'mean', {}, 0.5, 164), metric('accuracy', 'pass_at_k', {'k': 1}, 0.75, 164)]}))
item = {'id': 'humaneval', 'benchmark': 'humaneval', 'expected_samples': 164, 'metric': {'name': 'accuracy', 'aggregation': 'pass_at_k', 'dimensions': {'k': 1}}}
scored = intelligence.read_score(run, 'humaneval', item['metric'])
short = dict(scored, num_samples=100)
print(json.dumps({'scored': scored, 'missing': intelligence.read_score(run, 'gsm8k', item['metric']),
                  'problems': intelligence.score_problems(item, scored), 'short': intelligence.score_problems(item, short),
                  'none': intelligence.score_problems(item, None), 'label': evaluate.metric_label(item['metric'])}))`);
    assert.equal(out.scored.score, 0.75);
    assert.ok(Math.abs(out.scored.stderr - Math.sqrt(0.75 * 0.25 / 164)) < 1e-12);
    assert.equal(out.missing, null);
    assert.deepEqual(out.problems, []);
    assert.match(out.short.join(' '), /scored 100 samples instead of 164/);
    assert.match(out.none.join(' '), /no humaneval score was produced/);
    assert.equal(out.label, 'accuracy/pass_at_k(k=1)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a dataset file that does not match its pinned hash is refused, and the source stays untouched', () => {
  const dir = tmp();
  try {
    const out = harness(`
import pathlib
base = pathlib.Path(${JSON.stringify(dir)})
source = base / 'source' / 'data'
source.mkdir(parents=True)
(source / 'a.txt').write_text('hello')
good = {'name': 'data', 'source': 'modelscope', 'repository': 'x/y', 'files': [{'path': 'a.txt', 'sha256': intelligence.sha256_file(source / 'a.txt')}]}
bad = dict(good, files=[{'path': 'a.txt', 'sha256': '0' * 64}])
(base / 'scratch1').mkdir()
(base / 'scratch2').mkdir()
copied = intelligence.prepare_dataset(good, base / 'source', base / 'scratch1')
(copied / 'a.txt').write_text('changed')
refused = False
try:
    intelligence.prepare_dataset(bad, base / 'source', base / 'scratch2')
except SystemExit as exc:
    refused = 'does not match its pinned SHA-256' in str(exc)
print(json.dumps({'refused': refused, 'source': (source / 'a.txt').read_text()}))`);
    assert.equal(out.refused, true);
    assert.equal(out.source, 'hello', 'EvalScope edits a private copy, not the pinned source');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the reference engine serves known behavior, reuses prefixes, and breaks as told', () => {
  const out = harness(`
import urllib.request, urllib.error
from reference_engine import ReferenceEngine
def post(origin, text, stream=True, limit=8):
    request = urllib.request.Request(origin + '/v1/chat/completions', data=json.dumps({'model': 'm', 'messages': [{'role': 'user', 'content': text}], 'max_tokens': limit, 'stream': stream}).encode(), headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read().decode()
def usage(body):
    return [json.loads(line[5:]) for line in body.splitlines() if line.startswith('data:') and 'usage' in line][-1]['usage']
prompt = 'shared prefix ' * 400
with ReferenceEngine(1e6, 1e6) as engine:
    first, second = usage(post(engine.origin, prompt + 'one')), usage(post(engine.origin, prompt + 'two'))
    plain = json.loads(post(engine.origin, 'hi', stream=False))
with ReferenceEngine(1e6, 1e6, ('stops_early',)) as engine:
    early = usage(post(engine.origin, 'hi', limit=100))
with ReferenceEngine(1e6, 1e6, ('no_prefix_cache',)) as engine:
    post(engine.origin, prompt + 'one')
    uncached = usage(post(engine.origin, prompt + 'two'))
down = None
with ReferenceEngine(1e6, 1e6, ('http_error',)) as engine:
    try:
        post(engine.origin, 'hi')
    except urllib.error.HTTPError as exc:
        down = exc.code
answers = [{'match': 'Question: 2+2', 'right': 'The answer is \\\\boxed{4}.', 'wrong': 'The answer is \\\\boxed{5}.'}]
with ReferenceEngine(1e6, 1e6, answers=answers, answer_mode='wrong') as engine:
    oracle = json.loads(post(engine.origin, 'Few shot... Question: 2+2', stream=False, limit=64))
print(json.dumps({'first': first, 'second': second, 'plain': plain, 'early': early, 'uncached': uncached, 'down': down, 'oracle': oracle}))`);
  assert.equal(out.first.prompt_tokens_details.cached_tokens, 0);
  assert.ok(out.second.prompt_tokens_details.cached_tokens > 0.8 * out.second.prompt_tokens, 'the second prompt reuses the first one\'s prefix');
  assert.equal(out.uncached.prompt_tokens_details.cached_tokens, 0, 'no_prefix_cache reports no reuse');
  assert.equal(out.plain.usage.completion_tokens, 8);
  assert.equal(out.plain.choices[0].finish_reason, 'length');
  assert.equal(out.early.completion_tokens, 10, 'stops_early stops at 10 tokens whatever the request asks');
  assert.equal(out.down, 500);
  assert.equal(out.oracle.choices[0].message.content, 'The answer is \\boxed{5}.');
});

test('the driver refuses a missing option, a bad endpoint, fixed request fields, bad parts, and bad declarations', () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'experiment.json'), '{}');
    const base = [
      '--endpoint', 'http://127.0.0.1:9', '--model', 'm', '--tokenizer-path', dir, '--role', 'baseline', '--engine-name', 'e', '--warmup', '0',
      '--repetitions', '1', '--evaluation-revision', commit('9'), '--artifact', `engine=${sha('a')}`, '--hardware-model', 'h',
      '--toolchain', 't', '--power-mode', 'p', '--thermal-observations', 'n', '--experiment-dir', dir, '--experiment-revision', commit('8'),
    ];
    const swap = (from, to) => base.map(arg => (arg === from ? to : arg));
    assert.match(failure(...base.slice(2)).text, /Missing required options: --endpoint/);
    assert.match(failure(...swap('http://127.0.0.1:9', 'http://example.com')).text, /Plain http/);
    assert.match(failure(...swap('http://127.0.0.1:9', 'https://example.com')).text, /not on loopback/);
    assert.match(failure(...swap('1', '0')).text, /--repetitions must be 1 or more/);
    assert.match(failure(...swap(`engine=${sha('a')}`, 'engine=zz')).text, /--artifact must look like/);
    assert.match(failure(...base, '--request-field', 'max_tokens=5').text, /fixed by the evaluation/);
    assert.match(failure(...base, '--request-field', 'top_k=[1]').text, /scalar or an object/);
    assert.match(failure(...base, '--parts', 'speed').text, /--parts must be/);
    assert.match(failure(...base, '--runtime-revision', 'abc').text, /--runtime-revision must be a full/);
    assert.match(failure(...swap(commit('8'), 'abc')).text, /--experiment-revision must be a full/);
    assert.match(failure(...swap(dir, join(dir, 'missing'))).text, /Missing required options|must hold experiment\.json|must be a directory/);
    assert.match(failure(...base, '--declare', 'human_interventions=-1').text, /not a valid count/);
    assert.match(failure(...base, '--declare', 'cost=1').text, /--declare must look like KEY=VALUE/);
    assert.match(failure(...base, '--declare', 'self_hosting_status=demonstrated').text, /Demonstrated self-hosting needs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('declared run context is recorded as given and defaults to unavailable', () => {
  const out = harness(`
print(json.dumps({
  'default': evaluate.parse_declarations([]),
  'given': evaluate.parse_declarations(['human_interventions=3', 'elapsed_hours=1.5', 'builder_tokens=Unavailable: no usage report', 'self_hosting_status=not-in-scope']),
  'demonstrated': evaluate.parse_declarations(['self_hosting_status=demonstrated', 'self_hosting_transition_at=2026-10-28T08:00:00Z',
      'self_hosting_builder_matches_target=true', 'self_hosting_routing=harness to the engine', 'self_hosting_external_recovery_used=false',
      'self_hosting_evidence_sha256=' + 'a' * 64]),
}))`);
  assert.match(out.default.human_interventions, /^Unavailable: /);
  assert.equal(out.default.self_hosting_status, 'not-demonstrated');
  assert.deepEqual([out.given.human_interventions, out.given.elapsed_hours, out.given.self_hosting_status], [3, 1.5, 'not-in-scope']);
  assert.equal(out.given.builder_tokens, 'Unavailable: no usage report');
  assert.equal(out.demonstrated.self_hosting_transition_at, '2026-10-28T08:00:00+00:00');
  assert.equal(out.demonstrated.self_hosting_builder_matches_target, true);
});

test('a modified script or dependency lock no longer matches its recorded hash and is refused', () => {
  const dir = tmp();
  try {
    for (const target of ['scripts/perf.py', 'requirements.lock']) {
      const copy = join(dir, target.replace('/', '-'), 'engine-evalscope');
      cpSync(evaluationDir, copy, { recursive: true });
      writeFileSync(join(copy, target), `${readFileSync(join(copy, target), 'utf8')}\n# changed\n`);
      try {
        python([join(copy, 'scripts', 'evaluate.py'), '--endpoint', 'http://127.0.0.1:9']);
        assert.fail('the driver was expected to fail');
      } catch (error) {
        assert.match(`${error.stderr}`, /does not match its recorded hash/, target);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The negative control runs the real EvalScope pipeline against a reference engine. It needs the locked environment, a model
// tokenizer, the pinned datasets, and Docker, so it runs only when they are named: EVALSCOPE_TEST_TOKENIZER and, optionally,
// EVALSCOPE_TEST_DATASETS.
const tokenizer = process.env.EVALSCOPE_TEST_TOKENIZER;
test('the negative control passes through the real EvalScope pipeline and emits a valid result', { skip: tokenizer && existsSync(venvPython) ? false : 'set EVALSCOPE_TEST_TOKENIZER and install the locked environment' }, () => {
  const dir = tmp();
  try {
    const output = join(dir, 'result.json');
    const args = [join(scripts, 'evaluate.py'), '--self-test', '--tokenizer-path', tokenizer, '--emit-result', output, '--evaluation-revision', commit('9')];
    if (process.env.EVALSCOPE_TEST_DATASETS) args.push('--dataset-dir', process.env.EVALSCOPE_TEST_DATASETS);
    const text = execFileSync(venvPython, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 900000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    assert.match(text, /self-test: ok/);
    const result = JSON.parse(readFileSync(output, 'utf8'));
    accepts(result);
    assert.equal(result.evaluation_sha256, fileHash(join(evaluationDir, 'evaluation.json')));
    assert.equal(result.requests_reconciled, true);
    assert.equal(result.negative_control_verified, true);
    assert.equal(result.restricted_environment, true);
    assert.equal(result.intelligence_complete, true);
    assert.ok(Math.abs(result.decode_tokens_per_second - 400) < 0.35 * 400, 'the known decode rate is recovered');
    assert.ok(result['throughput.concurrency.in512.out64.c4.output_tokens_per_second'] > result['throughput.concurrency.in512.out64.c1.output_tokens_per_second']);
    assert.ok(result['throughput.multi-turn.in2k.t3.c1.cache_hit_ratio'] > 0.3);
    const evidence = readFileSync(join(dir, 'result.requests.evidence'), 'utf8');
    assert.ok(!evidence.includes('"messages"'), 'no prompts in the evidence');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
