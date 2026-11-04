// Generates the leaderboard index from the experiment records of this exact checkout. It is a build artifact and is never committed.
// Usage: node scripts/build-index.mjs [--out <file>]   (defaults to public/data/leaderboard.json)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(site, '..');
const argv = process.argv.slice(2);
const out = resolve(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : `${site}/public/data/leaderboard.json`);

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`error: ${command} ${args.join(' ')} failed${result.error ? `: ${result.error.message}` : ''}`);
    process.exit(result.status ?? 1);
  }
}

// Schema validation needs the repository's own dependencies, which a build rooted at site/ has not installed.
if (!existsSync(resolve(root, 'node_modules', 'ajv'))) run('npm', ['ci'], root);

mkdirSync(dirname(out), { recursive: true });
run('node', [resolve(root, 'tools/leaderboard/build-index.mjs'), root, '--out', out, '--drawings', resolve(dirname(out), 'drawings'), '--require-validation'], root);
