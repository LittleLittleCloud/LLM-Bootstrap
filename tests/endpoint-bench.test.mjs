import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadValidators } from '../skills/bootstrap-experiment-sop/scripts/validators.mjs';
import { normalizeBase, newCompat, streamChat } from '../evaluations/endpoint-bench/src/client.js';
import { defaultConfig, endpointClass, resolvePlan, validateConfig } from '../evaluations/endpoint-bench/src/config.js';
import { runConform } from '../evaluations/endpoint-bench/src/conform.js';
import { buildDocument, gradeCode, generateTask } from '../evaluations/endpoint-bench/src/context.js';
import { speedRun, decodeRun } from '../evaluations/endpoint-bench/src/measure.js';
import { loadModels, resolveContextWindow } from '../evaluations/endpoint-bench/src/models.js';
import { headlineMetrics } from '../evaluations/endpoint-bench/src/report.js';
import { runEvaluation } from '../evaluations/endpoint-bench/src/run.js';
import { buildPrompt } from '../evaluations/endpoint-bench/src/cache.js';
import { buildQuestion, gradeAnswer } from '../evaluations/endpoint-bench/src/thinking.js';
import { percentile } from '../evaluations/endpoint-bench/src/util.js';
import { createReferenceEngine } from '../evaluations/endpoint-bench/reference/engine.js';
import { commit, sha } from './helpers/fixtures.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = join(root, 'evaluations', 'endpoint-bench');
const definition = JSON.parse(readFileSync(join(directory, 'evaluation.json'), 'utf8'));
const { evaluation: validators } = await loadValidators();
const fileHash = path => createHash('sha256').update(readFileSync(join(directory, path))).digest('hex');
const accepts = report => assert.ok(validators.EvaluationReport(report), JSON.stringify(validators.EvaluationReport.errors?.slice(0, 5), null, 2));
const pin = { id: 'endpoint-bench', revision: commit('e'), sha256: sha('f'), dirty: false };

// The real plan shrunk so that a run against an in-memory engine takes seconds.
const small = (() => {
  const copy = structuredClone(definition);
  Object.assign(copy.plan.speed, { warmup: 1, runs: 3, max_tokens: 60 });
  Object.assign(copy.plan.thinking, { questions: 3, rows: 12, warmup: 1 });
  Object.assign(copy.plan.decode, { lengths: [50, 200], runs: 2, warmup: 1 });
  Object.assign(copy.plan.prefill, { sizes: [2000, 6000, 90000], runs: 1 });
  Object.assign(copy.plan.needle, { positions: [10, 90], runs: 1 });
  Object.assign(copy.plan.cache, { padded_tokens: 3000, repeats: 2 });
  return copy;
})();
const fast = options => createReferenceEngine({ prefillTps: 400000, decodeTps: 2000, window: 12000, ...options });
const run = (fetch, patch = {}, config = {}) => runEvaluation({
  config: { ...defaultConfig(), endpoint: 'http://reference.invalid', model: 'reference', ...config }, definition: small, pin, overrides: { fetch, ...patch },
});

test('the definition is released, pins every evaluator file by hash, and plans the seven tests', () => {
  assert.ok(validators.EvaluationDefinition(definition), JSON.stringify(validators.EvaluationDefinition.errors));
  assert.equal(definition.evaluation_id, 'endpoint-bench');
  assert.equal(definition.status, 'released');
  const files = ['src', 'reference'].flatMap(folder => readdirSync(join(directory, folder)).map(name => `${folder}/${name}`)).sort();
  assert.deepEqual(definition.scripts.map(script => script.path).sort(), files, 'every evaluator file is a pinned script');
  for (const script of definition.scripts) assert.equal(script.sha256, fileHash(script.path), `${script.path} changed: run tools/evaluation/refresh-hashes.mjs endpoint-bench`);
  assert.deepEqual(Object.keys(definition.plan), ['conform', 'speed', 'thinking', 'decode', 'prefill', 'needle', 'cache']);
  assert.deepEqual(definition.plan.decode.lengths, [100, 1000, 4000]);
  assert.deepEqual(definition.plan.needle.positions, [5, 25, 50, 75, 90]);
  assert.equal(definition.plan.cache.padded_tokens, 50000);
  assert.deepEqual(resolvePlan(definition, 'full'), definition.plan);
  assert.ok(resolvePlan(definition, 'quick').decode.lengths.length < definition.plan.decode.lengths.length, 'the quick profile reduces the plan');
  assert.equal(resolvePlan(definition, 'quick').speed.max_tokens, definition.plan.speed.max_tokens, 'and keeps what it does not change');
});

