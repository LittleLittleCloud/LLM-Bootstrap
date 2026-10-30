#!/usr/bin/env python3
"""Measure an OpenAI-compatible endpoint with EvalScope: throughput first, then rule-scored intelligence.

Throughput runs `evalscope perf` on fixed workloads. Intelligence runs `evalscope eval` on pinned, rule-scored benchmarks
(HumanEval in a Docker sandbox, GSM8K) and only checks that the engine still computes the model correctly. EvalScope is pinned
by version and by a hash-locked requirements file. Run this script with the Python of an environment installed from that file.
See the evaluation protocol in the experiment skill.
"""
import argparse
import datetime
import hashlib
import importlib.metadata
import json
import platform
import re
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parent
DEFINITION = HERE.parent / 'evaluation.json'
NOT_OBTAINED = 'Not obtained'
HEADLINE_PREFILL = 'prefill.in2k.out1'
HEADLINE_DECODE = 'decode.in128.out256'
TOKENIZER_FILES = ('tokenizer.json', 'tokenizer_config.json', 'chat_template.jinja', 'vocab.json', 'merges.txt')


def sha256_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def verify_scripts():
    """Check every script and the dependency lock against their recorded hashes before any of them is imported or run.

    This entry file cannot vouch for itself: run it from the pinned repository revision.
    """
    definition = json.loads(DEFINITION.read_text())
    if definition.get('status') != 'released':
        raise SystemExit('The evaluation definition is a draft; formal runs need a released one.')
    for script in definition['scripts']:
        path = (DEFINITION.parent / script['path']).resolve()
        if DEFINITION.parent.resolve() not in path.parents or not path.is_file() or sha256_file(path) != script['sha256']:
            raise SystemExit('File %s does not match its recorded hash.' % script['path'])


# Development modes skip this so scripts can be edited before the hashes are updated.
if __name__ == '__main__' and not {'--describe', '--self-test'} & set(sys.argv):
    verify_scripts()

sys.path.insert(0, str(HERE))

import intelligence  # noqa: E402
import perf  # noqa: E402


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')


def load_definition():
    return json.loads(DEFINITION.read_text())


def swap_out_bytes():
    """Whole-machine cumulative swap-out, or None when the platform does not expose it."""
    try:
        if sys.platform == 'darwin':
            text = subprocess.run(['vm_stat'], capture_output=True, text=True, timeout=10).stdout
            page = int(text.split('page size of')[1].split('bytes')[0])
            return int(text.split('Swapouts:')[1].split()[0].rstrip('.')) * page
        if sys.platform.startswith('linux'):
            import os
            with open('/proc/vmstat') as handle:
                pages = next(int(line.split()[1]) for line in handle if line.startswith('pswpout '))
            return pages * os.sysconf('SC_PAGE_SIZE')
    except (OSError, ValueError, IndexError, StopIteration, subprocess.SubprocessError):
        pass
    return None


class MemorySampler:
    """Samples a process's resident set size, in KiB, at a fixed interval until stopped."""
    INTERVAL_SECONDS = 0.5

    def __init__(self, pid):
        self.pid, self.peak_kib, self._stop = pid, None, threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _sample(self):
        try:
            kib = int(subprocess.run(['ps', '-o', 'rss=', '-p', str(self.pid)], capture_output=True, text=True, timeout=5).stdout.strip())
        except (ValueError, OSError, subprocess.SubprocessError):
            return
        self.peak_kib = kib if self.peak_kib is None else max(self.peak_kib, kib)

    def _run(self):
        while not self._stop.is_set():
            self._sample()
            self._stop.wait(self.INTERVAL_SECONDS)

    def start(self):
        self._thread.start()

    def stop(self):
        self._stop.set()
        self._thread.join()
        self._sample()
        return None if self.peak_kib is None else self.peak_kib / (1024 * 1024)


class Context:
    """Everything one measurement needs."""

    def __init__(self, endpoint, model, tokenizer_path, workdir, fields, salt, api_key=None, timeout=3600):
        self.endpoint, self.model, self.tokenizer_path, self.workdir = endpoint, model, tokenizer_path, Path(workdir)
        self.fields, self.salt, self.api_key, self.timeout = fields, salt, api_key, timeout
        self.workdir.mkdir(parents=True, exist_ok=True)


def seed_for(salt, *parts):
    """A fresh random-prompt seed per level and pass, so no prompt repeats and no prefix cache can serve an earlier one."""
    return int(hashlib.sha256(('|'.join([salt, *map(str, parts)])).encode()).hexdigest()[:8], 16) % (2 ** 31)


def run_throughput_pass(ctx, plan, phase, index):
    """One pass over the throughput plan. Returns a record per workload level."""
    records = []
    for item in plan:
        for level in item['levels']:
            name = '%s.p%d.%s%d' % (item['id'], level['parallel'], phase, index)
            outputs = ctx.workdir / 'perf' / name
            seed = seed_for(ctx.salt, item['id'], level['parallel'], phase, index)
            args = perf.perf_arguments(item, level, ctx.endpoint, ctx.model, ctx.tokenizer_path, outputs, ctx.fields, seed, ctx.api_key)
            status, level_dir = perf.run_level(args, ctx.workdir / ('%s.log' % name), item.get('timeout_seconds', ctx.timeout))
            record = {'phase': phase, 'pass': index, 'id': item['id'], 'kind': item['kind'], 'parallel': level['parallel'],
                      'number': level['number'], 'seed': seed, 'status': 'ok', 'problems': [], 'summary': None}
            measured = None
            if status == 'timed-out':
                record.update(status='timed-out', problems=['timed out'])
            elif level_dir is None or not (level_dir / 'benchmark_summary.json').is_file():
                record.update(status='failed', problems=['evalscope exited with status %s and wrote no summary' % status])
            else:
                measured = perf.read_level(level_dir)
                record['summary'] = measured['summary']
                record['p50'], record['p99'] = measured['percentile']['50%'], measured['percentile']['99%']
                record['problems'] = perf.level_problems(item, level, measured)
                if status != 0:
                    record['problems'].append('evalscope exited with status %s' % status)
            if record['problems'] and record['status'] == 'ok':
                record['status'] = 'failed'
            records.append(record)
    return records


