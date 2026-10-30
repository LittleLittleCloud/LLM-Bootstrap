// Shared synthetic fixtures for the repository tests. Nothing here is a measurement.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const draftExperiment = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/draft-experiment.json', import.meta.url)), 'utf8'));

export const sha = char => char.repeat(64);
export const commit = char => char.repeat(40);
export const when = '2026-10-28T00:00:00+08:00';
export const startedAt = '2026-10-28T08:00:00Z';
export const stamp = '20261028-080000';

export function frozenExperiment() {
  return {
    ...draftExperiment,
    experiment_id: 'synthetic-schema-fixture',
    status: 'frozen',
    description: 'Synthetic fixture for schema tests; not an experiment.',
    skills_revision: commit('1'),
    builder_instruction_sha256: [`skills/bootstrap-experiment-sop/SKILL.md=${sha('a')}`],
    contract_frozen_at: when,
    scope: 'Synthetic engine construction only; no operating-system changes; fixture authorizes nothing.',
    hardware_os_version: 'synthetic-os 1',
    hardware_toolchain: 'synthetic-toolchain 1',
    target_files: [`model-00001.safetensors=${sha('b')}`],
    target_tokenizer_sha256: sha('c'),
    target_chat_template_sha256: sha('d'),
    target_activation_precision: 'bf16',
    target_speculative_draft: 'Not applicable: Speculative decoding is disabled.',
    builder_model: 'synthetic-builder',
    builder_provider: 'Unavailable: Provider exposes no identifier.',
    builder_revision: 'Unavailable: Provider exposes no revision.',
    builder_inference_location: 'hosted',
    builder_sampling: 'temperature=0',
    builder_network_and_source_access: 'none',
    harness_revision: 'Unavailable: No package hash.',
    ...evaluationReference,
    evaluation_warmup_plan: 'one warm-up round',
    evaluation_formal_repetitions: 3,
    implementation_starting_scaffold: 'empty directory; no code reuse',
    implementation_language_and_backend: 'synthetic',
    implementation_allowed_libraries: [],
    implementation_baseline_source_inspection_allowed: false,
    baseline_selection_date: '2026-10-28',
    baseline_selection_method: 'synthetic; no alternatives left unevaluated',
    baseline_engines: [`synthetic-baseline=${commit('2')}`],
    goal_primary_metric: 'decode throughput, N-1 intervals over first-to-last token time',
    goal_thresholds: ['decode_tokens_per_second >= 1', 'peak_memory_gib <= 40', 'swap_out_delta_bytes <= 0'],
    budget_wall_clock_hours: 1,
    budget_builder_tokens: 1000,
    budget_api_cost_limit: 'Not applicable: Local only.',
    budget_hardware_hours: 1,
    budget_stopping_rule: 'synthetic',
  };
}

export const evaluationReference = { evaluation_id: 'synthetic-evaluation', evaluation_revision: commit('3'), evaluation_sha256: sha('c') };

export function syntheticResult(started = startedAt) {
  const detail = 'synthetic';
  return {
    ...evaluationReference,
    experiment_id: 'synthetic-schema-fixture',
    experiment_revision: commit('4'),
    experiment_sha256: sha('f'),
    started_at: started,
    role: 'candidate',
    engine_name: 'synthetic-engine',
    runtime_revision: 'Unavailable: Not exposed by the runtime.',
    artifacts: [`synthetic-engine=${sha('e')}`],
    commands: ['synthetic-run'],
    environment_hardware_model: detail,
    environment_os_version: detail,
    environment_toolchain: detail,
    environment_power_mode: detail,
    environment_thermal_observations: detail,
    environment_exclusive_gpu: true,
    environment_deviations: [],
    'setting.weight_precision': detail,
    warmup_passes: 0,
    formal_passes_succeeded: 3,
    formal_passes_failed: 0,
    failures: [],
    preliminary: false,
    prefill_tokens_per_second: 100,
    prefill_basis: 'processed-input-tokens',
    decode_tokens_per_second: 9,
    decode_basis: 'n-minus-1-intervals',
    client_ttft_median_seconds: 'Not obtained',
    requests_reconciled: true,
    peak_memory_gib: 'Not obtained',
    swap_out_delta_bytes: 'Not obtained',
    'intelligence.synthetic.metric': 'accuracy/mean',
    'intelligence.synthetic.score': 1,
    'intelligence.synthetic.num_samples': 10,
    'intelligence.synthetic.stderr': 0,
    intelligence_complete: true,
    negative_control_verified: true,
    restricted_environment: true,
    evidence_sha256: sha('8'),
    evidence_access_limitation: 'Kept next to the record and not committed.',
    human_interventions: 'Unavailable: Synthetic fixture.',
    builder_tokens: 'Unavailable: Synthetic fixture.',
    elapsed_hours: 'Unavailable: Synthetic fixture.',
    hardware_hours: 'Unavailable: Synthetic fixture.',
    self_hosting_status: 'not-in-scope',
  };
}
