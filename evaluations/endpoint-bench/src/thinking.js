// Thinking Test: a medium reasoning task, answered with reasoning left on and with it switched off.
// Each question is a fresh table; the model must name the row with the highest score in one exact line.
import { streamChat } from './client.js';
import { splitTokens } from './measure.js';
import { p50, p95, round, seeded, stderrOf } from './util.js';

const VARIANTS = {
  default: {},
  'no-thinking': { chat_template_kwargs: { enable_thinking: false } },
};

export function buildQuestion({ seed, rows }) {
  const random = seeded(seed);
  const ids = new Set();
  while (ids.size < rows) ids.add(1000 + Math.floor(random() * 9000));
  const scores = new Set();
  while (scores.size < rows) scores.add(1 + Math.floor(random() * rows * 20));
  const records = [...ids].map((id, index) => ({ id, name: `user-${index + 1}`, score: [...scores][index] }));
  const best = records.reduce((top, row) => (row.score > top.score ? row : top));
  // A shuffle by the question's own seed spreads the answer evenly over positions.
  for (let index = records.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [records[index], records[other]] = [records[other], records[index]];
  }
  const table = ['| id | name | score |', '| --- | --- | --- |', ...records.map(row => `| ${row.id} | ${row.name} | ${row.score} |`)].join('\n');
  const prompt = [
    `Below is a table of ${rows} rows with the columns id, name, and score.`, '', table, '',
    'Find the row with the highest score. The entire response must be exactly one line:', '<id>|<name>',
    'Output nothing else. Do not include reasoning, explanations, labels, markdown, or any text beyond the required answer.',
  ].join('\n');
  return { prompt, answer: best };
}

export function gradeAnswer(content, answer) {
  const text = (content ?? '').trim();
  const lines = text.split(/\r?\n/);
  const match = lines.length === 1 ? /^(\d+)\|(\S+)$/.exec(text) : null;
  if (!match) return { compliant: false, correct: false };
  const canonical = String(Number(match[1])) === match[1];
  return { compliant: true, correct: canonical && Number(match[1]) === answer.id && match[2].toLowerCase() === answer.name.toLowerCase() };
}

function summarize(runs) {
  const attempted = runs.length;
  const correct = runs.filter(run => run.correct).length;
  const ok = runs.filter(run => run.ok);
  const accuracy = attempted ? correct / attempted : null;
  return {
    attempted, correct, failed: attempted - ok.length, accuracy: round(accuracy, 4), stderr: round(stderrOf(accuracy, attempted), 4),
    format_compliance: attempted ? round(runs.filter(run => run.compliant).length / attempted, 4) : null,
    ttft_ms_p50: p50(ok.map(run => run.ttft_ms)), ttft_ms_p95: p95(ok.map(run => run.ttft_ms)),
    e2e_ms_p50: p50(ok.map(run => run.e2e_ms)), e2e_ms_p95: p95(ok.map(run => run.e2e_ms)),
    reasoning_tokens_p50: p50(ok.map(run => run.reasoning_tokens)), answer_tokens_p50: p50(ok.map(run => run.answer_tokens)),
  };
}

// plan: { questions, rows, warmup, max_tokens, timeout_seconds }; seed makes the questions reproducible.
export async function runThinking(env, plan, { seed, signal, onProgress = () => {} }) {
  const variants = {};
  let status = 'complete';
  let step = 0;
  const steps = Object.keys(VARIANTS).length * (plan.warmup + plan.questions);
  for (const [name, fields] of Object.entries(VARIANTS)) {
    const runs = [];
    for (let index = 0; index < plan.warmup + plan.questions; index += 1) {
      if (signal?.aborted) { status = 'cancelled'; break; }
      onProgress({ message: `${name}: question ${Math.max(0, index - plan.warmup) + 1} of ${plan.questions}`, done: step, total: steps });
      step += 1;
      const question = buildQuestion({ seed: `${seed}:q${index}`, rows: plan.rows });
      const result = await streamChat(env, { messages: [{ role: 'user', content: question.prompt }], maxTokens: plan.max_tokens, fields, timeoutMs: plan.timeout_seconds * 1000, signal });
      if (result.error === 'aborted') { status = 'cancelled'; break; }
      if (index < plan.warmup) continue;
      if (!result.ok) { runs.push({ ok: false, error: result.error, correct: false, compliant: false }); continue; }
      const split = splitTokens(result);
      runs.push({
        ok: true, ...gradeAnswer(result.content, question.answer), answer: result.content.trim().slice(0, 80),
        ttft_ms: round(result.firstAnyAt == null ? null : result.firstAnyAt - result.startAt, 1), e2e_ms: round(result.endAt - result.startAt, 1),
        reasoning_tokens: split.reasoning, answer_tokens: split.visible,
      });
    }
    variants[name] = { runs, summary: summarize(runs) };
    if (status === 'cancelled') break;
  }
  if (status === 'complete' && Object.values(variants).some(variant => variant.summary.failed > 0)) {
    status = Object.values(variants).every(variant => variant.summary.failed === variant.summary.attempted) ? 'error' : 'partial';
  }
  return { status, config: { questions: plan.questions, rows: plan.rows, warmup: plan.warmup, max_tokens: plan.max_tokens, seed }, variants };
}
