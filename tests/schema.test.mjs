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
import { commit, draftExperiment as example, frozenExperiment, sha, syntheticResult, when } from './helpers/fixtures.mjs';

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
  assert.ok(shared.length >= 11, `only ${shared.length} shared schemas`);
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

test('the experiment and evaluation record schemas are flat: no field holds an object or a nested array', () => {
  for (const [document, names] of [[spec, ['Experiment', 'DerivedExperiment']], [evaluationSpec, ['EvaluationResult']]]) {
    const components = document.components.schemas;
    for (const name of names) {
      const fields = { ...components[name].properties, ...components[name].patternProperties };
      assert.ok(Object.keys(fields).length > 30 || name === 'DerivedExperiment', `${name} declares its fields`);
      for (const [key, schema] of Object.entries(fields)) {
        const nested = valueTypes(schema, components).filter(type => ['object', 'item:object', 'item:array'].includes(type));
        assert.deepEqual(nested, [], `${name}.${key} is nested`);
      }
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
  rejects('Experiment', { ...frozen, hardware_os_version: null }, 'null in a frozen experiment');
  rejects('Experiment', { ...frozen, skills_revision: 'abc1234' }, 'abbreviated SHA');
  rejects('Experiment', { ...frozen, baseline_engines: [] }, 'no baselines');
  rejects('Experiment', { ...frozen, baseline_engines: ['synthetic-baseline'] }, 'a baseline names its commit');
  rejects('Experiment', { ...frozen, typo_field: 1 }, 'unknown field');
  rejects('Experiment', { ...frozen, hardware: { platform: 'x' } }, 'groups are key prefixes, not objects');
  rejects('Experiment', { ...frozen, hardware_platform: { name: 'x' } }, 'a field holds no object');
  rejects('Experiment', { ...frozen, target_speculative_decoding: true }, 'draft not declared');
  rejects('Experiment', { ...frozen, target_tokenizer_sha256: 'Not applicable: x' }, 'identity hash cannot be N/A');
  rejects('Experiment', { ...frozen, evaluation_sha256: null }, 'frozen evaluation must be pinned');
  rejects('Experiment', { ...frozen, goal_thresholds: ['decode throughput at least 1'] }, 'a threshold is metric, comparator, value');
  rejects('Experiment', { ...frozen, goal_thresholds: [] }, 'at least one threshold');
  rejects('Experiment', { ...frozen, evaluation_scripts: ['run.sh'] }, 'an experiment cannot carry evaluation scripts');
  rejects('Experiment', { ...frozen, evaluation_task_ids: ['task-1'] }, 'an experiment cannot define the workload');
  accepts('Experiment', { ...frozen, target_speculative_decoding: true, target_speculative_draft: 'draft-model q4, 4 tokens' });
});

test('an evaluation record validates and metric, key-family, and pass rules reject unsupported records', () => {
  const result = syntheticResult();
  acceptsEvaluation('EvaluationResult', result);
  acceptsEvaluation('EvaluationResult', {
    ...result,
    'throughput.decode.in128.out256.c1.decode_tokens_per_second': 200,
    'throughput.decode.in128.out256.c1.requests': 4,
    'throughput.decode.in128.out256.c1.cache_hit_ratio': 'Not obtained',
    'throughput.decode.in128.out256.c1.pass_tokens_per_second': [199, 201],
    'throughput.multi-turn.in8k.t5.c1.first_turn_ttft_seconds': 0.9,
  });
  acceptsEvaluation('EvaluationResult', { ...result, prefill_tokens_per_second: 'Not obtained', prefill_basis: 'Not obtained' });

  for (const key of Object.keys(result).filter(name => name.startsWith('evaluation_') || name.startsWith('experiment_'))) {
    rejectsEvaluation('EvaluationResult', mutate(result, r => { delete r[key]; }), `${key} pins the record`);
  }
  rejectsEvaluation('EvaluationResult', { ...result, evaluation_revision: null }, 'a record pins its evaluation');
  rejectsEvaluation('EvaluationResult', { ...result, prefill_tokens_per_second: null }, 'a missing metric is Not obtained');
  rejectsEvaluation('EvaluationResult', { ...result, prefill_tokens_per_second: 'n/a' }, 'a missing metric is Not obtained');
  rejectsEvaluation('EvaluationResult', { ...result, decode_basis: 'arithmetic-mean' }, 'unknown decode basis');
  rejectsEvaluation('EvaluationResult', { ...result, formal_passes_succeeded: 1 }, 'a single cohort is preliminary');
  rejectsEvaluation('EvaluationResult', { ...result, formal_passes_failed: 1 }, 'a failure needs a description');
  acceptsEvaluation('EvaluationResult', { ...result, formal_passes_failed: 1, failures: ['formal pass 2 failed: timed out'] });
  rejectsEvaluation('EvaluationResult', { ...result, artifacts: [] }, 'runtime identity needs hashes');
  rejectsEvaluation('EvaluationResult', { ...result, artifacts: ['synthetic-engine'] }, 'an artifact names its hash');
  rejectsEvaluation('EvaluationResult', { ...result, evidence_sha256: 'abc' }, 'evidence is referenced by hash');
  rejectsEvaluation('EvaluationResult', { ...result, environment: { hardware_model: 'x' } }, 'groups are key prefixes, not objects');
  rejectsEvaluation('EvaluationResult', { ...result, 'setting.nested': { a: 1 } }, 'a setting is a scalar');
  rejectsEvaluation('EvaluationResult', { ...result, 'settings.weight_precision': 'x' }, 'only setting.* keys are settings');
  rejectsEvaluation('EvaluationResult', { ...result, 'throughput.decode.in128.out256.c0.requests': 4 }, 'concurrency starts at 1');
  rejectsEvaluation('EvaluationResult', { ...result, 'throughput.decode.in128.out256.c1.requests': 1.5 }, 'a request count is an integer');
  rejectsEvaluation('EvaluationResult', { ...result, 'throughput.decode.in128.out256.c1.speed': 1 }, 'unknown throughput metric');
  rejectsEvaluation('EvaluationResult', { ...result, 'intelligence.synthetic.score': 2 }, 'a score is a proportion');
  rejectsEvaluation('EvaluationResult', { ...result, 'intelligence.synthetic.num_samples': 0 }, 'a benchmark scores at least one sample');
  rejectsEvaluation('EvaluationResult', { ...result, extra: 1 }, 'unknown field');
});

test('self-hosting claims need transition evidence and builder/target identity', () => {
  const result = syntheticResult();
  acceptsEvaluation('EvaluationResult', { ...result, self_hosting_status: 'not-demonstrated' });
  rejectsEvaluation('EvaluationResult', { ...result, self_hosting_status: 'demonstrated' }, 'no evidence');
  const demonstrated = {
    ...result,
    self_hosting_status: 'demonstrated',
    self_hosting_transition_at: when,
    self_hosting_builder_matches_target: true,
    self_hosting_routing: 'synthetic',
    self_hosting_external_recovery_used: false,
    self_hosting_evidence_sha256: sha('7'),
  };
  acceptsEvaluation('EvaluationResult', demonstrated);
  rejectsEvaluation('EvaluationResult', { ...demonstrated, self_hosting_builder_matches_target: false }, 'identity must match');
});

const releasedDefinition = scriptHash => ({
  evaluation_id: 'synthetic-evaluation',
  status: 'released',
  description: 'Synthetic fixture; not an evaluation.',
  result_schema: 'EvaluationResult',
  harness: { name: 'synthetic-harness', version: '1' },
  datasets: [{ name: 'data', source: 'modelscope', repository: 'synthetic/data', files: [{ path: 'data.parquet', sha256: sha('b') }] }],
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
  assert.ok(names.includes(example.evaluation_id), 'the draft fixture selects a repository evaluation');
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
    skills_revision: commit('7'),
    hardware_power: 'Battery',
    goal_thresholds: ['prefill_tokens_per_second >= 2'],
    baseline_engines: [`other-baseline=${commit('8')}`],
  });
  accepts('DerivedExperiment', derived);

  const effective = resolveExperiment(derived, base);
  accepts('Experiment', effective);
  for (const key of Object.keys(base).filter(name => name.startsWith('target_'))) assert.deepEqual(effective[key], base[key], key);
  assert.equal(effective.experiment_id, 'synthetic-derived');
  assert.equal(effective.skills_revision, commit('7'));
  assert.equal(effective.hardware_power, 'Battery');
  assert.equal(effective.hardware_platform, base.hardware_platform);
  assert.deepEqual(effective.goal_thresholds, ['prefill_tokens_per_second >= 2']);
  assert.equal(effective.goal_primary_metric, base.goal_primary_metric);
  assert.deepEqual(effective.baseline_engines, [`other-baseline=${commit('8')}`]);
  assert.equal(base.hardware_power, example.hardware_power, 'the base is not mutated');
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
  rejects('Experiment', resolveExperiment(derivedFrom({ hardware_power: null }), base), 'frozen forbids null');
  const draft = derivedFrom({ hardware_os_version: 'synthetic-os 2' }, { status: 'draft-not-run', contract_frozen_at: null });
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
    const middleHash = write('middle.json', derivedFrom({ hardware_power: 'Battery' }, {
      experiment_id: 'synthetic-middle',
      extends_sha256: baseHash,
    }));
    write('leaf.json', derivedFrom({ budget_wall_clock_hours: 2 }, { extends_path: 'middle.json', extends_sha256: middleHash }));

    const effective = resolveExperimentFile(join(dir, 'leaf.json'));
    accepts('Experiment', effective);
    assert.equal(effective.experiment_id, 'synthetic-derived');
    assert.equal(effective.hardware_power, 'Battery');
    assert.equal(effective.budget_wall_clock_hours, 2);
    assert.equal(effective.target_repository, base.target_repository);

    write('base.json', { ...base, hardware_power: 'Changed' });
    assert.throws(() => resolveExperimentFile(join(dir, 'leaf.json')), /sha256/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