def pass_outcome(records):
    if any(r['status'] == 'timed-out' for r in records):
        return 'timed-out'
    return 'failed' if any(r['problems'] for r in records) else 'succeeded'


def pass_failures(records):
    return '; '.join('%s at concurrency %d: %s' % (r['id'], r['parallel'], ', '.join(r['problems'])) for r in records if r['problems'])


def level_sums(record):
    """Sums over one level's successful requests, from EvalScope's own averages."""
    s = record['summary']
    n = s['Success Requests']
    average_in, average_out = s['Avg Input Tokens'], s['Avg Output Tokens']
    hit = s.get('KV Cache Hit Rate (%)', 0.0) / 100.0
    decode_tokens = n * (average_out - 1)
    return {
        'requests': n, 'input_tokens': n * average_in, 'new_input_tokens': n * average_in * (1 - hit), 'cached_tokens': n * average_in * hit,
        'output_tokens': n * average_out, 'ttft_seconds': n * s['Avg TTFT (ms)'] / 1000.0,
        'decode_tokens': decode_tokens, 'decode_seconds': decode_tokens * s['Avg TPOT (ms)'] / 1000.0,
        'duration': s['Test Duration (s)'],
    }


def aggregate(basis, tokens, seconds):
    """Ratio of sums, computed from the stored rounded numbers so the document is self-consistent."""
    tokens, seconds = int(round(tokens)), round(seconds, 6)
    if tokens <= 0 or seconds <= 0:
        return NOT_OBTAINED
    return {'basis': basis, 'total_tokens': tokens, 'total_seconds': seconds, 'tokens_per_second': tokens / seconds}


def tokens_per_second(value):
    return None if value == NOT_OBTAINED else value['tokens_per_second']


def throughput_result(item, parallel, records, all_records):
    """The aggregate of one workload level over the formal passes whose requests all met their gates."""
    good = [level_sums(r) for r in records]
    total = lambda key: sum(g[key] for g in good)  # noqa: E731
    result = {
        'workload_id': item['id'], 'kind': item['kind'], 'concurrency': parallel, 'input_tokens': item['input_tokens'],
        'output_tokens': item['output_tokens'],
        'requests': sum(r['summary']['Total Requests'] for r in all_records if r['summary']),
        'succeeded_requests': sum(r['summary']['Success Requests'] for r in all_records if r['summary']),
        'prefill': NOT_OBTAINED, 'decode': NOT_OBTAINED, 'ttft_median_seconds': NOT_OBTAINED,
        'output_tokens_per_second': NOT_OBTAINED, 'total_tokens_per_second': NOT_OBTAINED, 'requests_per_second': NOT_OBTAINED,
        'cache_hit_ratio': NOT_OBTAINED,
    }
    if not good:
        return result
    result['prefill'] = aggregate('processed-input-tokens', total('new_input_tokens'), total('ttft_seconds'))
    result['decode'] = aggregate('n-minus-1-intervals', total('decode_tokens'), total('decode_seconds'))
    result['ttft_median_seconds'] = round(statistics.median(r['p50']['TTFT (ms)'] for r in records) / 1000.0, 6)
    duration = total('duration')
    result['output_tokens_per_second'] = round(total('output_tokens') / duration, 4)
    result['total_tokens_per_second'] = round((total('output_tokens') + total('input_tokens')) / duration, 4)
    result['requests_per_second'] = round(total('requests') / duration, 4)
    if total('input_tokens') > 0 and any('KV Cache Hit Rate (%)' in r['summary'] for r in records):
        result['cache_hit_ratio'] = round(total('cached_tokens') / total('input_tokens'), 4)
    if item['kind'] == 'multi-turn':
        first = [r['summary'].get('Avg First-Turn TTFT (ms)') for r in records]
        later = [r['summary'].get('Avg Subsequent-Turn TTFT (ms)') for r in records]
        if all(v is not None for v in first + later):
            result['first_turn_ttft_seconds'] = round(statistics.mean(first) / 1000.0, 6)
            result['subsequent_turn_ttft_seconds'] = round(statistics.mean(later) / 1000.0, 6)
    metric, values = headline_values(item, records)
    if values:
        result['variability'] = {'metric': metric, 'values': [round(v, 4) for v in values],
                                 'sample_stddev': round(statistics.stdev(values), 4) if len(values) > 1 else NOT_OBTAINED}
    return result


def headline_values(item, records):
    values = []
    for r in records:
        s = level_sums(r)
        if item['kind'] == 'prefill':
            values.append(s['new_input_tokens'] / s['ttft_seconds'])
        elif item['kind'] == 'decode' and s['decode_seconds'] > 0:
            values.append(s['decode_tokens'] / s['decode_seconds'])
        else:
            values.append(r['summary']['Output Throughput (tok/s)'])
    metric = {'prefill': 'prefill tokens per second', 'decode': 'decode tokens per second'}.get(item['kind'], 'output tokens per second')
    return metric, values