test('the inputs are an endpoint, an optional token, and a model, and nothing about the machine', () => {
  const config = { ...defaultConfig(), endpoint: 'https://api.example.com/v1', model: 'm' };
  assert.deepEqual(validateConfig(config), [], 'no token is needed');
  assert.deepEqual(Object.keys(defaultConfig()).sort(), ['apiKey', 'endpoint', 'model', 'profile', 'tests']);
  assert.match(validateConfig({ ...config, endpoint: 'ftp://x' }).join(), /endpoint/);
  assert.match(validateConfig({ ...config, endpoint: 'nonsense' }).join(), /endpoint/);
  assert.match(validateConfig({ ...config, model: ' ' }).join(), /model/);
  assert.match(validateConfig({ ...config, tests: [] }).join(), /test/);
  assert.match(validateConfig({ ...config, tests: ['speed', 'gsm8k'] }).join(), /test/);
  assert.match(validateConfig({ ...config, profile: 'turbo' }).join(), /profile/);
});

test('endpoint URLs are normalized and classified without keeping the address', () => {
  assert.equal(normalizeBase('http://x:8080'), 'http://x:8080/v1');
  assert.equal(normalizeBase('http://x/v1/'), 'http://x/v1');
  assert.equal(normalizeBase('http://x/v1/chat/completions'), 'http://x/v1');
  assert.equal(normalizeBase('https://u:p@x/api/v2?key=1#f'), 'https://x/api/v2', 'credentials and query never survive');
  assert.deepEqual(['http://127.0.0.1:1', 'http://localhost', 'http://192.168.0.4', 'http://10.1.2.3', 'http://172.16.0.1', 'http://172.40.0.1', 'https://api.openai.com/v1', 'http://box:80'].map(endpointClass),
    ['loopback', 'loopback', 'private-network', 'private-network', 'private-network', 'remote', 'remote', 'private-network']);
});

test('percentiles are nearest-rank, and a decode rate drops the first token and the reasoning', () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.9), 5);
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([null, 3, undefined], 0.5), 3, 'missing values are not counted');
  const stream = (patch = {}) => ({ ok: true, startAt: 0, firstAnyAt: 100, firstVisibleAt: 300, lastVisibleAt: 1300, endAt: 1400, completionTokens: 120, reasoningTokens: 20, reasoningChars: 0, content: '', ...patch });
  const decode = decodeRun(stream());
  assert.equal(decode.visible_tokens, 100);
  assert.equal(decode.reasoning_tokens, 20);
  assert.equal(decode.decode_tokens_per_second, 99, '(100 - 1) tokens over one second');
  assert.equal(decode.ttft_ms, 300, 'the first visible token, not the first reasoning delta');
  assert.equal(decode.reasoning_required, true);
  assert.equal(speedRun(stream()).ttft_ms, 100, 'speed counts the first delta of any kind');
  assert.equal(speedRun(stream()).tokens_per_second, 92.31, 'completion tokens over the time after the first delta, reasoning included');
  const estimated = decodeRun(stream({ reasoningTokens: null, reasoningChars: 300, content: 'x'.repeat(700) }));
  assert.equal(estimated.reasoning_tokens, 36, 'without server counts the split follows the streamed characters');
  assert.equal(decodeRun({ ok: false, error: 'timeout' }).ok, false);
  assert.equal(decodeRun(stream({ lastVisibleAt: 300 })).decode_tokens_per_second, null, 'no interval, no rate');
});

