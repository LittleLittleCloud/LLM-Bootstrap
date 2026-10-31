import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Validator } from '@seriousme/openapi-schema-validator';
import { resolveExperiment, resolveExperimentFile } from '../skills/bootstrap-experiment-sop/scripts/resolve-experiment.mjs';
import { loadValidators } from '../skills/bootstrap-experiment-sop/scripts/validators.mjs';
import { commit, draftExperiment as example, frozenExperiment, sha, syntheticReport, when } from './helpers/fixtures.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => JSON.parse(readFileSync(`${root}${path}`, 'utf8'));
const spec = read('skills/bootstrap-experiment-sop/assets/schema/experiment-protocol.openapi.json');
const evaluationSpec = read('skills/bootstrap-experiment-sop/assets/schema/evaluation-protocol.openapi.json');

const { experiment: validators, evaluation: evaluationValidators } = await loadValidators();

const checks = set => ({
  accepts: (name, value) => assert.ok(set[name](value), JSON.stringify(set[name].errors, null, 2)),
  rejects: (name, value, why) => assert.equal(set[name](value), false, why),
});
const { accepts, rejects } = checks(validators);
const { accepts: acceptsEvaluation, rejects: rejectsEvaluation } = checks(evaluationValidators);

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
  assert.ok(shared.length >= 4, `only ${shared.length} shared schemas`);
  for (const name of shared) assert.deepEqual(evaluationSpec.components.schemas[name], spec.components.schemas[name], name);
});

// The value types a field can take, following references; an object or an array of arrays or objects would be nested data.
function valueTypes(schema, components, seen = new Set()) {
  if (schema.$ref) {
    const name = schema.$ref.split('/').pop();
    if (seen.has(name)) return [];
    return valueTypes(components[name], components, new Set([...seen, name]));
  }
  const nested = [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])].flatMap(item => valueTypes(item, components, seen));
  const own = [].concat(schema.type ?? []).flatMap(type => (type === 'array'
    ? ['array', ...(schema.items ? valueTypes(schema.items, components, seen).map(item => `item:${item}`) : [])]
    : [type]));
  return [...own, ...nested];
}

test('the experiment schemas are flat: no field holds an object or a nested array', () => {
  const components = spec.components.schemas;
  for (const name of ['Experiment', 'DerivedExperiment']) {
    const fields = { ...components[name].properties, ...components[name].patternProperties };
    assert.ok(Object.keys(fields).length > 15 || name === 'DerivedExperiment', `${name} declares its fields`);
    for (const [key, schema] of Object.entries(fields)) {
      const nested = valueTypes(schema, components).filter(type => ['object', 'item:object', 'item:array'].includes(type));
      assert.deepEqual(nested, [], `${name}.${key} is nested`);
    }
  }
});

test('the draft fixture validates as a draft experiment but not as a frozen one', () => {
  accepts('Experiment', example);
  rejects('Experiment', { ...example, status: 'frozen' }, 'unresolved nulls must not freeze');
});

test('a fully resolved experiment can be frozen and unresolved or invalid fields are rejected', () => {
  const frozen = frozenExperiment();
  accepts('Experiment', frozen);
  accepts('Experiment', { ...frozen, amends_revision: commit('5'), amends_reason: 'synthetic' });
  rejects('Experiment', { ...frozen, amends_revision: commit('5') }, 'an amendment names its reason');
  rejects('Experiment', { ...frozen, hardware_gpu_cores: null }, 'null in a frozen experiment');
  rejects('Experiment', { ...frozen, target_revision: 'abc1234' }, 'abbreviated SHA');
  rejects('Experiment', { ...frozen, engine_name: null }, 'a frozen experiment names its engine');
  rejects('Experiment', { ...frozen, engine_commit: 'abc1234' }, 'an engine is pinned by a full commit');
  rejects('Experiment', { ...frozen, engine_name: 'a/b' }, 'an engine name has no path separator');
  rejects('Experiment', { ...frozen, engines: [`one=${commit('2')}`] }, 'one engine per experiment');
  accepts('Experiment', { ...frozen, engine_name: 'mlx-lm', engine_commit: commit('3') });
  for (const dropped of ['builder_model', 'harness_name', 'skills_revision', 'goal_quality_gate', 'baseline_engines', 'budget_wall_clock_hours', 'scope']) {
    rejects('Experiment', { ...frozen, [dropped]: 'x' }, `${dropped} is not part of an experiment`);
  }
  rejects('Experiment', { ...frozen, typo_field: 1 }, 'unknown field');
  rejects('Experiment', { ...frozen, hardware: { platform: 'x' } }, 'groups are key prefixes, not objects');
  rejects('Experiment', { ...frozen, hardware_platform: { name: 'x' } }, 'a field holds no object');
  rejects('Experiment', { ...frozen, evaluation_sha256: null }, 'frozen evaluation must be pinned');
  rejects('Experiment', { ...frozen, goal_thresholds: ['decode throughput at least 1'] }, 'a threshold is metric, comparator, value');
  rejects('Experiment', { ...frozen, evaluation_formal_repetitions: 3 }, 'the evaluation fixes its own repetitions');
  rejects('Experiment', { ...frozen, goal_thresholds: [] }, 'at least one threshold');
  rejects('Experiment', { ...frozen, evaluation_scripts: ['run.sh'] }, 'an experiment cannot carry evaluation scripts');
  rejects('Experiment', { ...frozen, evaluation_task_ids: ['task-1'] }, 'an experiment cannot define the workload');
});

