import { useState } from 'react';
import { Trends } from './Trends.jsx';
import {
  FACETS, METRICS, collapse, defaultState, filterRuns, formatValue, largestCohort, mixedConditions, rankRuns, orderRows, unrankedReason, conformance,
} from './lib/model.js';

const PAGE = 15;
const SELECTS = ['hardware', 'target_model', 'evaluation'];
const CONFORM = { passed: ['good', 'Conforms'], failed: ['bad', 'Fails conform'], unchecked: ['warn', 'Unchecked'] };

function Select({ label, value, onChange, options }) {
  return (
    <label className="select">
      <span>{label}</span>
      <select value={value} onChange={event => onChange(event.target.value)}>
        <option value="">All</option>
        {options.map(([key, text]) => <option key={key} value={key}>{text ?? key}</option>)}
      </select>
    </label>
  );
}

export function Board({ runs, state, patch, setState }) {
  const [shown, setShown] = useState(PAGE);
  const filtered = filterRuns(runs, state);
  const rows = collapse(filtered, state.metric, state.view);
  const mixed = mixedConditions(state.tab === 'trends' ? filtered : rows, state.metric);
  const filterBy = key => value => {
    const filters = { ...state.filters };
    if (value) filters[key] = [value]; else delete filters[key];
    patch({ filters });
    setShown(PAGE);
  };
  if (!runs.length) return <main className="band board"><p className="empty">No results have been submitted yet.</p></main>;
  const dirty = Boolean(state.query || state.from || state.to || Object.keys(state.filters).length);

  return (
    <main className="band board">
      <div className="controls">
        <div className="seg" role="tablist" aria-label="View">
          {['leaderboard', 'trends'].map(tab => (
            <button key={tab} type="button" role="tab" aria-selected={state.tab === tab} onClick={() => patch({ tab })}>
              {tab === 'leaderboard' ? 'Leaderboard' : 'Trends'}
            </button>
          ))}
        </div>
        <label className="select">
          <span>Metric</span>
          <select value={state.metric} onChange={event => patch({ metric: event.target.value, sort: 'rank' })}>
            {Object.entries(METRICS).map(([key, spec]) => <option key={key} value={key}>{spec.label}</option>)}
          </select>
        </label>
        {SELECTS.map(key => {
          const facet = FACETS.find(item => item.key === key);
          const picked = state.filters[key];
          return (
            <Select key={key} label={facet.label} value={picked?.length === 1 ? picked[0] : ''} onChange={filterBy(key)}
              options={[...new Set(runs.map(facet.read))].sort().map(value => [value])} />
          );
        })}
        <input className="search" type="search" placeholder="Search" value={state.query} aria-label="Search"
          onChange={event => { patch({ query: event.target.value }); setShown(PAGE); }} />
        {dirty && (
          <button type="button" className="text" onClick={() => setState(current => ({ ...defaultState(), metric: current.metric, tab: current.tab, groupBy: current.groupBy }))}>
            Reset
          </button>
        )}
      </div>

      {mixed.length > 0 && (
        <p className="notice">
          Mixed {mixed.map(item => item.name).join(', ')}. Ranks are not a controlled comparison.
          <button type="button" className="text" onClick={() => patch({ filters: largestCohort(filtered, state.metric) })}>Largest cohort</button>
        </p>
      )}

      {state.tab === 'trends'
        ? <Trends runs={runs} filtered={filtered} state={state} patch={patch} />
        : <Table rows={rows} state={state} shown={shown} onMore={() => setShown(shown + PAGE)} />}
    </main>
  );
}

function Table({ rows, state, shown, onMore }) {
  const spec = METRICS[state.metric];
  const ranks = rankRuns(rows, state.metric);
  const ordered = orderRows(rows, ranks, state.sort);
  if (!ordered.length) return <p className="empty">No runs match.</p>;
  const lead = ordered.find(run => ranks.has(run));
  const best = lead && spec.read(lead);
  const fill = run => {
    const value = spec.read(run);
    if (!ranks.has(run) || !best) return 0;
    return Math.max(0.02, spec.better === 'higher' ? value / best : best / value);
  };

  return (
    <>
      <ol className="rows">
        <li className="head" aria-hidden="true">
          <span>#</span><span>Experiment</span><span>Setup</span><span>{spec.label}</span><span>Conformance</span><span>Date</span>
        </li>
        {ordered.slice(0, shown).map(run => {
          const rank = ranks.get(run);
          const [tone, gate] = CONFORM[conformance(run)];
          return (
            <li key={run.entry_id} className={rank ? '' : 'unranked'} title={unrankedReason(run, state.metric) ?? undefined}>
              <span className="rank">{rank ?? '—'}</span>
              <span className="name">
                <strong>{run.experiment_id}</strong>
                <small>
                  {run.engine.name}{run.engine.revision ? ` · ${run.engine.revision.slice(0, 7)}` : ''}
                  {run.comparison_track !== 'matched-configuration' && <em>best permitted</em>}
                  {run.metrics.preliminary && <em title="A reduced profile or an incomplete test">preliminary</em>}
                </small>
              </span>
              <span className="setup">{run.hardware}<small>{run.target_model} · {run.weights}</small></span>
              <span className="metric">
                <b>{formatValue(state.metric, spec.read(run), false)}</b>
                <i style={{ '--fill': fill(run) }} />
              </span>
              <span className={`gate ${tone}`}><u />{gate}</span>
              <span className="date">{run.date}</span>
            </li>
          );
        })}
      </ol>
      {ordered.length > shown && <button type="button" className="more" onClick={onMore}>{ordered.length - shown} more</button>}
    </>
  );
}