test('a stream is timed, learns what the endpoint rejects, and reports a missing usage', async () => {
  const env = (fetch, patch = {}) => ({ fetch, now: () => performance.now(), base: 'http://x/v1', model: 'reference', apiKey: '', compat: newCompat(), ...patch });
  const ask = environment => streamChat(environment, { messages: [{ role: 'user', content: 'hello world' }], maxTokens: 20, timeoutMs: 5000 });
  const ok = await ask(env(fast()));
  assert.equal(ok.ok, true);
  assert.equal(ok.completionTokens, 20);
  assert.ok(ok.promptTokens > 0);
  assert.ok(ok.firstVisibleAt > ok.startAt && ok.endAt >= ok.lastVisibleAt);

  const strict = env(fast({ requireCompletionTokens: true, rejectTemperature: true }));
  const adapted = await ask(strict);
  assert.equal(adapted.ok, true, adapted.error);
  assert.equal(strict.compat.tokenParam, 'max_completion_tokens');
  assert.equal(strict.compat.noTemperature, true);

  assert.match((await ask(env(fast({ fault: 'no-usage' })))).error, /no usage/);
  assert.equal((await ask(env(async () => new Response('down', { status: 503 })))).error, 'HTTP 503');
  assert.equal((await ask(env(async () => { throw new TypeError('Failed to fetch'); }))).error, 'Failed to fetch');
  const controller = new AbortController();
  const hanging = env((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('x', 'AbortError')))));
  const timed = await streamChat(hanging, { messages: [], maxTokens: 1, timeoutMs: 30 });
  assert.equal(timed.error, 'timeout');
  setTimeout(() => controller.abort(), 20);
  assert.equal((await streamChat(hanging, { messages: [], maxTokens: 1, timeoutMs: 5000, signal: controller.signal })).error, 'aborted');
});

test('every streamed request is reported live, in order, labelled by the test, and a broken listener changes nothing', async () => {
  const events = [];
  const { report } = await runEvaluation({
    config: { ...defaultConfig(), endpoint: 'http://reference.invalid', model: 'reference', tests: ['speed'] }, definition: small, pin,
    overrides: { fetch: fast() }, onStream: event => events.push(event),
  });
  assert.equal(report.status, 'complete');
  const starts = events.filter(event => event.type === 'start');
  assert.equal(starts.length, small.plan.speed.warmup + small.plan.speed.runs);
  assert.deepEqual(starts.map(event => event.message), ['warm-up', 'run 1 of 3', 'run 2 of 3', 'run 3 of 3']);
  assert.ok(events.every(event => event.test === 'speed'));
  const first = events.findIndex(event => event.type === 'delta');
  assert.equal(events[first - 1].type, 'start');
  const ends = events.filter(event => event.type === 'end');
  assert.equal(ends.length, starts.length);
  assert.ok(ends.every(event => event.ok && event.tokens === 60));
  const deltas = events.filter(event => event.type === 'delta');
  assert.ok(deltas.length > starts.length);
  assert.ok(deltas.every((event, index) => index === 0 || event.at >= deltas[index - 1].at));
  assert.ok(deltas.every(event => ['content', 'reasoning'].includes(event.kind) && event.text.length > 0));

  const broken = await run(fast(), { onStream: () => { throw new Error('display failed'); } }, { tests: ['speed'] });
  assert.equal(broken.report.status, 'complete');
});

test('the model list yields the context window when the endpoint says it, and a flagged assumption when it does not', async () => {
  const env = fetch => ({ fetch, now: () => 0, base: 'http://x/v1', model: 'reference', compat: newCompat() });
  const listed = await loadModels(env(fast({ window: 20000 })));
  assert.deepEqual(resolveContextWindow(listed.models, 'reference'), { tokens: 20000, source: 'models-metadata' });
  const bare = await loadModels(env(fast({ models: [{ id: 'reference' }] })));
  assert.deepEqual(resolveContextWindow(bare.models, 'reference'), { tokens: 32768, source: 'assumed' });
  const llama = await loadModels(env(fast({ models: [{ id: 'reference', meta: { n_ctx_train: 8192 } }] })));
  assert.equal(resolveContextWindow(llama.models, 'reference').tokens, 8192);
  const down = await loadModels(env(async () => new Response('no', { status: 404 })));
  assert.equal(down.ok, false);
  assert.deepEqual(resolveContextWindow(down.models, 'reference'), { tokens: 32768, source: 'assumed' });
});

