// Cache Test: one fixed question asked three ways. Short stays under the cacheable minimum, padded crosses it with identical bytes on
// every request, and busted prepends a fresh nonce to the padded prompt so that nothing can be reused.
import { streamChat } from './client.js';
import { fillerLine } from './context.js';
import { p50, round, seeded } from './util.js';

const QUESTION = 'What is the capital of France? Answer with the city name only.';
const HEADER = 'The reference log below is background context for the question that follows.';

export function buildPrompt({ seed, targetTokens, charsPerToken, nonce = null }) {
  if (targetTokens <= 0) return QUESTION;
  const random = seeded(seed);
  const fixed = [HEADER, '', '--- CONTEXT START ---', '--- CONTEXT END ---', '', QUESTION].join('\n').length;
  const lines = [];
  let total = 0;
  while (lines.length < 8 || total + fixed < targetTokens * charsPerToken + 64) {
    const line = fillerLine(random, lines.length + 1);
    lines.push(line);
    total += line.length + 1;
  }
  const body = [HEADER, '', '--- CONTEXT START ---', ...lines, '--- CONTEXT END ---', '', QUESTION].join('\n');
  return nonce ? `Request nonce: ${nonce}\n${body}` : body;
}

const nonce = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), byte => byte.toString(16).padStart(2, '0')).join('');

const record = result => (result.ok ? {
  ok: true, ttft_ms: round(result.firstAnyAt == null ? null : result.firstAnyAt - result.startAt, 1), prompt_tokens: result.promptTokens,
  cached_tokens: result.cachedTokens, correct: /\bparis\b/i.test(result.content), e2e_ms: round(result.endAt - result.startAt, 1),
} : { ok: false, error: result.error });

function summarizeVariant(cold, warm) {
  const ok = warm.filter(run => run.ok);
  const reported = ok.length > 0 && ok.every(run => run.cached_tokens != null);
  const warmTtft = p50(ok.map(run => run.ttft_ms));
  const coldTtft = cold.ok ? cold.ttft_ms : null;
  const prompt = ok.reduce((total, run) => total + run.prompt_tokens, 0);
  return {
    cache_reported: reported,
    cache_hit_pct: reported && prompt > 0 ? round(100 * ok.reduce((total, run) => total + run.cached_tokens, 0) / prompt, 1) : null,
    cold_ttft_ms: coldTtft, warm_ttft_ms_p50: warmTtft,
    ttft_reduction_pct: coldTtft > 0 && warmTtft != null ? round(100 * (coldTtft - warmTtft) / coldTtft, 1) : null,
    prompt_tokens: cold.ok ? cold.prompt_tokens : null, completed_runs: ok.length + (cold.ok ? 1 : 0), failed_runs: warm.length - ok.length + (cold.ok ? 0 : 1),
    correct: ok.filter(run => run.correct).length + (cold.ok && cold.correct ? 1 : 0),
  };
}

// plan: { padded_tokens, repeats, timeout_seconds }; window: { tokens }
export async function runCache(env, plan, { window, charsPerToken, seed, signal, onProgress = () => {} }) {
  const padded = Math.min(plan.padded_tokens, Math.floor(window.tokens / 2));
  const variants = {};
  let status = 'complete';
  let step = 0;
  const steps = 3 * (1 + plan.repeats);
  const specs = [
    ['short', () => buildPrompt({ seed, targetTokens: 0, charsPerToken })],
    ['padded', () => buildPrompt({ seed: `${seed}:padded`, targetTokens: padded, charsPerToken })],
    ['busted', () => buildPrompt({ seed: `${seed}:padded`, targetTokens: padded, charsPerToken, nonce: nonce() })],
  ];
  for (const [name, make] of specs) {
    // The same prompt is built once so every repeat is byte-identical; only busted rebuilds around a new nonce.
    const fixed = name === 'busted' ? null : make();
    const requests = [];
    for (let index = 0; index < 1 + plan.repeats; index += 1) {
      if (signal?.aborted) { status = 'cancelled'; break; }
      onProgress({ message: `${name}: ${index === 0 ? 'cold request' : `repeat ${index} of ${plan.repeats}`}`, done: step, total: steps });
      step += 1;
      const result = await streamChat(env, { messages: [{ role: 'user', content: fixed ?? make() }], maxTokens: 64, timeoutMs: plan.timeout_seconds * 1000, signal });
      if (result.error === 'aborted') { status = 'cancelled'; break; }
      requests.push(record(result));
    }
    const [cold = { ok: false, error: 'not run' }, ...warm] = requests;
    variants[name] = { cold, warm, summary: summarizeVariant(cold, warm) };
    if (status === 'cancelled') break;
  }
  if (status === 'complete') {
    const failed = Object.values(variants).reduce((total, variant) => total + variant.summary.failed_runs, 0);
    if (failed > 0) status = failed === steps ? 'error' : 'partial';
  }
  return { status, config: { padded_tokens: padded, requested_padded_tokens: plan.padded_tokens, repeats: plan.repeats }, variants };
}
