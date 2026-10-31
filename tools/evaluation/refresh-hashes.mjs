// Refreshes the content hashes in evaluations/<id>/evaluation.json after a script or bundled dataset changes.
// Usage: node tools/evaluation/refresh-hashes.mjs <evaluation-id>
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const id = process.argv[2];
if (!id) {
  console.error('usage: node tools/evaluation/refresh-hashes.mjs <evaluation-id>');
  process.exit(2);
}
const directory = join(root, 'evaluations', id);
const file = join(directory, 'evaluation.json');
const definition = JSON.parse(readFileSync(file, 'utf8'));
const hash = path => createHash('sha256').update(readFileSync(join(directory, path))).digest('hex');

for (const script of definition.scripts) script.sha256 = hash(script.path);
for (const dataset of Array.isArray(definition.datasets) ? definition.datasets : []) {
  if (dataset.source === 'bundled') for (const entry of dataset.files) entry.sha256 = hash(entry.path);
}
writeFileSync(file, `${JSON.stringify(definition, null, 2)}\n`);
console.log(`refreshed ${definition.scripts.length} script hashes in ${file}`);