test('conformance passes a compliant endpoint and names what a broken one lacks', async () => {
  const env = fetch => ({ fetch, now: () => performance.now(), base: 'http://x/v1', model: 'reference', apiKey: '', compat: newCompat() });
  const check = async fetch => {
    const environment = env(fetch);
    return runConform(environment, definition.plan.conform, { models: await loadModels(environment) });
  };
  const good = await check(fast());
  assert.equal(good.required_passed, true, JSON.stringify(good.checks.filter(item => item.status !== 'pass')));
  assert.deepEqual(good.checks.map(item => item.id), [
    'models-list', 'chat-completion', 'chat-stream', 'stream-usage', 'cached-tokens', 'max-tokens', 'system-message', 'stop-sequence', 'deterministic', 'error-shape',
  ]);
  const status = (result, id) => result.checks.find(item => item.id === id).status;
  const noUsage = await check(fast({ fault: 'no-usage' }));
  assert.equal(noUsage.required_passed, false);
  assert.equal(status(noUsage, 'stream-usage'), 'fail');
  assert.equal(status(noUsage, 'chat-stream'), 'pass', 'the stream itself works');
  const noCached = await check(fast({ reportCached: false }));
  assert.equal(noCached.required_passed, true, 'cached tokens are optional');
  assert.equal(status(noCached, 'cached-tokens'), 'fail');
  assert.equal(noCached.checks.find(item => item.id === 'cached-tokens').required, false);
  const unknownModel = await check(fast({ models: [{ id: 'other' }] }));
  assert.equal(unknownModel.required_passed, false);
  assert.equal(status(unknownModel, 'models-list'), 'fail');
  const dead = await check(async () => { throw new TypeError('Failed to fetch'); });
  assert.equal(dead.required_passed, false);
  assert.ok(dead.checks.every(item => item.status === 'fail'));
});

test('thinking questions have one right answer, spread over positions, and the grade is strict about the format', () => {
  const first = buildQuestion({ seed: 'a', rows: 12 });
  assert.deepEqual(buildQuestion({ seed: 'a', rows: 12 }), first, 'a seed gives one question');
  assert.notEqual(buildQuestion({ seed: 'b', rows: 12 }).prompt, first.prompt);
  const rows = [...first.prompt.matchAll(/^\| (\d+) \| (user-\d+) \| (\d+) \|$/gm)].map(([, id, name, score]) => ({ id: Number(id), name, score: Number(score) }));
  assert.equal(rows.length, 12);
  assert.equal(new Set(rows.map(row => row.score)).size, 12, 'scores are unique, so there is no tie');
  const top = rows.reduce((best, row) => (row.score > best.score ? row : best));
  assert.deepEqual([top.id, top.name], [first.answer.id, first.answer.name]);
  const positions = new Set(Array.from({ length: 40 }, (_, index) => {
    const question = buildQuestion({ seed: `p${index}`, rows: 12 });
    return [...question.prompt.matchAll(/^\| (\d+) \|/gm)].findIndex(match => Number(match[1]) === question.answer.id);
  }));
  assert.ok(positions.size > 6, 'the highest row is not always in the same place');
  const answer = { id: 1234, name: 'user-7' };
  assert.deepEqual(gradeAnswer('1234|user-7', answer), { compliant: true, correct: true });
  assert.deepEqual(gradeAnswer('  1234|USER-7\n', answer), { compliant: true, correct: true });
  assert.deepEqual(gradeAnswer('1234|user-8', answer), { compliant: true, correct: false });
  assert.deepEqual(gradeAnswer('Answer: 1234|user-7', answer), { compliant: false, correct: false });
  assert.deepEqual(gradeAnswer('1234|user-7\nbecause it is highest', answer), { compliant: false, correct: false });
  assert.deepEqual(gradeAnswer('01234|user-7', answer), { compliant: true, correct: false }, 'the id is canonical');
  assert.deepEqual(gradeAnswer('', answer), { compliant: false, correct: false });
});