def summarize_throughput(plan, passes):
    """Per-level results and the run-level headline metrics from the formal passes."""
    formal = [p for p in passes if p['phase'] == 'formal']
    results = []
    for item in plan:
        for level in item['levels']:
            key = lambda r: r['id'] == item['id'] and r['parallel'] == level['parallel']  # noqa: E731
            every = [r for p in formal for r in p['records'] if key(r)]
            results.append(throughput_result(item, level['parallel'], [r for r in every if not r['problems']], every))
    return results


def headline(results, workload_id):
    found = [r for r in results if r['workload_id'] == workload_id and r['concurrency'] == 1]
    return found[0] if found else None


def execute_throughput(ctx, plan, warmup, repetitions, observe_machine=False, memory_pid=None):
    passes, sampler, swap_before, formal_start = [], None, None, None
    for index in range(warmup + repetitions):
        phase = 'warm-up' if index < warmup else 'formal'
        if index == warmup:
            swap_before = swap_out_bytes() if observe_machine else None
            sampler = MemorySampler(memory_pid) if observe_machine and memory_pid else None
            if sampler:
                sampler.start()
            formal_start = time.monotonic()
        records = run_throughput_pass(ctx, plan, phase, index)
        passes.append({'phase': phase, 'index': index, 'records': records, 'outcome': pass_outcome(records),
                       'failure_description': pass_failures(records)})
    formal_seconds = time.monotonic() - formal_start if formal_start else 0.0
    swap_after = swap_out_bytes() if observe_machine else None
    peak = sampler.stop() if sampler else None
    swap = swap_after - swap_before if swap_before is not None and swap_after is not None and swap_after >= swap_before else None
    return {'plan': plan, 'passes': passes, 'formal_seconds': formal_seconds, 'peak_memory_gib': peak, 'swap_out_delta_bytes': swap}


def run_intelligence(ctx, definition, datasets, sandbox, items=None, limit=None, tag='real'):
    """One `evalscope eval` per benchmark. Returns {benchmark id: record}."""
    records = {}
    for item in items or definition['plan']['intelligence']:
        run_dir = ctx.workdir / 'eval' / tag / item['id']
        args = intelligence.eval_arguments(item, ctx.endpoint, ctx.model, datasets[item['benchmark']], run_dir, ctx.fields,
                                           sandbox if item['sandbox'] else None, ctx.api_key, limit)
        status, found = intelligence.run_eval(args, ctx.workdir / ('eval-%s-%s.log' % (tag, item['id'])), ctx.timeout)
        scored = intelligence.read_score(found, item['benchmark'], item['metric']) if found else None
        problems = [] if status == 0 else ['evalscope exited with status %s' % status]
        if limit is None:
            problems += intelligence.score_problems(item, scored)
        records[item['id']] = {'item': item, 'status': status, 'scored': scored, 'problems': problems}
    return records


def metric_label(metric):
    dimensions = ','.join('%s=%s' % pair for pair in sorted(metric.get('dimensions', {}).items()))
    return '%s/%s%s' % (metric['name'], metric['aggregation'], '(%s)' % dimensions if dimensions else '')


def intelligence_quality(definition, records, control):
    benchmarks = [{'benchmark_id': r['item']['id'], 'metric': metric_label(r['item']['metric']), 'score': round(r['scored']['score'], 6),
                   'num_samples': r['scored']['num_samples'], 'stderr': round(r['scored']['stderr'], 6)}
                  for r in records.values() if r['scored'] and not r['problems']]
    if not benchmarks:
        return NOT_OBTAINED
    return {'benchmarks': benchmarks, 'complete': len(benchmarks) == len(definition['plan']['intelligence']),
            'negative_control_verified': control['verified'], 'restricted_environment': control['restricted']}


CONTROL_RATES = {'prefill': 20000.0, 'decode': 400.0}
CONTROL_TOLERANCE = 0.35
CONTROL_PLAN = [
    {'id': HEADLINE_PREFILL, 'kind': 'prefill', 'input_tokens': 2048, 'output_tokens': 1, 'levels': [{'parallel': 1, 'number': 3, 'warmup': 1}]},
    {'id': HEADLINE_DECODE, 'kind': 'decode', 'input_tokens': 128, 'output_tokens': 256, 'levels': [{'parallel': 1, 'number': 3, 'warmup': 1}]},
    {'id': 'concurrency.in512.out64', 'kind': 'concurrency', 'input_tokens': 512, 'output_tokens': 64,
     'levels': [{'parallel': 1, 'number': 4, 'warmup': 1}, {'parallel': 4, 'number': 8, 'warmup': 4}]},
    {'id': 'multi-turn.in2k.t3', 'kind': 'multi-turn', 'input_tokens': 2048, 'output_tokens': 16, 'turns': 3,
     'levels': [{'parallel': 1, 'number': 2, 'warmup': 0}]},
]
NETWORK_PROBE = (
    '\nimport socket as _s\n_c = _s.socket()\n_c.settimeout(3)\ntry:\n    _c.connect(("1.1.1.1", 53))\n'
    '    raise SystemExit("the sandbox has network access")\nexcept OSError:\n    pass\n'
)
WRONG_STUB = 'def {entry}(*args, **kwargs):\n    return None\n'


def tokenizer_counter(tokenizer_path):
    from transformers import AutoTokenizer
    tokenizer = AutoTokenizer.from_pretrained(tokenizer_path)
    return lambda text: len(tokenizer.encode(text)) + 2