test('a report holds what was measured and nothing about the machine, the experiment, or the engine', () => {
  const report = syntheticReport();
  acceptsEvaluation('EvaluationReport', report);
  for (const key of ['evaluation_id', 'evaluation_revision', 'evaluation_sha256', 'started_at', 'endpoint_class', 'model', 'profile', 'seed', 'context_window', 'selected_tests', 'status', 'failures', 'tests']) {
    rejectsEvaluation('EvaluationReport', mutate(report, r => { delete r[key]; }), `${key} is required`);
  }
  for (const key of ['experiment_id', 'engine_name', 'environment_hardware_model', 'artifacts', 'endpoint', 'token', 'api_key', 'human_interventions']) {
    rejectsEvaluation('EvaluationReport', { ...report, [key]: 'x' }, `a report has no ${key}`);
  }
  rejectsEvaluation('EvaluationReport', { ...report, evaluation_revision: 'abc1234' }, 'a report pins its evaluation by full commit');
  rejectsEvaluation('EvaluationReport', { ...report, endpoint_class: 'http://127.0.0.1:8080' }, 'the address is never recorded');
  rejectsEvaluation('EvaluationReport', { ...report, profile: 'turbo' }, 'unknown profile');
  rejectsEvaluation('EvaluationReport', { ...report, seed: 'xyz' }, 'the seed is eight hex digits');
  rejectsEvaluation('EvaluationReport', { ...report, selected_tests: [] }, 'at least one test');
  rejectsEvaluation('EvaluationReport', { ...report, selected_tests: ['conform', 'conform'] }, 'a test is selected once');
  rejectsEvaluation('EvaluationReport', { ...report, selected_tests: ['gsm8k'] }, 'unknown test');
  rejectsEvaluation('EvaluationReport', { ...report, tests: { speed: { status: 'complete' } } }, 'a complete test carries its runs and summary');
  rejectsEvaluation('EvaluationReport', { ...report, tests: { conform: { status: 'complete' } } }, 'a complete conformance test carries its checks');
  rejectsEvaluation('EvaluationReport', { ...report, tests: { other: { status: 'complete' } } }, 'unknown test result');
  rejectsEvaluation('EvaluationReport', { ...report, status: 'partial' }, 'an incomplete report lists its failures');
  acceptsEvaluation('EvaluationReport', { ...report, status: 'partial', failures: ['speed: error (timeout)'], tests: { ...report.tests, speed: { status: 'error', error: 'timeout' } }, selected_tests: ['conform', 'speed'] });
  rejectsEvaluation('EvaluationReport', { ...report, failures: ['speed: error'] }, 'a complete report has no failures');
  acceptsEvaluation('EvaluationReport', { ...report, build_dirty: true });
  rejectsEvaluation('EvaluationReport', { ...report, build_dirty: false }, 'the flag is present only when true');
  rejectsEvaluation('EvaluationReport', { ...report, context_window: { tokens: 0, source: 'assumed' } }, 'a window has tokens');
  rejectsEvaluation('EvaluationReport', { ...report, context_window: { tokens: 10, source: 'guessed' } }, 'a window says where it came from');
});

const realDefinition = JSON.parse(readFileSync(join(root, 'evaluations', 'endpoint-bench', 'evaluation.json'), 'utf8'));
const releasedDefinition = scriptHash => ({
  ...structuredClone(realDefinition),
  evaluation_id: 'synthetic-evaluation',
  description: 'Synthetic fixture; not an evaluation.',
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
  assert.ok(names.includes(example.evaluation_id), 'the draft fixture selects a repository evaluation');
});

