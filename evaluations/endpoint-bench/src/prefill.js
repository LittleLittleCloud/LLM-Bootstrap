// Prefill Test: how fast the endpoint digests long prompts. The needle stays near the end, so the model must read everything before it.
import { askNeedle, summarizeRetrieval } from './retrieval.js';

// plan: { sizes, needle_percent, runs, timeout_seconds }; window: { tokens }
export async function runPrefill(env, plan, { window, charsPerToken, seed, signal, onProgress = () => {} }) {
  const sizes = [];
  let status = 'complete';
  let step = 0;
  const runnable = plan.sizes.filter(size => size <= window.tokens);
  const steps = runnable.length * plan.runs;
  for (const size of plan.sizes) {
    if (size > window.tokens) {
      sizes.push({ input_tokens: size, status: 'skipped', reason: `larger than the ${window.tokens}-token context window`, runs: [], summary: summarizeRetrieval([]) });
      continue;
    }
    const runs = [];
    for (let index = 0; index < plan.runs; index += 1) {
      if (signal?.aborted) { status = 'cancelled'; break; }
      onProgress({ message: `${size} input tokens, run ${index + 1} of ${plan.runs}`, done: step, total: steps });
      step += 1;
      const run = await askNeedle(env, { seed: `${seed}:prefill:${size}:${index}`, targetTokens: size, positionPercent: plan.needle_percent, charsPerToken, timeoutMs: plan.timeout_seconds * 1000, signal });
      if (run.aborted) { status = 'cancelled'; break; }
      runs.push(run);
    }
    const summary = summarizeRetrieval(runs);
    sizes.push({ input_tokens: size, status: summary.failed ? (summary.failed === summary.attempted ? 'error' : 'partial') : 'complete', runs, summary });
    if (status === 'cancelled') break;
  }
  const measured = sizes.filter(size => size.status !== 'skipped');
  if (status === 'complete') {
    if (!measured.length) status = 'skipped';
    else if (measured.every(size => size.status === 'error')) status = 'error';
    else if (measured.some(size => size.status !== 'complete')) status = 'partial';
  }
  return { status, config: { sizes: plan.sizes, needle_percent: plan.needle_percent, runs: plan.runs }, sizes };
}
