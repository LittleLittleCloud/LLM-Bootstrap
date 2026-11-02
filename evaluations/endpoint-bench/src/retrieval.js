// One needle-retrieval request, shared by the needle and prefill tests. `fields` are extra request fields: only needle sends
// a thinking policy, so prefill keeps the endpoint's own default.
import { streamChat } from './client.js';
import { gradeCode, generateTask } from './context.js';
import { splitTokens } from './measure.js';
import { p50, p90, round, stderrOf } from './util.js';

export async function askNeedle(env, { seed, targetTokens, positionPercent, charsPerToken, timeoutMs, signal, fields = {} }) {
  const task = generateTask({ seed, targetTokens, positionPercent, charsPerToken });
  const result = await streamChat(env, { messages: [{ role: 'user', content: task.prompt }], maxTokens: 64, fields, timeoutMs, signal });
  if (!result.ok) return { ok: false, error: result.error, correct: false, compliant: false, aborted: result.error === 'aborted' };
  const ttftMs = result.firstAnyAt == null ? null : result.firstAnyAt - result.startAt;
  const split = splitTokens(result);
  return {
    ok: true, ...gradeCode(result.content, task.expected), answer: result.content.trim().slice(0, 40), prompt_tokens: result.promptTokens,
    ttft_ms: round(ttftMs, 1), e2e_ms: round(result.endAt - result.startAt, 1),
    input_tokens_per_second: result.promptTokens > 0 && ttftMs > 0 ? round(result.promptTokens / (ttftMs / 1000), 1) : null,
    completion_tokens: result.completionTokens, reasoning_tokens: split.reasoning, visible_tokens: split.visible, finish_reason: result.finish,
  };
}

export function summarizeRetrieval(runs) {
  const ok = runs.filter(run => run.ok);
  const accuracy = runs.length ? runs.filter(run => run.correct).length / runs.length : null;
  return {
    attempted: runs.length, correct: runs.filter(run => run.correct).length, failed: runs.length - ok.length,
    accuracy: round(accuracy, 4), stderr: round(stderrOf(accuracy, runs.length), 4),
    format_compliance: runs.length ? round(runs.filter(run => run.compliant).length / runs.length, 4) : null,
    prompt_tokens_p50: p50(ok.map(run => run.prompt_tokens)),
    ttft_ms_p50: p50(ok.map(run => run.ttft_ms)), ttft_ms_p90: p90(ok.map(run => run.ttft_ms)),
    input_tokens_per_second_p50: p50(ok.map(run => run.input_tokens_per_second)),
    // An empty or truncated answer is told apart from a wrong one: the output budget may have gone to reasoning.
    empty_runs: ok.filter(run => run.answer === '').length,
    truncated_runs: ok.filter(run => run.finish_reason === 'length').length,
    reasoning_runs: ok.filter(run => run.reasoning_tokens > 0).length,
    reasoning_tokens_p50: p50(ok.map(run => run.reasoning_tokens)),
  };
}
