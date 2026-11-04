// Pelican Test: one request for an SVG drawing of a pelican riding a bicycle. It is a picture for a person to look at, not a score.
// The report records whether a drawing came back and how large it was; the drawing itself goes to `keep` and never into the report.
import { NO_THINKING, streamChat } from './client.js';
import { splitTokens } from './measure.js';
import { round, sha256Hex } from './util.js';

// From the first <svg to the last </svg>, so a markdown fence or a sentence around the drawing is dropped.
export function extractSvg(content) {
  const start = (content ?? '').search(/<svg[\s>]/i);
  const end = (content ?? '').toLowerCase().lastIndexOf('</svg>');
  return start >= 0 && end > start ? content.slice(start, end + '</svg>'.length) : null;
}

// plan: { max_tokens, timeout_seconds, prompt }. Thinking is switched off, as in needle, so the output budget goes to the drawing.
export async function runPelican(env, plan, { signal, keep = () => {}, onProgress = () => {} }) {
  const config = { max_tokens: plan.max_tokens, thinking: 'disabled' };
  onProgress({ message: 'drawing', done: 0, total: 1 });
  const result = await streamChat(env, {
    messages: [{ role: 'user', content: plan.prompt }], maxTokens: plan.max_tokens, fields: NO_THINKING, timeoutMs: plan.timeout_seconds * 1000, signal,
  });
  if (result.error === 'aborted') return { status: 'cancelled', config };
  if (!result.ok) return { status: 'error', error: result.error, config };
  const svg = extractSvg(result.content);
  if (svg) keep(svg);
  const split = splitTokens(result);
  const bytes = svg ? new TextEncoder().encode(svg) : null;
  return {
    status: 'complete', config,
    run: {
      ok: true, svg: svg != null, svg_bytes: bytes?.length ?? null, elements: svg ? (svg.match(/<[a-z][^\s/>]*/gi) ?? []).length : null,
      sha256: bytes ? await sha256Hex(bytes) : null,
      ttft_ms: round(result.firstAnyAt == null ? null : result.firstAnyAt - result.startAt, 1), e2e_ms: round(result.endAt - result.startAt, 1),
      completion_tokens: result.completionTokens, reasoning_tokens: split.reasoning, visible_tokens: split.visible, finish_reason: result.finish,
    },
  };
}
