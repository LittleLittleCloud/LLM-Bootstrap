// Decode Test: output speed at fixed output lengths, from the first to the last visible token.
import { streamChat } from './client.js';
import { decodeRun, summarizeDecode } from './measure.js';

// plan: { lengths, runs, warmup, timeout_seconds, prompt }
export async function runDecode(env, plan, { signal, onProgress = () => {} }) {
  const lengths = [];
  let status = 'complete';
  let step = 0;
  const steps = plan.lengths.length * (plan.warmup + plan.runs);
  for (const length of plan.lengths) {
    const runs = [];
    for (let index = 0; index < plan.warmup + plan.runs; index += 1) {
      if (signal?.aborted) { status = 'cancelled'; break; }
      onProgress({ message: `${length} tokens, ${index < plan.warmup ? 'warm-up' : `run ${index - plan.warmup + 1} of ${plan.runs}`}`, done: step, total: steps });
      step += 1;
      const result = await streamChat(env, {
        messages: [{ role: 'user', content: plan.prompt }], maxTokens: length, forceLength: true, timeoutMs: plan.timeout_seconds * 1000, signal,
      });
      if (result.error === 'aborted') { status = 'cancelled'; break; }
      if (index >= plan.warmup) runs.push(decodeRun(result));
    }
    lengths.push({ output_tokens: length, runs, summary: summarizeDecode(runs) });
    if (status === 'cancelled') break;
  }
  if (status === 'complete') {
    const completed = lengths.reduce((total, item) => total + item.summary.completed_runs, 0);
    if (completed < plan.lengths.length * plan.runs) status = completed ? 'partial' : 'error';
  }
  return { status, config: { lengths: plan.lengths, runs: plan.runs, warmup: plan.warmup }, lengths };
}
