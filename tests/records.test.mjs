import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildIndex, loadEvaluationIds, loadRecordFiles } from '../tools/leaderboard/build-index.mjs';
import { loadValidators } from '../skills/bootstrap-experiment-sop/scripts/validators.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const ACCEPTED = /^experiments\/[^/]+\/(experiment\.json|evaluation\/\d{8}-\d{6}\.json)$/;
const MAX_BYTES = 1024 * 1024;

function trackedRecords() {
  try {
    return execFileSync('git', ['ls-files', '--', 'experiments'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').filter(path => path && existsSync(join(root, path)));
  } catch {
    return null;
  }
}
const tracked = trackedRecords();

test('the accepted record files are exactly the documented ones', () => {
  for (const path of [
    'experiments/e1/experiment.json', 'experiments/e1/evaluation/20261028-080000.json',
  ]) assert.match(path, ACCEPTED, path);
  for (const path of [
    'experiments/e1/contract.json', 'experiments/e1/report.md', 'experiments/e1/runs/r1/run.json',
    'experiments/e1/evidence/20261028-080000.requests.evidence', 'experiments/e1/evaluation/20261028:080000.json',
    'experiments/e1/evaluation/notes.json', 'experiments/e1/evaluation/20261028-080000.requests.evidence',
    'experiments/e1/evaluation/sub/20261028-080000.json', 'experiments/e1/notes.md', 'experiments/TEMPLATE.md', 'experiments/experiment.json',
  ]) assert.doesNotMatch(path, ACCEPTED, path);
});

test('committed experiment records validate and build into the leaderboard index', async () => {
  const validators = await loadValidators();
  assert.ok(validators, 'schema validation needs the dev dependencies (npm ci)');
  const files = loadRecordFiles(root);
  const index = buildIndex(files, { validators, evaluationIds: loadEvaluationIds(root) });
  const records = [...files.keys()].filter(path => /\/evaluation\/[^/]+\.json$/.test(path));
  const listed = new Set(index.entries.map(entry => entry.source.evaluation));
  for (const path of records) assert.ok(listed.has(path) || index.retired_runs.includes(path), `${path} is neither listed nor retired`);
});

test('only accepted, small record files are committed, and every experiment has an experiment.json and an evaluation record', { skip: tracked === null && 'not a Git checkout' }, () => {
  const byExperiment = new Map();
  for (const path of tracked) {
    assert.match(path, ACCEPTED, `${path} is not an accepted record file (raw evidence and other files stay out of the repository)`);
    assert.ok(statSync(join(root, path)).size <= MAX_BYTES, `${path} is larger than 1 MiB`);
    const id = path.split('/')[1];
    byExperiment.set(id, [...(byExperiment.get(id) ?? []), path.split('/').slice(2).join('/')]);
  }
  for (const [id, paths] of byExperiment) {
    assert.ok(paths.includes('experiment.json'), `${id} has no experiment.json`);
    assert.ok(paths.some(path => /^evaluation\/[^/]+\.json$/.test(path)), `${id} has no evaluation record`);
  }
});
