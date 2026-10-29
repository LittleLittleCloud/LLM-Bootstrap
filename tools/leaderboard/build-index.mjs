// Builds the leaderboard index from experiment records.
//
// Usage: node tools/leaderboard/build-index.mjs <repo-root> --out <file> [--synthetic] [--require-validation]
//
// Reads experiments/<id>/runs/<run-id>/run.json (an ExperimentRun) under <repo-root>, the contract it pins, and every
// evaluation result it references. Each pinned file is checked against its recorded sha256. One entry is written for
// each referenced EvaluationResult, so a run that measured a baseline and a candidate yields two entries.
//
// The index is a projection for display. It is not a record: the documents under experiments/ stay authoritative.
// Two rules are leaderboard policy, not schema facts:
//   - quality_gate is "passed" only when the run completed, the numerical check passed, every application task passed,
//     the negative control was verified, and generated programs ran in a restricted environment. It is "failed" when the
//     numerical check failed or a task failed, and "unverified" otherwise. Only "passed" entries are ranked.
//   - Missing values stay null. They are never replaced by zero or inferred (an unavailable intervention log is not "none").
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveContract } from '../../skills/bootstrap-experiment-sop/scripts/resolve-contract.mjs';
import { errorsOf, loadValidators } from '../../skills/bootstrap-experiment-sop/scripts/validators.mjs';

export const INDEX_VERSION = '0.2.0';
const RUN_PATH = /^experiments\/[^/]+\/runs\/[^/]+\/run\.json$/;
const sha256 = text => createHash('sha256').update(text).digest('hex');
// Display precision only; the documents keep the exact ratio of sums.
const numberOrNull = value => (typeof value === 'number' ? Math.round(value * 1e4) / 1e4 : null);
const aggregate = value => (value && typeof value === 'object' ? value : null);
const day = timestamp => new Date(timestamp).toISOString().slice(0, 10);

export class IndexError extends Error {
  constructor(problems) {
    super(`${problems.length} problem(s) building the index:\n- ${problems.join('\n- ')}`);
    this.problems = problems;
  }
}

export function qualityGate(result, runStatus) {
  const { numerical_status: numerical, application } = result.quality;
  if (numerical === 'failed' || application.passed < application.total) return runStatus === 'completed' ? 'failed' : 'unverified';
  const verified = runStatus === 'completed' && numerical === 'passed' && application.negative_control_verified && application.restricted_environment;
  return verified ? 'passed' : 'unverified';
}

