"""Run `evalscope eval` for one rule-scored benchmark and read its score.

Benchmarks are scored by rules only: HumanEval executes the official tests in a Docker sandbox, GSM8K matches the final number.
No judge model is involved. Datasets come from pinned local copies, never from whatever the hub serves today.
"""
import hashlib
import json
import math
import shutil
import subprocess
from pathlib import Path

from perf import evalscope_command


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for block in iter(lambda: handle.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def sandbox_config(spec, network_enabled=False):
    return {'enabled': True, 'engine': spec['engine'], 'default_config': {
        'image': spec['image'], 'network_enabled': network_enabled, 'memory_limit': spec['memory'], 'cpu_limit': spec['cpus']}}


def prepare_dataset(pin, source_dir, scratch):
    """Return a private copy of one pinned dataset. Every pinned file must match its hash; EvalScope edits the copy, not the source."""
    target = Path(scratch) / pin['name']
    if source_dir and (Path(source_dir) / pin['name']).is_dir():
        shutil.copytree(Path(source_dir) / pin['name'], target)
    else:
        from modelscope.hub.snapshot_download import dataset_snapshot_download
        dataset_snapshot_download(pin['repository'], local_dir=str(target))
    for item in pin['files']:
        path = target / item['path']
        if not path.is_file() or sha256_file(path) != item['sha256']:
            raise SystemExit('Dataset file %s/%s does not match its pinned SHA-256.' % (pin['name'], item['path']))
    return target


def eval_arguments(item, endpoint, model, dataset_dir, work_dir, fields, sandbox, api_key=None, limit=None, max_tokens=4096):
    generation = {'max_tokens': max_tokens, 'temperature': 0.0, 'seed': 0}
    if fields:
        generation['extra_body'] = fields
    args = [
        'eval', '--model', model, '--api-url', endpoint.rstrip('/') + '/v1', '--api-key', api_key or 'EMPTY',
        '--eval-type', 'openai_api', '--datasets', item['benchmark'], '--eval-batch-size', '1', '--seed', '0',
        '--dataset-args', json.dumps({item['benchmark']: {'local_path': str(dataset_dir)}}),
        '--generation-config', json.dumps(generation, sort_keys=True), '--work-dir', str(work_dir),
    ]
    count = limit if limit is not None else item.get('limit')
    if count:
        args += ['--limit', str(count)]
    if sandbox:
        args += ['--sandbox', json.dumps(sandbox, sort_keys=True)]
    return args


def run_eval(args, log_path, timeout):
    """Run one benchmark and return (exit status, run directory or None). The log stays local."""
    with open(log_path, 'w') as log:
        try:
            result = subprocess.run(evalscope_command(*args), stdout=log, stderr=subprocess.STDOUT, timeout=timeout)
            status = result.returncode
        except subprocess.TimeoutExpired:
            return 'timed-out', None
    runs = sorted(path for path in Path(args[args.index('--work-dir') + 1]).iterdir() if path.is_dir())
    return status, (runs[-1] if runs else None)


def read_score(run_dir, benchmark, metric):
    """The benchmark's primary metric: score, sample count, and the standard error of a proportion."""
    reports = list(Path(run_dir).glob('reports/*/%s.json' % benchmark))
    if len(reports) != 1:
        return None
    for entry in json.loads(reports[0].read_text())['metrics']:
        identity = entry['identity']
        if identity['name'] == metric['name'] and identity['aggregation'] == metric['aggregation'] \
                and identity.get('dimensions', {}) == metric.get('dimensions', {}):
            score, count = entry['score'], entry['num']
            return {'score': score, 'num_samples': count, 'stderr': math.sqrt(score * (1 - score) / count) if count else None}
    return None


def score_problems(item, scored):
    if scored is None:
        return ['no %s score was produced' % item['id']]
    if scored['num_samples'] != item['expected_samples']:
        return ['%s scored %d samples instead of %d' % (item['id'], scored['num_samples'], item['expected_samples'])]
    return []
