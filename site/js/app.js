import {
  FACETS, GROUPS, METRICS, collapse, deriveDeltas, defaultState, facetCounts, filterRuns, formatValue, frontier,
  hashToState, largestCohort, lineageRoots, mixedConditions, orderRows, rankRuns, stateToHash, summarize, trendSeries, unrankedReason,
} from './model.js';
import { lineChart, marker, styleFor } from './chart.js';

const $ = id => document.getElementById(id);
// Data only ever reaches the page as text nodes and attributes, never as markup.
const h = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'class') node.className = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter(child => child != null && child !== false));
  return node;
};

let runs = [];
let state = hashToState(location.hash);
let shown = 25;
let synthetic = false;
const hiddenSeries = new Set();
const PAGE = 25;

// The index built from real experiment records wins over the synthetic demo index when both exist.
async function fetchIndex() {
  for (const url of ['data/leaderboard.json', 'data/leaderboard.mock.json']) {
    const response = await fetch(url);
    if (response.ok) return response.json();
  }
  throw new Error('no leaderboard index was found');
}

async function load() {
  let data;
  try {
    data = await fetchIndex();
    runs = data.entries;
    synthetic = data.synthetic === true;
  } catch (error) {
    $('panel-leaderboard').replaceChildren(h('p', { class: 'empty-state' },
      `Could not load the run data (${error.message}). Serve this folder over HTTP instead of opening the file directly.`));
    return;
  }
  if (synthetic) {
    $('banner').hidden = false;
    $('banner').textContent = 'Demo with synthetic data. Every number on this page is made up and says nothing about any real engine, model, or hardware.';
  }
  $('metric').replaceChildren(...Object.entries(METRICS).map(([key, spec]) => h('option', { value: key }, `${spec.label} (${spec.better} is better)`)));
  $('group').replaceChildren(...Object.entries(GROUPS).map(([key, label]) => h('option', { value: key }, label)));
  bind();
  const wanted = new URLSearchParams(location.hash.slice(1)).get('entry');
  update();
  const linked = runs.find(run => run.entry_id === wanted);
  if (linked) openDetail(linked);
}

function bind() {
  const set = (key, read) => event => { state = { ...state, [key]: read(event.target) }; update(); };
  $('query').addEventListener('input', set('query', input => input.value));
  $('from').addEventListener('change', set('from', input => input.value));
  $('to').addEventListener('change', set('to', input => input.value));
  $('failed').addEventListener('change', set('includeNotPassed', input => input.checked));
  $('selfhosted').addEventListener('change', set('selfHosting', input => input.checked));
  $('metric').addEventListener('change', event => { state = { ...state, metric: event.target.value, sort: 'rank' }; update(); });
  $('view').addEventListener('change', set('view', input => input.value));
  $('group').addEventListener('change', set('groupBy', input => input.value));
  $('frontier').addEventListener('change', set('frontier', input => input.checked));
  for (const tab of document.querySelectorAll('[data-tab]')) {
    tab.addEventListener('click', () => { state = { ...state, tab: tab.dataset.tab }; update(); });
  }
  $('reset').addEventListener('click', () => {
    const { metric, view, tab, sort, groupBy, frontier: showFrontier } = state;
    state = { ...defaultState(), metric, view, tab, sort, groupBy, frontier: showFrontier };
    update();
  });
  const dialog = $('detail');
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
}

function update() {
  shown = PAGE;
  const hash = stateToHash(state);
  history.replaceState(null, '', hash ? `#${hash}` : `${location.pathname}${location.search}`);
  syncControls();
  renderFacets();
  render();
}

function render() {
  const filtered = filterRuns(runs, state);
  const rows = collapse(filtered, state.metric, state.view);
  renderNotice(state.tab === 'leaderboard' ? rows : filtered, state.tab === 'leaderboard' ? 'Ranks' : 'Trends');
  renderCards();
  if (state.tab === 'leaderboard') renderLeaderboard(rows);
  else renderTrends(filtered);
}

