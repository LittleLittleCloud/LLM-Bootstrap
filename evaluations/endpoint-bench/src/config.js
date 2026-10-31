// The inputs of a run, and the plan the evaluation definition fixes for them.

export const TESTS = ['conform', 'speed', 'thinking', 'decode', 'prefill', 'needle', 'cache'];
export const PROFILES = ['full', 'quick'];

export const defaultConfig = () => ({ endpoint: '', apiKey: '', model: '', tests: [...TESTS], profile: 'full' });

// Returns one message for each problem that must be fixed before the run can start. Only the endpoint and a model are required.
export function validateConfig(config) {
  const problems = [];
  try {
    const url = new URL(config.endpoint);
    if (!/^https?:$/.test(url.protocol)) problems.push('The endpoint must be an http or https URL.');
  } catch {
    problems.push('The endpoint must be an http or https URL.');
  }
  if (!/\S/.test(config.model ?? '')) problems.push('Choose a model.');
  if (!config.tests.length || config.tests.some(test => !TESTS.includes(test))) problems.push('Select at least one test.');
  if (!PROFILES.includes(config.profile)) problems.push('The profile must be full or quick.');
  return problems;
}

// Where the endpoint is, as a class. The address stays out of the report: it can be a private machine address.
export function endpointClass(endpoint) {
  const host = new URL(endpoint).hostname.toLowerCase();
  if (host === 'localhost' || host === '[::1]' || /^127\./.test(host)) return 'loopback';
  const octets = host.split('.').map(Number);
  const private172 = octets.length === 4 && octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31;
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || private172 || host.endsWith('.local') || host.endsWith('.lan') || !host.includes('.')) return 'private-network';
  return 'remote';
}

// The definition's plan for each test, with the chosen profile's changes on top.
export function resolvePlan(definition, profile) {
  const overrides = profile === 'full' ? {} : definition.profiles[profile] ?? {};
  return Object.fromEntries(Object.entries(definition.plan).map(([test, plan]) => [test, { ...plan, ...overrides[test] }]));
}
