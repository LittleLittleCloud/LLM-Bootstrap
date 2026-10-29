#!/usr/bin/env python3
"""Measure prefill and decode throughput of an OpenAI-compatible streaming chat endpoint.

Every request has a fixed input and output length and a unique prompt, so no prefix can be reused. Intervals are timed on
one monotonic clock at the client. Standard library only (Python 3.9+). See the evaluation protocol in the experiment skill.
"""
import argparse
import datetime
import hashlib
import json
import platform
import re
import statistics
import sys
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
    """Find the filler length whose prompt the engine counts as about `target` tokens, using the engine's own usage."""
    tolerance = max(2, workload.input_tolerance(target) // 2)
    words, slope, last = max(1, round(target / 1.3)), 1.3, None
    for _ in range(MAX_CALIBRATION_PROBES):
        tokens = probe(words)
        if abs(tokens - target) <= tolerance:
            return words
        if last and last[0] != words and (tokens - last[1]) * (words - last[0]) > 0:
            slope = (tokens - last[1]) / (words - last[0])
        last = (words, tokens)
        words = max(0, words + round((target - tokens) / slope))
    raise CalibrationError('could not size a prompt to about %d tokens in %d probes' % (target, MAX_CALIBRATION_PROBES))


def execute(origin, model, api_key, timeout, warmup, repetitions, fields, seed, salt, observe_machine=False, memory_pid=None):
    """Calibrate prompt sizes, run the warm-up and formal passes serially, and return every request record."""
    records, passes, counter = [], [], [0]

    def request(phase, index, workload_id, filler_words, max_tokens=None):
        spec = WORKLOADS[workload_id]
        counter[0] += 1
        nonce = workload.make_nonce(salt, seed, counter[0])
        prompt = workload.build_prompt(workload_id, nonce, filler_words, seed)
        obs = measure.observe(origin, model, prompt, max_tokens or spec['output_tokens'], api_key, timeout, fields)
        records.append({
            'phase': phase, 'pass': index, 'workload': workload_id, 'nonce': nonce, 'filler_words': filler_words,
            'status': obs['status'], 'prompt_tokens': obs['prompt_tokens'], 'cached_tokens': obs['cached_tokens'],
            'completion_tokens': obs['completion_tokens'], 'chunks': obs['chunks'], 'finish_reason': obs['finish_reason'],
            'ttft_seconds': obs['first'],
            'decode_seconds': None if obs['first'] is None else obs['last'] - obs['first'],
            'timed_out': obs['timed_out'],
            'problems': ([obs['error']] if obs['error'] else []) if phase == 'calibration' else measure.judge(spec, obs),
        })
        return records[-1]

    filler = {}
    for workload_id, spec in WORKLOADS.items():
        def probe(count, workload_id=workload_id):
            record = request('calibration', None, workload_id, count, max_tokens=1)
            if record['problems'] or not isinstance(record['prompt_tokens'], int):
                raise CalibrationError('%s: %s' % (workload_id, '; '.join(record['problems']) or 'the engine reported no prompt_tokens'))
            return record['prompt_tokens']
        filler[workload_id] = calibrate(probe, spec['input_tokens'])

    sampler = measure.MemorySampler(memory_pid) if observe_machine and memory_pid else None
    swap_before = formal_start = None
    for index in range(warmup + repetitions):
        phase = 'warm-up' if index < warmup else 'formal'
        if index == warmup:
            swap_before = measure.swap_out_bytes() if observe_machine else None
            if sampler:
                sampler.start()
            formal_start = time.monotonic()
        batch = [request(phase, index, workload_id, filler[workload_id]) for workload_id in WORKLOADS]
        issues = ['%s: %s' % (r['workload'], p) for r in batch for p in r['problems']]
        outcome = 'timed-out' if any(r['timed_out'] for r in batch) else 'failed' if issues else 'succeeded'
        passes.append({'phase': phase, 'index': index, 'outcome': outcome, 'failure_description': '; '.join(issues)})
    formal_seconds = time.monotonic() - formal_start
    swap_after = measure.swap_out_bytes() if observe_machine else None
    peak_gib = sampler.stop() if sampler else None
    swap_delta = swap_after - swap_before if swap_before is not None and swap_after is not None and swap_after >= swap_before else None
    return {'records': records, 'passes': passes, 'filler_words': filler, 'formal_seconds': formal_seconds,
            'swap_out_delta_bytes': swap_delta, 'peak_memory_gib': peak_gib}


def throughput(basis, tokens, seconds):
    """Ratio of sums. The value is computed from the stored, rounded seconds so the document is self-consistent."""
    seconds = round(seconds, 6)
    if seconds <= 0:
        return NOT_OBTAINED
    return {'basis': basis, 'total_tokens': tokens, 'total_seconds': seconds, 'tokens_per_second': tokens / seconds}


def summarize(run):
    """Run-level metrics from the formal passes that succeeded; every request stays in the evidence either way."""
    formal_passes = [p for p in run['passes'] if p['phase'] == 'formal']
    good = {p['index'] for p in formal_passes if p['outcome'] == 'succeeded'}
    formal = [r for r in run['records'] if r['phase'] == 'formal']
    used = [r for r in formal if r['pass'] in good]
    kind = lambda r: WORKLOADS[r['workload']]['kind']  # noqa: E731
    prefill_rows = [r for r in used if kind(r) == 'prefill']
    decode_rows = [r for r in used if kind(r) == 'decode' and r['completion_tokens'] >= 2 and r['decode_seconds']]
    notes = {}
    prefill = throughput('processed-input-tokens', sum(r['prompt_tokens'] - (r['cached_tokens'] or 0) for r in prefill_rows),
                         sum(r['ttft_seconds'] for r in prefill_rows)) if prefill_rows else NOT_OBTAINED
    decode = NOT_OBTAINED
    if decode_rows:
        ratio = sum(r['chunks'] for r in decode_rows) / sum(r['completion_tokens'] for r in decode_rows)
        notes['decode_chunk_token_ratio'] = round(ratio, 4)
        if ratio >= workload.MIN_CHUNK_TOKEN_RATIO:
            decode = throughput('n-minus-1-intervals', sum(r['completion_tokens'] - 1 for r in decode_rows),
                                sum(r['decode_seconds'] for r in decode_rows))
        else:
            notes['decode_not_obtained_reason'] = ('the engine sent %.2f output chunks per token, below %.2f, so the N-1 '
                                                   'interval definition does not apply' % (ratio, workload.MIN_CHUNK_TOKEN_RATIO))
    reconciled = (len(formal) == len(formal_passes) * len(WORKLOADS)
                  and all(isinstance(r['prompt_tokens'], int) and isinstance(r['completion_tokens'], int) for r in formal))
    return {
        'formal_repetitions': len(good), 'preliminary': len(good) <= 1, 'prefill': prefill, 'decode': decode,
        'client_ttft_median_seconds': statistics.median(r['ttft_seconds'] for r in prefill_rows) if prefill_rows else NOT_OBTAINED,
        'application_duration_seconds': round(run['formal_seconds'], 3) if run['formal_seconds'] > 0 else NOT_OBTAINED,
        'requests_reconciled': reconciled, 'passed_requests': sum(1 for r in formal if not r['problems']),
        'total_requests': len(formal), 'notes': notes,
        'cached_tokens_reported': bool(formal) and all(isinstance(r['cached_tokens'], int) for r in formal),
    }


SELF_TEST_RATES = {'prefill': 40000.0, 'decode': 800.0}
RATE_TOLERANCE = 0.30


def reference_run(faults=(), scale=1.0):
    from reference_engine import ReferenceEngine
    with ReferenceEngine(SELF_TEST_RATES['prefill'] * scale, SELF_TEST_RATES['decode'] * scale, faults) as engine:
        return execute(engine.origin, engine.model, None, 30.0, 1, 2, {}, SEED, 'self-test')


def self_test():
    """Negative control: known rates must be recovered, slower rates must read slower, and each fault must be caught."""
    from concurrent.futures import ThreadPoolExecutor
    from reference_engine import FAULTS

    def attempt(faults=(), scale=1.0):
        try:
            return reference_run(faults, scale)
        except CalibrationError as exc:
            return exc

    with ThreadPoolExecutor(max_workers=2) as pool:
        reference_future, slow_future = pool.submit(attempt), pool.submit(attempt, (), 0.5)
        reference, slow = reference_future.result(), slow_future.result()
    with ThreadPoolExecutor(max_workers=len(FAULTS)) as pool:
        futures = {fault: pool.submit(attempt, (fault,)) for fault in FAULTS}
        faulty = {fault: future.result() for fault, future in futures.items()}

    problems, summary = [], None
    if isinstance(reference, Exception) or isinstance(slow, Exception):
        problems.append('the reference engine could not be calibrated: %s' % (reference if isinstance(reference, Exception) else slow))
    else:
        summary, slow_summary = summarize(reference), summarize(slow)
        failed = [p['failure_description'] for p in reference['passes'] if p['outcome'] != 'succeeded']
        if failed or not summary['requests_reconciled']:
            problems.append('the reference engine does not pass: %s' % ('; '.join(failed) or 'requests were not reconciled'))
        for name in ('prefill', 'decode'):
            expected = SELF_TEST_RATES[name]
            measured, slower = summary[name], slow_summary[name]
            if measured == NOT_OBTAINED or slower == NOT_OBTAINED:
                problems.append('%s throughput was not obtained from the reference engine' % name)
                continue
            if abs(measured['tokens_per_second'] - expected) > RATE_TOLERANCE * expected:
                problems.append('%s throughput read %.0f tok/s for a known %.0f tok/s' % (name, measured['tokens_per_second'], expected))
            ratio = measured['tokens_per_second'] / slower['tokens_per_second']
            if not 1.5 <= ratio <= 2.6:
                problems.append('%s throughput did not halve with the engine: ratio %.2f' % (name, ratio))

    def formal_issues(run):
        return [p['failure_description'] for p in run['passes'] if p['phase'] == 'formal' and p['outcome'] == 'failed']

    def caught(fault, run):
        if fault in ('no_usage', 'http_error'):
            return isinstance(run, CalibrationError)
        if isinstance(run, Exception):
            return False
        issues = formal_issues(run)
        if fault == 'reports_cached':
            return len(issues) == run_formal_count(run) and all('cached' in text for text in issues)
        if fault == 'stops_early':
            return len(issues) == run_formal_count(run) and all('output tokens' in text for text in issues)
        if fault == 'coalesced_chunks':
            return summarize(run)['decode'] == NOT_OBTAINED and 'decode_not_obtained_reason' in summarize(run)['notes']
        return False

    for fault, run in faulty.items():
        if not caught(fault, run):
            problems.append('fault %s was not detected' % fault)
    return not problems, problems, reference, summary


def run_formal_count(run):
    return sum(1 for p in run['passes'] if p['phase'] == 'formal')


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


def build_result(info, run, summary, control, evidence_ref):
    definition_hash = sha256_file(DEFINITION)
    formal = [r for r in run['records'] if r['phase'] == 'formal']
    settings = {
        'api': 'openai-chat-completions-stream', 'temperature': 0, 'seed': SEED, 'request_concurrency': 1,
        'warmup_passes': info['warmup'], 'formal_passes': info['repetitions'],
        'endpoint_scheme': info['scheme'], 'endpoint_host_class': info['host_class'],
        'input_tokens_counted_by': 'the engine-reported usage.prompt_tokens, which includes the chat template',
        'prefill_seconds_definition': ('client time from dispatch to the first output chunk; it includes queueing, transfer, '
                                       'and the first sampled token'),
        'decode_definition': ('usage.completion_tokens minus 1 divided by the time from the first to the last output chunk; '
                              'it applies only while chunks are at least 0.9 per token'),
        'cache_policy_applied': 'a unique nonce starts every prompt; reported cached tokens must be zero',
        'cached_tokens_reported': summary['cached_tokens_reported'],
    }
    for workload_id, count in run['filler_words'].items():
        settings['filler_words.' + workload_id] = count
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
                       'revision': info['evaluation_revision'], 'sha256': definition_hash},
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
        'resources': {'peak_memory_gib': NOT_OBTAINED if run['peak_memory_gib'] is None else round(run['peak_memory_gib'], 3),
                      'swap_out_delta_bytes': NOT_OBTAINED if run['swap_out_delta_bytes'] is None else run['swap_out_delta_bytes']},
        'quality': {'application': {'passed': summary['passed_requests'], 'total': len(formal),
                                    'negative_control_verified': control['verified'], 'restricted_environment': True}},
    }