function syncControls() {
  if ($('query').value !== state.query) $('query').value = state.query;
  $('from').value = state.from;
  $('to').value = state.to;
  $('failed').checked = state.includeNotPassed;
  $('selfhosted').checked = state.selfHosting;
  $('metric').value = state.metric;
  $('view').value = state.view;
  $('group').value = state.groupBy;
  $('frontier').checked = state.frontier;
  const leaderboard = state.tab === 'leaderboard';
  $('view-wrap').hidden = !leaderboard;
  $('group-wrap').hidden = leaderboard;
  $('frontier-wrap').hidden = leaderboard;
  $('panel-leaderboard').hidden = !leaderboard;
  $('panel-trends').hidden = leaderboard;
  for (const tab of document.querySelectorAll('[data-tab]')) {
    tab.setAttribute('aria-selected', String(tab.dataset.tab === state.tab));
    tab.tabIndex = tab.dataset.tab === state.tab ? 0 : -1;
  }
}

function renderFacets() {
  const focused = document.activeElement?.dataset?.fid;
  $('facets').replaceChildren(...FACETS.map(facet => {
    const counts = facetCounts(runs, state, facet.key);
    const picked = state.filters[facet.key] ?? [];
    const values = [...new Set(runs.map(run => facet.read(run)))].sort();
    return h('fieldset', {},
      h('legend', {}, facet.label),
      values.map(value => {
        const count = counts.get(value) ?? 0;
        const id = `${facet.key}:${value}`;
        return h('label', { class: `check${count || picked.includes(value) ? '' : ' empty'}` },
          h('input', {
            type: 'checkbox', 'data-fid': id, checked: picked.includes(value), disabled: !count && !picked.includes(value),
            onchange: event => toggle(facet.key, value, event.target.checked),
          }),
          h('span', { class: 'label' }, value),
          h('span', { class: 'count' }, String(count)));
      }));
  }));
  if (focused) $('facets').querySelector(`[data-fid="${CSS.escape(focused)}"]`)?.focus();
}

function toggle(key, value, on) {
  const next = new Set(state.filters[key] ?? []);
  if (on) next.add(value); else next.delete(value);
  const filters = { ...state.filters, [key]: [...next] };
  if (!next.size) delete filters[key];
  state = { ...state, filters };
  update();
}

function renderNotice(rows, subject) {
  const mixed = mixedConditions(rows, state.metric);
  const notice = $('notice');
  notice.hidden = !mixed.length;
  if (!mixed.length) return;
  notice.replaceChildren(
    `This view mixes ${mixed.map(item => `${item.count} ${item.name} values`).join(', ')}. ${subject} across different conditions are not a controlled comparison.`,
    h('button', { type: 'button', class: 'link', onclick: () => {
      state = { ...state, filters: largestCohort(filterRuns(runs, state), state.metric) };
      update();
    } }, 'Compare only the largest cohort'));
}

function renderCards() {
  const spec = METRICS[state.metric];
  const summary = summarize(filterRuns(runs, { ...state, includeNotPassed: true }), state.metric);
  const card = (key, value, sub) => h('div', { class: 'card' }, h('div', { class: 'k' }, key), h('div', { class: 'v' }, value), h('div', { class: 's' }, sub));
  $('cards').replaceChildren(
    card('Runs in view', String(summary.runs), `${summary.experiments} experiments`),
    card(`Best ${spec.label}`, formatValue(state.metric, summary.best && spec.read(summary.best)),
      summary.best ? `${summary.best.experiment_id} · ${summary.best.engine.name}` : 'No run passed the quality gate'),
    card(`Median ${spec.label}`, formatValue(state.metric, summary.median), 'Runs that passed the quality gate'),
    card('Quality gate pass rate', summary.passRate == null ? '—' : `${Math.round(summary.passRate * 100)}%`, `${summary.notPassed} not passed`),
    card('Human interventions', summary.medianInterventions == null ? '—' : String(summary.medianInterventions), `median per run · ${summary.selfHosted} self-hosted experiments`),
  );
}