test('long documents hide one code at the asked depth, grow to the size asked, and are graded as one exact line', () => {
  const task = generateTask({ seed: 's', targetTokens: 4000, positionPercent: 50, charsPerToken: 4 });
  assert.deepEqual(generateTask({ seed: 's', targetTokens: 4000, positionPercent: 50, charsPerToken: 4 }), task);
  assert.ok(Math.abs(task.prompt.length / 4 - 4000) < 500, `${task.prompt.length / 4} estimated tokens`);
  assert.equal(task.prompt.match(/access code for sector/g).length, 1, 'only the entry names the sector this way; the instruction does not');
  assert.ok(task.prompt.includes(`is ${task.expected}.`));
  const lines = task.prompt.split('\n');
  const start = lines.indexOf('--- DOCUMENT START ---');
  const end = lines.indexOf('--- DOCUMENT END ---');
  const entry = lines.findIndex(line => line.includes(task.expected));
  assert.ok(Math.abs((entry - start) / (end - start) - 0.5) < 0.02, 'the needle sits at the asked depth');
  const early = generateTask({ seed: 's', targetTokens: 4000, positionPercent: 5, charsPerToken: 4 });
  const late = generateTask({ seed: 's', targetTokens: 4000, positionPercent: 90, charsPerToken: 4 });
  assert.ok(early.needleLine < task.needleLine && task.needleLine < late.needleLine);
  assert.ok(generateTask({ seed: 's', targetTokens: 4000, positionPercent: 50, charsPerToken: 2 }).prompt.length < task.prompt.length, 'fewer characters per token, shorter document');
  assert.deepEqual(gradeCode(task.expected, task.expected), { compliant: true, correct: true });
  assert.deepEqual(gradeCode(` ${task.expected.toLowerCase()} \n`, task.expected), { compliant: true, correct: true });
  assert.deepEqual(gradeCode(`The code is ${task.expected}`, task.expected), { compliant: false, correct: false });
  assert.deepEqual(gradeCode('AAAA-BBBB-CCCC', task.expected), { compliant: true, correct: false });
  assert.equal(buildDocument({ random: () => 0.5, sector: 'x', code: 'AAAA-BBBB-CCCC', positionPercent: 0, targetTokens: 10, charsPerToken: 4 }).lines.length >= 8, true, 'a document is never degenerate');
});

test('the cache prompts differ only where the test says: padded repeats byte for byte, busted never does', () => {
  const padded = buildPrompt({ seed: 'c', targetTokens: 3000, charsPerToken: 4 });
  assert.equal(buildPrompt({ seed: 'c', targetTokens: 3000, charsPerToken: 4 }), padded);
  assert.ok(Math.abs(padded.length / 4 - 3000) < 200);
  assert.ok(padded.endsWith('What is the capital of France? Answer with the city name only.'), 'the question is always last');
  assert.equal(buildPrompt({ seed: 'c', targetTokens: 0, charsPerToken: 4 }), 'What is the capital of France? Answer with the city name only.');
  const busted = buildPrompt({ seed: 'c', targetTokens: 3000, charsPerToken: 4, nonce: 'abc' });
  assert.equal(busted, `Request nonce: abc\n${padded}`);
  assert.notEqual(buildPrompt({ seed: 'd', targetTokens: 3000, charsPerToken: 4 }), padded, 'a fresh seed rebuilds the padding');
});

