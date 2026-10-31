// Requests to an OpenAI-compatible endpoint, timed on the caller's monotonic clock (milliseconds).
// env: { fetch, now, base, apiKey, model, compat } where compat remembers what the endpoint rejected, so each retry changes one thing.

export const normalizeBase = endpoint => {
  const url = new URL(endpoint.trim());
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  let path = url.pathname.replace(/\/+$/, '').replace(/\/(chat\/completions|models)$/, '');
  if (path === '') path = '/v1';
  return `${url.origin}${path}`;
};

const headers = env => ({ 'content-type': 'application/json', ...(env.apiKey ? { authorization: `Bearer ${env.apiKey}` } : {}) });

// Yields the data payload of each server-sent event with the time its bytes arrived.
export async function* sseEvents(body, now) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const take = raw => raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
  for (;;) {
    const { done, value } = await reader.read();
    const at = now();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (let match = buffer.match(/\r?\n\r?\n/); match; match = buffer.match(/\r?\n\r?\n/)) {
      const data = take(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
      if (data) yield { data, at };
    }
  }
  const rest = take(buffer);
  if (rest) yield { data: rest, at: now() };
}

// Live telemetry for a display. A failing listener must never change a measurement.
const emit = (env, event) => {
  try { env.onStream?.(event); } catch { /* ignored */ }
};

const timeoutSignal = (signal, timeoutMs) => {
  const controller = new AbortController();
  const abort = reason => () => controller.abort(reason);
  const timer = timeoutMs ? setTimeout(abort('timeout'), timeoutMs) : null;
  signal?.addEventListener('abort', abort('aborted'), { once: true });
  if (signal?.aborted) controller.abort('aborted');
  return { signal: controller.signal, done: () => clearTimeout(timer), reason: () => controller.signal.reason };
};

// What a 400 says about the request, so the next attempt can drop or rename the field.
const learn = (env, errorText) => {
  const text = errorText.toLowerCase();
  const compat = env.compat;
  if (text.includes('max_completion_tokens') && compat.tokenParam !== 'max_completion_tokens') { compat.tokenParam = 'max_completion_tokens'; return true; }
  if (text.includes('temperature') && !compat.noTemperature) { compat.noTemperature = true; return true; }
  if (text.includes('stream_options') && !compat.noStreamOptions) { compat.noStreamOptions = true; return true; }
  if ((text.includes('min_tokens') || text.includes('ignore_eos')) && !compat.noForcedLength) { compat.noForcedLength = true; return true; }
  return false;
};

export const newCompat = () => ({ tokenParam: 'max_tokens', noTemperature: false, noStreamOptions: false, noForcedLength: false });

function buildBody(env, { messages, maxTokens, fields, stream, forceLength }) {
  const compat = env.compat;
  return {
    model: env.model, messages, stream, top_p: 1,
    ...(compat.noTemperature ? {} : { temperature: 0 }),
    ...(maxTokens == null ? {} : { [compat.tokenParam]: maxTokens }),
    ...(stream && !compat.noStreamOptions ? { stream_options: { include_usage: true } } : {}),
    ...(forceLength && !compat.noForcedLength ? { min_tokens: maxTokens, ignore_eos: true } : {}),
    ...fields,
  };
}

// One streamed chat completion. Times are milliseconds on env.now; visible tokens are the final content, reasoning is tracked apart.
export async function streamChat(env, { messages, maxTokens, fields = {}, forceLength = false, timeoutMs = 120000, signal }) {
  for (let attempt = 0; ; attempt += 1) {
    const result = await streamOnce(env, { messages, maxTokens, fields, forceLength, timeoutMs, signal });
    if (!result.ok && result.status === 400 && attempt < 4 && learn(env, result.errorBody ?? '')) continue;
    result.forcedLength = Boolean(forceLength) && !env.compat.noForcedLength;
    return result;
  }
}

