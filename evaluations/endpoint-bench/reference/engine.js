// Reference engines for verifying the evaluator: in-memory, answering through a fetch-compatible function so the evaluator's own client,
// timing, and grading run unchanged. The repository tests measure each against what it is known to do.
const encoder = new TextEncoder();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const tokensOf = text => Math.ceil(text.length / 4);
const CACHE_BLOCK = 16;
const CACHE_MIN = 1024;

const event = value => encoder.encode(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`);
const stream = start => new Response(new ReadableStream({
  async start(controller) {
    try { await start(data => controller.enqueue(event(data))); controller.close(); } catch (error) { controller.error(error); }
  },
}), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const lastUser = messages => messages.filter(message => message.role === 'user').at(-1)?.content ?? '';
const textOf = messages => messages.map(message => message.content).join('\n');

// A reply for a prompt the engine "knows": the needle code, the thinking answer, the capital, or filler words.
function answerFor(body, { knowsNeedle, answersThinking }) {
  const prompt = lastUser(body.messages);
  if (/capital of France/.test(prompt)) return 'Paris';
  if (/<id>\|<name>/.test(prompt)) {
    if (!answersThinking) return '0|none';
    const rows = [...prompt.matchAll(/^\| (\d+) \| (user-\d+) \| (\d+) \|$/gm)].map(([, id, name, score]) => ({ id, name, score: Number(score) }));
    const best = rows.reduce((top, row) => (row.score > top.score ? row : top));
    return `${best.id}|${best.name}`;
  }
  if (/access code for the \w+ sector/.test(prompt)) return knowsNeedle ? prompt.match(/is ([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})\./)?.[1] ?? 'none' : 'AAAA-BBBB-CCCC';
  if (/Count from 1/.test(prompt)) return Array.from({ length: 50 }, (_, index) => index + 1).join(' ');
  return 'word '.repeat(4000);
}

// reasoning: emit thinking deltas first. cache: honor prefixes. faults: 'no-usage', 'wrong-answers', 'early-stop', 'http-error'.
export function createReferenceEngine({
  prefillTps = 20000, decodeTps = 400, window = 32768, reasoning = 0, cache = true, fault = null, knowsNeedle = true, answersThinking = true, models = null,
  reportCached = true, requireCompletionTokens = false, rejectTemperature = false,
} = {}) {
  const history = [];
  let count = 0;
  return async function reference(url, init = {}) {
    const path = new URL(url).pathname;
    if (path.endsWith('/models')) return json(200, { object: 'list', data: models ?? [{ id: 'reference', object: 'model', max_model_len: window }] });
    count += 1;
    const body = JSON.parse(init.body);
    if (body.model !== 'reference') return json(404, { error: { message: `the model ${body.model} does not exist`, type: 'invalid_request_error' } });
    if (requireCompletionTokens && 'max_tokens' in body) return json(400, { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } });
    if (rejectTemperature && 'temperature' in body) return json(400, { error: { message: "Unsupported value: 'temperature' does not support 0 with this model." } });
    if (fault === 'http-error' && count % 3 === 0) return json(500, { error: { message: 'fault' } });
    const prompt = textOf(body.messages);
    const promptTokens = tokensOf(prompt) + 8;
    const limit = body.max_tokens ?? body.max_completion_tokens ?? 256;
    let cached = 0;
    if (cache) {
      for (const earlier of history) {
        let index = 0;
        while (index < prompt.length && index < earlier.length && prompt[index] === earlier[index]) index += 1;
        cached = Math.max(cached, Math.floor(tokensOf(prompt.slice(0, index)) / CACHE_BLOCK) * CACHE_BLOCK);
      }
      history.push(prompt);
      if (history.length > 16) history.shift();
      if (cached < CACHE_MIN) cached = 0;
    }
    if (promptTokens > window) return json(400, { error: { message: `the prompt of ${promptTokens} tokens exceeds the context length of ${window}` } });
    const reply = fault === 'wrong-answers' ? 'wrong' : answerFor(body, { knowsNeedle, answersThinking });
    const stop = (body.stop ?? []).find(item => reply.includes(item));
    const words = (stop ? reply.slice(0, reply.indexOf(stop)).trim() : reply).split(' ');
    const forced = body.min_tokens && body.ignore_eos;
    const total = Math.min(limit, forced ? limit : Math.max(1, words.length));
    const wantsUsage = body.stream_options?.include_usage;
    const usage = { prompt_tokens: promptTokens, completion_tokens: total + reasoning, ...(reportCached ? { prompt_tokens_details: { cached_tokens: cached } } : {}) };
    if (!body.stream) {
      return json(200, {
        choices: [{ index: 0, message: { role: 'assistant', content: words.slice(0, total).join(' ') }, finish_reason: stop && total >= words.length ? 'stop' : total >= limit ? 'length' : 'stop' }],
        usage: { ...usage, completion_tokens: total },
      });
    }
    const delta = delta => ({ choices: [{ index: 0, delta, finish_reason: null }] });
    return stream(async send => {
      await sleep((Math.max(1, promptTokens - cached) / prefillTps) * 1000);
      for (let index = 0; index < reasoning; index += 10) {
        send(delta({ reasoning_content: 'think '.repeat(Math.min(10, reasoning - index)) }));
        await sleep((Math.min(10, reasoning - index) / decodeTps) * 1000);
      }
      const visible = Math.min(total, fault === 'early-stop' ? Math.max(1, Math.floor(limit / 2)) : total);
      const pieces = forced ? Array(visible).fill('word') : words.slice(0, visible);
      const batch = Math.max(1, Math.round(decodeTps * 0.02));
      for (let sent = 0; sent < pieces.length; sent += batch) {
        const part = pieces.slice(sent, sent + batch);
        send(delta({ content: (sent ? ' ' : '') + part.join(' ') }));
        await sleep((part.length / decodeTps) * 1000);
      }
      send({ choices: [{ index: 0, delta: {}, finish_reason: visible >= limit ? 'length' : 'stop' }] });
      if (wantsUsage && fault !== 'no-usage') send({ choices: [], usage: { ...usage, completion_tokens: visible + reasoning, ...(reasoning ? { completion_tokens_details: { reasoning_tokens: reasoning } } : {}) } });
      send('[DONE]');
    });
  };
}

