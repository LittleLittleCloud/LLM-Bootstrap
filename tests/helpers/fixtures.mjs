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
    contract_frozen_at: when,
    ...evaluationReference,
    engine_name: 'synthetic-engine',
    engine_commit: commit('2'),
    goal_thresholds: ['decode_tokens_per_second_p50 >= 1', 'speed_ttft_ms_p50 <= 5000'],
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
