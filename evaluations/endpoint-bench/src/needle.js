// Needle Test: a document that fills most of the context window hides one access code at several depths ("lost in the middle").
import { askNeedle, summarizeRetrieval } from './retrieval.js';
import { MIN_DOCUMENT_TOKENS } from './context.js';

// plan: { fill_percent, positions, runs, timeout_seconds }; window: { tokens }
export async function runNeedle(env, plan, { window, charsPerToken, seed, signal, onProgress = () => {} }) {
  const inputTokens = Math.max(MIN_DOCUMENT_TOKENS, Math.floor(window.tokens * plan.fill_percent / 100));
  const positions = [];
  let status = 'complete';
  let step = 0;
  const steps = plan.positions.length * plan.runs;
  for (const percent of plan.positions) {
    const runs = [];
    for (let index = 0; index < plan.runs; index += 1) {
      if (signal?.aborted) { status = 'cancelled'; break; }
      onProgress({ message: `needle at ${percent}%, run ${index + 1} of ${plan.runs}`, done: step, total: steps });
      step += 1;
      const run = await askNeedle(env, { seed: `${seed}:needle:${percent}:${index}`, targetTokens: inputTokens, positionPercent: percent, charsPerToken, timeoutMs: plan.timeout_seconds * 1000, signal });
      if (run.aborted) { status = 'cancelled'; break; }
      runs.push(run);
    }
    positions.push({ percent, runs, summary: summarizeRetrieval(runs) });
    if (status === 'cancelled') break;
  }
  const all = positions.flatMap(position => position.runs);
  const summary = summarizeRetrieval(all);
  if (status === 'complete' && summary.failed > 0) status = summary.failed === summary.attempted ? 'error' : 'partial';
  return { status, config: { fill_percent: plan.fill_percent, input_tokens: inputTokens, runs: plan.runs, positions: plan.positions }, positions, summary };
}
