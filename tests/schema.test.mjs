import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Validator } from '@seriousme/openapi-schema-validator';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { resolveContract, resolveContractFile } from '../schema/resolve-contract.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => JSON.parse(readFileSync(`${root}${path}`, 'utf8'));
const spec = read('schema/experiment-protocol.openapi.json');
const evaluationSpec = read('schema/evaluation-protocol.openapi.json');
const example = read('experiments/m5pro-qwen36-pi/example.json');

// Conditional overlays name sibling properties, so strictTypes and strictRequired stay off.
const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false });
addFormats(ajv);

// Component refs become $defs refs so each Schema Object compiles under strict JSON Schema 2020-12.
function compileAll(document, id) {
  const defs = JSON.parse(JSON.stringify(document.components.schemas).replaceAll('#/components/schemas/', () => '#/$defs/'));
  ajv.addSchema({ $id: id, $defs: defs });
  return Object.fromEntries(Object.keys(defs).map(name => [name, ajv.compile({ $ref: `${id}#/$defs/${name}` })]));
}
const validators = compileAll(spec, 'https://llm-bootstrap.invalid/experiment-protocol');
const evaluationValidators = compileAll(evaluationSpec, 'https://llm-bootstrap.invalid/evaluation-protocol');

const checks = set => ({
  accepts: (name, value) => assert.ok(set[name](value), JSON.stringify(set[name].errors, null, 2)),
  rejects: (name, value, why) => assert.equal(set[name](value), false, why),
});
const { accepts, rejects } = checks(validators);
const { accepts: acceptsEvaluation, rejects: rejectsEvaluation } = checks(evaluationValidators);

const sha = char => char.repeat(64);
const commit = char => char.repeat(40);
const when = '2026-10-28T00:00:00+08:00';
const notApplicable = reason => ({ not_applicable: true, reason });
const unavailable = reason => ({ unavailable: true, reason });

function frozenContract() {
  const contract = structuredClone(example);
  Object.assign(contract, {
    experiment_id: 'synthetic-schema-fixture',
    status: 'frozen',
    description: 'Synthetic fixture for schema tests; not an experiment.',
    skills_revision: commit('1'),
    builder_instruction_hashes: [{ name: 'skills/bootstrap-plan/SKILL.md', sha256: sha('a') }],
    contract_frozen_at: when,
    scope: 'Synthetic engine construction only; no operating-system changes; fixture authorizes nothing.',
  });
  Object.assign(contract.hardware, { os_version: 'synthetic-os 1', toolchain: 'synthetic-toolchain 1' });
  Object.assign(contract.target_model, {
    file_hash_manifest: [{ name: 'model-00001.safetensors', sha256: sha('b') }],
    tokenizer_hash: sha('c'),
    chat_template_hash: sha('d'),
    activation_precision: 'bf16',
    speculative_draft: notApplicable('Speculative decoding is disabled.'),
  });
  Object.assign(contract.builder, {
    model: 'synthetic-builder',
    provider: unavailable('Provider exposes no identifier.'),
    revision_or_exposed_identifier: unavailable('Provider exposes no revision.'),
    initial_inference_location: 'hosted',
    sampling_settings: { temperature: 0 },
    network_and_source_access: 'none',
  });
  contract.development_harness.revision_or_package_hash = unavailable('No package hash.');
  contract.evaluation.definition = { ...evaluationReference };
  Object.assign(contract.evaluation, {
    warmup_plan: 'one warm-up round',
    formal_repetitions: 3,
    numerical_oracle_and_tolerances: {
      oracle: 'synthetic reference',
      tolerances: [{ quantity: 'logits', error_metric: 'max-abs-error', threshold: 0.01 }],
    },
  });
  Object.assign(contract.implementation, {
    starting_scaffold: 'empty directory; no code reuse',
    language_and_backend: 'synthetic',
    allowed_libraries: [],
    baseline_source_inspection_allowed: false,
  });
  Object.assign(contract.baselines, {
    selection_date: '2026-10-28',
    selection_method: 'synthetic; no alternatives left unevaluated',
    engines_and_revisions: [{ name: 'synthetic-baseline', revision: commit('2') }],
  });
  Object.assign(contract.goal, {
    primary_metric: 'decode throughput, N-1 intervals over first-to-last token time',
    performance_thresholds: [{ metric: 'decode throughput', comparator: 'at-least', threshold: 1, unit: 'tok/s' }],
    resource_limits: { max_memory_footprint_gib: 40, max_swap_out_delta_gib: 0 },
  });
  Object.assign(contract.budget, {
    wall_clock_hours: 1,
    builder_tokens: 1000,
    api_cost_limit: notApplicable('Local only.'),
    hardware_hours: 1,
    stopping_rule: 'synthetic',
  });
  return contract;
}

