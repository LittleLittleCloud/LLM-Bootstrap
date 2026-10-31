// Conformance: does the endpoint behave like an OpenAI-compatible chat API, as far as the other tests rely on it?
// A required check that fails means other results cannot be trusted; an optional check only describes the endpoint.
import { chatOnce, streamChat } from './client.js';

const USER = text => [{ role: 'user', content: text }];
const COUNT = 'Count from 1 to 50 separated by single spaces. Output only the numbers.';
const hasNumber = value => Number.isFinite(value) && value >= 0;

export async function runConform(env, plan, { models, signal, onProgress = () => {} }) {
  const checks = [];
  const timeoutMs = plan.timeout_seconds * 1000;
  const add = async (id, title, required, run) => {
    onProgress({ message: title });
    try {
      const outcome = await run();
      checks.push({ id, title, required, status: outcome.pass ? 'pass' : outcome.skip ? 'skip' : 'fail', detail: outcome.detail ?? '' });
    } catch (error) {
      if (signal?.aborted) throw error;
      checks.push({ id, title, required, status: 'fail', detail: String(error?.message ?? error).slice(0, 200) });
    }
  };
  const verdict = (problems, ok = 'ok') => ({ pass: problems.length === 0, detail: problems.length ? problems.join('; ') : ok });

  await add('models-list', 'Lists models at /models', true, async () => {
    if (!models.ok) return { detail: models.error };
    return verdict(models.models.some(model => model.id === env.model) ? [] : [`the list has no model ${env.model}`], `${models.models.length} models`);
  });

  await add('chat-completion', 'Answers a chat completion with usage', true, async () => {
    const response = await chatOnce(env, { messages: USER('Reply with the single word: ok'), maxTokens: 16, timeoutMs, signal });
    if (!response.ok) return { detail: response.error ?? `HTTP ${response.status}: ${response.text.slice(0, 120)}` };
    const choice = response.json?.choices?.[0];
    const problems = [];
    if (typeof choice?.message?.content !== 'string' && typeof choice?.message?.reasoning_content !== 'string') problems.push('no choices[0].message.content');
    if (!choice?.finish_reason) problems.push('no finish_reason');
    if (!hasNumber(response.json?.usage?.prompt_tokens) || !hasNumber(response.json?.usage?.completion_tokens)) problems.push('no usage.prompt_tokens and usage.completion_tokens');
    return verdict(problems);
  });

  const stream = await streamChat(env, { messages: USER('Reply with the single word: ok'), maxTokens: 16, timeoutMs, signal });
  await add('chat-stream', 'Streams server-sent events', true, async () => {
    if (stream.status !== 200) return { detail: stream.error ?? `HTTP ${stream.status}` };
    return verdict(stream.firstAnyAt == null ? ['the stream carried no content delta'] : []);
  });
  await add('stream-usage', 'Reports token usage in the stream', true, async () => {
    const problems = [];
    if (!stream.ok) problems.push(stream.error ?? 'the stream failed');
    else if (!(stream.promptTokens > 0) || !(stream.completionTokens > 0)) problems.push('usage has no positive prompt and completion token counts');
    return verdict(problems, `${stream.promptTokens} prompt, ${stream.completionTokens} completion tokens`);
  });
  await add('cached-tokens', 'Reports cached prompt tokens', false, async () => (stream.cachedTokens == null
    ? { detail: 'usage.prompt_tokens_details.cached_tokens is absent, so cache hits cannot be measured' } : { pass: true, detail: `${stream.cachedTokens} cached` }));

  await add('max-tokens', 'Honors the output token limit', true, async () => {
    const response = await chatOnce(env, { messages: USER(COUNT), maxTokens: 5, timeoutMs, signal });
    if (!response.ok) return { detail: response.error ?? `HTTP ${response.status}` };
    const completion = response.json?.usage?.completion_tokens;
    const finish = response.json?.choices?.[0]?.finish_reason;
    const problems = [];
    if (!(completion <= 5)) problems.push(`${completion} completion tokens for a limit of 5`);
    if (finish !== 'length') problems.push(`finish_reason ${finish}, not length`);
    return verdict(problems);
  });

  await add('system-message', 'Accepts a system message', true, async () => {
    const response = await chatOnce(env, { messages: [{ role: 'system', content: 'You are terse.' }, ...USER('Say ok.')], maxTokens: 16, timeoutMs, signal });
    return response.ok ? { pass: true, detail: 'ok' } : { detail: response.error ?? `HTTP ${response.status}: ${response.text.slice(0, 120)}` };
  });

  await add('stop-sequence', 'Honors a stop sequence', false, async () => {
    const response = await chatOnce(env, { messages: USER('Count from 1 to 10 separated by single spaces. Output only the numbers.'), maxTokens: 64, fields: { stop: ['5'] }, timeoutMs, signal });
    if (!response.ok) return { detail: response.error ?? `HTTP ${response.status}` };
    const content = response.json?.choices?.[0]?.message?.content ?? '';
    return verdict(content.includes('5') ? ['the output contains the stop sequence'] : []);
  });

  await add('deterministic', 'Repeats itself at temperature 0', false, async () => {
    const ask = () => chatOnce(env, { messages: USER(COUNT), maxTokens: 24, timeoutMs, signal });
    const [first, second] = [await ask(), await ask()];
    if (!first.ok || !second.ok) return { detail: 'a request failed' };
    const text = response => response.json?.choices?.[0]?.message?.content;
    return verdict(text(first) === text(second) ? [] : ['two identical requests gave different text']);
  });

  await add('error-shape', 'Rejects an unknown model with an error object', false, async () => {
    const response = await chatOnce(env, { messages: USER('hi'), maxTokens: 1, fields: { model: '__no_such_model__' }, timeoutMs, signal });
    const problems = [];
    if (response.status < 400 || response.status >= 500) problems.push(`status ${response.status}, not 4xx`);
    if (response.json?.error == null) problems.push('no error object in the body');
    return verdict(problems, `HTTP ${response.status}`);
  });

  const requiredFailed = checks.filter(check => check.required && check.status !== 'pass');
  return { status: 'complete', required_passed: requiredFailed.length === 0, checks };
}
