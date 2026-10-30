// Resolves a derived experiment.json against its base. Dependency-free; nothing runs this automatically.
// Usage: node scripts/resolve-experiment.mjs path/to/experiment.json
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Declared by the derived experiment itself, never inherited.
const OWN_FIELDS = ['experiment_id', 'status', 'description', 'contract_frozen_at', 'amends_revision', 'amends_reason'];
const REFERENCE_FIELDS = ['extends_path', 'extends_revision', 'extends_sha256'];

export const isDerived = document => 'extends_path' in document;

const pick = (document, keys) => Object.fromEntries(keys.filter(key => key in document).map(key => [key, document[key]]));
const omit = (document, keys) => Object.fromEntries(Object.entries(document).filter(([key]) => !keys.includes(key)));

// The documents are flat, so an override is a field of the same name that replaces the base value.
export function resolveExperiment(derived, base) {
  const overrides = omit(derived, [...OWN_FIELDS, ...REFERENCE_FIELDS]);
  for (const key of Object.keys(overrides)) {
    if (key.startsWith('target_')) throw new Error(`a derived experiment must not override "${key}"; a different target model needs a new base experiment`);
  }
  return structuredClone({ ...pick(derived, OWN_FIELDS), ...omit(base, OWN_FIELDS), ...overrides });
}

// Loads an experiment file, following extends links and checking each base file against its pinned hash.
export function resolveExperimentFile(path) {
  const derived = JSON.parse(readFileSync(path, 'utf8'));
  if (!isDerived(derived)) return derived;
  const basePath = resolve(dirname(path), derived.extends_path);
  const digest = createHash('sha256').update(readFileSync(basePath)).digest('hex');
  if (digest !== derived.extends_sha256) {
    throw new Error(`base ${derived.extends_path} has sha256 ${digest}, expected ${derived.extends_sha256}`);
  }
  return resolveExperiment(derived, resolveExperimentFile(basePath));
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  if (!process.argv[2]) throw new Error('usage: node resolve-experiment.mjs <experiment.json>');
  process.stdout.write(`${JSON.stringify(resolveExperimentFile(process.argv[2]), null, 2)}\n`);
}
