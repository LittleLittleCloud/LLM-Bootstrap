// Pure leaderboard logic: filtering, faceting, ranking, trends, and URL state. No DOM access, so it runs under Node tests.

const read = path => run => path.reduce((value, key) => value?.[key], run);

export const METRICS = {
  decode_tok_s: { label: 'Decode tok/s', unit: 'tok/s', better: 'higher', digits: 1, read: read(['metrics', 'decode_tok_s']) },
  prefill_tok_s: { label: 'Prefill tok/s', unit: 'tok/s', better: 'higher', digits: 1, read: read(['metrics', 'prefill_tok_s']) },
  ttft_ms_p50: { label: 'TTFT p50', unit: 'ms', better: 'lower', digits: 0, read: read(['metrics', 'ttft_ms_p50']) },
  peak_memory_gib: { label: 'Peak memory', unit: 'GiB', better: 'lower', digits: 1, read: read(['metrics', 'peak_memory_gib']) },
  human_interventions: { label: 'Human interventions', unit: '', better: 'lower', digits: 0, read: read(['autonomy', 'human_interventions']) },
  hardware_hours: { label: 'Hardware hours', unit: 'h', better: 'lower', digits: 1, read: read(['autonomy', 'hardware_hours']) },
};

export const FACETS = [
  { key: 'hardware', label: 'Hardware', read: run => run.hardware },
  { key: 'target_model', label: 'Target model', read: run => run.target_model },
  { key: 'evaluation', label: 'Evaluation', read: run => run.evaluation },
  { key: 'builder', label: 'Builder LLM', read: run => run.builder },
  { key: 'harness', label: 'Harness', read: run => run.harness },
  { key: 'comparison_track', label: 'Comparison track', read: run => run.comparison_track },
  { key: 'role', label: 'Role', read: run => run.role },
  { key: 'engine', label: 'Engine', read: run => run.engine.name },
];

export const GROUPS = {
  lineage: 'Experiment lineage',
  engine: 'Engine',
  hardware: 'Hardware',
  target_model: 'Target model',
  builder: 'Builder LLM',
  none: 'No grouping',
};

export const defaultState = () => ({
  metric: 'decode_tok_s', filters: {}, includeFailed: false, selfHosting: false, query: '', from: '', to: '',
  view: 'best', tab: 'leaderboard', sort: 'rank', groupBy: 'lineage', frontier: true,
});

export function formatValue(metric, value, withUnit = true) {
  if (value == null) return '—';
  const spec = METRICS[metric];
  return `${Number(value).toFixed(spec.digits)}${withUnit && spec.unit ? ` ${spec.unit}` : ''}`;
}

const isBetter = (metric, a, b) => (METRICS[metric].better === 'higher' ? a > b : a < b);

const haystack = run => [run.run_id, run.experiment_id, run.derived_from, run.engine.name, run.engine.revision, run.hardware,
  run.target_model, run.builder, run.harness, run.evaluation].filter(Boolean).join(' ').toLowerCase();

function matches(run, state, skipFacet) {
  if (!state.includeFailed && run.quality_gate !== 'passed') return false;
  if (state.selfHosting && !run.autonomy.self_hosting) return false;
  if (state.from && run.date < state.from) return false;
  if (state.to && run.date > state.to) return false;
  if (state.query && !haystack(run).includes(state.query.trim().toLowerCase())) return false;
  return FACETS.every(facet => {
    const picked = state.filters[facet.key];
    return facet.key === skipFacet || !picked?.length || picked.includes(facet.read(run));
  });
}

export const filterRuns = (runs, state) => runs.filter(run => matches(run, state));

// Counts for one facet under every other active filter, so the options stay reachable while narrowing.
export function facetCounts(runs, state, facetKey) {
  const facet = FACETS.find(item => item.key === facetKey);
  const counts = new Map();
  for (const run of runs) {
    if (matches(run, state, facetKey)) counts.set(facet.read(run), (counts.get(facet.read(run)) ?? 0) + 1);
  }
  return counts;
}

// Is `run` the better entry to show for its experiment: a passing run beats a failing one, then the better metric, then the later date.
function preferred(metric, run, current) {
  const passed = r => r.quality_gate === 'passed';
  if (passed(run) !== passed(current)) return passed(run);
  if (!passed(run)) return run.date > current.date;
  const [a, b] = [METRICS[metric].read(run), METRICS[metric].read(current)];
  return a === b ? run.date > current.date : isBetter(metric, a, b);
}