const evaluationReference = { evaluation_id: 'synthetic-evaluation', revision: commit('3'), sha256: sha('c') };
const evidenceFixture = { description: 'synthetic', access: 'local-only', sha256: sha('8'), access_limitation: 'synthetic' };

function syntheticResult() {
  const detail = 'synthetic';
  return {
    evaluation: evaluationReference,
    role: 'candidate',
    engine_name: 'synthetic-engine',
    environment: {
      hardware_model: detail,
      os_version: detail,
      toolchain: detail,
      power_mode: detail,
      thermal_observations: detail,
      exclusive_gpu: true,
      deviations_from_contract: [],
    },
    runtime_revision: unavailable('Not exposed by the runtime.'),
    artifacts: [{ name: 'synthetic-engine', sha256: sha('e') }],
    commands: ['synthetic-run'],
    settings: { weight_precision: detail },
    repetitions: [{ phase: 'formal', outcome: 'succeeded' }],
    metrics: {
      formal_repetitions: 3,
      preliminary: false,
      prefill: { basis: 'processed-input-tokens', total_tokens: 100, total_seconds: 1, tokens_per_second: 100 },
      decode: { basis: 'n-minus-1-intervals', total_tokens: 9, total_seconds: 1, tokens_per_second: 9 },
      client_ttft_median_seconds: 'Not obtained',
      application_duration_seconds: 'Not obtained',
      requests_reconciled: true,
      per_request_evidence: evidenceFixture,
    },
    resources: { peak_memory_gib: 'Not obtained', swap_out_delta_bytes: 'Not obtained' },
    quality: {
      numerical_status: 'not-run',
      application: { passed: 1, total: 1, negative_control_verified: true, restricted_environment: true },
    },
  };
}

function syntheticRun() {
  const detail = 'synthetic';
  return {
    run_id: 'synthetic-schema-fixture',
    status: 'completed',
    acceptance: 'unverified',
    contract: { path: 'contract.json', revision: commit('4'), sha256: sha('f') },
    skills_revision: commit('1'),
    started_at: when,
    ended_at: when,
    evaluation_results: [{ role: 'candidate', engine_name: 'synthetic-engine', path: 'results/candidate.json', sha256: sha('d') }],
    comparisons: [{
      track: 'matched-configuration',
      metric: 'decode throughput',
      baseline_engine: 'synthetic-baseline',
      candidate_engine: 'synthetic-engine',
      baseline_value: 'Not obtained',
      candidate_value: 'Not obtained',
      definitions_compatible: false,
      matched_settings: false,
      differences: [detail],
    }],
    claims: [],
    human_interventions: unavailable('Synthetic fixture.'),
    cost: {
      builder_tokens: unavailable('Synthetic fixture.'),
      elapsed_hours: unavailable('Synthetic fixture.'),
      hardware_hours: unavailable('Synthetic fixture.'),
    },
    self_hosting: { status: 'not-in-scope' },
    evidence: [evidenceFixture],
    interpretation: 'Synthetic schema fixture; not a measurement.',
  };
}

const mutate = (value, change) => {
  const copy = structuredClone(value);
  change(copy);
  return copy;
};

test('every component schema compiles under strict JSON Schema 2020-12', () => {
  for (const [document, set] of [[spec, validators], [evaluationSpec, evaluationValidators]]) {
    assert.equal(document.openapi, '3.1.0');
    assert.deepEqual(Object.keys(set).sort(), Object.keys(document.components.schemas).sort());
  }
});

test('both OpenAPI documents pass the official OpenAPI 3.1 schema', async () => {
  for (const document of [spec, evaluationSpec]) {
    const result = await new Validator().validate(structuredClone(document));
    assert.ok(result.valid, JSON.stringify(result.errors, null, 2));
  }
});