const CORE = ['decode_tok_s', 'client_ttft_median_s', 'peak_memory_gib', 'human_interventions'];
const BASIS_LABEL = {
  'n-minus-1-intervals': 'N−1 intervals', 'native-command-timing': 'native command', 'native-speculative-multi-token': 'native speculative',
  'processed-input-tokens': 'input tokens',
};
const BASIS_KEY = { decode_tok_s: 'decode_basis', prefill_tok_s: 'prefill_basis' };
const heading = key => `${METRICS[key].label}${METRICS[key].unit && !METRICS[key].label.includes(METRICS[key].unit) ? ` (${METRICS[key].unit})` : ''}`;

const scoreText = run => (run.quality.benchmarks ? run.quality.benchmarks.map(item => `${item.benchmark_id} ${(100 * item.score).toFixed(1)}%`).join(', ') : 'not obtained');

function renderLeaderboard(collapsed) {
  const ranks = rankRuns(collapsed, state.metric);
  const rows = orderRows(collapsed, ranks, state.sort);
  const panel = $('panel-leaderboard');
  if (!rows.length) {
    panel.replaceChildren(h('div', { class: 'empty-state' }, 'No runs match these filters. ', h('button', { type: 'button', class: 'link', onclick: () => $('reset').click() }, 'Reset filters')));
    return;
  }
  const metrics = CORE.includes(state.metric) ? CORE : [...CORE, state.metric];
  const sortBy = state.sort;
  const headSort = key => {
    if (key === 'date') return sortBy === 'date-desc' ? 'descending' : sortBy === 'date-asc' ? 'ascending' : null;
    return key === state.metric && sortBy === 'rank' ? (METRICS[key].better === 'higher' ? 'descending' : 'ascending') : null;
  };
  const th = (label, key, onclick, cls = '') => h('th', { class: cls, scope: 'col', 'aria-sort': headSort(key) }, h('button', { type: 'button', onclick }, label));
  const setMetric = key => () => { state = { ...state, metric: key, sort: 'rank' }; update(); };
  const head = h('tr', {},
    th('Rank', 'rank', () => { state = { ...state, sort: 'rank' }; update(); }),
    h('th', { scope: 'col' }, 'Experiment'),
    h('th', { scope: 'col' }, 'Hardware and model'),
    h('th', { scope: 'col' }, 'Builder and harness'),
    metrics.map(key => th(heading(key), key, setMetric(key), 'num')),
    h('th', { scope: 'col' }, 'Gate'),
    th('Date', 'date', () => { state = { ...state, sort: sortBy === 'date-desc' ? 'date-asc' : 'date-desc' }; update(); }));

  const body = rows.slice(0, shown).map(run => {
    const rank = ranks.get(run);
    const reason = unrankedReason(run, state.metric);
    const gate = { passed: ['good', '\u2713'], failed: ['bad', '\u2717'], unverified: ['', '?'] }[run.quality_gate];
    const sub = key => (BASIS_KEY[key] && run.metrics[BASIS_KEY[key]] ? h('span', { class: 'sub' }, BASIS_LABEL[run.metrics[BASIS_KEY[key]]]) : null);
    return h('tr', { class: rank ? '' : 'unranked', onclick: () => openDetail(run) },
      h('td', { class: 'rank', title: reason }, rank ? String(rank) : '\u2014'),
      h('td', { class: 'exp' },
        h('button', { type: 'button', class: 'link', onclick: event => { event.stopPropagation(); openDetail(run); } }, run.experiment_id),
        h('span', { class: 'badges' },
          run.role === 'baseline' ? h('span', { class: 'badge' }, 'baseline') : null,
          run.comparison_track !== 'matched-configuration' ? h('span', { class: 'badge' }, 'best-permitted') : null,
          run.autonomy.self_hosting_status === 'demonstrated' ? h('span', { class: 'badge' }, 'self-hosted') : null,
          run.metrics.preliminary ? h('span', { class: 'badge', title: 'A single cohort is preliminary evidence' }, 'preliminary') : null,
          run.deviations.length ? h('span', { class: 'badge', title: run.deviations.join('; ') }, 'deviations') : null,
          synthetic ? h('span', { class: 'badge mock' }, 'mock') : null),
        h('span', { class: 'sub' }, `${run.engine.name}${run.engine.revision ? ` \u00b7 ${run.engine.revision.slice(0, 7)}` : ''}${run.derived_from ? ` \u00b7 derived from ${run.derived_from}` : ''}`)),
      h('td', {}, run.hardware, h('span', { class: 'sub' }, `${run.target_model} (${run.weights}) \u00b7 ${run.evaluation}`)),
      h('td', {}, run.builder ?? '\u2014', h('span', { class: 'sub' }, run.harness)),
      metrics.map(key => h('td', { class: `num${key === state.metric ? ' hot' : ''}` }, formatValue(key, METRICS[key].read(run), false), sub(key))),
      h('td', { class: `gate ${gate[0]}`, title: `${run.quality_gate}: ${scoreText(run)}` }, gate[1]),
      h('td', { class: 'date' }, run.date));
  });

  panel.replaceChildren(
    h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, head), h('tbody', {}, body))),
    rows.length > shown ? h('button', { type: 'button', class: 'more', onclick: () => { shown += PAGE; render(); } }, `Show more (${rows.length - shown} left)`) : null);
}

