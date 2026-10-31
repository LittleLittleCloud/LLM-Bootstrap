// Builds the leaderboard index from experiment records.
//
// Usage: node tools/leaderboard/build-index.mjs <repo-root> --out <file> [--synthetic] [--require-validation]
//
// Reads experiments/<id>/experiment.json (an Experiment, or a DerivedExperiment that is resolved against its pinned base) and
// every experiments/<id>/evaluation/<YYYYMMDD-HHMMSS>.json (an EvaluationReport) under <repo-root>. A report names no engine or
// machine: the experiment gives the one engine, its commit, and everything else. A report's name is its started_at in UTC.
// One entry is written for each report.
//
// The index is a projection for display. It is not a record: the documents under experiments/ stay authoritative.
// Rules that are leaderboard policy, not schema facts:
//   - Every report is listed, a regression included. The conformance result and the accuracy scores are carried as data; nothing
//     is filtered or ranked out by them.
//   - A report of a reduced profile, or one with an incomplete test, is preliminary.
//   - Missing values stay null. They are never replaced by zero or inferred.
//   - An experiment that pins an evaluation which no longer exists in evaluations/ is history, not a failure: it stays in the
//     repository, its reports are not listed, and they are named in retired_runs so they are never dropped silently.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { headlineMetrics, qualityScores } from '../../evaluations/endpoint-bench/src/report.js';
import { isDerived, resolveExperiment } from '../../skills/bootstrap-experiment-sop/scripts/resolve-experiment.mjs';
import { errorsOf, loadValidators } from '../../skills/bootstrap-experiment-sop/scripts/validators.mjs';

export const INDEX_VERSION = '1.0.0';
const EXPERIMENT_PATH = /^experiments\/([^/]+)\/experiment\.json$/;
const EVALUATION_DIR = /^experiments\/([^/]+)\/evaluation\//;
const EVALUATION_PATH = /^experiments\/([^/]+)\/evaluation\/(\d{8}-\d{6})\.json$/;
const sha256 = text => createHash('sha256').update(text).digest('hex');
// Display precision only; the reports keep the exact values.
const numberOrNull = value => (typeof value === 'number' ? Math.round(value * 1e4) / 1e4 : null);
const day = timestamp => new Date(timestamp).toISOString().slice(0, 10);

// The file name of a report: its started_at in UTC.
export const evaluationStamp = timestamp => new Date(timestamp).toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-');

export class IndexError extends Error {
  constructor(problems) {
    super(`${problems.length} problem(s) building the index:\n- ${problems.join('\n- ')}`);
    this.problems = problems;
  }
}

// files: Map of repository-relative POSIX path -> file text. evaluationIds: ids of the evaluations that exist now, or null to list every report.
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
    const recordPaths = [...files.keys()].filter(path => EVALUATION_DIR.test(path) && path.startsWith(`experiments/${id}/`)).sort();
    for (const path of recordPaths) if (!EVALUATION_PATH.test(path)) fail(`${path} is not named <YYYYMMDD-HHMMSS>.json`);
    // An experiment without reports has nothing to list.
    if (!recordPaths.length) continue;
    const loaded = loadExperiment(experimentPath, files.get(experimentPath), 0);
    if (!loaded) continue;
    const { experiment, parent } = loaded;
    if (experiment.experiment_id !== id) { fail(`${experimentPath} declares experiment_id ${experiment.experiment_id}, not its directory name ${id}`); continue; }
    if (experiment.status !== 'frozen') { fail(`${experimentPath} is not frozen, so its reports cannot be listed`); continue; }
    if (evaluationIds && !evaluationIds.has(experiment.evaluation_id)) { retired.push(...recordPaths); continue; }

    const reports = [];
    for (const path of recordPaths.filter(item => EVALUATION_PATH.test(item))) {
      const [, , stamp] = EVALUATION_PATH.exec(path);
      const report = parse(files.get(path), path);
      if (!report || !validate('evaluation', 'EvaluationReport', report, path)) continue;
      if (evaluationStamp(report.started_at) !== stamp) { fail(`${path} is not named after its started_at (${evaluationStamp(report.started_at)})`); continue; }
      if (['evaluation_id', 'evaluation_revision', 'evaluation_sha256'].some(key => report[key] !== experiment[key])) {
        fail(`${path} cites a different evaluation than ${experimentPath}`);
        continue;
      }
      reports.push({ path, report, stamp });
    }

    for (const { path, report, stamp } of reports) {
      try {
        const metrics = headlineMetrics(report);
        const complete = report.status === 'complete' && report.profile === 'full';
        entries.push({
          entry_id: `${id}/${stamp}`,
          run_id: `${id}/${stamp}`,
          experiment_id: id,
          derived_from: parent,
          date: day(report.started_at),
          comparison_track: experiment.comparison_track,
          engine: { name: experiment.engine_name, revision: experiment.engine_commit },
          hardware: experiment.hardware_platform,
          target_model: experiment.target_repository,
          weights: experiment.target_weights,
          evaluation: report.evaluation_id,
          profile: report.profile,
          endpoint_class: report.endpoint_class,
          context_window: report.context_window,
          metrics: {
            decode_tok_s: numberOrNull(metrics.decode_tokens_per_second_p50),
            prefill_tok_s: numberOrNull(metrics.prefill_tokens_per_second_p50),
            speed_tok_s: numberOrNull(metrics.speed_tokens_per_second_p50),
            ttft_ms: numberOrNull(metrics.speed_ttft_ms_p50),
            cache_hit_pct: numberOrNull(metrics.cache_hit_pct),
            needle_accuracy: numberOrNull(metrics.needle_accuracy),
            thinking_accuracy: numberOrNull(metrics.thinking_accuracy),
            preliminary: !complete,
          },
          quality: {
            conform_passed: metrics.conform_passed === null ? null : metrics.conform_passed === 1,
            benchmarks: qualityScores(report).map(({ benchmark_id, score, stderr, num_samples }) => ({ benchmark_id, score: numberOrNull(score), stderr: numberOrNull(stderr), num_samples })),
          },
          failures: report.failures,
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
      console.log(`wrote ${index.counts.entries} entries from ${index.counts.runs} evaluation reports to ${out}`);
      return 0;
    } catch (error) {
      console.error(error instanceof IndexError ? error.message : `error: ${error.message}`);
      return 1;
    }
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exit(await main(process.argv.slice(2)));