test('all seven tests run against a known engine and the report says what the engine does', { timeout: 120000 }, async () => {
  const { report, fileName } = await run(fast({ reasoning: 30 }));
  accepts(report);
  assert.equal(report.status, 'complete', report.failures.join('; '));
  assert.deepEqual(report.selected_tests, ['conform', 'speed', 'thinking', 'decode', 'prefill', 'needle', 'cache']);
  assert.deepEqual(report.context_window, { tokens: 12000, source: 'models-metadata' });
  assert.equal(report.endpoint_class, 'remote');
  assert.equal(report.model, 'reference');
  assert.equal(report.profile, 'full');
  assert.match(report.seed, /^[0-9a-f]{8}$/);
  assert.match(fileName, /^\d{8}-\d{6}\.json$/);
  assert.equal(report.evaluation_revision, pin.revision);
  assert.equal(report.tests.conform.required_passed, true);

  const speed = report.tests.speed.summary;
  assert.equal(speed.completed_runs, 3);
  assert.ok(speed.tokens_per_second_p50 > 500 && speed.tokens_per_second_p50 < 3000, `speed ${speed.tokens_per_second_p50}`);
  const decode = report.tests.decode.lengths.at(-1);
  assert.equal(decode.output_tokens, 200);
  assert.ok(Math.abs(decode.summary.decode_tokens_per_second_p50 - 2000) / 2000 < 0.5, `decode ${decode.summary.decode_tokens_per_second_p50}`);
  assert.equal(decode.summary.visible_tokens_p50, 200, 'reasoning does not count as output');
  assert.equal(decode.summary.reasoning_required, true);
  assert.equal(decode.summary.fixed_length_applied, true);
  const thinking = report.tests.thinking.variants;
  assert.equal(thinking.default.summary.accuracy, 1);
  assert.equal(thinking.default.summary.attempted, 3, 'the warm-up question is not counted');
  assert.equal(thinking['no-thinking'].summary.format_compliance, 1);
  assert.deepEqual(report.tests.prefill.sizes.map(size => size.status), ['complete', 'complete', 'skipped'], 'a size above the window is skipped, not failed');
  assert.ok(report.tests.prefill.sizes[1].summary.input_tokens_per_second_p50 > 50000);
  assert.equal(report.tests.needle.summary.accuracy, 1);
  assert.equal(report.tests.needle.config.input_tokens, 10800, 'the document fills 90% of the window');
  assert.ok(report.tests.needle.positions.every(position => position.summary.attempted === 1));
  const cache = report.tests.cache.variants;
  assert.ok(cache.padded.summary.cache_hit_pct > 90, `padded hit ${cache.padded.summary.cache_hit_pct}`);
  assert.equal(cache.short.summary.cache_hit_pct, 0, 'a short prompt is below the cacheable minimum');
  assert.equal(cache.busted.summary.cache_hit_pct, 0, 'the nonce defeats the cache');
  assert.ok(cache.padded.summary.ttft_reduction_pct > cache.busted.summary.ttft_reduction_pct);
  assert.equal(report.tests.cache.config.padded_tokens, 3000);

  const metrics = headlineMetrics(report);
  assert.equal(metrics.conform_passed, 1);
  assert.ok(Object.values(metrics).every(value => Number.isFinite(value)), JSON.stringify(metrics));
});

