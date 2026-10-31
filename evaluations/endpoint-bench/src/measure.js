// Shared measurements: how a streamed result becomes the numbers every test reports.
import { max, min, p50, p90, p95, round } from './util.js';

const interval = (from, to) => (from == null || to == null ? null : to - from);

// Reasoning tokens as the server reports them, else estimated from the share of streamed characters.
export function splitTokens(result) {
  const total = result.completionTokens ?? 0;
  if (Number.isFinite(result.reasoningTokens)) {
    const reasoning = Math.min(total, Math.max(0, result.reasoningTokens));
    return { reasoning, visible: total - reasoning, source: 'server' };
  }
  const characters = result.reasoningChars + result.content.length;
  const reasoning = result.reasoningChars > 0 && characters > 0 ? Math.round(total * (result.reasoningChars / characters)) : 0;
  return { reasoning, visible: total - reasoning, source: reasoning > 0 ? 'estimated' : 'none' };
}

const rate = (tokens, milliseconds) => (tokens > 0 && milliseconds > 0 ? tokens / (milliseconds / 1000) : null);

// Speed: tokens over the streaming time after the first delta of any kind, reasoning included.
export function speedRun(result) {
  if (!result.ok) return { ok: false, error: result.error };
  const split = splitTokens(result);
  return {
    ok: true, ttft_ms: round(interval(result.startAt, result.firstAnyAt), 1), e2e_ms: round(interval(result.startAt, result.endAt), 1),
    tokens_per_second: round(rate(result.completionTokens, interval(result.firstAnyAt, result.endAt)), 2),
    completion_tokens: result.completionTokens, reasoning_tokens: split.reasoning,
  };
}

// Decode: visible tokens minus the first, over the time from the first to the last visible token.
export function decodeRun(result) {
  if (!result.ok) return { ok: false, error: result.error };
  const split = splitTokens(result);
  const decodeMs = interval(result.firstVisibleAt, result.lastVisibleAt);
  return {
    ok: true, ttft_ms: round(interval(result.startAt, result.firstVisibleAt), 1), decode_ms: round(decodeMs, 1),
    total_latency_ms: round(interval(result.startAt, result.endAt), 1),
    decode_tokens_per_second: round(rate(split.visible - 1, decodeMs), 2), visible_tokens: split.visible, reasoning_tokens: split.reasoning,
    reasoning_required: split.reasoning > 0, fixed_length: result.forcedLength, finish_reason: result.finish,
  };
}

const good = runs => runs.filter(run => run.ok);
const column = (runs, key) => good(runs).map(run => run[key]);

export function summarizeSpeed(runs) {
  return {
    completed_runs: good(runs).length, failed_runs: runs.length - good(runs).length,
    ttft_ms_p50: p50(column(runs, 'ttft_ms')), ttft_ms_p90: p90(column(runs, 'ttft_ms')),
    e2e_ms_p50: p50(column(runs, 'e2e_ms')), e2e_ms_p90: p90(column(runs, 'e2e_ms')),
    tokens_per_second_min: min(column(runs, 'tokens_per_second')), tokens_per_second_p50: p50(column(runs, 'tokens_per_second')),
    tokens_per_second_max: max(column(runs, 'tokens_per_second')),
  };
}

export function summarizeDecode(runs) {
  return {
    completed_runs: good(runs).length, failed_runs: runs.length - good(runs).length,
    decode_tokens_per_second_p50: p50(column(runs, 'decode_tokens_per_second')), decode_tokens_per_second_p90: p90(column(runs, 'decode_tokens_per_second')),
    ttft_ms_p50: p50(column(runs, 'ttft_ms')), ttft_ms_p90: p90(column(runs, 'ttft_ms')),
    total_latency_ms_p50: p50(column(runs, 'total_latency_ms')), total_latency_ms_p90: p90(column(runs, 'total_latency_ms')),
    visible_tokens_p50: p50(column(runs, 'visible_tokens')), reasoning_tokens_p50: p50(column(runs, 'reasoning_tokens')),
    reasoning_required: good(runs).some(run => run.reasoning_required),
    fixed_length_applied: good(runs).length > 0 && good(runs).every(run => run.fixed_length),
  };
}

export { p95 };
