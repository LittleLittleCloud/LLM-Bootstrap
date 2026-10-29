import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildIndex, loadRecordFiles } from '../tools/leaderboard/build-index.mjs';
import { loadValidators } from '../skills/bootstrap-experiment-sop/scripts/validators.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const ACCEPTED = /^experiments\/[^/]+\/(contract\.json|report\.md|runs\/[^/]+\/(run\.json|(baseline|candidate)-[^/]+\.json))$/;
const MAX_BYTES = 1024 * 1024;

function trackedRecords() {
  try {
    return execFileSync('git', ['ls-files', '--', 'experiments'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean);
  } catch {
    return null;
  }
}
const tracked = trackedRecords();

test('the accepted record files are exactly the documented ones', () => {
  for (const path of [
    'experiments/e1/contract.json', 'experiments/e1/report.md', 'experiments/e1/runs/r1/run.json',
    'experiments/e1/runs/r1/candidate-eng.json', 'experiments/e1/runs/r1/baseline-ref.json',
  ]) assert.match(path, ACCEPTED, path);
  for (const path of [
    'experiments/e1/evidence/log.json', 'experiments/e1/runs/r1/transcript.md', 'experiments/e1/runs/r1/weights.bin',
    'experiments/e1/notes.md', 'experiments/TEMPLATE.md', 'experiments/e1/runs/run.json',
  ]) assert.doesNotMatch(path, ACCEPTED, path);
});

test('committed experiment records validate and build into the leaderboard index', async () => {
  const validators = await loadValidators();
  assert.ok(validators, 'schema validation needs the dev dependencies (npm ci)');
  buildIndex(loadRecordFiles(root), { validators });
});

test('only accepted, small record files are committed, and every experiment has a contract and a report', { skip: tracked === null && 'not a Git checkout' }, () => {
  const byExperiment = new Map();
  for (const path of tracked) {
    assert.match(path, ACCEPTED, `${path} is not an accepted record file (raw evidence and other files stay out of the repository)`);
    assert.ok(statSync(join(root, path)).size <= MAX_BYTES, `${path} is larger than 1 MiB`);
    const id = path.split('/')[1];
    byExperiment.set(id, [...(byExperiment.get(id) ?? []), path.split('/').slice(2).join('/')]);
  }
  for (const [id, paths] of byExperiment) {
    assert.ok(paths.includes('contract.json'), `${id} has no contract.json`);
    assert.ok(paths.includes('report.md'), `${id} has no report.md`);
    assert.ok(paths.some(path => /^runs\/[^/]+\/run\.json$/.test(path)), `${id} has no run record`);
  }
});