test('a report holds no token, no address, no prompt, and no model output beyond a short answer', { timeout: 120000 }, async () => {
  const { report } = await run(fast(), {}, { endpoint: 'http://192.168.7.7:8080', apiKey: 'sk-secret-token', tests: ['conform', 'thinking', 'needle'] });
  const text = JSON.stringify(report);
  assert.doesNotMatch(text, /sk-secret-token/);
  assert.doesNotMatch(text, /192\.168\.7\.7/);
  assert.doesNotMatch(text, /DOCUMENT START|Find the row|Entry \d+:/);
  assert.equal(report.endpoint_class, 'private-network');
  assert.ok(Math.max(...[...text.matchAll(/"answer":"([^"]*)"/g)].map(match => match[1].length)) <= 80);
});

test('the token is sent as a bearer token when given and not at all otherwise', async () => {
  const seen = [];
  const spy = engine => (url, init) => { seen.push(init.headers.authorization ?? null); return engine(url, init); };
  await run(spy(fast()), {}, { apiKey: 'tok', tests: ['conform'] });
  assert.ok(seen.length > 5 && seen.every(value => value === 'Bearer tok'));
  seen.length = 0;
  await run(spy(fast()), {}, { tests: ['conform'] });
  assert.ok(seen.every(value => value === null));
});

test('a wrong engine is measured as wrong: bad answers score zero, a missing cache shows as none, absent cached tokens are not guessed', { timeout: 120000 }, async () => {
  const wrong = (await run(fast({ answersThinking: false, knowsNeedle: false }), {}, { tests: ['thinking', 'needle'] })).report;
  accepts(wrong);
  assert.equal(wrong.tests.thinking.variants.default.summary.accuracy, 0);
  assert.equal(wrong.tests.needle.summary.accuracy, 0);
  assert.equal(wrong.status, 'complete', 'a wrong answer is a measurement, not a failure');

  const uncached = (await run(fast({ cache: false }), {}, { tests: ['cache'] })).report;
  assert.equal(uncached.tests.cache.variants.padded.summary.cache_hit_pct, 0);
  assert.ok(Math.abs(uncached.tests.cache.variants.padded.summary.ttft_reduction_pct) < 60);

  const silent = (await run(fast({ reportCached: false }), {}, { tests: ['cache'] })).report;
  accepts(silent);
  assert.equal(silent.tests.cache.variants.padded.summary.cache_reported, false);
  assert.equal(silent.tests.cache.variants.padded.summary.cache_hit_pct, null, 'no cached tokens reported is not zero');
});

test('an endpoint that rejects fields is accommodated and the report says how', { timeout: 120000 }, async () => {
  const { report } = await run(fast({ requireCompletionTokens: true, rejectTemperature: true }), {}, { tests: ['conform', 'speed'] });
  accepts(report);
  assert.equal(report.status, 'complete', report.failures.join('; '));
  assert.deepEqual(report.compat, { tokenParam: 'max_completion_tokens', noTemperature: true });
});

test('failures are recorded as failures: errors, a missing usage, and an unusable endpoint', { timeout: 120000 }, async () => {
  const flaky = (await run(fast({ fault: 'http-error' }), {}, { tests: ['speed', 'decode'] })).report;
  accepts(flaky);
  assert.notEqual(flaky.status, 'complete');
  assert.ok(flaky.failures.length >= 1);
  assert.match(flaky.failures.join(), /HTTP 500/);
  assert.equal(flaky.tests.speed.runs.some(item => item.ok === false), true);
  assert.equal(headlineMetrics(flaky).decode_tokens_per_second_p50 === null || typeof headlineMetrics(flaky).decode_tokens_per_second_p50 === 'number', true);

  const noUsage = (await run(fast({ fault: 'no-usage' }), {}, { tests: ['conform', 'speed'] })).report;
  accepts(noUsage);
  assert.equal(noUsage.tests.conform.required_passed, false);
  assert.equal(noUsage.tests.speed.status, 'error');
  assert.equal(noUsage.status, 'partial', 'conformance ran, so the report is partly complete');

  const dead = (await run(async () => { throw new TypeError('Failed to fetch'); }, {}, { tests: ['speed'] })).report;
  accepts(dead);
  assert.equal(dead.status, 'error');
  assert.equal(dead.context_window.source, 'assumed');
  assert.match(dead.failures.join(), /Failed to fetch/);
});

test('a stopped run keeps what finished, lists the rest as cancelled, and still validates', { timeout: 120000 }, async () => {
  const controller = new AbortController();
  let calls = 0;
  const engine = fast();
  const counting = (url, init) => { calls += 1; if (calls === 14) controller.abort(); return engine(url, init); };
  const { report } = await runEvaluation({
    config: { ...defaultConfig(), endpoint: 'http://reference.invalid', model: 'reference', tests: ['conform', 'speed', 'decode'] }, definition: small, pin,
    overrides: { fetch: counting }, signal: controller.signal,
  });
  accepts(report);
  assert.equal(report.status, 'cancelled');
  assert.equal(report.tests.conform.status, 'complete');
  assert.ok(['cancelled'].includes(report.tests.decode.status), JSON.stringify(report.tests.decode.status));
  assert.ok(report.failures.length >= 1);
});

test('an unusable configuration stops before any request', async () => {
  let calls = 0;
  await assert.rejects(runEvaluation({ config: defaultConfig(), definition: small, pin, overrides: { fetch: () => { calls += 1; } } }), /not ready/);
  assert.equal(calls, 0);
});

test('the quick profile runs a smaller plan and says so', { timeout: 120000 }, async () => {
  const quickDefinition = structuredClone(small);
  quickDefinition.profiles.quick = { speed: { runs: 2 }, decode: { lengths: [50], runs: 1 } };
  const { report } = await runEvaluation({
    config: { ...defaultConfig(), endpoint: 'http://reference.invalid', model: 'reference', tests: ['speed', 'decode'], profile: 'quick' }, definition: quickDefinition, pin, overrides: { fetch: fast() },
  });
  accepts(report);
  assert.equal(report.profile, 'quick');
  assert.equal(report.tests.speed.runs.length, 2);
  assert.deepEqual(report.tests.decode.lengths.map(item => item.output_tokens), [50]);
});
