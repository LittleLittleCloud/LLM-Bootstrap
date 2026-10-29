import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Validator } from '@seriousme/openapi-schema-validator';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { resolveContract, resolveContractFile } from '../schema/resolve-contract.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const spec = JSON.parse(readFileSync(`${root}schema/experiment-protocol.openapi.json`, 'utf8'));
const example = JSON.parse(readFileSync(`${root}experiments/m5pro-qwen36-pi/example.json`, 'utf8'));

// Component refs become $defs refs so each Schema Object compiles under strict JSON Schema 2020-12.
const defs = JSON.parse(JSON.stringify(spec.components.schemas).replaceAll('#/components/schemas/', () => '#/$defs/'));
const id = 'https://llm-bootstrap.invalid/experiment-protocol';
// Conditional overlays name sibling properties, so strictTypes and strictRequired stay off.
const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false });
addFormats(ajv);
ajv.addSchema({ $id: id, $defs: defs });
const validators = Object.fromEntries(
  Object.keys(defs).map(name => [name, ajv.compile({ $ref: `${id}#/$defs/${name}` })]),
);

const accepts = (name, value) => {
  assert.ok(validators[name](value), JSON.stringify(validators[name].errors, null, 2));
};
const rejects = (name, value, why) => assert.equal(validators[name](value), false, why);

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
  Object.assign(contract.evaluation, {
    sampling_settings: { temperature: 0 },
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

function syntheticRun() {
  const detail = 'synthetic';
  const evidence = { description: detail, access: 'local-only', sha256: sha('8'), access_limitation: detail };
  return {
    run_id: 'synthetic-schema-fixture',
    status: 'completed',
    acceptance: 'unverified',
    contract: { path: 'contract.json', revision: commit('4'), sha256: sha('f') },
    skills_revision: commit('1'),
    started_at: when,
    ended_at: when,
    environment: {
      hardware_model: detail,
      os_version: detail,
      toolchain: detail,
      power_mode: detail,
      thermal_observations: detail,
      exclusive_gpu: true,
      deviations_from_contract: [],
    },
    engines: [{
      role: 'candidate',
      engine_name: 'synthetic-engine',
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
        per_request_evidence: evidence,
      },
      resources: { peak_memory_gib: 'Not obtained', swap_out_delta_bytes: 'Not obtained' },
      quality: {
        numerical_status: 'not-run',
        application: { passed: 1, total: 1, negative_control_verified: true, restricted_environment: true },
      },
    }],
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
    evidence: [evidence],
    interpretation: 'Synthetic schema fixture; not a measurement.',
  };
}

const mutate = (value, change) => {
  const copy = structuredClone(value);
  change(copy);
  return copy;
};

test('every component schema compiles under strict JSON Schema 2020-12', () => {
  assert.equal(spec.openapi, '3.1.0');
  assert.deepEqual(Object.keys(validators).sort(), Object.keys(spec.components.schemas).sort());
});

test('the OpenAPI document passes the official OpenAPI 3.1 schema', async () => {
  const result = await new Validator().validate(structuredClone(spec));
  assert.ok(result.valid, JSON.stringify(result.errors, null, 2));
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
});

test('a synthetic run record validates and metric, evidence, and comparison rules reject unsupported records', () => {
  const run = syntheticRun();
  accepts('ExperimentRun', run);
  const engine = r => r.engines[0];

  rejects('ExperimentRun', mutate(run, r => { engine(r).metrics.prefill = 0; }), 'missing metric is not zero');
  rejects('ExperimentRun', mutate(run, r => { engine(r).metrics.decode.basis = 'arithmetic-mean'; }), 'unknown decode basis');
  rejects('ExperimentRun', mutate(run, r => { engine(r).metrics.formal_repetitions = 1; }), 'single cohort is preliminary');
  rejects('ExperimentRun', mutate(run, r => { engine(r).repetitions[0].outcome = 'failed'; }), 'failure needs description');
  rejects('ExperimentRun', mutate(run, r => { engine(r).artifacts = []; }), 'runtime identity needs hashes');
  rejects('ExperimentRun', mutate(run, r => { engine(r).metrics.per_request_evidence.url = 'https://example.invalid/log'; }), 'local-only evidence has no URL');
  rejects('ExperimentRun', mutate(run, r => { r.acceptance = 'passed'; r.status = 'running'; }), 'passed needs completed');
  rejects('ExperimentRun', mutate(run, r => { r.ended_at = null; }), 'completed needs an end');
  rejects('ExperimentRun', mutate(run, r => { r.evidence = []; }), 'evidence required');

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
