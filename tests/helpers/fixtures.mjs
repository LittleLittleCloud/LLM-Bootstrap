// Shared synthetic fixtures for the repository tests. Nothing here is a measurement.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const draftContract = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/draft-contract.json', import.meta.url)), 'utf8'));

export const sha = char => char.repeat(64);
export const commit = char => char.repeat(40);
export const when = '2026-10-28T00:00:00+08:00';
export const notApplicable = reason => ({ not_applicable: true, reason });
export const unavailable = reason => ({ unavailable: true, reason });

export function frozenContract() {
  const contract = structuredClone(draftContract);
  Object.assign(contract, {
    experiment_id: 'synthetic-schema-fixture',
    status: 'frozen',
    description: 'Synthetic fixture for schema tests; not an experiment.',
    skills_revision: commit('1'),
    builder_instruction_hashes: [{ name: 'skills/bootstrap-experiment-sop/SKILL.md', sha256: sha('a') }],
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

export const evaluationReference = { evaluation_id: 'synthetic-evaluation', revision: commit('3'), sha256: sha('c') };
export const evidenceFixture = { description: 'synthetic', access: 'local-only', sha256: sha('8'), access_limitation: 'synthetic' };

export function syntheticResult() {
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

export function syntheticRun() {
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

