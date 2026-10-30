// Builds the leaderboard index from experiment records.
//
// Usage: node tools/leaderboard/build-index.mjs <repo-root> --out <file> [--synthetic] [--require-validation]
//
// Reads experiments/<id>/experiment.json (an Experiment, or a DerivedExperiment that is resolved against its pinned base) and
// every experiments/<id>/evaluation/<YYYYMMDD-HHMMSS>.json (an EvaluationResult) under <repo-root>. A record pins its experiment.json
// by sha256, a base is pinned by its derived experiment, and a record's name is its started_at in UTC. One entry is written for each
// evaluation record.
//
// The index is a projection for display. It is not a record: the documents under experiments/ stay authoritative.
// Two rules are leaderboard policy, not schema facts:
//   - quality_gate is the intelligence check that the engine still computes the model correctly. It is "passed" only when every
//     benchmark was scored in full, the negative control was verified, generated programs ran in a restricted environment, and,
//     for a candidate, every benchmark score is within two standard errors of the best score of the baselines of the same
//     experiment. A baseline defines that reference, so it passes on verification alone. It is "failed" when a candidate scores
//     lower than that tolerance allows, and "unverified" otherwise. Only "passed" entries are ranked.
//   - Missing values stay null. They are never replaced by zero or inferred (an unavailable intervention log is not "none").
//   - An experiment that pins an evaluation which no longer exists in evaluations/ is history, not a failure: it stays in the
//     repository, its records are not listed, and they are named in retired_runs so they are never dropped silently.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDerived, resolveExperiment } from '../../skills/bootstrap-experiment-sop/scripts/resolve-experiment.mjs';
import { errorsOf, loadValidators } from '../../skills/bootstrap-experiment-sop/scripts/validators.mjs';

export const INDEX_VERSION = '0.5.0';
const EXPERIMENT_PATH = /^experiments\/([^/]+)\/experiment\.json$/;
const EVALUATION_DIR = /^experiments\/([^/]+)\/evaluation\//;
const EVALUATION_PATH = /^experiments\/([^/]+)\/evaluation\/(\d{8}-\d{6})\.json$/;
const sha256 = text => createHash('sha256').update(text).digest('hex');
// Display precision only; the records keep the exact ratio of sums.
const numberOrNull = value => (typeof value === 'number' ? Math.round(value * 1e4) / 1e4 : null);
const day = timestamp => new Date(timestamp).toISOString().slice(0, 10);

// The file name of an evaluation record: its started_at in UTC.
export const evaluationStamp = timestamp => new Date(timestamp).toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-');

export class IndexError extends Error {
  constructor(problems) {
    super(`${problems.length} problem(s) building the index:\n- ${problems.join('\n- ')}`);
    this.problems = problems;
  }
}

// The scored benchmarks of a record, from its flat intelligence.<benchmark>.<field> keys.
export function benchmarksOf(result) {
  const ids = new Set();
  for (const key of Object.keys(result)) {
    const match = /^intelligence\.(.+)\.(metric|score|num_samples|stderr)$/.exec(key);
    if (match) ids.add(match[1]);
  }
  return [...ids].sort().map(id => ({
    benchmark_id: id,
    metric: result[`intelligence.${id}.metric`],
    score: result[`intelligence.${id}.score`],
    num_samples: result[`intelligence.${id}.num_samples`],
    stderr: result[`intelligence.${id}.stderr`],
  }));
}

export function qualityGate(result, baselines = []) {
  const own = benchmarksOf(result);
  if (!own.length || !(result.intelligence_complete && result.negative_control_verified && result.restricted_environment)) return 'unverified';
  if (result.role === 'baseline') return 'passed';
  for (const benchmark of own) {
    const references = baselines.flatMap(baseline => benchmarksOf(baseline).filter(item => item.benchmark_id === benchmark.benchmark_id));
    if (!references.length) return 'unverified';
    const best = references.reduce((a, b) => (b.score > a.score ? b : a));
    const tolerance = Math.max(2 * Math.hypot(benchmark.stderr, best.stderr), 1 / Math.min(benchmark.num_samples, best.num_samples));
    if (benchmark.score < best.score - tolerance) return 'failed';
  }
  return 'passed';
}

const levelMetric = (result, workload, concurrency, metric) => result[`throughput.${workload}.c${concurrency}.${metric}`];
const multiTurnCacheRatio = result => result[Object.keys(result).find(key => /^throughput\.multi-turn\..*\.c\d+\.cache_hit_ratio$/.test(key))];
const basisOrNull = value => (value === 'Not obtained' ? null : value);