def reference_answers(datasets):
    """Oracle replies for the pinned benchmarks: right, wrong, and right with a network probe."""
    import pandas
    answers = []
    for row in pandas.read_parquet(datasets['humaneval'] / 'openai_humaneval' / 'test-00000-of-00001.parquet').to_dict('records'):
        right = row['prompt'] + row['canonical_solution']
        answers.append({'match': row['prompt'], 'right': '```python\n%s\n```' % right,
                        'wrong': '```python\n%s```' % WRONG_STUB.format(entry=row['entry_point']),
                        'probe': '```python\n%s%s\n```' % (right, NETWORK_PROBE)})
    for row in pandas.read_parquet(datasets['gsm8k'] / 'main' / 'test-00000-of-00001.parquet').to_dict('records'):
        final = row['answer'].split('####')[-1].strip().replace(',', '')
        reply = lambda value: 'The answer is \\boxed{%s}.' % value  # noqa: E731
        answers.append({'match': row['question'], 'right': reply(final), 'wrong': reply('-12345'), 'probe': reply(final)})
    return answers


def throughput_control(base, count):
    """Known rates, concurrency scaling, and prefix reuse must come back through EvalScope; each fault must be caught."""
    from concurrent.futures import ThreadPoolExecutor
    from reference_engine import FAULTS, ReferenceEngine

    def run(faults, plan, name):
        with ReferenceEngine(CONTROL_RATES['prefill'], CONTROL_RATES['decode'], faults, count=count) as engine:
            ctx = Context(engine.origin, engine.model, base.tokenizer_path, base.workdir / 'control' / name, {}, base.salt, timeout=900)
            return execute_throughput(ctx, plan, 0, 1)

    problems = []
    healthy = run((), CONTROL_PLAN, 'healthy')
    if healthy['passes'][0]['outcome'] != 'succeeded':
        problems.append('the reference engine does not pass the throughput control: %s' % healthy['passes'][0]['failure_description'])
        return problems, healthy
    results = summarize_throughput(CONTROL_PLAN, healthy['passes'])
    by_id = {(r['workload_id'], r['concurrency']): r for r in results}

    def expect(label, measured, expected, tolerance=CONTROL_TOLERANCE):
        if measured is None:
            problems.append('%s was not obtained from the reference engine' % label)
        elif abs(measured - expected) > tolerance * expected:
            problems.append('%s read %.0f tok/s for a known %.0f tok/s' % (label, measured, expected))

    expect('prefill', tokens_per_second(by_id[(HEADLINE_PREFILL, 1)]['prefill']), CONTROL_RATES['prefill'])
    expect('decode', tokens_per_second(by_id[(HEADLINE_DECODE, 1)]['decode']), CONTROL_RATES['decode'])
    one, four = by_id[('concurrency.in512.out64', 1)]['output_tokens_per_second'], by_id[('concurrency.in512.out64', 4)]['output_tokens_per_second']
    if NOT_OBTAINED in (one, four) or not 1.3 <= four / one <= 3.2:
        problems.append('aggregate output did not scale with concurrency as the reference engine\'s two slots allow (%s, %s)' % (one, four))
    cache = by_id[('multi-turn.in2k.t3', 1)]['cache_hit_ratio']
    if cache == NOT_OBTAINED or cache < 0.3:
        problems.append('the multi-turn workload did not show prefix reuse on the reference engine (%s)' % (cache,))
    decode_item = {**CONTROL_PLAN[1], 'levels': [{'parallel': 1, 'number': 2, 'warmup': 0}]}
    fault_plans = {'stops_early': [decode_item], 'http_error': [decode_item], 'no_prefix_cache': [CONTROL_PLAN[3]]}
    with ThreadPoolExecutor(max_workers=len(FAULTS)) as pool:
        futures = {fault: pool.submit(run, (fault,), fault_plans[fault], 'fault-' + fault) for fault in FAULTS}
        faulty = {fault: future.result() for fault, future in futures.items()}
    for fault, outcome in faulty.items():
        records = outcome['passes'][0]['records']
        text = ' '.join(p for r in records for p in r['problems'])
        if fault == 'stops_early':
            caught = 'output length' in text
        elif fault == 'http_error':
            caught = outcome['passes'][0]['outcome'] != 'succeeded'
        else:
            ratio = summarize_throughput(fault_plans[fault], outcome['passes'])[0]['cache_hit_ratio']
            caught = ratio != NOT_OBTAINED and ratio < 0.05
        if not caught:
            problems.append('fault %s was not detected' % fault)
    return problems, healthy


def intelligence_control(base, definition, datasets, count):
    """The pipeline must score right answers 1, wrong answers 0, and the sandbox must keep generated code off the network."""
    from reference_engine import ReferenceEngine
    plan = definition['plan']
    answers = reference_answers(datasets)
    problems, notes = [], []

    def run(mode, items, network, limit=5):
        with ReferenceEngine(1e9, 1e6, answers=answers, answer_mode=mode, count=count) as engine:
            ctx = Context(engine.origin, engine.model, base.tokenizer_path, base.workdir / 'control', {}, base.salt, timeout=1800)
            return run_intelligence(ctx, definition, datasets, intelligence.sandbox_config(plan['sandbox'], network), items, limit, 'control-%s-%s' % (mode, network))

    def scores(records):
        return {name: (r['scored'] or {}).get('score') for name, r in records.items()}

    items = plan['intelligence']
    code = [item for item in items if item['sandbox']]
    for mode, expected in (('right', 1.0), ('wrong', 0.0)):
        got = scores(run(mode, items, False))
        for name, value in got.items():
            if value != expected:
                problems.append('the %s answers scored %s on %s instead of %s' % (mode, value, name, expected))
    blocked = scores(run('probe', code, False, 3))
    restricted = bool(blocked) and all(value == 1.0 for value in blocked.values())
    if not restricted:
        problems.append('code that probes the network did not run cleanly in the restricted sandbox: %s' % blocked)
    else:
        opened = scores(run('probe', code, True, 3))
        if any(value != 0.0 for value in opened.values()):
            restricted = False
            notes.append('network isolation could not be demonstrated: the same probe also ran cleanly with the network enabled')
    return problems, restricted, notes


