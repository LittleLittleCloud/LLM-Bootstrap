// Resolves an experiment.json (following extends links), lists what a derived experiment changes, and checks the result.
// Usage: node scripts/check-experiment.mjs path/to/experiment.json
// Exit 0: no problems. Exit 1: problems found. Exit 2: usage, unreadable input, or a base that cannot be resolved.
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDerived, resolveExperimentFile } from './resolve-experiment.mjs';
import { errorsOf, loadValidators } from './validators.mjs';

const OWN_FIELDS = ['experiment_id', 'status', 'description', 'contract_frozen_at', 'amends_revision', 'amends_reason'];
const show = value => {
  const text = JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
};

export const unresolvedFields = experiment => Object.entries(experiment).filter(([, value]) => value === null).map(([key]) => key);

export function changesFrom(base, effective) {
  const lines = [];
  for (const [key, value] of Object.entries(effective)) {
    if (!(key in base)) lines.push(`+ ${key}: ${show(value)}`);
    else if (JSON.stringify(base[key]) !== JSON.stringify(value)) lines.push(`~ ${key}: ${show(base[key])} -> ${show(value)}`);
  }
  for (const key of Object.keys(base)) if (!(key in effective)) lines.push(`- ${key}`);
  return lines;
}

async function schemaErrors(experiment) {
  const validators = await loadValidators();
  if (!validators) return null;
  const validate = validators.experiment.Experiment;
  return validate(experiment) ? [] : errorsOf(validate);
}

export async function checkExperiment(path) {
  const out = [];
  const problems = [];
  const file = JSON.parse(readFileSync(path, 'utf8'));
  const effective = resolveExperimentFile(path);
  if (isDerived(file)) {
    const base = resolveExperimentFile(resolve(dirname(path), file.extends_path));
    out.push(`derived from ${file.extends_path} (commit ${file.extends_revision}, sha256 ${file.extends_sha256.slice(0, 12)}...)`);
    const changes = changesFrom(base, effective).filter(line => !OWN_FIELDS.includes(line.slice(2).split(':')[0]));
    out.push(`changes from the base (${changes.length}):`, ...changes.map(line => `  ${line}`));
  } else {
    out.push('base experiment (no extends_path)');
  }
  out.push(`status: ${effective.status}`);

  const unresolved = unresolvedFields(effective);
  if (effective.status === 'frozen' && unresolved.length) {
    problems.push(`a frozen experiment has ${unresolved.length} unresolved fields: ${unresolved.join(', ')}`);
  } else if (unresolved.length) {
    out.push(`unresolved fields (${unresolved.length}): ${unresolved.join(', ')}`);
  }

  const errors = await schemaErrors(effective);
  if (errors === null) out.push('schema: not checked (ajv is not installed; run npm ci in the plugin repository to enable it)');
  else if (errors.length) problems.push(...errors.map(error => `schema: ${error}`));
  else out.push('schema: valid Experiment');
  return { out, problems };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  if (!process.argv[2]) {
    console.error('usage: node check-experiment.mjs <experiment.json>');
    process.exit(2);
  }
  let result;
  try {
    result = await checkExperiment(process.argv[2]);
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(2);
  }
  console.log(result.out.join('\n'));
  for (const problem of result.problems) console.log(`PROBLEM: ${problem}`);
  console.log(result.problems.length ? 'result: not ready' : 'result: no problems found');
  process.exit(result.problems.length ? 1 : 0);
}
