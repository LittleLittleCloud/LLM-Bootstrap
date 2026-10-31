// The model list of the endpoint and, when it says so, each model's context window.
import { getJson } from './client.js';

export const ASSUMED_CONTEXT_WINDOW = 32768;
const WINDOW_KEYS = ['context_length', 'context_window', 'max_model_len', 'max_context_length', 'max_input_tokens', 'context_size', 'n_ctx'];

export function contextWindowOf(entry) {
  for (const holder of [entry, entry?.meta, entry?.metadata, entry?.architecture]) {
    for (const key of WINDOW_KEYS.concat('n_ctx_train')) {
      const value = holder?.[key];
      if (Number.isFinite(value) && value > 0) return value;
    }
  }
  return null;
}

// Returns { ok, status, models: [{ id, contextWindow }], error }.
export async function loadModels(env, { signal } = {}) {
  const response = await getJson(env, '/models', { signal });
  if (!response.ok) return { ok: false, status: response.status, models: [], error: response.error ?? `HTTP ${response.status}` };
  const list = Array.isArray(response.json?.data) ? response.json.data : Array.isArray(response.json) ? response.json : null;
  if (!list) return { ok: false, status: response.status, models: [], error: 'the response has no model list' };
  const models = list.filter(entry => typeof entry?.id === 'string').map(entry => ({ id: entry.id, contextWindow: contextWindowOf(entry) }));
  return { ok: true, status: response.status, models, error: null };
}

export function resolveContextWindow(models, modelId) {
  const known = models.find(model => model.id === modelId)?.contextWindow;
  return known ? { tokens: known, source: 'models-metadata' } : { tokens: ASSUMED_CONTEXT_WINDOW, source: 'assumed' };
}
