import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Validator } from '@seriousme/openapi-schema-validator';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

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