async function streamOnce(env, { messages, maxTokens, fields, forceLength, timeoutMs, signal }) {
  const startAt = env.now();
  const out = {
    ok: false, status: 0, error: null, errorBody: null, content: '', reasoningChars: 0, startAt, firstAnyAt: null, firstVisibleAt: null,
    lastVisibleAt: null, endAt: null, promptTokens: null, completionTokens: null, cachedTokens: null, reasoningTokens: null, finish: null,
  };
  const guard = timeoutSignal(signal, timeoutMs);
  emit(env, { type: 'start', at: startAt });
  try {
    const response = await env.fetch(`${env.base}/chat/completions`, {
      method: 'POST', headers: headers(env), signal: guard.signal,
      body: JSON.stringify(buildBody(env, { messages, maxTokens, fields, stream: true, forceLength })),
    });
    out.status = response.status;
    if (!response.ok) {
      out.error = `HTTP ${response.status}`;
      out.errorBody = (await response.text().catch(() => '')).slice(0, 500);
    } else {
      for await (const { data, at } of sseEvents(response.body, env.now)) {
        if (data === '[DONE]') break;
        let chunk;
        try { chunk = JSON.parse(data); } catch { continue; }
        if (chunk.error) { out.error = String(chunk.error.message ?? chunk.error).slice(0, 200); break; }
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        const content = delta?.content ?? '';
        const reasoning = delta?.reasoning_content ?? delta?.reasoning ?? '';
        if (content || reasoning) out.firstAnyAt ??= at;
        if (reasoning) emit(env, { type: 'delta', at, kind: 'reasoning', text: reasoning });
        if (content) emit(env, { type: 'delta', at, kind: 'content', text: content });
        if (reasoning) out.reasoningChars += reasoning.length;
        if (content) {
          out.firstVisibleAt ??= at;
          out.lastVisibleAt = at;
          out.content += content;
        }
        if (choice?.finish_reason) out.finish = choice.finish_reason;
        if (chunk.usage) {
          out.promptTokens = chunk.usage.prompt_tokens ?? null;
          out.completionTokens = chunk.usage.completion_tokens ?? null;
          out.cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? chunk.usage.cached_tokens ?? null;
          out.reasoningTokens = chunk.usage.completion_tokens_details?.reasoning_tokens ?? null;
        }
      }
      out.ok = out.error == null;
      if (out.ok && out.completionTokens == null) { out.ok = false; out.error = 'the stream reported no usage'; }
    }
  } catch (error) {
    const reason = guard.reason();
    out.error = reason === 'timeout' ? 'timeout' : reason === 'aborted' || error?.name === 'AbortError' ? 'aborted' : String(error?.message ?? error).slice(0, 200);
  } finally {
    guard.done();
  }
  out.endAt = env.now();
  emit(env, { type: 'end', at: out.endAt, ok: out.ok, error: out.error, tokens: out.completionTokens, promptTokens: out.promptTokens });
  return out;
}

// A non-streamed request, for the conformance checks. It also retries once per field the endpoint rejects.
export async function chatOnce(env, { messages, maxTokens, fields = {}, timeoutMs = 60000, signal, stream = false }) {
  for (let attempt = 0; ; attempt += 1) {
    const guard = timeoutSignal(signal, timeoutMs);
    let result;
    try {
      const response = await env.fetch(`${env.base}/chat/completions`, {
        method: 'POST', headers: headers(env), signal: guard.signal,
        body: JSON.stringify(buildBody(env, { messages, maxTokens, fields, stream, forceLength: false })),
      });
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      result = { status: response.status, ok: response.ok, json, text: text.slice(0, 2000), contentType: response.headers.get('content-type') ?? '' };
    } catch (error) {
      result = { status: 0, ok: false, json: null, text: '', contentType: '', error: guard.reason() === 'timeout' ? 'timeout' : String(error?.message ?? error).slice(0, 200) };
    } finally {
      guard.done();
    }
    if (result.status === 400 && attempt < 4 && learn(env, result.text)) continue;
    return result;
  }
}

export async function getJson(env, path, { signal, timeoutMs = 30000 } = {}) {
  const guard = timeoutSignal(signal, timeoutMs);
  try {
    const response = await env.fetch(`${env.base}${path}`, { headers: headers(env), signal: guard.signal });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, ok: response.ok, json, text: text.slice(0, 500) };
  } catch (error) {
    return { status: 0, ok: false, json: null, text: '', error: String(error?.message ?? error).slice(0, 200) };
  } finally {
    guard.done();
  }
}