function renderTrends(filtered) {
  const spec = METRICS[state.metric];
  const roots = lineageRoots(runs);
  const { series, hidden } = trendSeries(filtered, { metric: state.metric, groupBy: state.groupBy, roots });
  const styled = series.map((item, index) => ({ ...item, ...styleFor(index) }));
  const visible = styled.filter(item => !hiddenSeries.has(item.label));
  const best = state.frontier ? frontier(filtered, state.metric) : [];
  const digits = value => Number(value).toFixed(spec.digits);
  const chart = lineChart({
    series: visible, frontier: best, connect: ['lineage', 'engine'].includes(state.groupBy), format: digits,
    formatPoint: value => formatValue(state.metric, value),
    describe: `${spec.label} over time for ${visible.length} groups`, onSelect: openDetail,
  });
  const legend = h('ul', { class: 'legend' }, styled.map(item => h('li', {},
    h('button', { type: 'button', 'aria-pressed': String(!hiddenSeries.has(item.label)), onclick: () => {
      if (hiddenSeries.has(item.label)) hiddenSeries.delete(item.label); else hiddenSeries.add(item.label);
      render();
    } }, swatch(item), `${item.label} (${item.points.length})`))));
  const notes = [
    state.frontier ? 'The dashed line is the best passing result so far.' : null,
    state.includeNotPassed ? 'Hollow markers did not pass the quality gate.' : null,
    hidden ? `${hidden} smaller groups are not shown; narrow the filters or change the grouping.` : null,
  ].filter(Boolean).join(' ');
  $('panel-trends').replaceChildren(
    h('div', { class: 'chart-card' },
      h('h2', {}, `${spec.label} over time (${spec.better} is better)`),
      chart ?? h('p', { class: 'empty-state' }, 'No runs to plot with these filters.'),
      legend, notes ? h('p', { class: 'legend-note' }, notes) : null),
    deriveTable(filtered));
}

function swatch(item) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 14 14');
  svg.setAttribute('aria-hidden', 'true');
  svg.append(marker(item.shape, 7, 7, 4.5, { fill: item.color }));
  return svg;
}