test('primitive schemas shared by both protocols are identical', () => {
  const shared = Object.keys(spec.components.schemas).filter(name => name in evaluationSpec.components.schemas);
  assert.ok(shared.length >= 12, `only ${shared.length} shared schemas`);
  for (const name of shared) assert.deepEqual(evaluationSpec.components.schemas[name], spec.components.schemas[name], name);
});

test('the draft example validates as a draft contract but not as a frozen one', () => {
  accepts('ExperimentContract', example);
  rejects('ExperimentContract', { ...example, status: 'frozen' }, 'unresolved nulls must not freeze');
});

test('a fully resolved contract can be frozen and unresolved or invalid fields are rejected', () => {
  const frozen = frozenContract();
  accepts('ExperimentContract', frozen);
  accepts('ExperimentContract', mutate(frozen, c => { c.amends = { revision: commit('5'), reason: 'synthetic' }; }));
  rejects('ExperimentContract', mutate(frozen, c => { c.hardware.os_version = null; }), 'null in frozen contract');
  rejects('ExperimentContract', mutate(frozen, c => { c.skills_revision = 'abc1234'; }), 'abbreviated SHA');
  rejects('ExperimentContract', mutate(frozen, c => { c.baselines.engines_and_revisions = []; }), 'no baselines');
  rejects('ExperimentContract', mutate(frozen, c => { c.hardware.typo_field = 1; }), 'unknown property');
  rejects('ExperimentContract', mutate(frozen, c => { c.target_model.speculative_decoding = true; }), 'draft not declared');
  rejects('ExperimentContract', mutate(frozen, c => { c.target_model.tokenizer_hash = notApplicable('x'); }), 'identity hash cannot be N/A');
  rejects('ExperimentContract', mutate(frozen, c => { c.evaluation.definition.sha256 = null; }), 'frozen evaluation must be pinned');
  rejects('ExperimentContract', mutate(frozen, c => { c.evaluation.scripts = [{ role: 'driver', path: 'run.sh', sha256: sha('1') }]; }), 'a contract cannot carry evaluation scripts');
  rejects('ExperimentContract', mutate(frozen, c => { c.evaluation.task_ids = ['task-1']; }), 'a contract cannot define the workload');
});

test('a synthetic run record validates and status, comparison, and claim rules reject unsupported records', () => {
  const run = syntheticRun();
  accepts('ExperimentRun', run);

  rejects('ExperimentRun', mutate(run, r => { r.acceptance = 'passed'; r.status = 'running'; }), 'passed needs completed');
  rejects('ExperimentRun', mutate(run, r => { r.ended_at = null; }), 'completed needs an end');
  rejects('ExperimentRun', mutate(run, r => { r.evidence = []; }), 'evidence required');
  rejects('ExperimentRun', mutate(run, r => { r.evaluation_results = []; }), 'completed needs a result document');
  rejects('ExperimentRun', mutate(run, r => { r.evaluation_results[0].sha256 = 'abc'; }), 'result documents are pinned by hash');
  rejects('ExperimentRun', mutate(run, r => { r.engines = []; }), 'results live in evaluation result documents');

  rejects('ExperimentRun', mutate(run, r => {
    Object.assign(r.comparisons[0], { matched_settings: true, speedup_ratio: 2 });
  }), 'no speedup for incompatible metrics');
  rejects('ExperimentRun', mutate(run, r => {
    Object.assign(r.comparisons[0], { definitions_compatible: true, speedup_ratio: 2 });
  }), 'matched track speedup needs matched settings');
  accepts('ExperimentRun', mutate(run, r => {
    Object.assign(r.comparisons[0], {
      baseline_value: 10,
      candidate_value: 20,
      definitions_compatible: true,
      matched_settings: true,
      speedup_ratio: 2,
    });
  }));

  const claim = {
    claim_type: 'best-among-tested',
    bounds: 'synthetic device, model, workload, metric, and envelope',
    comparison_engines: ['synthetic-baseline'],
    date: '2026-10-28',
    uncertainty: 'synthetic',
    baseline_coverage_sufficient: false,
  };
  accepts('PerformanceClaim', claim);
  rejects('PerformanceClaim', { ...claim, claim_type: 'bounded-sota' }, 'bounded SOTA needs baseline coverage');
  rejects('PerformanceClaim', { ...claim, claim_type: 'competitive-with' }, 'competitive-with needs a named baseline');
  accepts('PerformanceClaim', { ...claim, claim_type: 'bounded-sota', baseline_coverage_sufficient: true });
});