def run_controls(base, definition, datasets, parts, count):
    """Negative control of the whole pipeline. `verified` needs every selected part to recover its known behavior."""
    control = {'verified': False, 'restricted': False, 'problems': [], 'notes': [], 'reference': None}
    if 'throughput' in parts:
        problems, reference = throughput_control(base, count)
        control['problems'] += problems
        control['reference'] = reference
    if 'intelligence' in parts:
        problems, restricted, notes = intelligence_control(base, definition, datasets, count)
        control['problems'] += problems
        control['restricted'], control['notes'] = restricted, notes
    control['verified'] = not control['problems']
    return control


def check_environment(definition, parts):
    problems = []
    if sys.version_info < (3, 10):
        problems.append('EvalScope needs Python 3.10 or newer; this is %s.' % platform.python_version())
    expected = definition['harness']['version']
    try:
        found = importlib.metadata.version('evalscope')
    except importlib.metadata.PackageNotFoundError:
        found = None
    if found != expected:
        problems.append('The evaluation pins EvalScope %s; found %s. Install requirements.lock into a clean environment.' % (expected, found))
    if 'intelligence' in parts:
        try:
            subprocess.run(['docker', 'info'], capture_output=True, timeout=30, check=True)
        except (OSError, subprocess.SubprocessError):
            problems.append('Docker is not available; the code benchmark needs it to run generated programs in a sandbox.')
        else:
            image = definition['plan']['sandbox']['image']
            if subprocess.run(['docker', 'image', 'inspect', image], capture_output=True).returncode != 0:
                if subprocess.run(['docker', 'pull', image], capture_output=True, timeout=900).returncode != 0:
                    problems.append('The pinned sandbox image %s is not installed and could not be pulled.' % image)
    return problems


def tokenizer_digest(path):
    files = sorted(p for p in Path(path).iterdir() if p.name in TOKENIZER_FILES and p.is_file())
    if not files:
        raise SystemExit('--tokenizer-path must hold the model tokenizer (tokenizer.json or similar) with its chat template.')
    return hashlib.sha256(''.join('%s:%s\n' % (p.name, sha256_file(p)) for p in files).encode()).hexdigest()


def build_result(info, definition, run, records, control, evidence_ref):
    plan = run['plan'] if run else []
    results = summarize_throughput(plan, run['passes']) if run else []
    formal = [p for p in run['passes'] if p['phase'] == 'formal'] if run else []
    succeeded = [p for p in formal if p['outcome'] == 'succeeded']
    prefill, decode = headline(results, HEADLINE_PREFILL), headline(results, HEADLINE_DECODE)
    sandbox = definition['plan']['sandbox']
    settings = {
        'tool': 'evalscope %s' % definition['harness']['version'], 'python': platform.python_version(),
        'parts': ','.join(info['parts']), 'temperature': 0, 'seed': 0, 'prompt_salt': info['salt'],
        'tokenizer_sha256': info['tokenizer_sha256'], 'endpoint_scheme': info['scheme'], 'endpoint_host_class': info['host_class'],
        'warmup_passes': info['warmup'], 'formal_passes': info['repetitions'],
        'throughput_workloads': ','.join(item['id'] for item in plan) or 'none',
        'intelligence_benchmarks': ','.join(item['id'] for item in definition['plan']['intelligence']) if records else 'none',
        'generation_max_tokens': 4096, 'sandbox_image': sandbox['image'], 'sandbox_network': 'disabled',
        'sandbox_memory': sandbox['memory'], 'sandbox_cpus': sandbox['cpus'],
        'prefill_definition': 'processed input tokens (reported prompt tokens minus cached) over EvalScope time to first token, summed over requests',
        'decode_definition': 'output tokens minus 1 over EvalScope time per output token, summed over requests of one fixed output length',
        'output_throughput_definition': 'output tokens of all requests over the EvalScope test duration, including ramp-up and ramp-down',
        'cache_policy_applied': 'EvalScope random prompts are reseeded for every level and pass, so no prompt repeats; only multi-turn workloads reuse their own earlier turns',
    }
    settings.update({'request_field.%s' % key: value for key, value in info['fields'].items()})
    settings.update({'control_note.%d' % i: note for i, note in enumerate(control['notes'])})
    if info.get('memory_definition'):
        settings['peak_memory_definition'] = info['memory_definition']
    repetitions = []
    for entry in (run['passes'] if run else []):
        item = {'phase': entry['phase'], 'outcome': entry['outcome']}
        if entry['outcome'] != 'succeeded':
            item['failure_description'] = entry['failure_description'] or entry['outcome']
        repetitions.append(item)
    if records:
        failed = '; '.join('%s: %s' % (name, ', '.join(r['problems'])) for name, r in records.items() if r['problems'])
        repetitions.append({'phase': 'formal', 'outcome': 'failed' if failed else 'succeeded', **({'failure_description': failed} if failed else {})})
    if not repetitions:
        repetitions.append({'phase': 'formal', 'outcome': 'failed', 'failure_description': 'no part was run'})
    return {
        'evaluation': {'evaluation_id': definition['evaluation_id'], 'revision': info['evaluation_revision'], 'sha256': sha256_file(DEFINITION)},
        'role': info['role'], 'engine_name': info['engine_name'], 'environment': info['environment'],
        'runtime_revision': info['runtime_revision'], 'artifacts': info['artifacts'], 'commands': info['commands'],
        'settings': settings, 'repetitions': repetitions,
        'metrics': {
            'formal_repetitions': len(succeeded), 'preliminary': len(succeeded) <= 1,
            'prefill': prefill['prefill'] if prefill else NOT_OBTAINED, 'decode': decode['decode'] if decode else NOT_OBTAINED,
            'client_ttft_median_seconds': prefill['ttft_median_seconds'] if prefill else NOT_OBTAINED,
            'requests_reconciled': bool(formal) and all(not r['problems'] for p in formal for r in p['records']),
            'per_request_evidence': evidence_ref,
        },
        'throughput': results,
        'resources': {'peak_memory_gib': NOT_OBTAINED if not run or run['peak_memory_gib'] is None else round(run['peak_memory_gib'], 3),
                      'swap_out_delta_bytes': NOT_OBTAINED if not run or run['swap_out_delta_bytes'] is None else run['swap_out_delta_bytes']},
        'quality': {'intelligence': intelligence_quality(definition, records, control) if records else NOT_OBTAINED},
    }