// files: Map of repository-relative POSIX path -> file text. evaluationIds: ids of the evaluations that exist now, or null to list every record.
export function buildIndex(files, { synthetic = false, validators = null, evaluationIds = null } = {}) {
  const problems = [];
  const retired = [];
  const fail = message => { problems.push(message); };
  const read = path => {
    if (!files.has(path)) { fail(`missing file ${path}`); return null; }
    return files.get(path);
  };
  const parse = (text, path) => {
    try { return JSON.parse(text); } catch { fail(`${path} is not valid JSON`); return null; }
  };
  const validate = (group, name, document, path) => {
    if (!validators) return true;
    const check = validators[group][name];
    if (check(document)) return true;
    fail(`${path} is not a valid ${name}: ${errorsOf(check).slice(0, 3).join('; ')}`);
    return false;
  };

  // Returns the effective experiment and the id of its base, following extends links.
  const loadExperiment = (path, text, depth) => {
    if (depth > 10) { fail(`${path}: the extends chain is too deep or cyclic`); return null; }
    const document = parse(text, path);
    if (!document) return null;
    if (!isDerived(document)) {
      return validate('experiment', 'Experiment', document, path) ? { experiment: document, parent: null } : null;
    }
    if (!validate('experiment', 'DerivedExperiment', document, path)) return null;
    const basePath = posix.normalize(posix.join(posix.dirname(path), document.extends_path));
    const baseText = read(basePath);
    if (baseText == null) return null;
    if (sha256(baseText) !== document.extends_sha256) { fail(`${basePath} does not match the sha256 pinned in ${path}`); return null; }
    const base = loadExperiment(basePath, baseText, depth + 1);
    if (!base) return null;
    try {
      const effective = resolveExperiment(document, base.experiment);
      return validate('experiment', 'Experiment', effective, `${path} (resolved)`)
        ? { experiment: effective, parent: base.experiment.experiment_id } : null;
    } catch (error) {
      fail(`${path}: ${error.message}`);
      return null;
    }
  };

  const entries = [];
  for (const experimentPath of [...files.keys()].filter(path => EXPERIMENT_PATH.test(path)).sort()) {
    const id = EXPERIMENT_PATH.exec(experimentPath)[1];
    const experimentText = files.get(experimentPath);
    const recordPaths = [...files.keys()].filter(path => EVALUATION_DIR.test(path) && path.startsWith(`experiments/${id}/`)).sort();
    for (const path of recordPaths) if (!EVALUATION_PATH.test(path)) fail(`${path} is not named <YYYYMMDD-HHMMSS>.json`);
    // An experiment without evaluation records has nothing to list.
    if (!recordPaths.length) continue;
    const loaded = loadExperiment(experimentPath, experimentText, 0);
    if (!loaded) continue;
    const { experiment, parent } = loaded;
    if (experiment.experiment_id !== id) { fail(`${experimentPath} declares experiment_id ${experiment.experiment_id}, not its directory name ${id}`); continue; }
    if (experiment.status !== 'frozen') { fail(`${experimentPath} is not frozen, so its evaluation records cannot be listed`); continue; }
    if (evaluationIds && !evaluationIds.has(experiment.evaluation_id)) { retired.push(...recordPaths); continue; }

    const records = [];
    for (const path of recordPaths.filter(item => EVALUATION_PATH.test(item))) {
      const result = parse(files.get(path), path);
      if (!result || !validate('evaluation', 'EvaluationResult', result, path)) continue;
      if (result.experiment_id !== id || result.experiment_sha256 !== sha256(experimentText)) {
        fail(`${experimentPath} does not match the experiment_id and sha256 pinned in ${path}`);
        continue;
      }
      if (evaluationStamp(result.started_at) !== EVALUATION_PATH.exec(path)[2]) {
        fail(`${path} is not named after its started_at (${evaluationStamp(result.started_at)})`);
        continue;
      }
      if (['evaluation_id', 'evaluation_revision', 'evaluation_sha256'].some(key => result[key] !== experiment[key])) {
        fail(`${path} cites a different evaluation than ${experimentPath}`);
        continue;
      }
      records.push({ path, result });
    }
    const baselines = records.filter(item => item.result.role === 'baseline').map(item => item.result);

    for (const { path, result } of records) {
      try {
        const runId = `${id}/${EVALUATION_PATH.exec(path)[2]}`;
        const benchmarks = benchmarksOf(result);
        entries.push({
          entry_id: `${runId}/${result.role}/${result.engine_name}`,
          run_id: runId,
          experiment_id: id,
          derived_from: parent,
          date: day(result.started_at),
          role: result.role,
          comparison_track: experiment.baseline_comparison_track,
          engine: { name: result.engine_name, revision: /^[0-9a-f]{40}$/.test(result.runtime_revision) ? result.runtime_revision : null },
          hardware: result.environment_hardware_model,
          target_model: experiment.target_repository,
          weights: experiment.target_weights,
          builder: result.role === 'candidate' ? experiment.builder_model : null,
          harness: `${experiment.harness_name} ${experiment.harness_version}`,
          evaluation: result.evaluation_id,
          metrics: {
            decode_tok_s: numberOrNull(result.decode_tokens_per_second),
            decode_basis: basisOrNull(result.decode_basis),
            prefill_tok_s: numberOrNull(result.prefill_tokens_per_second),
            prefill_basis: basisOrNull(result.prefill_basis),
            client_ttft_median_s: numberOrNull(result.client_ttft_median_seconds),
            concurrent_output_tok_s: numberOrNull(levelMetric(result, 'concurrency.in512.out64', 8, 'output_tokens_per_second')),
            cache_hit_ratio: numberOrNull(multiTurnCacheRatio(result)),
            peak_memory_gib: numberOrNull(result.peak_memory_gib),
            formal_repetitions: result.formal_passes_succeeded,
            preliminary: result.preliminary,
            requests_reconciled: result.requests_reconciled,
          },
          quality_gate: qualityGate(result, baselines),
          quality: {
            benchmarks: benchmarks.length ? benchmarks.map(({ benchmark_id, score, stderr, num_samples }) => ({ benchmark_id, score: numberOrNull(score), stderr: numberOrNull(stderr), num_samples })) : null,
            complete: benchmarks.length ? result.intelligence_complete : null,
            negative_control_verified: benchmarks.length ? result.negative_control_verified : null,
          },
          autonomy: {
            human_interventions: numberOrNull(result.human_interventions),
            hardware_hours: numberOrNull(result.hardware_hours),
            builder_tokens: numberOrNull(result.builder_tokens),
            elapsed_hours: numberOrNull(result.elapsed_hours),
            self_hosting_status: result.self_hosting_status,
            external_recovery_used: result.self_hosting_external_recovery_used ?? null,
          },
          deviations: result.environment_deviations,
          evidence: [{ description: 'Per-request evidence, referenced by hash and not published', access: 'local-only' }],
          source: { experiment: experimentPath, evaluation: path },
        });
      } catch (error) {
        fail(`${path}: ${error.message}`);
      }
    }
  }

  if (problems.length) throw new IndexError(problems);
  entries.sort((a, b) => a.date.localeCompare(b.date) || a.entry_id.localeCompare(b.entry_id));
  return {
    schema_version: INDEX_VERSION,
    synthetic,
    ...(evaluationIds ? { retired_runs: retired } : {}),
    counts: {
      runs: new Set(entries.map(entry => entry.run_id)).size,
      experiments: new Set(entries.map(entry => entry.experiment_id)).size,
      entries: entries.length,
    },
    entries,
  };
}

