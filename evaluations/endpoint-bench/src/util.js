// Small shared helpers: hashing, a seeded generator, and statistics. No DOM or Node-only APIs, so the evaluator runs in a browser and under Node.

export async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// xmur3 string hash seeding mulberry32.
export function seeded(seed) {
  let h = 1779033703 ^ String(seed).length;
  for (const char of String(seed)) {
    h = Math.imul(h ^ char.charCodeAt(0), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let state = (() => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^ (h >>> 16)) >>> 0;
  })();
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Nearest-rank percentile, the definition every summary uses. Null for no values.
export function percentile(values, probability) {
  const usable = values.filter(Number.isFinite);
  if (!usable.length) return null;
  const sorted = [...usable].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(probability * sorted.length) - 1)];
}

export const p50 = values => percentile(values, 0.5);
export const p90 = values => percentile(values, 0.9);
export const p95 = values => percentile(values, 0.95);
export const min = values => { const usable = values.filter(Number.isFinite); return usable.length ? Math.min(...usable) : null; };
export const max = values => { const usable = values.filter(Number.isFinite); return usable.length ? Math.max(...usable) : null; };

// Standard error of a proportion.
export const stderrOf = (score, count) => (count > 0 ? Math.sqrt(score * (1 - score) / count) : null);

export const estimateTokens = text => Math.round(text.length / 4);
export const round = (value, digits = 3) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null);
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