def write_evidence(path, run, records, info):
    levels = [{k: v for k, v in r.items()} for p in (run['passes'] if run else []) for r in p['records']]
    scored = {name: {'status': r['status'], 'scored': r['scored'], 'problems': r['problems']} for name, r in (records or {}).items()}
    Path(path).write_text(json.dumps({'salt': info['salt'], 'levels': levels, 'intelligence': scored}, indent=2) + '\n')
    return {'description': 'Per-level EvalScope summaries with the gate outcomes, seeds, and benchmark scores; it holds no prompts or model output',
            'access': 'local-only', 'sha256': sha256_file(path),
            'access_limitation': 'Kept next to the result document and not committed to the repository.'}


def validate_origin(value):
    parts = urlsplit(value)
    loopback = parts.hostname in ('127.0.0.1', 'localhost', '::1')
    if (parts.scheme not in ('http', 'https') or not parts.hostname or parts.username or parts.password
            or parts.query or parts.fragment or parts.path not in ('', '/')):
        raise SystemExit('--endpoint must be a credential-free origin such as http://127.0.0.1:8080')
    if parts.scheme == 'http' and not loopback:
        raise SystemExit('Plain http is only allowed for a loopback endpoint.')
    return '%s://%s' % (parts.scheme, parts.netloc), parts.scheme, 'loopback' if loopback else 'remote'


def parse_artifacts(items):
    artifacts = []
    for item in items:
        name, _, digest = item.partition('=')
        if not name or not re.fullmatch(r'[0-9a-f]{64}', digest):
            raise SystemExit('--artifact must look like NAME=SHA256 with a lowercase hexadecimal digest.')
        artifacts.append({'name': name, 'sha256': digest})
    if not artifacts:
        raise SystemExit('At least one --artifact NAME=SHA256 of a deployed engine executable is required.')
    return artifacts


def parse_fields(items):
    fields = {}
    for item in items:
        key, separator, raw = item.partition('=')
        if not separator or not key:
            raise SystemExit('--request-field must look like KEY=JSON_VALUE.')
        if key in ('model', 'messages', 'max_tokens', 'temperature', 'stream', 'stream_options', 'seed', 'ignore_eos'):
            raise SystemExit('The request field %s is fixed by the evaluation.' % key)
        try:
            value = json.loads(raw)
        except ValueError:
            raise SystemExit('--request-field %s: the value must be JSON, for example true or {"a": 1}.' % key)
        if not isinstance(value, (str, int, float, bool, dict)):
            raise SystemExit('--request-field %s: use a scalar or an object.' % key)
        fields[key] = value
    return fields


def parse_parts(value):
    parts = [p for p in (value or 'throughput,intelligence').split(',') if p]
    if not parts or any(p not in ('throughput', 'intelligence') for p in parts):
        raise SystemExit('--parts must be throughput, intelligence, or both separated by a comma.')
    return [p for p in ('throughput', 'intelligence') if p in parts]


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--describe', action='store_true', help='Print the task ids, plan, and limits as JSON')
    parser.add_argument('--self-test', action='store_true', help='Run the negative control against a reference engine')
    parser.add_argument('--emit-result', type=Path, help='With --self-test, write the reference run as a result document')
    parser.add_argument('--endpoint', help='Origin of the engine, for example http://127.0.0.1:8080')
    parser.add_argument('--model', help='Model name sent in requests')
    parser.add_argument('--tokenizer-path', type=Path, help='Directory with the model tokenizer and chat template')
    parser.add_argument('--role', choices=('baseline', 'candidate'))
    parser.add_argument('--engine-name')
    parser.add_argument('--parts', help='throughput, intelligence, or both (default); a subset is recorded as a deviation')
    parser.add_argument('--warmup', type=int, help='Unmeasured warm-up passes over the throughput plan (0 or more)')
    parser.add_argument('--repetitions', type=int, help='Formal passes over the throughput plan (1 or more)')
    parser.add_argument('--api-key-file', type=Path, help='Read privately; never logged or recorded')
    parser.add_argument('--request-field', action='append', default=[], help='KEY=JSON_VALUE added to every request body (repeatable)')
    parser.add_argument('--dataset-dir', type=Path, help='Local copies of the pinned datasets, one folder per dataset name; hashes are checked')
    parser.add_argument('--logs-dir', type=Path, help='Keep EvalScope logs here (local only)')
    parser.add_argument('--evaluation-revision', help='Full commit of this repository that holds the pinned definition')
    parser.add_argument('--runtime-revision', help='Engine commit, if known')
    parser.add_argument('--artifact', action='append', default=[], help='NAME=SHA256 of a deployed engine executable (repeatable)')
    parser.add_argument('--engine-command', action='append', default=[], help='Command that started the engine (repeatable)')
    parser.add_argument('--hardware-model')
    parser.add_argument('--toolchain')
    parser.add_argument('--power-mode')
    parser.add_argument('--thermal-observations')
    parser.add_argument('--exclusive-gpu', action='store_true', help='State that nothing else used the GPU during the run')
    parser.add_argument('--deviation', action='append', default=[], help='Deviation from the contract (repeatable)')
    parser.add_argument('--memory-pid', type=int, help='Process whose resident memory is sampled (loopback endpoints only)')
    parser.add_argument('--allow-remote', action='store_true', help='Permit a non-loopback endpoint and record it as a deviation')
    parser.add_argument('--output', type=Path, help='New file for the result document')
    return parser.parse_args()


