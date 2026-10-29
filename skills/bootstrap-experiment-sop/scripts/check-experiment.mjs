// Resolves a contract (following extends links), lists what a derived contract changes, and checks the result.
// Usage: node scripts/check-experiment.mjs path/to/contract.json
// Exit 0: no problems. Exit 1: problems found. Exit 2: usage, unreadable input, or a base that cannot be resolved.
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveContractFile } from './resolve-contract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const show = value => {
  const text = JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
};

// Leaf paths follow the merge rules: only objects are descended into; arrays and scalars are leaves.
function leaves(value, prefix = '') {
  if (!isObject(value)) return [[prefix, value]];
  return Object.entries(value).flatMap(([key, child]) => leaves(child, prefix ? `${prefix}.${key}` : key));
}

export function unresolvedPaths(contract) {
  return leaves(contract).filter(([, value]) => value === null).map(([path]) => path);
}

export function changesFrom(base, effective) {
  const before = new Map(leaves(base));
  const after = new Map(leaves(effective));
  const lines = [];
  for (const [path, value] of after) {
    if (!before.has(path)) lines.push(`+ ${path}: ${show(value)}`);
    else if (JSON.stringify(before.get(path)) !== JSON.stringify(value)) {
      lines.push(`~ ${path}: ${show(before.get(path))} -> ${show(value)}`);
    }
  }
  for (const path of before.keys()) if (!after.has(path)) lines.push(`- ${path}`);
  return lines;
}

// The validators are dev dependencies of this repository; an installed plugin has none, so the check is optional.
async function schemaErrors(contract) {
  let Ajv2020;
  let addFormats;
  try {
    ({ default: Ajv2020 } = await import('ajv/dist/2020.js'));
    ({ default: addFormats } = await import('ajv-formats'));
  } catch {
    return null;
  }
  const spec = JSON.parse(readFileSync(resolve(here, '../assets/schema/experiment-protocol.openapi.json'), 'utf8'));
  const defs = JSON.parse(JSON.stringify(spec.components.schemas).replaceAll('#/components/schemas/', () => '#/$defs/'));
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false });
  addFormats(ajv);
  ajv.addSchema({ $id: 'https://llm-bootstrap.invalid/experiment-protocol', $defs: defs });
  const validate = ajv.compile({ $ref: 'https://llm-bootstrap.invalid/experiment-protocol#/$defs/ExperimentContract' });
  return validate(contract) ? [] : validate.errors.map(e => `${e.instancePath || '/'} ${e.message}`);
}

export async function checkExperiment(path) {
  const out = [];
  const problems = [];
  const file = JSON.parse(readFileSync(path, 'utf8'));
  const effective = resolveContractFile(path);
  if ('extends' in file) {
    const base = resolveContractFile(resolve(dirname(path), file.extends.path));
    out.push(`derived from ${file.extends.path} (commit ${file.extends.revision}, sha256 ${file.extends.sha256.slice(0, 12)}...)`);
    const changes = changesFrom(base, effective).filter(line => !/^[+~-] (experiment_id|status|description|contract_frozen_at|amends)\b/.test(line));
    out.push(`changes from the base (${changes.length}):`, ...changes.map(line => `  ${line}`));
    if (JSON.stringify(base.target_model) !== JSON.stringify(effective.target_model)) {
      problems.push('the target model differs from the base; a different model needs a new base experiment');
    }
  } else {
    out.push('base experiment (no extends)');
  }
  out.push(`status: ${effective.status}`);

  const unresolved = unresolvedPaths(effective);
  if (effective.status === 'frozen' && unresolved.length) {
    problems.push(`a frozen contract has ${unresolved.length} unresolved fields: ${unresolved.join(', ')}`);
  } else if (unresolved.length) {
    out.push(`unresolved fields (${unresolved.length}): ${unresolved.join(', ')}`);
  }

  const errors = await schemaErrors(effective);
  if (errors === null) out.push('schema: not checked (ajv is not installed; run npm ci in the plugin repository to enable it)');
  else if (errors.length) problems.push(...errors.map(error => `schema: ${error}`));
  else out.push('schema: valid ExperimentContract');
  return { out, problems };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  if (!process.argv[2]) {
    console.error('usage: node check-experiment.mjs <contract.json>');
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
