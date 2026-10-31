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
    implementation_starting_scaffold: 'empty directory; no code reuse',
    implementation_language_and_backend: 'synthetic',
    implementation_allowed_libraries: [],
    implementation_baseline_source_inspection_allowed: false,
    baseline_selection_date: '2026-10-28',
    baseline_selection_method: 'synthetic; no alternatives left unevaluated',
    baseline_engines: [`synthetic-baseline=${commit('2')}`],
    goal_primary_metric: 'decode throughput, N-1 intervals over first-to-last token time',
    goal_thresholds: ['decode_tokens_per_second_p50 >= 1', 'speed_ttft_ms_p50 <= 5000'],
    budget_wall_clock_hours: 1,
    budget_builder_tokens: 1000,
    budget_api_cost_limit: 'Not applicable: Local only.',
    budget_hardware_hours: 1,
    budget_stopping_rule: 'synthetic',
  };
}

export const evaluationReference = { evaluation_id: 'synthetic-evaluation', evaluation_revision: commit('3'), evaluation_sha256: sha('c') };

// A minimal complete report: one test, no machine, no experiment. Nothing here is a measurement.
export function syntheticReport(started = startedAt) {
  return {
    report_version: 1,
    ...evaluationReference,
    started_at: started,
    finished_at: started,
    endpoint_class: 'loopback',
    model: 'synthetic-model',
    profile: 'full',
    seed: '0123abcd',
    context_window: { tokens: 4096, source: 'assumed' },
    chars_per_token: null,
    selected_tests: ['conform'],
    status: 'complete',
    failures: [],
    tests: {
      conform: {
        status: 'complete',
        required_passed: true,
        checks: [{ id: 'models-list', title: 'Lists models at /models', required: true, status: 'pass', detail: '1 models' }],
      },
    },
  };
}