def prepare(args):
    """Validate the options for a real run before anything is measured."""
    required = ('endpoint', 'model', 'tokenizer_path', 'role', 'engine_name', 'warmup', 'repetitions', 'evaluation_revision', 'output',
                'hardware_model', 'toolchain', 'power_mode', 'thermal_observations')
    missing = [name for name in required if getattr(args, name) in (None, '')]
    if missing:
        raise SystemExit('Missing required options: ' + ', '.join('--' + name.replace('_', '-') for name in missing))
    if not re.fullmatch(r'[0-9a-f]{40}', args.evaluation_revision):
        raise SystemExit('--evaluation-revision must be a full 40-character commit SHA.')
    if args.warmup < 0 or args.repetitions < 1:
        raise SystemExit('--warmup must be 0 or more and --repetitions must be 1 or more.')
    if args.runtime_revision and not re.fullmatch(r'[0-9a-f]{40}', args.runtime_revision):
        raise SystemExit('--runtime-revision must be a full 40-character commit SHA.')
    evidence_path = args.output.with_name(args.output.stem + '.requests.evidence')
    if args.output.exists() or evidence_path.exists():
        raise SystemExit('--output and its .requests.evidence companion must be new files.')
    origin, scheme, host_class = validate_origin(args.endpoint)
    if host_class == 'remote' and not args.allow_remote:
        raise SystemExit('The endpoint is not on loopback. Run the driver on the engine\'s machine, or pass --allow-remote.')
    if args.memory_pid and host_class == 'remote':
        raise SystemExit('--memory-pid needs a loopback endpoint.')
    fields, parts, artifacts = parse_fields(args.request_field), parse_parts(args.parts), parse_artifacts(args.artifact)
    if not args.tokenizer_path.is_dir():
        raise SystemExit('--tokenizer-path must be a directory.')
    definition = load_definition()
    problems = check_environment(definition, parts)
    if problems:
        raise SystemExit('\n'.join(problems))
    key = args.api_key_file.read_text().strip() if args.api_key_file else None
    return {'origin': origin, 'scheme': scheme, 'host_class': host_class, 'fields': fields, 'parts': parts, 'artifacts': artifacts,
            'key': key, 'evidence_path': evidence_path, 'tokenizer_sha256': tokenizer_digest(args.tokenizer_path)}


def describe():
    definition = load_definition()
    return {'task_ids': definition['task_ids'], 'limits': definition['limits'], 'harness': definition['harness'],
            'throughput': [{k: v for k, v in item.items()} for item in definition['plan']['throughput']],
            'intelligence': [item['id'] for item in definition['plan']['intelligence']]}


def reference_info(args, parts):
    return {
        'role': 'candidate', 'engine_name': 'reference-engine', 'warmup': 0, 'repetitions': 1, 'scheme': 'http', 'host_class': 'loopback',
        'evaluation_revision': args.evaluation_revision, 'fields': {}, 'parts': parts, 'salt': 'self-test',
        'tokenizer_sha256': tokenizer_digest(args.tokenizer_path),
        'runtime_revision': {'unavailable': True, 'reason': 'The reference engine is not versioned.'},
        'artifacts': [{'name': 'reference_engine.py', 'sha256': sha256_file(HERE / 'reference_engine.py')}],
        'commands': ['evaluate.py --self-test'],
        'environment': {'hardware_model': 'not applicable: reference engine', 'os_version': platform.platform(),
                        'toolchain': 'Python %s, EvalScope' % platform.python_version(), 'power_mode': 'not applicable',
                        'thermal_observations': 'not observed', 'exclusive_gpu': False,
                        'deviations_from_contract': ['Synthetic reference run against an oracle; not a measurement of any engine.']},
    }


def prepare_datasets(definition, source_dir, scratch):
    return {pin['name']: intelligence.prepare_dataset(pin, source_dir, scratch) for pin in definition['datasets']}


