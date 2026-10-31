// Speed Test: raw output-generation speed from a short prompt, one tokens-per-second value per measured run.
import { streamChat } from './client.js';
import { speedRun, summarizeSpeed } from './measure.js';

// plan: { warmup, runs, max_tokens, timeout_seconds, prompt }
export async function runSpeed(env, plan, { signal, onProgress = () => {} }) {
  const runs = [];
  const total = plan.warmup + plan.runs;
  let status = 'complete';
  for (let index = 0; index < total; index += 1) {
    if (signal?.aborted) { status = 'cancelled'; break; }
    onProgress({ message: index < plan.warmup ? 'warm-up' : `run ${index - plan.warmup + 1} of ${plan.runs}`, done: index, total });
    const result = await streamChat(env, { messages: [{ role: 'user', content: plan.prompt }], maxTokens: plan.max_tokens, timeoutMs: plan.timeout_seconds * 1000, signal });
    if (result.error === 'aborted') { status = 'cancelled'; break; }
    if (index >= plan.warmup) runs.push(speedRun(result));
  }
  const summary = summarizeSpeed(runs);
  if (status === 'complete' && summary.completed_runs < plan.runs) status = summary.completed_runs ? 'partial' : 'error';
  return { status, config: { warmup: plan.warmup, runs: plan.runs, max_tokens: plan.max_tokens }, runs, summary };
}