export function collapse(runs, metric, view) {
  if (view === 'all') return runs;
  const best = new Map();
  for (const run of runs) {
    const key = `${run.experiment_id}|${run.role}|${run.engine.name}`;
    if (!best.has(key) || preferred(metric, run, best.get(key))) best.set(key, run);
  }
  return [...best.values()];
}

// Competition ranking (1, 2, 2, 4). Runs that failed the quality gate are never ranked.
export function rankRuns(runs, metric) {
  const spec = METRICS[metric];
  const sign = spec.better === 'higher' ? -1 : 1;
  const eligible = runs.filter(run => run.quality_gate === 'passed' && spec.read(run) != null)
    .sort((a, b) => sign * (spec.read(a) - spec.read(b)) || a.date.localeCompare(b.date));
  const ranks = new Map();
  let last;
  let lastRank = 0;
  eligible.forEach((run, index) => {
    if (spec.read(run) !== last) { last = spec.read(run); lastRank = index + 1; }
    ranks.set(run, lastRank);
  });
  return ranks;
}

export function orderRows(runs, ranks, sort) {
  const byDate = (a, b) => b.date.localeCompare(a.date) || a.run_id.localeCompare(b.run_id);
  if (sort === 'date-desc') return [...runs].sort(byDate);
  if (sort === 'date-asc') return [...runs].sort((a, b) => -byDate(a, b));
  const ranked = runs.filter(run => ranks.has(run)).sort((a, b) => ranks.get(a) - ranks.get(b) || byDate(a, b));
  return [...ranked, ...runs.filter(run => !ranks.has(run)).sort(byDate)];
}

export function summarize(runs, metric) {
  const spec = METRICS[metric];
  const passed = runs.filter(run => run.quality_gate === 'passed' && spec.read(run) != null);
  const values = passed.map(spec.read).sort((a, b) => a - b);
  const middle = values.length >> 1;
  const median = !values.length ? null : values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
  const best = passed.reduce((top, run) => (!top || isBetter(metric, spec.read(run), spec.read(top)) ? run : top), null);
  const interventions = runs.map(run => run.autonomy.human_interventions).sort((a, b) => a - b);
  return {
    runs: runs.length,
    experiments: new Set(runs.map(run => run.experiment_id)).size,
    passRate: runs.length ? passed.length / runs.length : null,
    failed: runs.filter(run => run.quality_gate !== 'passed').length,
    best, median,
    medianInterventions: interventions.length ? interventions[interventions.length >> 1] : null,
    selfHosted: new Set(runs.filter(run => run.autonomy.self_hosting).map(run => run.experiment_id)).size,
  };
}

// Distinct conditions in a set of rows. More than one value in any of them makes ranks an uncontrolled comparison.
export function mixedConditions(runs) {
  const counts = {
    hardware: new Set(runs.map(run => run.hardware)).size,
    'target model': new Set(runs.map(run => run.target_model)).size,
    evaluation: new Set(runs.map(run => run.evaluation)).size,
    'comparison track': new Set(runs.map(run => run.comparison_track)).size,
  };
  return Object.entries(counts).filter(([, count]) => count > 1).map(([name, count]) => ({ name, count }));
}

