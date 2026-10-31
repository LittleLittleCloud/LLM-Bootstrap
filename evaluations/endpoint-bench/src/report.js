// The headline metrics of a report. Experiment thresholds and the leaderboard read these names, nothing else.
import { PROFILES } from './config.js';

const number = value => (Number.isFinite(value) ? value : null);

export function headlineMetrics(report) {
  const tests = report.tests ?? {};
  const decodeLengths = (tests.decode?.lengths ?? []).filter(item => number(item.summary.decode_tokens_per_second_p50) != null);
  const decode = decodeLengths.find(item => item.output_tokens === 1000) ?? decodeLengths.at(-1);
  const prefill = (tests.prefill?.sizes ?? []).find(item => number(item.summary.input_tokens_per_second_p50) != null);
  return {
    conform_passed: tests.conform ? (tests.conform.required_passed ? 1 : 0) : null,
    speed_tokens_per_second_p50: number(tests.speed?.summary.tokens_per_second_p50),
    speed_ttft_ms_p50: number(tests.speed?.summary.ttft_ms_p50),
    decode_tokens_per_second_p50: number(decode?.summary.decode_tokens_per_second_p50),
    prefill_tokens_per_second_p50: number(prefill?.summary.input_tokens_per_second_p50),
    needle_accuracy: number(tests.needle?.summary.accuracy),
    thinking_accuracy: number(tests.thinking?.variants.default?.summary.accuracy),
    cache_hit_pct: number(tests.cache?.variants.padded?.summary.cache_hit_pct),
  };
}

// The accuracy scores the leaderboard compares with a baseline, each with its sample count.
export function qualityScores(report) {
  const tests = report.tests ?? {};
  const scores = [];
  const thinking = tests.thinking?.variants.default?.summary;
  if (tests.thinking?.status === 'complete' && thinking?.attempted > 0) scores.push({ benchmark_id: 'thinking', score: thinking.accuracy, stderr: thinking.stderr, num_samples: thinking.attempted });
  const needle = tests.needle?.summary;
  if (tests.needle?.status === 'complete' && needle?.attempted > 0) scores.push({ benchmark_id: 'needle', score: needle.accuracy, stderr: needle.stderr, num_samples: needle.attempted });
  return scores;
}

export const isFullProfile = report => report.profile === PROFILES[0];
