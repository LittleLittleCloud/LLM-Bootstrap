#!/usr/bin/env python3
"""Measure the throughput of an OpenAI-compatible streaming chat endpoint with fixed request shapes.

Workloads fix the input and output lengths: prefill at several prompt lengths, decode at several context depths, an agent
session that reuses a large prefix, and closed-loop concurrent requests. Every session starts with a unique nonce, so no
prefix is reused except where a workload reuses one on purpose. Intervals come from one monotonic clock at the client.
Standard library only (Python 3.9+). See the evaluation protocol in the experiment skill.
"""
import argparse
import datetime
import hashlib
import json
import platform
import re
import statistics
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parent
DEFINITION = HERE.parent / 'evaluation.json'
NOT_OBTAINED = 'Not obtained'
MAX_CALIBRATION_PROBES = 10
SEED = 0


def sha256_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def verify_scripts():
    """Check every script against its recorded hash before any of them is imported or run.

    This entry file cannot vouch for itself: run it from the pinned repository revision.
    """
    definition = json.loads(DEFINITION.read_text())
    if definition.get('status') != 'released':
        raise SystemExit('The evaluation definition is a draft; formal runs need a released one.')
    for script in definition['scripts']:
        path = (DEFINITION.parent / script['path']).resolve()
        if DEFINITION.parent.resolve() not in path.parents or not path.is_file() or sha256_file(path) != script['sha256']:
            raise SystemExit('Script %s does not match its recorded hash.' % script['path'])


# Development modes (--describe, --self-test) skip this so scripts can be edited before the hashes are updated.
if __name__ == '__main__' and not {'--describe', '--self-test'} & set(sys.argv):
    verify_scripts()

sys.path.insert(0, str(HERE))

import measure  # noqa: E402
import workload  # noqa: E402
from workload import WORKLOADS  # noqa: E402


class CalibrationError(Exception):
    pass


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')