// The most populous hardware, model, and evaluation combination, as filters.
export function largestCohort(runs) {
  const counts = new Map();
  for (const run of runs) {
    const key = JSON.stringify([run.hardware, run.target_model, run.evaluation]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (!top) return {};
  const [hardware, target_model, evaluation] = JSON.parse(top[0]);
  return { hardware: [hardware], target_model: [target_model], evaluation: [evaluation] };
}

// Maps every experiment to the root of its derive chain.
export function lineageRoots(runs) {
  const parents = new Map(runs.map(run => [run.experiment_id, run.derived_from]));
  const roots = new Map();
  for (const experiment of parents.keys()) {
    let root = experiment;
    const seen = new Set();
    while (parents.get(root) && !seen.has(root)) { seen.add(root); root = parents.get(root); }
    roots.set(experiment, root);
  }
  return roots;
}

function groupLabel(run, groupBy, roots) {
  if (groupBy === 'lineage') return `${roots.get(run.experiment_id) ?? run.experiment_id}${run.role === 'baseline' ? ' (baseline)' : ''}`;
  if (groupBy === 'engine') return run.engine.name;
  if (groupBy === 'none') return 'All runs';
  return FACETS.find(facet => facet.key === groupBy).read(run);
}

export function trendSeries(runs, { metric, groupBy, roots, max = 8 }) {
  const readValue = METRICS[metric].read;
  const groups = new Map();
  for (const run of runs) {
    if (readValue(run) == null) continue;
    const label = groupLabel(run, groupBy, roots);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push({ t: Date.parse(`${run.date}T00:00:00Z`), value: readValue(run), run });
  }
  const all = [...groups.entries()].map(([label, points]) => ({ label, points: points.sort((a, b) => a.t - b.t) }))
    .sort((a, b) => b.points.length - a.points.length || a.label.localeCompare(b.label));
  return { series: all.slice(0, max), hidden: Math.max(0, all.length - max) };
}

// Running best over time among runs that passed the quality gate.
export function frontier(runs, metric) {
  const spec = METRICS[metric];
  const points = [];
  for (const run of [...runs].filter(r => r.quality_gate === 'passed' && spec.read(r) != null).sort((a, b) => a.date.localeCompare(b.date))) {
    if (!points.length || isBetter(metric, spec.read(run), points.at(-1).value)) {
      points.push({ t: Date.parse(`${run.date}T00:00:00Z`), value: spec.read(run), run });
    }
  }
  return points;
}

// Best candidate of each derived experiment against the best candidate of its parent. Positive change always means better.
export function deriveDeltas(runs, metric) {
  const spec = METRICS[metric];
  const bestOf = experiment => runs.filter(run => run.experiment_id === experiment && run.role === 'candidate'
    && run.quality_gate === 'passed' && spec.read(run) != null)
    .reduce((top, run) => (!top || isBetter(metric, spec.read(run), spec.read(top)) ? run : top), null);
  const derived = new Map(runs.filter(run => run.derived_from).map(run => [run.experiment_id, run.derived_from]));
  return [...derived.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([experiment, parent]) => {
    const child = bestOf(experiment);
    const base = bestOf(parent);
    const change = child && base && spec.read(base) ? ((spec.read(child) - spec.read(base)) / spec.read(base)) * 100 * (spec.better === 'higher' ? 1 : -1) : null;
    const differs = child && base ? ['hardware', 'evaluation', 'comparison_track'].filter(key => child[key] !== base[key]) : [];
    return { experiment, parent, child, base, change, differs };
  });
}

const FLAGS = { includeFailed: 'failed', selfHosting: 'selfhosted' };

export function stateToHash(state) {
  const defaults = defaultState();
  const params = new URLSearchParams();
  for (const key of ['metric', 'view', 'tab', 'sort', 'groupBy', 'query', 'from', 'to']) {
    if (state[key] !== defaults[key]) params.set(key, state[key]);
  }
  if (state.frontier !== defaults.frontier) params.set('frontier', state.frontier ? '1' : '0');
  for (const [key, name] of Object.entries(FLAGS)) if (state[key]) params.set(name, '1');
  for (const facet of FACETS) for (const value of state.filters[facet.key] ?? []) params.append(`f.${facet.key}`, value);
  return params.toString();
}

export function hashToState(hash) {
  const state = defaultState();
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const choose = (key, allowed) => { const value = params.get(key); if (value && allowed.includes(value)) state[key] = value; };
  choose('metric', Object.keys(METRICS));
  choose('view', ['best', 'all']);
  choose('tab', ['leaderboard', 'trends']);
  choose('sort', ['rank', 'date-desc', 'date-asc']);
  choose('groupBy', Object.keys(GROUPS));
  const date = key => { const value = params.get(key); if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) state[key] = value; };
  date('from');
  date('to');
  state.query = params.get('query') ?? '';
  if (params.has('frontier')) state.frontier = params.get('frontier') === '1';
  for (const [key, name] of Object.entries(FLAGS)) state[key] = params.get(name) === '1';
  for (const facet of FACETS) {
    const values = params.getAll(`f.${facet.key}`);
    if (values.length) state.filters[facet.key] = values;
  }
  return state;
}