test('a released evaluation needs a driver, no unresolved fields, contained paths, and verified scripts', () => {
  const released = releasedDefinition(sha('1'));
  acceptsEvaluation('EvaluationDefinition', released);
  rejectsEvaluation('EvaluationDefinition', mutate(released, d => { d.plan.speed.runs = 0; }), 'a test runs at least once');
  rejectsEvaluation('EvaluationDefinition', mutate(released, d => { delete d.plan.cache; }), 'the plan covers every test');
  rejectsEvaluation('EvaluationDefinition', mutate(released, d => { d.plan.speed.extra = 1; }), 'the plan has no unknown settings');
  rejectsEvaluation('EvaluationDefinition', mutate(released, d => { d.profiles.slow = {}; }), 'only the quick profile exists');
  rejectsEvaluation('EvaluationDefinition', mutate(released, d => { d.scripts = []; }), 'released has scripts');
  rejectsEvaluation('EvaluationDefinition', mutate(released, d => { d.result_schema = 'EvaluationResult'; }), 'the result is a report');
  rejectsEvaluation('EvaluationDefinition', mutate(released, d => { d.scripts[0].role = 'assertion-evaluator'; }), 'released needs a driver');
  rejectsEvaluation('EvaluationDefinition', mutate(released, d => { d.scripts[0].path = '../outside.sh'; }), 'no parent traversal');
  rejectsEvaluation('EvaluationDefinition', mutate(released, d => { d.scripts[0].path = '/etc/passwd'; }), 'no absolute path');
  rejectsEvaluation('EvaluationDefinition', mutate(released, d => { d.evaluation_id = 'Not Kebab'; }), 'kebab-case id');
  acceptsEvaluation('EvaluationDefinition', mutate(released, d => { d.status = 'draft'; d.scripts = []; }));

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

const derivedFrom = (overrides, extra = {}) => ({
  experiment_id: 'synthetic-derived',
  status: 'frozen',
  description: 'Synthetic derived fixture; not an experiment.',
  contract_frozen_at: when,
  extends_path: 'base.json',
  extends_revision: commit('6'),
  extends_sha256: sha('9'),
  ...overrides,
  ...extra,
});

test('a derived experiment inherits its base, overrides all but the target model, and resolves to a valid experiment', () => {
  const base = frozenExperiment();
  const derived = derivedFrom({
    hardware_memory_gib: 64,
    goal_thresholds: ['prefill_tokens_per_second_p50 >= 2'],
    engine_commit: commit('8'),
  });
  accepts('DerivedExperiment', derived);

  const effective = resolveExperiment(derived, base);
  accepts('Experiment', effective);
  for (const key of Object.keys(base).filter(name => name.startsWith('target_'))) assert.deepEqual(effective[key], base[key], key);
  assert.equal(effective.experiment_id, 'synthetic-derived');
  assert.equal(effective.hardware_memory_gib, 64);
  assert.equal(effective.hardware_platform, base.hardware_platform);
  assert.deepEqual(effective.goal_thresholds, ['prefill_tokens_per_second_p50 >= 2']);
  assert.equal(effective.evaluation_id, base.evaluation_id);
  assert.equal(effective.engine_commit, commit('8'));
  assert.equal(effective.engine_name, base.engine_name);
  assert.equal(base.hardware_memory_gib, example.hardware_memory_gib, 'the base is not mutated');
  assert.equal('extends_path' in effective, false, 'the effective experiment carries no extends fields');

  const amended = { ...base, amends_revision: commit('5'), amends_reason: 'synthetic' };
  assert.equal('amends_revision' in resolveExperiment(derived, amended), false, 'amendments are not inherited');
});

test('a derived experiment cannot override the target model, and its own identity fields come from itself', () => {
  for (const key of ['target_repository', 'target_weights', 'target_revision']) {
    const derived = derivedFrom({ [key]: 'x' });
    rejects('DerivedExperiment', derived, `${key} must not be overridden`);
    assert.throws(() => resolveExperiment(derived, frozenExperiment()), new RegExp(key));
  }
  rejects('DerivedExperiment', mutate(derivedFrom({}), d => { delete d.extends_sha256; }), 'base must be pinned');
  rejects('DerivedExperiment', mutate(derivedFrom({}), d => { delete d.extends_path; }), 'base is required');
  rejects('DerivedExperiment', derivedFrom({}, { amends_reason: 'x' }), 'an amendment names its revision');
});

test('misspelled or unresolved overrides fail validation of the effective experiment', () => {
  const base = frozenExperiment();
  rejects('Experiment', resolveExperiment(derivedFrom({ hardware_powr: 'x' }), base), 'unknown field');
  rejects('Experiment', resolveExperiment(derivedFrom({ hardware_memory_gib: null }), base), 'frozen forbids null');
  const draft = derivedFrom({ hardware_gpu_cores: 32 }, { status: 'draft-not-run', contract_frozen_at: null });
  accepts('Experiment', resolveExperiment(draft, example));
});

test('derived experiment files resolve through a hash-pinned chain and reject a changed base', () => {
  const dir = mkdtempSync(join(tmpdir(), 'llm-bootstrap-derive-'));
  try {
    const write = (name, value) => {
      const text = `${JSON.stringify(value, null, 2)}\n`;
      writeFileSync(join(dir, name), text);
      return createHash('sha256').update(text).digest('hex');
    };
    const base = frozenExperiment();
    const baseHash = write('base.json', base);
    const middleHash = write('middle.json', derivedFrom({ hardware_memory_gib: 64 }, {
      experiment_id: 'synthetic-middle',
      extends_sha256: baseHash,
    }));
    write('leaf.json', derivedFrom({ hardware_gpu_cores: 32 }, { extends_path: 'middle.json', extends_sha256: middleHash }));

    const effective = resolveExperimentFile(join(dir, 'leaf.json'));
    accepts('Experiment', effective);
    assert.equal(effective.experiment_id, 'synthetic-derived');
    assert.equal(effective.hardware_memory_gib, 64);
    assert.equal(effective.hardware_gpu_cores, 32);
    assert.equal(effective.target_repository, base.target_repository);

    write('base.json', { ...base, hardware_memory_gib: 128 });
    assert.throws(() => resolveExperimentFile(join(dir, 'leaf.json')), /sha256/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