def main():
    args = parse_args()
    if args.describe:
        print(json.dumps(describe()))
        return 0
    definition = load_definition()
    scratch_root = tempfile.TemporaryDirectory(prefix='engine-evalscope-')
    scratch = Path(scratch_root.name)
    salt = hashlib.sha256((now() + str(time.monotonic())).encode()).hexdigest()[:16]
    try:
        if args.self_test:
            if not args.tokenizer_path:
                raise SystemExit('--self-test needs --tokenizer-path.')
            problems = check_environment(definition, ['throughput', 'intelligence'])
            if problems:
                raise SystemExit('\n'.join(problems))
            datasets = prepare_datasets(definition, args.dataset_dir, scratch)
            base = Context('', '', str(args.tokenizer_path), scratch, {}, salt)
            control = run_controls(base, definition, datasets, ['throughput', 'intelligence'], tokenizer_counter(str(args.tokenizer_path)))
            print('self-test: %s' % ('ok' if control['verified'] else 'FAILED'))
            for problem in control['problems'] + control['notes']:
                print('  ' + problem)
            if args.emit_result and control['verified']:
                if not args.evaluation_revision:
                    raise SystemExit('--emit-result needs --evaluation-revision.')
                info = reference_info(args, ['throughput', 'intelligence'])
                records = {item['id']: {'item': item, 'status': 0, 'problems': [], 'scored': {'score': 1.0, 'num_samples': item['expected_samples'], 'stderr': 0.0}}
                           for item in definition['plan']['intelligence']}
                evidence = write_evidence(args.emit_result.with_name(args.emit_result.stem + '.requests.evidence'), control['reference'], records, info)
                args.emit_result.write_text(json.dumps(build_result(info, definition, control['reference'], records, control, evidence), indent=2) + '\n')
            return 0 if control['verified'] else 1

        prepared = prepare(args)
        parts = prepared['parts']
        datasets = prepare_datasets(definition, args.dataset_dir, scratch) if 'intelligence' in parts else {}
        count = tokenizer_counter(str(args.tokenizer_path))
        base = Context(prepared['origin'], args.model, str(args.tokenizer_path), scratch, prepared['fields'], salt, prepared['key'],
                       definition['limits']['timeout_seconds_per_task'])
        control = run_controls(base, definition, datasets, parts, count) if 'intelligence' in parts else run_controls(base, definition, {}, parts, count)
        if not control['verified']:
            raise SystemExit('The negative control failed, so this evaluation is not trustworthy:\n  ' + '\n  '.join(control['problems']))
        sandbox = intelligence.sandbox_config(definition['plan']['sandbox'], False)
        run = records = None
        if 'throughput' in parts:
            run = execute_throughput(base, definition['plan']['throughput'], args.warmup, args.repetitions,
                                     observe_machine=prepared['host_class'] == 'loopback', memory_pid=args.memory_pid)
        if 'intelligence' in parts:
            records = run_intelligence(base, definition, datasets, sandbox)
        info = {
            'role': args.role, 'engine_name': args.engine_name, 'warmup': args.warmup, 'repetitions': args.repetitions, 'parts': parts,
            'scheme': prepared['scheme'], 'host_class': prepared['host_class'], 'fields': prepared['fields'], 'salt': salt,
            'tokenizer_sha256': prepared['tokenizer_sha256'], 'evaluation_revision': args.evaluation_revision,
            'runtime_revision': args.runtime_revision or {'unavailable': True, 'reason': 'No runtime revision was supplied.'},
            'artifacts': prepared['artifacts'], 'commands': [' '.join(a for a in sys.argv if a != str(args.api_key_file))] + args.engine_command,
            'memory_definition': ('resident set size of PID %d sampled every %.1f seconds during the formal passes; it may not include GPU memory'
                                  % (args.memory_pid, MemorySampler.INTERVAL_SECONDS)) if args.memory_pid else None,
            'environment': {'hardware_model': args.hardware_model, 'os_version': platform.platform(), 'toolchain': args.toolchain,
                            'power_mode': args.power_mode, 'thermal_observations': args.thermal_observations,
                            'exclusive_gpu': args.exclusive_gpu,
                            'deviations_from_contract': list(args.deviation) + (['Only %s was run.' % ' and '.join(parts)] if len(parts) < 2 else [])
                            + (['The endpoint is remote, so timings include network transfer.'] if prepared['host_class'] == 'remote' else [])
                            + control['notes']},
        }
        evidence = write_evidence(prepared['evidence_path'], run, records, info)
        args.output.write_text(json.dumps(build_result(info, definition, run, records, control, evidence), indent=2) + '\n')
        if args.logs_dir:
            args.logs_dir.mkdir(parents=True, exist_ok=True)
            for log in scratch.glob('*.log'):
                (args.logs_dir / log.name).write_bytes(log.read_bytes())
        print_summary(run, records)
        failed = (run and any(p['outcome'] != 'succeeded' for p in run['passes'])) or (records and any(r['problems'] for r in records.values()))
        return 1 if failed else 0
    finally:
        scratch_root.cleanup()


def print_summary(run, records):
    if run:
        for result in summarize_throughput(run['plan'], run['passes']):
            print('%s (concurrency %d): prefill %s, decode %s, output %s tok/s' % (
                result['workload_id'], result['concurrency'], format_rate(result['prefill']), format_rate(result['decode']),
                result['output_tokens_per_second']))
    for name, record in (records or {}).items():
        scored = record['scored']
        print('%s: %s' % (name, 'score %.4f over %d samples' % (scored['score'], scored['num_samples']) if scored else NOT_OBTAINED))


def format_rate(value):
    return NOT_OBTAINED if value == NOT_OBTAINED else '%.1f tok/s' % value['tokens_per_second']


if __name__ == '__main__':
    raise SystemExit(main())