test('an evaluation result validates and metric, evidence, and repetition rules reject unsupported results', () => {
  const result = syntheticResult();
  acceptsEvaluation('EvaluationResult', result);

  rejectsEvaluation('EvaluationResult', mutate(result, r => { r.evaluation.revision = null; }), 'result must pin its evaluation');
  rejectsEvaluation('EvaluationResult', mutate(result, r => { delete r.evaluation; }), 'result must cite its evaluation');
  rejectsEvaluation('EvaluationResult', mutate(result, r => { r.metrics.prefill = 0; }), 'missing metric is not zero');
  rejectsEvaluation('EvaluationResult', mutate(result, r => { r.metrics.decode.basis = 'arithmetic-mean'; }), 'unknown decode basis');
  rejectsEvaluation('EvaluationResult', mutate(result, r => { r.metrics.formal_repetitions = 1; }), 'single cohort is preliminary');
  rejectsEvaluation('EvaluationResult', mutate(result, r => { r.repetitions[0].outcome = 'failed'; }), 'failure needs description');
  rejectsEvaluation('EvaluationResult', mutate(result, r => { r.artifacts = []; }), 'runtime identity needs hashes');
  rejectsEvaluation('EvaluationResult', mutate(result, r => { r.metrics.per_request_evidence.url = 'https://example.invalid/log'; }), 'local-only evidence has no URL');
});

const releasedDefinition = scriptHash => ({
  evaluation_id: 'synthetic-evaluation',
  status: 'released',
  description: 'Synthetic fixture; not an evaluation.',
  result_schema: 'EvaluationResult',
  harness: { name: 'synthetic-harness', version: '1' },
  dataset: { repository: 'https://example.invalid/data', revision: commit('a'), file: 'data.jsonl', sha256: sha('b') },
  task_ids: ['task-1'],
  seed: 0,
  limits: { context_window: 1024, max_output_tokens_per_request: 128, timeout_seconds_per_task: 10, request_concurrency: 1 },
  cache_policy: 'none',
  sampling_settings: { temperature: 0 },
  scripts: [{ role: 'driver', path: 'scripts/run.sh', sha256: scriptHash }],
});

// Evaluation code is owned by its directory in this repository: valid definition, matching id, contained scripts, matching hashes.
function checkEvaluationDir(dir) {
  const definition = JSON.parse(readFileSync(join(dir, 'evaluation.json'), 'utf8'));
  acceptsEvaluation('EvaluationDefinition', definition);
  assert.equal(basename(dir), definition.evaluation_id, 'directory name must equal evaluation_id');
  for (const script of definition.scripts ?? []) {
    const file = resolve(dir, script.path);
    assert.ok(!relative(dir, file).startsWith('..') && file.startsWith(dir + sep), `${script.path} escapes ${dir}`);
    assert.ok(existsSync(file), `${script.path} is missing`);
    assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), script.sha256, `${script.path} hash`);
  }
  return definition;
}

