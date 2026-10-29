import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Validator } from '@seriousme/openapi-schema-validator';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse } from 'yaml';

const root = fileURLToPath(new URL('../', import.meta.url));
const spec = parse(readFileSync(`${root}schema/experiment-protocol.openapi.yaml`, 'utf8'));
const example = JSON.parse(readFileSync(`${root}experiments/m5pro-qwen36-pi/example.json`, 'utf8'));

// Component refs become $defs refs so each Schema Object compiles under strict JSON Schema 2020-12.
const defs = JSON.parse(JSON.stringify(spec.components.schemas).replaceAll('#/components/schemas/', () => '#/$defs/'));
const id = 'https://llm-bootstrap.invalid/experiment-protocol';
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
  });
  Object.assign(contract.scope, {
    statement: 'Synthetic engine construction only.',
    operating_system_changes_in_scope: 'None.',
    execution_authorization: 'Synthetic fixture; authorizes nothing.',
  });
  Object.assign(contract.hardware, {
    os_version: 'synthetic-os 1',
    drivers: notApplicable('Drivers ship with the OS.'),
    toolchain: 'synthetic-toolchain 1',
    cpu_fallback_allowed: false,
    offloading_allowed: false,
    ssd_streaming_allowed: false,
    multi_host_allowed: false,
  });
  Object.assign(contract.target_model, {
    file_hash_manifest: [{ name: 'model-00001.safetensors', sha256: sha('b') }],
    tokenizer_hash: sha('c'),
    chat_template_hash: sha('d'),
    activation_precision: 'bf16',
    context_limit_tokens: 32768,
    speculative_draft: notApplicable('Speculative decoding is disabled.'),
  });
  Object.assign(contract.builder, {
    model: 'synthetic-builder',
    provider: unavailable('Provider exposes no identifier.'),
    revision_or_exposed_identifier: unavailable('Provider exposes no revision.'),
    initial_inference_location: 'hosted',
    routing_control: 'user',
    sampling_settings: { temperature: 0 },
    tools: ['shell'],
    network_and_source_access: 'none',
    starting_context: 'skills only',
  });
  Object.assign(contract.development_harness, {
    revision_or_package_hash: unavailable('No package hash.'),
    skill_loading_method: 'plugin',
  });
  Object.assign(contract.evaluation, {
    request_sequencing: 'serial',
    sampling_settings: { temperature: 0 },
    warmup_plan: 'one warm-up round',
    formal_repetitions: 3,
    numerical_oracle_and_tolerances: {
      oracle: 'synthetic reference',
      tolerances: [{ quantity: 'logits', error_metric: 'max-abs-error', threshold: 0.01 }],
    },
    evaluator_artifact_hashes: [{ name: 'evaluator-image', sha256: sha('e') }],
  });
  Object.assign(contract.implementation, {
    starting_scaffold: 'empty directory',
    starting_scaffold_revision: notApplicable('Empty scaffold.'),
    code_reuse: 'none',
    language_and_backend: 'synthetic',
    allowed_libraries: [],
    baseline_source_inspection_allowed: false,
  });
  Object.assign(contract.baselines, {
    selection_date: '2026-10-28',
    selection_method: 'synthetic',
    engines_and_revisions: [{
      name: 'synthetic-baseline',
      revision: commit('2'),
      primary_source_uri: 'https://example.invalid/baseline',
      primary_source_date: '2026-10-28',
    }],
    alternatives_not_evaluated: [],
  });
  Object.assign(contract.goal, {
    primary_metric: 'decode throughput',
    performance_thresholds: [{
      metric: 'decode throughput',
      definition: 'N-1 intervals over first-to-last token time',
      comparator: 'at-least',
      threshold: 1,
      unit: 'tok/s',
    }],
    permitted_quality_loss: 'none',
    resource_limits: { max_memory_footprint_gib: 40, max_swap_out_delta_gib: 0 },
    allowed_optimizations: ['kernel fusion'],
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
  const request = {
    request_id: 'synthetic-1',
    outcome: 'succeeded',
    input_tokens: 100,
    cached_input_tokens: 0,
    output_tokens: 10,
    prefill: {
      processed_input_tokens: 100,
      seconds: 1,
      includes_queueing: false,
      includes_transfer: false,
      includes_state_import: false,
    },
    decode: { definition: 'n-minus-1-intervals', output_tokens: 10, first_to_last_token_seconds: 1 },
    client_ttft: {
      seconds: 1,
      clock: 'monotonic',
      observer: 'driver',
      first_event_kind: 'text',
      proxy_boundary: 'none',
      observation_overhead: 'not measured',
    },
  };
  const repetition = {
    index: 1,
    phase: 'formal',
    outcome: 'succeeded',
    requests: [request],
    application_duration: 'Not obtained',
    resources: {
      memory_definition: 'synthetic',
      sampling_interval_seconds: 'Not obtained',
      peak_memory_gib: 'Not obtained',
      memory_pressure: 'synthetic',
      swap_out_delta_bytes: 'Not obtained',
      swap_scope: 'whole-machine',
      swap_attributed_to_process: false,
      power_thermal: 'synthetic',
      failures: [],
    },
  };
  const detail = 'synthetic';
  return {
    run_id: 'synthetic-schema-fixture',
    status: 'completed',
    acceptance: 'unverified',
    contract: { path: 'contract.json', revision: commit('4'), sha256: sha('f'), frozen_at: when },
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
      cpu_fallback_observed: false,
      offloading_observed: false,
      ssd_streaming_observed: false,
      multi_host_participation_observed: false,
      deviations_from_contract: [],
    },
    measurements: [{
      role: 'candidate',
      engine_name: 'synthetic-engine',
      runtime: {
        source_revision: commit('3'),
        deployed_runtime_revision: unavailable('Not exposed by the runtime.'),
        artifacts: [{ name: 'synthetic-engine', sha256: sha('e') }],
        identity_verification: detail,
      },
      settings: Object.fromEntries([
        'weight_precision', 'activation_precision', 'kv_precision', 'recurrent_state_precision',
        'speculation', 'caching', 'workload', 'resource_limits',
      ].map(key => [key, detail])),
      commands: ['synthetic-run'],
      configuration_sha256: sha('9'),
      repetitions: [repetition],
      aggregate: {
        formal_repetition_count: 3,
        preliminary: false,
        variability_across_repetitions: detail,
        prefill: { basis: 'processed-input-tokens', aggregation: 'ratio-of-sums', total_tokens: 100, total_seconds: 1, tokens_per_second: 100 },
        decode: { basis: 'n-minus-1-intervals', aggregation: 'ratio-of-sums', total_tokens: 9, total_seconds: 1, tokens_per_second: 9 },
        client_ttft_median_seconds: 'Not obtained',
        coverage: {
          harness_request_count: 1,
          native_timing_request_count: 1,
          client_observation_request_count: 1,
          token_totals_reconciled: true,
          complete: true,
        },
      },
      quality: {
        numerical: { status: 'not-run', oracle: detail, representative_inputs: ['short'] },
        application: {
          passed: 1,
          failed: 0,
          timed_out: 0,
          errored: 0,
          total: 1,
          negative_control_verified: true,
          network_access: false,
          credentials_present: false,
          resource_bounds: detail,
        },
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
      interpretation: 'not-comparable',
    }],
    evidence: [{ description: detail, access: 'local-only', sha256: sha('8'), access_limitation: detail }],
    autonomy: {
      human_interventions: unavailable('Synthetic fixture.'),
      builder_tokens: unavailable('Synthetic fixture.'),
      api_cost: notApplicable('Synthetic fixture.'),
      elapsed_hours: unavailable('Synthetic fixture.'),
      experiments_attempted: unavailable('Synthetic fixture.'),
      hardware_hours: unavailable('Synthetic fixture.'),
    },
    self_hosting: { status: 'not-in-scope' },
    claims: [],
    disposition: {
      implementation_pull_request: notApplicable('Synthetic fixture.'),
      results_pull_request: notApplicable('Synthetic fixture.'),
      adoption_decision: 'not-decided',
    },
    interpretation: 'Synthetic schema fixture; not a measurement.',
  };
}

const mutate = (value, change) => {
  const copy = structuredClone(value);
  change(copy);
  return copy;
};

test('the OpenAPI document is valid and every component schema compiles under strict JSON Schema', () => {
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
  rejects('ExperimentContract', mutate(frozen, c => { c.hardware.os_version = null; }), 'null in frozen contract');
  rejects('ExperimentContract', mutate(frozen, c => { c.skills_revision = 'abc1234'; }), 'abbreviated SHA');
  rejects('ExperimentContract', mutate(frozen, c => { c.baselines.engines_and_revisions = []; }), 'no baselines');
  rejects('ExperimentContract', mutate(frozen, c => { c.hardware.typo_field = 1; }), 'unknown property');
  rejects('ExperimentContract', mutate(frozen, c => { c.target_model.speculative_decoding = true; }), 'draft not declared');
  rejects('ExperimentContract', mutate(frozen, c => { c.target_model.tokenizer_hash = notApplicable('x'); }), 'identity hash cannot be N/A');
  accepts('ExperimentContract', mutate(frozen, c => {
    c.target_model.speculative_decoding = true;
    c.target_model.speculative_draft = {
      repository: 'synthetic/draft',
      revision: commit('5'),
      file_hash_manifest: [{ name: 'draft.safetensors', sha256: sha('6') }],
      settings: { draft_tokens: 4 },
    };
  }));
});

test('a synthetic run record validates and claim, evidence, and metric rules reject unsupported records', () => {
  const run = syntheticRun();
  accepts('ExperimentRun', run);
  const measurement = path => path.measurements[0];
  const request = path => measurement(path).repetitions[0].requests[0];

  rejects('ExperimentRun', mutate(run, r => { request(r).decode.output_tokens = 1; }), 'N-1 decode needs two tokens');
  rejects('ExperimentRun', mutate(run, r => { request(r).decode = { definition: 'native-command-timing', tokens: 4, seconds: 1 }; }), 'native definition');
  accepts('ExperimentRun', mutate(run, r => { request(r).decode = 'Not obtained'; }));
  rejects('ExperimentRun', mutate(run, r => { request(r).prefill = 0; }), 'missing metric is not zero');
  rejects('ExperimentRun', mutate(run, r => { measurement(r).aggregate.prefill.aggregation = 'arithmetic-mean'; }), 'ratio of sums only');
  rejects('ExperimentRun', mutate(run, r => { measurement(r).aggregate.formal_repetition_count = 1; }), 'single cohort is preliminary');
  rejects('ExperimentRun', mutate(run, r => { measurement(r).aggregate.coverage.token_totals_reconciled = false; }), 'complete requires reconciliation');
  rejects('ExperimentRun', mutate(run, r => {
    Object.assign(measurement(r).repetitions[0], { outcome: 'failed' });
  }), 'failure needs description');
  rejects('ExperimentRun', mutate(run, r => {
    measurement(r).repetitions[0].resources.swap_attributed_to_process = true;
  }), 'process swap attribution needs evidence');
  rejects('ExperimentRun', mutate(run, r => { measurement(r).quality.application.network_access = true; }), 'deviation must be recorded');
  rejects('ExperimentRun', mutate(run, r => { r.evidence[0].url = 'https://example.invalid/log'; }), 'local-only evidence has no URL');
  rejects('ExperimentRun', mutate(run, r => { measurement(r).runtime.artifacts = []; }), 'runtime identity needs hashes');
  rejects('ExperimentRun', mutate(run, r => { r.acceptance = 'passed'; r.status = 'running'; }), 'passed needs completed');
  rejects('ExperimentRun', mutate(run, r => { r.ended_at = null; }), 'completed needs an end');

  rejects('ExperimentRun', mutate(run, r => { r.comparisons[0].speedup_ratio = 2; }), 'no speedup for incompatible metrics');
  rejects('ExperimentRun', mutate(run, r => {
    Object.assign(r.comparisons[0], { definitions_compatible: true, interpretation: 'controlled-engine-comparison' });
  }), 'controlled comparison needs matched settings');
  accepts('ExperimentRun', mutate(run, r => {
    Object.assign(r.comparisons[0], {
      baseline_value: 10,
      candidate_value: 20,
      definitions_compatible: true,
      matched_settings: true,
      speedup_ratio: 2,
      interpretation: 'controlled-engine-comparison',
    });
  }));

  const claim = {
    claim_type: 'best-among-tested',
    device: 'synthetic',
    model: 'synthetic',
    workload: 'synthetic',
    metric: 'synthetic',
    quality_resource_envelope: 'synthetic',
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
    initial_builder_inference_location: 'hosted',
    routing_control: 'user',
    transition_point: when,
    builder_identity_matches_target: true,
    generated_runtime_artifacts: [{ name: 'synthetic-engine', sha256: sha('e') }],
    harness_endpoint_routing: 'synthetic',
    subsequent_development_evidence: [{ description: 'synthetic', access: 'local-only', sha256: sha('7'), access_limitation: 'synthetic' }],
    external_recovery_used: false,
  };
  accepts('SelfHostingRecord', demonstrated);
  rejects('SelfHostingRecord', { ...demonstrated, builder_identity_matches_target: false }, 'identity must match');
  rejects('SelfHostingRecord', { ...demonstrated, external_recovery_used: true }, 'recovery must be described');
  rejects('SelfHostingRecord', { status: 'not-demonstrated', recursive_improvement: { status: 'demonstrated' } }, 'recursive needs self-hosting');
});
