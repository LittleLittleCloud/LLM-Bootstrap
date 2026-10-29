// Resolves a DerivedExperimentContract against its base. Dependency-free; nothing runs this automatically.
// Usage: node schema/resolve-contract.mjs path/to/contract.json
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Declared by the derived contract itself, never inherited or overridden.
const OWN_FIELDS = ['experiment_id', 'status', 'description', 'contract_frozen_at', 'amends'];
const LOCKED_FIELDS = [...OWN_FIELDS, 'target_model'];

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Objects merge by key; arrays, scalars, and null replace.
function merge(base, overrides) {
  if (!isObject(base) || !isObject(overrides)) return structuredClone(overrides);
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(overrides)) {
    result[key] = key in result ? merge(result[key], value) : structuredClone(value);
  }
  return result;
}

export function resolveContract(derived, base) {
  const { extends: _reference, overrides, ...envelope } = derived;
  for (const key of LOCKED_FIELDS) {
    if (key in overrides) throw new Error(`overrides must not contain "${key}"`);
  }
  const effective = merge(base, overrides);
  for (const key of OWN_FIELDS) delete effective[key];
  return { ...effective, ...envelope };
}

// Loads a contract file, following extends links and checking each base file against its pinned hash.
export function resolveContractFile(path) {
  const derived = JSON.parse(readFileSync(path, 'utf8'));
  if (!('extends' in derived)) return derived;
  const basePath = resolve(dirname(path), derived.extends.path);
  const digest = createHash('sha256').update(readFileSync(basePath)).digest('hex');
  if (digest !== derived.extends.sha256) {
    throw new Error(`base ${derived.extends.path} has sha256 ${digest}, expected ${derived.extends.sha256}`);
  }
  return resolveContract(derived, resolveContractFile(basePath));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('usage: node resolve-contract.mjs <contract.json>');
  process.stdout.write(`${JSON.stringify(resolveContractFile(process.argv[2]), null, 2)}\n`);
}