test('repository evaluation definitions are valid, own their directory, and match their script hashes', () => {
  const base = join(root, 'evaluations');
  const names = readdirSync(base, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
  assert.ok(names.length > 0);
  for (const name of names) checkEvaluationDir(join(base, name));
  assert.ok(names.includes(example.evaluation.definition.evaluation_id), 'the example selects a repository evaluation');
});

test('a released evaluation needs a driver, no unresolved fields, contained paths, and verified scripts', () => {
  const released = releasedDefinition(sha('1'));
  acceptsEvaluation('EvaluationDefinition', released);
  rejectsEvaluation('EvaluationDefinition', mutate(released, d => { d.cache_policy = null; }), 'released has no null');
  rejectsEvaluation('EvaluationDefinition', mutate(released, d => { d.scripts[0].role = 'assertion-evaluator'; }), 'released needs a driver');
  rejectsEvaluation('EvaluationDefinition', mutate(released, d => { d.scripts[0].path = '../outside.sh'; }), 'no parent traversal');
  rejectsEvaluation('EvaluationDefinition', mutate(released, d => { d.scripts[0].path = '/etc/passwd'; }), 'no absolute path');
  rejectsEvaluation('EvaluationDefinition', mutate(released, d => { d.evaluation_id = 'Not Kebab'; }), 'kebab-case id');
  acceptsEvaluation('EvaluationDefinition', mutate(released, d => { d.status = 'draft'; d.cache_policy = null; d.scripts = null; }));

  const base = mkdtempSync(join(tmpdir(), 'llm-bootstrap-evaluation-'));
  try {
    const script = '#!/bin/sh\necho synthetic\n';
    const place = (name, definition, content = script) => {
      const dir = join(base, name);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      writeFileSync(join(dir, 'evaluation.json'), JSON.stringify(definition));
      if (content !== null) writeFileSync(join(dir, 'scripts', 'run.sh'), content);
      return dir;
    };
    const hash = createHash('sha256').update(script).digest('hex');
    checkEvaluationDir(place('synthetic-evaluation', releasedDefinition(hash)));
    assert.throws(() => checkEvaluationDir(place('synthetic-evaluation', releasedDefinition(hash), `${script}tampered\n`)), /hash/);
    assert.throws(() => checkEvaluationDir(place('synthetic-evaluation', releasedDefinition(hash), null)), /missing/);
    assert.throws(() => checkEvaluationDir(place('other-name', releasedDefinition(hash))), /directory name/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('self-hosting claims need transition evidence and builder/target identity', () => {
  accepts('SelfHostingRecord', { status: 'not-demonstrated' });
  rejects('SelfHostingRecord', { status: 'demonstrated' }, 'no evidence');
  const demonstrated = {
    status: 'demonstrated',
    transition_point: when,
    builder_identity_matches_target: true,
    generated_runtime_artifacts: [{ name: 'synthetic-engine', sha256: sha('e') }],
    harness_endpoint_routing: 'synthetic',
    subsequent_development_evidence: [{ description: 'synthetic', access: 'local-only', sha256: sha('7'), access_limitation: 'synthetic' }],
    external_recovery_used: false,
  };
  accepts('SelfHostingRecord', demonstrated);
  rejects('SelfHostingRecord', { ...demonstrated, builder_identity_matches_target: false }, 'identity must match');
});

const derivedFrom = (overrides, extra = {}) => ({
  experiment_id: 'synthetic-derived',
  status: 'frozen',
  description: 'Synthetic derived fixture; not an experiment.',
  contract_frozen_at: when,
  extends: { path: 'base.json', revision: commit('6'), sha256: sha('9') },
  overrides,
  ...extra,
});

test('a derived contract inherits its base, overrides all but the target model, and resolves to a valid contract', () => {
  const base = frozenContract();
  const thresholds = [{ metric: 'prefill throughput', comparator: 'at-least', threshold: 2, unit: 'tok/s' }];
  const derived = derivedFrom({
    skills_revision: commit('7'),
    hardware: { power: 'Battery' },
    goal: { performance_thresholds: thresholds },
    baselines: { engines_and_revisions: [{ name: 'other-baseline', revision: commit('8') }] },
  });
  accepts('DerivedExperimentContract', derived);

  const effective = resolveContract(derived, base);
  accepts('ExperimentContract', effective);
  assert.deepEqual(effective.target_model, base.target_model);
  assert.equal(effective.experiment_id, 'synthetic-derived');
  assert.equal(effective.skills_revision, commit('7'));
  assert.equal(effective.hardware.power, 'Battery');
  assert.equal(effective.hardware.platform, base.hardware.platform);
  assert.deepEqual(effective.goal.performance_thresholds, thresholds);
  assert.equal(effective.goal.primary_metric, base.goal.primary_metric);
  assert.deepEqual(effective.baselines.engines_and_revisions, [{ name: 'other-baseline', revision: commit('8') }]);
  assert.equal(base.hardware.power, example.hardware.power, 'the base is not mutated');

  const amended = mutate(base, c => { c.amends = { revision: commit('5'), reason: 'synthetic' }; });
  assert.equal('amends' in resolveContract(derived, amended), false, 'amendments are not inherited');
});

test('a derived contract cannot override the target model or its own identity fields', () => {
  for (const key of ['target_model', 'experiment_id', 'status', 'description', 'contract_frozen_at', 'amends']) {
    const derived = derivedFrom({ [key]: {} });
    rejects('DerivedExperimentContract', derived, `${key} must not be overridden`);
    assert.throws(() => resolveContract(derived, frozenContract()), new RegExp(key));
  }
  rejects('DerivedExperimentContract', derivedFrom({}, { extends: { path: 'base.json' } }), 'base must be pinned');
  rejects('DerivedExperimentContract', mutate(derivedFrom({}), d => { delete d.extends; }), 'base is required');
});

test('misspelled or unresolved overrides fail validation of the effective contract', () => {
  const base = frozenContract();
  rejects('ExperimentContract', resolveContract(derivedFrom({ hardwre: { power: 'x' } }), base), 'unknown section');
  rejects('ExperimentContract', resolveContract(derivedFrom({ hardware: { powr: 'x' } }), base), 'unknown field');
  rejects('ExperimentContract', resolveContract(derivedFrom({ hardware: { power: null } }), base), 'frozen forbids null');
  const draft = derivedFrom({ hardware: { os_version: 'synthetic-os 2' } }, { status: 'draft-not-run', contract_frozen_at: null });
  accepts('ExperimentContract', resolveContract(draft, example));
});

test('derived contract files resolve through a hash-pinned chain and reject a changed base', () => {
  const dir = mkdtempSync(join(tmpdir(), 'llm-bootstrap-derive-'));
  try {
    const write = (name, value) => {
      const text = `${JSON.stringify(value, null, 2)}\n`;
      writeFileSync(join(dir, name), text);
      return createHash('sha256').update(text).digest('hex');
    };
    const base = frozenContract();
    const baseHash = write('base.json', base);
    const middleHash = write('middle.json', derivedFrom({ hardware: { power: 'Battery' } }, {
      experiment_id: 'synthetic-middle',
      extends: { path: 'base.json', revision: commit('6'), sha256: baseHash },
    }));
    write('leaf.json', derivedFrom({ budget: { wall_clock_hours: 2 } }, {
      extends: { path: 'middle.json', revision: commit('6'), sha256: middleHash },
    }));

    const effective = resolveContractFile(join(dir, 'leaf.json'));
    accepts('ExperimentContract', effective);
    assert.equal(effective.experiment_id, 'synthetic-derived');
    assert.equal(effective.hardware.power, 'Battery');
    assert.equal(effective.budget.wall_clock_hours, 2);
    assert.deepEqual(effective.target_model, base.target_model);

    write('base.json', mutate(base, c => { c.hardware.power = 'Changed'; }));
    assert.throws(() => resolveContractFile(join(dir, 'leaf.json')), /sha256/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const conformanceDir = join(root, 'evaluations', 'engine-api-conformance');
const python = (script, args, options = {}) => execFileSync('python3', [script, ...args], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  ...options,
});
const driver = (...args) => python(join(conformanceDir, 'scripts', 'conformance.py'), args);
const fileHash = path => createHash('sha256').update(readFileSync(path)).digest('hex');

// Runs the real driver entry point against the reference engine, optionally with an injected fault.
function runAgainstReference(dir, fault, window = true) {
  const output = join(dir, `result-${fault ?? 'clean'}${window ? '' : '-nowindow'}.json`);
  const code = [
    'import sys',
    `sys.path.insert(0, ${JSON.stringify(join(conformanceDir, 'scripts'))})`,
    'import conformance',
    'from fake_engine import FakeEngine',
    `with FakeEngine(faults=[${fault ? JSON.stringify(fault) : ''}]) as engine:`,
    `    sys.argv = ['conformance.py', '--endpoint', engine.origin, '--model', engine.model, '--engine-name', 'fake', ${window ? "'--context-window', str(engine.context_window), " : ''}'--output', ${JSON.stringify(output)}, '--evaluation-revision', ${JSON.stringify(commit('9'))}]`,
    '    code = conformance.main()',
    'raise SystemExit(code)',
  ].join('\n');
  let status = 0;
  try {
    python('-c', [code]);
  } catch (error) {
    status = error.status;
  }
  return { status, output, result: JSON.parse(readFileSync(output, 'utf8')) };
}

test('the conformance definition lists exactly the driver checks and limits', () => {
  const definition = read('evaluations/engine-api-conformance/evaluation.json');
  const described = JSON.parse(driver('--describe'));
  assert.deepEqual(definition.task_ids, described.check_ids);
  assert.equal(definition.limits.max_output_tokens_per_request, described.limits.max_output_tokens_per_request);
  assert.equal(definition.result_schema, 'ConformanceResult');
});

test('the conformance negative control passes and emits a valid, conformant result document', () => {
  const dir = mkdtempSync(join(tmpdir(), 'llm-bootstrap-conformance-'));
  try {
    const output = join(dir, 'result.json');
    assert.match(driver('--self-test', '--emit-result', output, '--evaluation-revision', commit('9')), /self-test: ok/);
    const result = JSON.parse(readFileSync(output, 'utf8'));
    acceptsEvaluation('ConformanceResult', result);
    assert.equal(result.checks.length, read('evaluations/engine-api-conformance/evaluation.json').task_ids.length);
    assert.deepEqual(result.summary, { ...result.summary, failed: 0, errored: 0, skipped: 0, required_failed: 0, conformant: true });
    assert.equal(result.evaluation.sha256, fileHash(join(conformanceDir, 'evaluation.json')));

    rejectsEvaluation('ConformanceResult', mutate(result, r => { r.negative_control.verified = false; }), 'conformant needs a verified negative control');
    rejectsEvaluation('ConformanceResult', mutate(result, r => { r.complete = false; }), 'conformant needs a complete run');
    rejectsEvaluation('ConformanceResult', mutate(result, r => { r.checks[0].outcome = 'fail'; }), 'a failed check needs a detail');
    rejectsEvaluation('ConformanceResult', mutate(result, r => { r.endpoint.host = '10.0.0.5'; }), 'no machine address in the result');
    acceptsEvaluation('ConformanceResult', mutate(result, r => {
      r.summary.conformant = false;
      r.complete = false;
      r.negative_control.verified = false;
    }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without a context window the overflow checks are skipped and the run stays valid', () => {
  const dir = mkdtempSync(join(tmpdir(), 'llm-bootstrap-conformance-'));
  try {
    const run = runAgainstReference(dir, undefined, false);
    acceptsEvaluation('ConformanceResult', run.result);
    const skipped = run.result.checks.filter(c => c.outcome === 'skip').map(c => c.check_id).sort();
    assert.deepEqual(skipped, ['chat.context.overflow_rejected', 'chat.context.recovers']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the real driver passes a correct engine, fails a faulty one, and records evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'llm-bootstrap-conformance-'));
  try {
    const clean = runAgainstReference(dir);
    assert.equal(clean.status, 0);
    acceptsEvaluation('ConformanceResult', clean.result);
    assert.equal(clean.result.summary.conformant, true);
    assert.equal(clean.result.endpoint.host_class, 'loopback');
    assert.equal(clean.result.cost.requests > 20, true);
    assert.equal(clean.result.evidence, undefined);

    const faulty = runAgainstReference(dir, 'chat_tool_finish_stop');
    assert.equal(faulty.status, 1);
    acceptsEvaluation('ConformanceResult', faulty.result);
    assert.equal(faulty.result.summary.conformant, false);
    assert.ok(faulty.result.summary.required_failed >= 1);
    assert.equal(faulty.result.evidence.access, 'local-only');
    assert.equal(faulty.result.evidence.sha256, fileHash(faulty.output.replace('.json', '.evidence.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the real driver refuses to run when a script no longer matches its recorded hash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'llm-bootstrap-conformance-'));
  try {
    const copy = join(dir, 'engine-api-conformance');
    cpSync(conformanceDir, copy, { recursive: true });
    writeFileSync(join(copy, 'scripts', 'client.py'), `${readFileSync(join(copy, 'scripts', 'client.py'), 'utf8')}# tampered\n`);
    assert.throws(
      () => python(join(copy, 'scripts', 'conformance.py'), ['--endpoint', 'http://127.0.0.1:1', '--model', 'm', '--output', join(dir, 'out.json'), '--evaluation-revision', commit('9')]),
      error => /does not match its recorded hash/.test(String(error.stderr)),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
