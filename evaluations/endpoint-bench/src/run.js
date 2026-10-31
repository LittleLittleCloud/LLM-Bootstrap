// Runs the selected tests against one endpoint and model and returns the report. Nothing else is asked of the person running it.
import { normalizeBase, newCompat } from './client.js';
import { runCache } from './cache.js';
import { TESTS, endpointClass, resolvePlan, validateConfig } from './config.js';
import { calibrateCharsPerToken } from './context.js';
import { runConform } from './conform.js';
import { runDecode } from './decode.js';
import { loadModels, resolveContextWindow } from './models.js';
import { runNeedle } from './needle.js';
import { runPrefill } from './prefill.js';
import { runSpeed } from './speed.js';
import { runThinking } from './thinking.js';
import { round } from './util.js';

const stamp = date => date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
const DEFAULT_CHARS_PER_TOKEN = 4;

// The distinct errors of a test's requests, for the report's failure list.
function errorsOf(value, found = new Set()) {
  if (Array.isArray(value)) value.forEach(item => errorsOf(item, found));
  else if (value && typeof value === 'object') {
    if (value.ok === false && value.error) found.add(value.error);
    Object.values(value).forEach(item => errorsOf(item, found));
  }
  return found;
}

// definition: the parsed evaluation.json; pin: { id, revision, sha256, dirty }. overrides replaces parts of the request environment.
// onStream receives { test, message, type: 'start' | 'delta' | 'end', at, ... } for every streamed request, as it happens.
export async function runEvaluation({ config, definition, pin, overrides = {}, onProgress = () => {}, onStream, signal }) {
  const invalid = validateConfig(config);
  if (invalid.length) throw new Error(`The configuration is not ready: ${invalid.join(' ')}`);
  const startedAt = new Date();
  const seed = Array.from(crypto.getRandomValues(new Uint8Array(4)), byte => byte.toString(16).padStart(2, '0')).join('');
  const plan = resolvePlan(definition, config.profile);
  const current = { test: '', message: '' };
  const env = {
    fetch: (...args) => globalThis.fetch(...args), now: () => performance.now(), base: normalizeBase(config.endpoint), apiKey: config.apiKey.trim(),
    model: config.model, compat: newCompat(), ...(onStream ? { onStream: event => onStream({ ...current, ...event }) } : {}), ...overrides,
  };
  const selected = TESTS.filter(test => config.tests.includes(test));
  const progress = (test, event) => {
    current.test = test;
    if (event.message) current.message = event.message;
    onProgress({ test, ...event });
  };

  progress('models', { message: 'Loading models' });
  const models = await loadModels(env, { signal });
  const window = resolveContextWindow(models.models, env.model);

  let charsPerToken = null;
  if (selected.some(test => ['needle', 'prefill', 'cache'].includes(test))) {
    progress('calibrate', { message: 'Sizing documents for this model' });
    charsPerToken = await calibrateCharsPerToken(env, { seed, timeoutMs: 120000, signal });
  }
  const cpt = charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;

  const context = { signal, seed, window, charsPerToken: cpt };
  const runners = {
    conform: hooks => runConform(env, plan.conform, { models, signal, ...hooks }),
    speed: hooks => runSpeed(env, plan.speed, { signal, ...hooks }),
    thinking: hooks => runThinking(env, plan.thinking, { seed, signal, ...hooks }),
    decode: hooks => runDecode(env, plan.decode, { signal, ...hooks }),
    prefill: hooks => runPrefill(env, plan.prefill, { ...context, ...hooks }),
    needle: hooks => runNeedle(env, plan.needle, { ...context, ...hooks }),
    cache: hooks => runCache(env, plan.cache, { ...context, ...hooks }),
  };

  const tests = {};
  const failures = [];
  for (const test of selected) {
    if (signal?.aborted) { tests[test] = { status: 'cancelled' }; failures.push(`${test}: cancelled`); continue; }
    progress(test, { message: `Starting ${test}` });
    try {
      tests[test] = await runners[test]({ onProgress: event => progress(test, event) });
    } catch (error) {
      tests[test] = { status: 'error', error: String(error?.message ?? error).slice(0, 200) };
    }
    if (tests[test].status !== 'complete') {
      const errors = [...errorsOf(tests[test])].slice(0, 3);
      failures.push(`${test}: ${tests[test].status}${tests[test].error ? ` (${tests[test].error})` : errors.length ? ` (${errors.join('; ')})` : ''}`);
    }
  }

  const statuses = selected.map(test => tests[test].status);
  const status = statuses.every(item => item === 'complete') ? 'complete' : signal?.aborted ? 'cancelled'
    : statuses.some(item => item === 'complete' || item === 'partial') ? 'partial' : 'error';
  const report = {
    report_version: 1,
    evaluation_id: pin.id, evaluation_revision: pin.revision, evaluation_sha256: pin.sha256, ...(pin.dirty ? { build_dirty: true } : {}),
    started_at: startedAt.toISOString(), finished_at: new Date().toISOString(),
    endpoint_class: endpointClass(config.endpoint), model: env.model, profile: config.profile, seed,
    context_window: { tokens: window.tokens, source: window.source }, chars_per_token: round(charsPerToken, 2),
    compat: Object.fromEntries(Object.entries(env.compat).filter(([key, value]) => value !== newCompat()[key])),
    selected_tests: selected, status, failures, tests,
  };
  return { report, fileName: `${stamp(startedAt)}.json`, models: models.models };
}