// files: Map of repository-relative POSIX path -> file text.
export function buildIndex(files, { synthetic = false, validators = null } = {}) {
  const problems = [];
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

  const loadContract = (path, expectedSha, from, depth) => {
    if (depth > 10) { fail(`${path}: the extends chain is too deep or cyclic`); return null; }
    const text = read(path);
    if (text == null) return null;
    if (sha256(text) !== expectedSha) { fail(`${path} does not match the sha256 pinned in ${from}`); return null; }
    const document = parse(text, path);
    if (!document) return null;
    if (!('extends' in document)) {
      return validate('experiment', 'ExperimentContract', document, path) ? { contract: document, parent: null } : null;
    }
    if (!validate('experiment', 'DerivedExperimentContract', document, path)) return null;
    const basePath = posix.normalize(posix.join(posix.dirname(path), document.extends.path));
    const base = loadContract(basePath, document.extends.sha256, path, depth + 1);
    if (!base) return null;
    try {
      const effective = resolveContract(document, base.contract);
      return validate('experiment', 'ExperimentContract', effective, `${path} (resolved)`)
        ? { contract: effective, parent: base.contract.experiment_id } : null;
    } catch (error) {
      fail(`${path}: ${error.message}`);
      return null;
    }
  };

  const contractCache = new Map();
  const contractFor = (reference, from) => {
    const key = `${reference.path}@${reference.sha256}`;
    if (!contractCache.has(key)) contractCache.set(key, loadContract(reference.path, reference.sha256, from, 0));
    return contractCache.get(key);
  };

  const entries = [];
  const runPaths = [...files.keys()].filter(path => RUN_PATH.test(path)).sort();
  for (const path of runPaths) {
    const run = parse(files.get(path), path);
    if (!run || !validate('experiment', 'ExperimentRun', run, path)) continue;
    // Drafts and runs in progress have no final results to show.
    if (!['completed', 'interrupted'].includes(run.status)) continue;
    const loaded = contractFor(run.contract, path);
    if (!loaded) continue;
    const { contract, parent } = loaded;
    if (contract.status !== 'frozen') { fail(`${run.contract.path} is not frozen, so ${path} cannot be listed`); continue; }

    for (const reference of run.evaluation_results) {
      try {
        const text = read(reference.path);
        if (text == null) continue;
        if (sha256(text) !== reference.sha256) { fail(`${reference.path} does not match the sha256 pinned in ${path}`); continue; }
        const result = parse(text, reference.path);
        if (!result || !validate('evaluation', 'EvaluationResult', result, reference.path)) continue;
        if (result.role !== reference.role || result.engine_name !== reference.engine_name) {
          fail(`${reference.path} does not match the role and engine recorded in ${path}`);
          continue;
        }
        const pinned = contract.evaluation.definition;
        if (['evaluation_id', 'revision', 'sha256'].some(key => result.evaluation[key] !== pinned[key])) {
          fail(`${reference.path} cites a different evaluation than the contract of ${path}`);
          continue;
        }
        const { metrics } = result;
        entries.push({
          entry_id: `${run.run_id}/${result.role}/${result.engine_name}`,
          run_id: run.run_id,
          experiment_id: contract.experiment_id,
          derived_from: parent,
          date: day(run.ended_at ?? run.started_at),
          role: result.role,
          comparison_track: contract.baselines.comparison_track,
          engine: { name: result.engine_name, revision: typeof result.runtime_revision === 'string' ? result.runtime_revision : null },
          hardware: result.environment.hardware_model,
          target_model: contract.target_model.repository,
          weights: contract.target_model.weights,
          builder: result.role === 'candidate' ? contract.builder.model : null,
          harness: `${contract.development_harness.name} ${contract.development_harness.version}`,
          evaluation: result.evaluation.evaluation_id,
          metrics: {
            decode_tok_s: numberOrNull(aggregate(metrics.decode)?.tokens_per_second),
            decode_basis: aggregate(metrics.decode)?.basis ?? null,
            prefill_tok_s: numberOrNull(aggregate(metrics.prefill)?.tokens_per_second),
            prefill_basis: aggregate(metrics.prefill)?.basis ?? null,
            client_ttft_median_s: numberOrNull(metrics.client_ttft_median_seconds),
            application_duration_s: numberOrNull(metrics.application_duration_seconds),
            peak_memory_gib: numberOrNull(result.resources.peak_memory_gib),
            formal_repetitions: metrics.formal_repetitions,
            preliminary: metrics.preliminary,
            requests_reconciled: metrics.requests_reconciled,
          },
          quality_gate: qualityGate(result, run.status),
          quality: {
            numerical_status: result.quality.numerical_status,
            application_passed: result.quality.application.passed,
            application_total: result.quality.application.total,
            negative_control_verified: result.quality.application.negative_control_verified,
          },
          autonomy: {
            human_interventions: Array.isArray(run.human_interventions) ? run.human_interventions.length : null,
            hardware_hours: numberOrNull(run.cost.hardware_hours),
            builder_tokens: numberOrNull(run.cost.builder_tokens),
            elapsed_hours: numberOrNull(run.cost.elapsed_hours),
            self_hosting_status: run.self_hosting.status,
            external_recovery_used: run.self_hosting.external_recovery_used ?? null,
          },
          deviations: result.environment.deviations_from_contract,
          acceptance: run.acceptance,
          run_status: run.status,
          evidence: run.evidence.map(item => (item.access === 'public'
            ? { description: item.description, access: item.access, url: item.url }
            : { description: item.description, access: item.access })),
          source: { run: path, result: reference.path },
        });
      } catch (error) {
        fail(`${reference.path}: ${error.message}`);
      }
    }
  }

  if (problems.length) throw new IndexError(problems);
  entries.sort((a, b) => a.date.localeCompare(b.date) || a.entry_id.localeCompare(b.entry_id));
  return {
    schema_version: INDEX_VERSION,
    synthetic,
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
      const index = buildIndex(loadRecordFiles(root), { synthetic: argv.includes('--synthetic'), validators });
      writeFileSync(out, serializeIndex(index));
      console.log(`wrote ${index.counts.entries} entries from ${index.counts.runs} runs to ${out}`);
      return 0;
    } catch (error) {
      console.error(error instanceof IndexError ? error.message : `error: ${error.message}`);
      return 1;
    }
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exit(await main(process.argv.slice(2)));