def write_evidence(path, run, salt):
    path.write_text(json.dumps({'salt': salt, 'filler_words': run['filler_words'], 'requests': run['records']}, indent=2) + '\n')
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
    fields = parse_fields(args.request_field)
    artifacts = parse_artifacts(args.artifact)
    key = args.api_key_file.read_text().strip() if args.api_key_file else None
    timeout = json.loads(DEFINITION.read_text())['limits']['timeout_seconds_per_task']
    return {'origin': origin, 'scheme': scheme, 'host_class': host_class, 'fields': fields, 'artifacts': artifacts,
            'key': key, 'timeout': timeout, 'evidence_path': evidence_path}


def emit_reference(args, control, run, summary):
    path = args.emit_result
    evidence = write_evidence(path.with_name(path.stem + '.requests.evidence'), run, 'self-test')
    info = {
        'role': 'candidate', 'engine_name': 'reference-engine', 'warmup': 1, 'repetitions': 2, 'fields': {},
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


def main():
    args = parse_args()
    if args.describe:
        print(json.dumps({'task_ids': list(WORKLOADS), 'workloads': WORKLOADS,
                          'limits': {'max_output_tokens_per_request': max(w['output_tokens'] for w in WORKLOADS.values()),
                                     'request_concurrency': 1}}))
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

    origin, scheme, host_class, fields = prepared['origin'], prepared['scheme'], prepared['host_class'], prepared['fields']
    evidence_path = prepared['evidence_path']
    salt = hashlib.sha256((now() + str(time.monotonic())).encode()).hexdigest()[:16]

    try:
        run = execute(origin, args.model, prepared['key'], prepared['timeout'], args.warmup, args.repetitions, fields, SEED, salt,
                      observe_machine=host_class == 'loopback', memory_pid=args.memory_pid)
    except CalibrationError as exc:
        raise SystemExit('Calibration failed, so nothing was measured: %s' % exc)
    summary = summarize(run)
    evidence = write_evidence(evidence_path, run, salt)
    deviations = list(args.deviation)
    if host_class == 'remote':
        deviations.append('The endpoint is remote, so client timings include network transfer.')
    info = {
        'role': args.role, 'engine_name': args.engine_name, 'warmup': args.warmup, 'repetitions': args.repetitions,
        'fields': fields, 'scheme': scheme, 'host_class': host_class, 'evaluation_revision': args.evaluation_revision,
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
    for name in ('prefill', 'decode'):
        value = summary[name]
        print('%s: %s' % (name, NOT_OBTAINED if value == NOT_OBTAINED else '%.2f tok/s over %d tokens' % (value['tokens_per_second'], value['total_tokens'])))
    failed = [p for p in run['passes'] if p['phase'] == 'formal' and p['outcome'] != 'succeeded']
    print('%d of %d formal passes succeeded' % (summary['formal_repetitions'], args.repetitions))
    return 0 if not failed else 1


if __name__ == '__main__':
    raise SystemExit(main())