// One entry per line, so a change to the data reviews as a readable diff.
export function serializeIndex(index) {
  const { entries, ...head } = index;
  return `${JSON.stringify(head).slice(0, -1)},\n"entries":[\n${entries.map(entry => JSON.stringify(entry)).join(',\n')}\n]}\n`;
}

// Ids of the released evaluations under <root>/evaluations, or null when the directory does not exist (no filtering).
export function loadEvaluationIds(root) {
  const base = join(root, 'evaluations');
  if (!existsSync(base)) return null;
  const ids = new Set();
  for (const name of readdirSync(base)) {
    const path = join(base, name, 'evaluation.json');
    if (existsSync(path) && JSON.parse(readFileSync(path, 'utf8')).status === 'released') ids.add(name);
  }
  return ids;
}

// Loads every JSON file under <root>/experiments into a Map keyed by repository-relative POSIX path.
export function loadRecordFiles(root) {
  const files = new Map();
  const walk = relative => {
    for (const name of readdirSync(join(root, relative))) {
      const next = posix.join(relative, name);
      if (statSync(join(root, next)).isDirectory()) walk(next);
      else if (name.endsWith('.json')) files.set(next, readFileSync(join(root, next), 'utf8'));
    }
  };
  if (existsSync(join(root, 'experiments'))) walk('experiments');
  return files;
}

function main(argv) {
  const root = argv[0];
  const out = argv[argv.indexOf('--out') + 1];
  if (!root || argv.indexOf('--out') < 0 || !out) {
    console.error('usage: node build-index.mjs <repo-root> --out <file> [--synthetic] [--require-validation]');
    return 2;
  }
  return loadValidators().then(validators => {
    if (!validators) {
      if (argv.includes('--require-validation')) { console.error('error: schema validation is required but ajv is not installed (run npm ci)'); return 2; }
      console.error('warning: ajv is not installed, so documents are not validated against the schemas');
    }
    try {
      const index = buildIndex(loadRecordFiles(root), { synthetic: argv.includes('--synthetic'), validators, evaluationIds: loadEvaluationIds(root) });
      writeFileSync(out, serializeIndex(index));
      console.log(`wrote ${index.counts.entries} entries from ${index.counts.runs} evaluation records to ${out}`);
      return 0;
    } catch (error) {
      console.error(error instanceof IndexError ? error.message : `error: ${error.message}`);
      return 1;
    }
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exit(await main(process.argv.slice(2)));