def calibrate(probe, target):
    """Find the filler length whose prompt the engine counts as about `target` tokens, using the engine's own usage.

    Returns the filler length and every (words, tokens) point probed.
    """
    tolerance = max(2, workload.input_tolerance(target) // 2)
    words, slope, last, points = max(1, round(target / 1.3)), 1.3, None, []
    for _ in range(MAX_CALIBRATION_PROBES):
        tokens = probe(words)
        points.append((words, tokens))
        if abs(tokens - target) <= tolerance:
            return words, points
        if last and last[0] != words and (tokens - last[1]) * (words - last[0]) > 0:
            slope = (tokens - last[1]) / (words - last[0])
        last = (words, tokens)
        words = max(0, words + round((target - tokens) / slope))
    raise CalibrationError('could not size a prompt to about %d tokens in %d probes' % (target, MAX_CALIBRATION_PROBES))


def fit_slope(points, probe):
    """Tokens per filler word, from probes that span a wide range so a long prompt can be sized without probing it."""
    if max(points)[0] - min(points)[0] < max(points)[0] // 3:
        low = max(1, max(points)[0] * 2 // 3)
        points.append((low, probe(low)))
    low, high = min(points), max(points)
    slope = (high[1] - low[1]) / (high[0] - low[0]) if high[0] != low[0] else 0
    if slope <= 0:
        raise CalibrationError('the engine\'s prompt token count does not grow with the prompt length')
    return slope


def execute(origin, model, api_key, timeout, warmup, repetitions, fields, seed, salt, workloads=None,
            observe_machine=False, memory_pid=None):
    """Size the prompts, run the warm-up and formal passes, and return every request record.

    Each pass runs the selected workloads in order; a workload instance is one request, one agent session, or one
    closed-loop batch.
    """
    selected = [name for name in WORKLOADS if workloads is None or name in workloads]
    records, passes, lock, serial = [], [], threading.Lock(), [0]
    epoch = time.monotonic()

    def new_nonce():
        with lock:
            serial[0] += 1
            return workload.make_nonce(salt, seed, serial[0])

    def request(phase, index, workload_id, filler_words, turn=1, increment_words=0, nonce=None, max_tokens=None, extra=None):
        spec = WORKLOADS[workload_id]
        nonce = nonce or new_nonce()
        prompt = workload.build_prompt(workload_id, nonce, filler_words, seed, turn, increment_words)
        obs = measure.observe(origin, model, prompt, max_tokens or spec['output_tokens'], api_key, timeout, fields)
        record = {
            'phase': phase, 'pass': index, 'workload': workload_id, 'nonce': nonce, 'turn': turn, 'worker': None,
            'sequence': None, 'filler_words': filler_words, 'status': obs['status'], 'prompt_tokens': obs['prompt_tokens'],
            'cached_tokens': obs['cached_tokens'], 'completion_tokens': obs['completion_tokens'], 'chunks': obs['chunks'],
            'finish_reason': obs['finish_reason'], 'started_seconds': obs['started'] - epoch, 'ended_seconds': obs['ended'] - epoch,
            'ttft_seconds': obs['first'], 'decode_seconds': None if obs['first'] is None else obs['last'] - obs['first'],
            'timed_out': obs['timed_out'],
            'problems': ([obs['error']] if obs['error'] else []) if phase == 'calibration' else measure.judge(spec, obs, turn),
        }
        record.update(extra or {})
        records.append(record)
        return record

    def probe_for(workload_id):
        def probe(count):
            record = request('calibration', None, workload_id, count, max_tokens=1)
            if record['problems'] or not isinstance(record['prompt_tokens'], int):
                raise CalibrationError('%s: %s' % (workload_id, '; '.join(record['problems']) or 'the engine reported no prompt_tokens'))
            return record['prompt_tokens']
        return probe

    filler, increments, fits = {}, {}, {}
    for name in sorted(selected, key=lambda n: WORKLOADS[n]['input_tokens']):
        if WORKLOADS[name]['input_tokens'] <= workload.DIRECT_CALIBRATION_LIMIT:
            filler[name], _ = calibrate(probe_for(name), WORKLOADS[name]['input_tokens'])
    for name in selected:
        if name in filler:
            continue
        template = workload.template_of(name)
        if template not in fits:
            probe = probe_for(workload.FIT_WORKLOAD[template])
            words, points = calibrate(probe, workload.FIT_TOKENS)
            tokens = points[-1][1]
            fits[template] = {'words': words, 'tokens': tokens, 'slope': fit_slope(points, probe)}
        fit = fits[template]
        filler[name] = max(0, fit['words'] + round((WORKLOADS[name]['input_tokens'] - fit['tokens']) / fit['slope']))
        if WORKLOADS[name]['kind'] == 'agent':
            increments[name] = max(1, round(WORKLOADS[name]['increment_tokens'] / fit['slope']))

    def run_agent(phase, index, workload_id):
        spec, nonce = WORKLOADS[workload_id], new_nonce()
        rows = [request(phase, index, workload_id, filler[workload_id], turn=turn, increment_words=increments[workload_id],
                        nonce=nonce) for turn in range(1, spec['turns'] + 1)]
        warm = rows[1:]
        if (rows[0]['ttft_seconds'] is not None and all(r['ttft_seconds'] is not None and r['cached_tokens'] is None for r in warm)
                and not any(r['problems'] for r in rows)):
            ratio = statistics.median(r['ttft_seconds'] for r in warm) / rows[0]['ttft_seconds']
            if ratio > workload.UNREPORTED_CACHE_SPEEDUP:
                rows[-1]['problems'].append('the engine reports no cached tokens and its warm turns took %.2f of the cold turn\'s '
                                            'time to the first token, so no cache reuse is evident' % ratio)
        return rows

    def run_batch(phase, index, workload_id):
        spec, rows, barrier = WORKLOADS[workload_id], [], threading.Barrier(WORKLOADS[workload_id]['concurrency'])

        def worker(number):
            barrier.wait()
            for sequence in range(1, spec['requests_per_worker'] + 1):
                row = request(phase, index, workload_id, filler[workload_id], extra={'worker': number, 'sequence': sequence})
                with lock:
                    rows.append(row)

        threads = [threading.Thread(target=worker, args=(number,)) for number in range(spec['concurrency'])]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        return rows

    def run_instance(phase, index, workload_id):
        kind = WORKLOADS[workload_id]['kind']
        if kind == 'agent':
            return run_agent(phase, index, workload_id)
        if kind == 'batch':
            return run_batch(phase, index, workload_id)
        return [request(phase, index, workload_id, filler[workload_id])]

    sampler = measure.MemorySampler(memory_pid) if observe_machine and memory_pid else None
    swap_before = formal_start = None
    for index in range(warmup + repetitions):
        phase = 'warm-up' if index < warmup else 'formal'
        if index == warmup:
            swap_before = measure.swap_out_bytes() if observe_machine else None
            if sampler:
                sampler.start()
            formal_start = time.monotonic()
        batch = [row for name in selected for row in run_instance(phase, index, name)]
        issues = ['%s: %s' % (r['workload'], p) for r in batch for p in r['problems']]
        outcome = 'timed-out' if any(r['timed_out'] for r in batch) else 'failed' if issues else 'succeeded'
        passes.append({'phase': phase, 'index': index, 'outcome': outcome, 'failure_description': '; '.join(issues)})
    formal_seconds = time.monotonic() - formal_start
    swap_after = measure.swap_out_bytes() if observe_machine else None
    peak_gib = sampler.stop() if sampler else None
    swap_delta = swap_after - swap_before if swap_before is not None and swap_after is not None and swap_after >= swap_before else None
    return {'records': records, 'passes': passes, 'selected': selected, 'filler_words': filler, 'increment_words': increments,
            'fit_slopes': {template: fit['slope'] for template, fit in fits.items()}, 'formal_seconds': formal_seconds,
            'swap_out_delta_bytes': swap_delta, 'peak_memory_gib': peak_gib}


def throughput(basis, tokens, seconds):
    """Ratio of sums. The value is computed from the stored, rounded seconds so the document is self-consistent."""
    seconds = round(seconds, 6)
    if seconds <= 0:
        return NOT_OBTAINED
    return {'basis': basis, 'total_tokens': tokens, 'total_seconds': seconds, 'tokens_per_second': tokens / seconds}


def prefill_aggregate(rows):
    return throughput('processed-input-tokens', sum(r['prompt_tokens'] - (r['cached_tokens'] or 0) for r in rows),
                      sum(r['ttft_seconds'] for r in rows))


def decode_aggregate(rows, notes, key):
    """N-1 tokens over first-to-last chunk intervals, only while chunks are close to one per token."""
    rows = [r for r in rows if r['completion_tokens'] >= 2 and r['decode_seconds']]
    if not rows:
        return NOT_OBTAINED
    ratio = sum(r['chunks'] for r in rows) / sum(r['completion_tokens'] for r in rows)
    notes['decode_chunk_token_ratio.' + key] = round(ratio, 4)
    if ratio >= workload.MIN_CHUNK_TOKEN_RATIO:
        return throughput('n-minus-1-intervals', sum(r['completion_tokens'] - 1 for r in rows), sum(r['decode_seconds'] for r in rows))
    notes['decode_not_obtained_reason.' + key] = ('the engine sent %.2f output chunks per token, below %.2f, so the N-1 interval '
                                                  'definition does not apply' % (ratio, workload.MIN_CHUNK_TOKEN_RATIO))
    return NOT_OBTAINED


def window_seconds(rows):
    return max(r['ended_seconds'] for r in rows) - min(r['started_seconds'] for r in rows)


def instance_value(kind, rows, notes):
    """The workload's headline tokens per second for one instance, or None."""
    if kind == 'prefill':
        aggregate = prefill_aggregate(rows)
    elif kind == 'agent':
        aggregate = prefill_aggregate([r for r in rows if r['turn'] == 1])
    elif kind == 'decode':
        aggregate = decode_aggregate(rows, {}, '')
    else:
        seconds = window_seconds(rows)
        return sum(r['completion_tokens'] for r in rows) / seconds if seconds > 0 else None
    return None if aggregate == NOT_OBTAINED else aggregate['tokens_per_second']


VARIABILITY_METRIC = {'prefill': 'prefill tokens per second', 'agent': 'cold prefill tokens per second',
                      'decode': 'decode tokens per second', 'batch': 'aggregate output tokens per second'}


def workload_result(run, workload_id, notes):
    spec = WORKLOADS[workload_id]
    kind = spec['kind']
    groups = {}
    for r in run['records']:
        if r['phase'] == 'formal' and r['workload'] == workload_id:
            groups.setdefault(r['pass'], []).append(r)
    rows = [r for group in groups.values() for r in group]
    good = [group for group in groups.values() if not any(r['problems'] for r in group)]
    used = [r for group in good for r in group]
    result = {'workload_id': workload_id, 'kind': kind, 'input_tokens': spec['input_tokens'],
              'output_tokens': spec['output_tokens'], 'concurrency': spec.get('concurrency', 1), 'requests': len(rows),
              'succeeded_requests': sum(1 for r in rows if not r['problems']), 'prefill': NOT_OBTAINED, 'decode': NOT_OBTAINED,
              'ttft_median_seconds': NOT_OBTAINED}
    if kind == 'prefill' and used:
        result['prefill'] = prefill_aggregate(used)
        result['ttft_median_seconds'] = statistics.median(r['ttft_seconds'] for r in used)
    elif kind == 'decode' and used:
        result['decode'] = decode_aggregate(used, notes, workload_id)
        result['ttft_median_seconds'] = statistics.median(r['ttft_seconds'] for r in used)
    elif kind == 'agent':
        cold, warm = [r for r in used if r['turn'] == 1], [r for r in used if r['turn'] > 1]
        if cold:
            result['prefill'] = prefill_aggregate(cold)
        if warm:
            result['ttft_median_seconds'] = statistics.median(r['ttft_seconds'] for r in warm)
        if cold and warm:
            known = all(isinstance(r['cached_tokens'], int) for r in warm)
            inputs, cached = sum(r['prompt_tokens'] for r in warm), sum(r['cached_tokens'] or 0 for r in warm)
            cold_ttft, warm_ttft = statistics.median(r['ttft_seconds'] for r in cold), result['ttft_median_seconds']
            result['cache'] = {
                'input_tokens': inputs, 'cached_input_tokens': cached if known else NOT_OBTAINED,
                'hit_ratio': round(cached / inputs, 4) if known else NOT_OBTAINED,
                'cold_ttft_median_seconds': cold_ttft, 'warm_ttft_median_seconds': warm_ttft,
                'speedup': round(cold_ttft / warm_ttft, 3) if warm_ttft > 0 else NOT_OBTAINED}
    elif kind == 'batch' and used:
        result['decode'] = decode_aggregate(used, notes, workload_id)
        result['ttft_median_seconds'] = statistics.median(r['ttft_seconds'] for r in used)
        result['aggregate_output'] = throughput('concurrent-window-output-tokens', sum(r['completion_tokens'] for r in used),
                                                sum(window_seconds(group) for group in good))
    values = [instance_value(kind, group, notes) for group in good]
    values = [round(v, 4) for v in values if v is not None]
    if values and not (kind == 'decode' and result['decode'] == NOT_OBTAINED):
        result['variability'] = {'metric': VARIABILITY_METRIC[kind], 'values': values,
                                 'sample_stddev': round(statistics.stdev(values), 4) if len(values) > 1 else NOT_OBTAINED}
    return result


def summarize(run):
    """Per-workload results and the run-level metrics; every request stays in the evidence either way."""
    notes = {}
    results = {name: workload_result(run, name, notes) for name in run['selected']}
    formal_passes = [p for p in run['passes'] if p['phase'] == 'formal']
    formal = [r for r in run['records'] if r['phase'] == 'formal']
    per_pass = sum(workload.requests_per_instance(WORKLOADS[name]) for name in run['selected'])
    succeeded = sum(1 for p in formal_passes if p['outcome'] == 'succeeded')
    reconciled = (len(formal) == len(formal_passes) * per_pass
                  and all(isinstance(r['prompt_tokens'], int) and isinstance(r['completion_tokens'], int) for r in formal))
    prefill = results.get(workload.HEADLINE_PREFILL)
    decode = results.get(workload.HEADLINE_DECODE)
    return {
        'formal_repetitions': succeeded, 'preliminary': succeeded <= 1,
        'prefill': prefill['prefill'] if prefill else NOT_OBTAINED,
        'decode': decode['decode'] if decode else NOT_OBTAINED,
        'client_ttft_median_seconds': prefill['ttft_median_seconds'] if prefill else NOT_OBTAINED,
        'application_duration_seconds': round(run['formal_seconds'], 3) if run['formal_seconds'] > 0 else NOT_OBTAINED,
        'requests_reconciled': reconciled, 'passed_requests': sum(1 for r in formal if not r['problems']),
        'total_requests': len(formal), 'workloads': list(results.values()), 'notes': notes,
        'cached_tokens_reported': bool(formal) and all(isinstance(r['cached_tokens'], int) for r in formal),
    }


SELF_TEST_RATES = {'prefill': 40000.0, 'decode': 800.0}
FAST_PREFILL = 400000.0
RATE_TOLERANCE = 0.30
TIMING_WORKLOADS = ['prefill.in2k.out1', 'prefill.in4k.out1', 'prefill.in8k.out1', 'decode.in128.out256', 'decode.in8k.out256',
                    'batch.c1.in512.out64', 'batch.c8.in512.out64']
SLOW_WORKLOADS = ['prefill.in2k.out1', 'decode.in128.out256']
LONG_WORKLOADS = ['prefill.in216k.out1', 'decode.in32k.out256', 'agent.p32k.s256.t5']
FAULT_WORKLOADS = ['prefill.in2k.out1', 'decode.in128.out256', 'agent.p32k.s256.t5']


def reference_run(workloads, faults=(), scale=1.0, prefill_rate=None, warmup=0, repetitions=2):
    from reference_engine import ReferenceEngine
    rate = (prefill_rate or SELF_TEST_RATES['prefill']) * scale
    with ReferenceEngine(rate, SELF_TEST_RATES['decode'] * scale, faults) as engine:
        return execute(engine.origin, engine.model, None, 120.0, warmup, repetitions, {}, SEED, 'self-test', workloads=workloads)


def formal_failures(run):
    return [p['failure_description'] for p in run['passes'] if p['phase'] == 'formal' and p['outcome'] != 'succeeded']


def formal_count(run):
    return sum(1 for p in run['passes'] if p['phase'] == 'formal')


def self_test():
    """Negative control: known rates and cache behavior must be recovered, and each injected fault must be caught.

    Returns (ok, problems, the timing run, its summary).
    """
    from concurrent.futures import ThreadPoolExecutor
    from reference_engine import FAULTS

    def attempt(*args, **kwargs):
        try:
            return reference_run(*args, **kwargs)
        except CalibrationError as exc:
            return exc

    # Timing-sensitive scenarios run alone so other threads do not disturb their sleeps.
    with ThreadPoolExecutor(max_workers=2) as pool:
        timing_future = pool.submit(attempt, TIMING_WORKLOADS)
        slow_future = pool.submit(attempt, SLOW_WORKLOADS, scale=0.5)
        timing, slow = timing_future.result(), slow_future.result()
    with ThreadPoolExecutor(max_workers=len(FAULTS) + 1) as pool:
        long_future = pool.submit(attempt, LONG_WORKLOADS, prefill_rate=FAST_PREFILL)
        fault_futures = {fault: pool.submit(attempt, FAULT_WORKLOADS, (fault,), prefill_rate=FAST_PREFILL) for fault in FAULTS}
        long, faulty = long_future.result(), {fault: future.result() for fault, future in fault_futures.items()}

    problems, summary = [], None
    for label, run in (('timing', timing), ('slow', slow), ('long-context', long)):
        if isinstance(run, Exception):
            problems.append('the reference engine could not be calibrated in the %s scenario: %s' % (label, run))
        elif formal_failures(run) or not summarize(run)['requests_reconciled']:
            problems.append('the reference engine does not pass the %s scenario: %s'
                            % (label, '; '.join(formal_failures(run)) or 'requests were not reconciled'))
    if not problems:
        summary = summarize(timing)
        slow_summary = summarize(slow)
        found = {w['workload_id']: w for w in summary['workloads']}
        slow_found = {w['workload_id']: w for w in slow_summary['workloads']}

        def rate(results, name, key):
            aggregate = results[name][key]
            return None if aggregate == NOT_OBTAINED else aggregate['tokens_per_second']

        def expect(label, measured, expected, tolerance=RATE_TOLERANCE):
            if measured is None:
                problems.append('%s was not obtained from the reference engine' % label)
            elif abs(measured - expected) > tolerance * expected:
                problems.append('%s read %.0f tok/s for a known %.0f tok/s' % (label, measured, expected))

        for name in ('prefill.in2k.out1', 'prefill.in4k.out1', 'prefill.in8k.out1'):
            expect(name + ' prefill', rate(found, name, 'prefill'), SELF_TEST_RATES['prefill'])
        for name in ('decode.in128.out256', 'decode.in8k.out256', 'batch.c1.in512.out64'):
            expect(name + ' decode', rate(found, name, 'decode'), SELF_TEST_RATES['decode'])
        expect('batch.c8 per-request decode', rate(found, 'batch.c8.in512.out64', 'decode'), SELF_TEST_RATES['decode'] / 4, 0.4)
        c1, c8 = rate(found, 'batch.c1.in512.out64', 'aggregate_output'), rate(found, 'batch.c8.in512.out64', 'aggregate_output')
        if c1 is None or c8 is None or not 1.5 <= c8 / c1 <= 3.0:
            problems.append('concurrent aggregate throughput did not scale as the engine\'s two slots allow (c1 %s, c8 %s)' % (c1, c8))
        for name, key in (('prefill.in2k.out1', 'prefill'), ('decode.in128.out256', 'decode')):
            fast, slower = rate(found, name, key), rate(slow_found, name, key)
            if fast is None or slower is None or not 1.5 <= fast / slower <= 2.6:
                problems.append('%s throughput did not halve with the engine (%s versus %s)' % (key, fast, slower))
        agent = next(w for w in summarize(long)['workloads'] if w['kind'] == 'agent')
        cache = agent.get('cache')
        if not cache or cache['hit_ratio'] == NOT_OBTAINED or cache['hit_ratio'] < workload.CACHE_HIT_FLOOR \
                or cache['speedup'] == NOT_OBTAINED or cache['speedup'] < 2:
            problems.append('the agent workload did not show cache reuse on the reference engine: %s' % (cache,))

    def caught(fault, run):
        if fault in ('no_usage', 'http_error'):
            return isinstance(run, CalibrationError)
        if isinstance(run, Exception):
            return False
        failures = formal_failures(run)
        every = len(failures) == formal_count(run)
        if fault == 'reports_cached':
            return every and all('cached prompt tokens' in text for text in failures)
        if fault == 'stops_early':
            return every and all('output tokens' in text for text in failures)
        if fault == 'no_prefix_cache':
            return every and all('cached prompt tokens for a repeated prefix' in text for text in failures)
        if fault == 'coalesced_chunks':
            results = {w['workload_id']: w for w in summarize(run)['workloads']}
            return not failures and results['decode.in128.out256']['decode'] == NOT_OBTAINED \
                and 'decode_not_obtained_reason.decode.in128.out256' in summarize(run)['notes']
        return False

    for fault, run in faulty.items():
        if not caught(fault, run):
            problems.append('fault %s was not detected' % fault)
    return not problems, problems, timing, summary


def validate_origin(value):
    parts = urlsplit(value)
    loopback = parts.hostname in ('127.0.0.1', 'localhost', '::1')
    if (parts.scheme not in ('http', 'https') or not parts.hostname or parts.username or parts.password
            or parts.query or parts.fragment or parts.path not in ('', '/')):
        raise SystemExit('--endpoint must be a credential-free origin such as http://127.0.0.1:8080')
    if parts.scheme == 'http' and not loopback:
        raise SystemExit('Plain http is only allowed for a loopback endpoint.')
    return '%s://%s' % (parts.scheme, parts.netloc), parts.scheme, 'loopback' if loopback else 'remote'


def parse_fields(items):
    fields = {}
    for item in items:
        key, separator, raw = item.partition('=')
        if not separator or not key:
            raise SystemExit('--request-field must look like KEY=JSON_VALUE.')
        if key in measure.FIXED_FIELDS:
            raise SystemExit('The request field %s is fixed by the evaluation.' % key)
        try:
            value = json.loads(raw)
        except ValueError:
            raise SystemExit('--request-field %s: the value must be JSON, for example 256 or true.' % key)
        if not isinstance(value, (str, int, float, bool)):
            raise SystemExit('--request-field %s: only scalar values are recorded.' % key)
        fields[key] = value
    return fields


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


def parse_workloads(value):
    names = [name for name in value.split(',') if name] if value else list(WORKLOADS)
    unknown = [name for name in names if name not in WORKLOADS]
    if unknown or not names:
        raise SystemExit('Unknown workload(s): %s. Known workloads: %s' % (', '.join(unknown) or '(none given)', ', '.join(WORKLOADS)))
    return [name for name in WORKLOADS if name in names]


def build_result(info, run, summary, control, evidence_ref):
    formal = [r for r in run['records'] if r['phase'] == 'formal']
    settings = {
        'api': 'openai-chat-completions-stream', 'temperature': 0, 'seed': SEED,
        'workloads': ','.join(run['selected']), 'warmup_passes': info['warmup'], 'formal_passes': info['repetitions'],
        'endpoint_scheme': info['scheme'], 'endpoint_host_class': info['host_class'],
        'input_tokens_counted_by': 'the engine-reported usage.prompt_tokens, which includes the chat template',
        'prefill_seconds_definition': ('client time from dispatch to the first output chunk; it includes queueing, transfer, '
                                       'and the first sampled token'),
        'decode_definition': ('usage.completion_tokens minus 1 divided by the time from the first to the last output chunk; '
                              'it applies only while chunks are at least 0.9 per token'),
        'aggregate_output_definition': ('output tokens of all requests in a closed-loop batch divided by the time from the '
                                        'first dispatch to the last completion, including ramp-up and ramp-down'),
        'cache_policy_applied': ('a unique nonce starts every session; reported cached tokens must be zero except on warm agent '
                                 'turns, which must reuse at least 0.9 of the shared prefix'),
        'cached_tokens_reported': summary['cached_tokens_reported'],
    }
    for name, count in run['filler_words'].items():
        settings['filler_words.' + name] = count
    for name, count in run['increment_words'].items():
        settings['increment_words.' + name] = count
    for template, slope in run['fit_slopes'].items():
        settings['calibration_tokens_per_word.' + template] = round(slope, 4)
    settings.update(summary['notes'])
    settings.update({'request_field.' + key: value for key, value in info['fields'].items()})
    if info.get('memory_definition'):
        settings['peak_memory_definition'] = info['memory_definition']
    repetitions = []
    for entry in run['passes']:
        item = {'phase': entry['phase'], 'outcome': entry['outcome']}
        if entry['outcome'] != 'succeeded':
            item['failure_description'] = entry['failure_description'] or entry['outcome']
        repetitions.append(item)
    return {
        'evaluation': {'evaluation_id': json.loads(DEFINITION.read_text())['evaluation_id'],
                       'revision': info['evaluation_revision'], 'sha256': sha256_file(DEFINITION)},
        'role': info['role'],
        'engine_name': info['engine_name'],
        'environment': info['environment'],
        'runtime_revision': info['runtime_revision'],
        'artifacts': info['artifacts'],
        'commands': info['commands'],
        'settings': settings,
        'repetitions': repetitions,
        'metrics': {key: summary[key] for key in (
            'formal_repetitions', 'preliminary', 'prefill', 'decode', 'client_ttft_median_seconds',
            'application_duration_seconds', 'requests_reconciled')} | {'per_request_evidence': evidence_ref},
        'workloads': summary['workloads'],
        'resources': {'peak_memory_gib': NOT_OBTAINED if run['peak_memory_gib'] is None else round(run['peak_memory_gib'], 3),
                      'swap_out_delta_bytes': NOT_OBTAINED if run['swap_out_delta_bytes'] is None else run['swap_out_delta_bytes']},
        'quality': {'application': {'passed': summary['passed_requests'], 'total': len(formal),
                                    'negative_control_verified': control['verified'], 'restricted_environment': True}},
    }


def write_evidence(path, run, salt):
    path.write_text(json.dumps({'salt': salt, 'filler_words': run['filler_words'], 'increment_words': run['increment_words'],
                                'requests': run['records']}, indent=2) + '\n')
    return {'description': 'Per-request timings, token counts, and gate outcomes; it holds no prompts or model output',
            'access': 'local-only', 'sha256': sha256_file(path),
            'access_limitation': 'Kept next to the result document and not committed to the repository.'}


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--describe', action='store_true', help='Print the task ids and limits as JSON')
    parser.add_argument('--self-test', action='store_true', help='Run the negative control against a reference engine')
    parser.add_argument('--emit-result', type=Path, help='With --self-test, write the reference run as a result document')
    parser.add_argument('--endpoint', help='Origin of the engine, for example http://127.0.0.1:8080')
    parser.add_argument('--model', help='Model name sent in requests')
    parser.add_argument('--role', choices=('baseline', 'candidate'))
    parser.add_argument('--engine-name')
    parser.add_argument('--workloads', help='Comma-separated task ids to run (default: all of them)')
    parser.add_argument('--warmup', type=int, help='Warm-up passes from the contract (0 or more)')
    parser.add_argument('--repetitions', type=int, help='Formal passes from the contract (1 or more)')
    parser.add_argument('--api-key-file', type=Path, help='Read privately; never logged')
    parser.add_argument('--request-field', action='append', default=[], help='KEY=JSON_VALUE added to every request (repeatable)')
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
    required = ('endpoint', 'model', 'role', 'engine_name', 'warmup', 'repetitions', 'evaluation_revision', 'output',
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
    key = args.api_key_file.read_text().strip() if args.api_key_file else None
    return {'origin': origin, 'scheme': scheme, 'host_class': host_class, 'fields': parse_fields(args.request_field),
            'artifacts': parse_artifacts(args.artifact), 'workloads': parse_workloads(args.workloads), 'key': key,
            'timeout': json.loads(DEFINITION.read_text())['limits']['timeout_seconds_per_task'], 'evidence_path': evidence_path}


def emit_reference(args, control, run, summary):
    path = args.emit_result
    evidence = write_evidence(path.with_name(path.stem + '.requests.evidence'), run, 'self-test')
    info = {
        'role': 'candidate', 'engine_name': 'reference-engine', 'warmup': 0, 'repetitions': 2, 'fields': {},
        'scheme': 'http', 'host_class': 'loopback', 'evaluation_revision': args.evaluation_revision,
        'runtime_revision': {'unavailable': True, 'reason': 'The reference engine is not versioned.'},
        'artifacts': [{'name': 'reference_engine.py', 'sha256': sha256_file(HERE / 'reference_engine.py')}],
        'commands': ['throughput.py --self-test'],
        'environment': {'hardware_model': 'not applicable: reference engine', 'os_version': platform.platform(),
                        'toolchain': 'Python %s' % platform.python_version(), 'power_mode': 'not applicable',
                        'thermal_observations': 'not observed', 'exclusive_gpu': False,
                        'deviations_from_contract': ['Synthetic reference run; not a measurement of any engine.']},
    }
    path.write_text(json.dumps(build_result(info, run, summary, control, evidence), indent=2) + '\n')


def describe():
    return {'task_ids': list(WORKLOADS), 'workloads': WORKLOADS,
            'limits': {'max_output_tokens_per_request': max(w['output_tokens'] for w in WORKLOADS.values()),
                       'request_concurrency': workload.max_concurrency(),
                       'max_input_tokens': max(workload.expected_input(w, w.get('turns', 1)) for w in WORKLOADS.values())}}


def print_summary(summary, run, repetitions):
    for item in summary['workloads']:
        parts = []
        for key in ('prefill', 'decode', 'aggregate_output'):
            value = item.get(key, NOT_OBTAINED)
            if value != NOT_OBTAINED:
                parts.append('%s %.2f tok/s' % (key.replace('_', ' '), value['tokens_per_second']))
        if 'cache' in item and item['cache']['hit_ratio'] != NOT_OBTAINED:
            parts.append('cache hit %.1f%%' % (100 * item['cache']['hit_ratio']))
        print('%s: %s (%d of %d requests passed)' % (item['workload_id'], ', '.join(parts) or NOT_OBTAINED,
                                                     item['succeeded_requests'], item['requests']))
    print('%d of %d formal passes succeeded' % (summary['formal_repetitions'], repetitions))


def main():
    args = parse_args()
    if args.describe:
        print(json.dumps(describe()))
        return 0
    prepared = None if args.self_test else prepare(args)
    ok, problems, reference, summary = self_test()
    control = {'verified': ok}
    if args.self_test:
        from reference_engine import FAULTS
        print('self-test: %s (%d faults)' % ('ok' if ok else 'FAILED', len(FAULTS)))
        for problem in problems:
            print('  ' + problem)
        if args.emit_result and ok:
            if not args.evaluation_revision:
                raise SystemExit('--emit-result needs --evaluation-revision.')
            emit_reference(args, control, reference, summary)
        return 0 if ok else 1
    if not ok:
        raise SystemExit('The self-test failed, so this evaluation is not trustworthy:\n  ' + '\n  '.join(problems))

    salt = hashlib.sha256((now() + str(time.monotonic())).encode()).hexdigest()[:16]
    try:
        run = execute(prepared['origin'], args.model, prepared['key'], prepared['timeout'], args.warmup, args.repetitions,
                      prepared['fields'], SEED, salt, workloads=prepared['workloads'],
                      observe_machine=prepared['host_class'] == 'loopback', memory_pid=args.memory_pid)
    except CalibrationError as exc:
        raise SystemExit('Calibration failed, so nothing was measured: %s' % exc)
    summary = summarize(run)
    evidence = write_evidence(prepared['evidence_path'], run, salt)
    deviations = list(args.deviation)
    if prepared['host_class'] == 'remote':
        deviations.append('The endpoint is remote, so client timings include network transfer.')
    info = {
        'role': args.role, 'engine_name': args.engine_name, 'warmup': args.warmup, 'repetitions': args.repetitions,
        'fields': prepared['fields'], 'scheme': prepared['scheme'], 'host_class': prepared['host_class'],
        'evaluation_revision': args.evaluation_revision,
        'runtime_revision': args.runtime_revision or {'unavailable': True, 'reason': 'No runtime revision was supplied.'},
        'artifacts': prepared['artifacts'], 'commands': [' '.join(sys.argv)] + args.engine_command,
        'memory_definition': ('resident set size of PID %d sampled every %.1f seconds during the formal passes; it may not '
                              'include GPU memory' % (args.memory_pid, measure.MemorySampler.INTERVAL_SECONDS)) if args.memory_pid else None,
        'environment': {'hardware_model': args.hardware_model, 'os_version': platform.platform(),
                        'toolchain': args.toolchain, 'power_mode': args.power_mode,
                        'thermal_observations': args.thermal_observations, 'exclusive_gpu': args.exclusive_gpu,
                        'deviations_from_contract': deviations},
    }
    args.output.write_text(json.dumps(build_result(info, run, summary, control, evidence), indent=2) + '\n')
    print_summary(summary, run, args.repetitions)
    return 0 if not formal_failures(run) else 1


if __name__ == '__main__':
    raise SystemExit(main())