function deriveTable(filtered) {
  const deltas = deriveDeltas(filtered, state.metric);
  if (!deltas.length) return null;
  const spec = METRICS[state.metric];
  const cell = run => (run ? formatValue(state.metric, spec.read(run)) : '—');
  return h('div', { class: 'derive' },
    h('h2', {}, 'Derived experiments against their base'),
    h('p', {}, 'Best passing candidate run of each. Results are not inherited, so a change is a controlled comparison only when the conditions match.'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Derived experiment', 'Base', 'Base best', 'Derived best', 'Change'].map((label, index) => h('th', { scope: 'col', class: index > 1 ? 'num' : '' }, label)))),
      h('tbody', {}, deltas.map(item => h('tr', {},
        h('td', {}, item.experiment), h('td', {}, item.parent),
        h('td', { class: 'num' }, cell(item.base)), h('td', { class: 'num' }, cell(item.child)),
        h('td', { class: `num ${item.change == null ? '' : item.change >= 0 ? 'good' : 'bad'}` },
          item.change == null ? '—' : `${item.change >= 0 ? '▲ +' : '▼ '}${item.change.toFixed(1)}% ${item.change >= 0 ? 'better' : 'worse'}`,
          item.differs.length ? h('span', { class: 'badge', title: 'The compared runs differ in these conditions' }, `differs: ${item.differs.join(', ')}`) : null)))))));
}

function openDetail(run) {
  const parents = new Map(runs.map(item => [item.experiment_id, item.derived_from]));
  const chain = [run.experiment_id];
  while (parents.get(chain[0]) && chain.length < 20) chain.unshift(parents.get(chain[0]));
  const count = value => (value == null ? 'not recorded' : String(value));
  const evidence = h('ul', {}, run.evidence.map(item => h('li', {},
    item.access === 'public' && item.url.startsWith('https://')
      ? h('a', { href: item.url, target: '_blank', rel: 'noopener noreferrer' }, item.description) : item.description,
    ` (${item.access})`)));
  const rows = [
    ['Experiment', run.experiment_id], ['Lineage', chain.join(' \u2192 ')], ['Run', `${run.run_id} (${run.run_status}, acceptance ${run.acceptance})`],
    ['Role and track', `${run.role}, ${run.comparison_track}`], ['Date', run.date],
    ['Engine', run.engine.name], ['Runtime revision', run.engine.revision ?? 'unavailable'],
    ['Hardware', run.hardware], ['Target model', `${run.target_model} (${run.weights})`], ['Builder LLM', run.builder ?? 'n/a (baseline)'],
    ['Development harness', run.harness], ['Evaluation', run.evaluation],
    ...Object.keys(METRICS).map(key => [METRICS[key].label, formatValue(key, METRICS[key].read(run))]),
    ['Decode timing basis', run.metrics.decode_basis ? BASIS_LABEL[run.metrics.decode_basis] : 'not obtained'],
    ['Prefill timing basis', run.metrics.prefill_basis ? BASIS_LABEL[run.metrics.prefill_basis] : 'not obtained'],
    ['Formal repetitions', `${run.metrics.formal_repetitions}${run.metrics.preliminary ? ' (preliminary)' : ''}`],
    ['Requests reconciled', run.metrics.requests_reconciled ? 'yes' : 'no'],
    ['Intelligence gate', `${run.quality_gate}: ${scoreText(run)}; negative control ${run.quality.negative_control_verified ? 'verified' : 'not verified'}`],
    ['Builder tokens', count(run.autonomy.builder_tokens)], ['Elapsed hours', count(run.autonomy.elapsed_hours)],
    ['Self-hosting', `${run.autonomy.self_hosting_status}${run.autonomy.external_recovery_used ? ' (external recovery used)' : ''}`],
    ['Deviations', run.deviations.length ? run.deviations.join('; ') : 'none recorded'],
    ['Source', `${run.source.run}`],
  ];
  const dialog = $('detail');
  dialog.replaceChildren(
    h('h2', { id: 'detail-title' }, run.entry_id),
    synthetic ? h('p', {}, h('span', { class: 'badge mock' }, 'Synthetic data')) : null,
    h('dl', {}, rows.flatMap(([key, value]) => [h('dt', {}, key), h('dd', {}, String(value))]), h('dt', {}, 'Evidence'), h('dd', {}, evidence)),
    h('div', { class: 'dialog-actions' }, h('button', { type: 'button', onclick: () => dialog.close() }, 'Close')));
  dialog.showModal();
}

load();
