#!/usr/bin/env python3
"""Run the Pi coding agent on 20 fixed HumanEval tasks against an OpenAI-compatible endpoint and score the solutions.

For each task Pi writes solution.py in a fresh workspace. A measuring proxy between Pi and the engine records per-request
timing and usage on one monotonic clock. The official assertions then run in offline restricted containers. Standard
library only (Python 3.9+) plus Docker for the assertions. See the evaluation protocol in the experiment skill.
"""
import argparse
import ast
import datetime
import gzip
import hashlib
import json
import os
import platform
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parent
DEFINITION = HERE.parent / 'evaluation.json'
NOT_OBTAINED = 'Not obtained'
WARMUP_TASKS = 2
MIN_CHUNK_TOKEN_RATIO = 0.9
MAX_SOLUTION_BYTES = 1024 * 1024
CHAT_PATH = '/chat/completions'


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha256_file(path):
    return sha256_bytes(Path(path).read_bytes())


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

import assertions  # noqa: E402
import pi_run  # noqa: E402
from proxy import MeasuringProxy  # noqa: E402


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')


def load_definition():
    return json.loads(DEFINITION.read_text())


def load_dataset(path=None):
    """The pinned HumanEval file as {task_id: row}. The hash is checked before anything is read from it."""
    pin = load_definition()['dataset']
    if path:
        data = Path(path).read_bytes()
    else:
        url = pin['repository'].replace('https://github.com/', 'https://raw.githubusercontent.com/') + '/%s/%s' % (pin['revision'], pin['file'])
        data = urllib.request.urlopen(url, timeout=60).read()
    if sha256_bytes(data) != pin['sha256']:
        raise SystemExit('The HumanEval dataset does not match its pinned SHA-256.')
    rows = {row['task_id']: row for row in (json.loads(line) for line in gzip.decompress(data).splitlines() if line)}
    if len(rows) != 164:
        raise SystemExit('Unexpected HumanEval task count.')
    return rows


def make_prompt(task_prompt, nonce):
    return ('Session %s.\nImplement the Python function specified below. Use your standard tools to write the complete '
            'implementation, including required imports, to solution.py in the current directory, using the relative path '
            'solution.py rather than an absolute path. Do not merely print the code. Do not fetch reference solutions or external tests. You may inspect and syntax-check your own '
            'file. Finish when the file is ready.\n\n%s' % (nonce, task_prompt))


class Context:
    """Everything one run needs. Pi sees only prompts; the tests stay with the evaluator."""

    def __init__(self, proxy, model, pi_prefix, rows, timeout, salt, staging, context_window, max_tokens, extra_env=None,
                 artifacts_dir=None):
        self.proxy, self.model, self.pi_prefix, self.timeout, self.salt = proxy, model, pi_prefix, timeout, salt
        self.staging, self.context_window, self.max_tokens = staging, context_window, max_tokens
        self.extra_env, self.artifacts_dir = extra_env or {}, artifacts_dir
        self.prompts = {task_id: row['prompt'] for task_id, row in rows.items()}
        self.held = {task_id: {'test': row['test'], 'entry_point': row['entry_point']} for task_id, row in rows.items()}


def chat_records(ctx, label):
    return [r for r in list(ctx.proxy.records) if r['label'] == label and r['path'].endswith(CHAT_PATH)]


def reconcile(events, records):
    """Pi's own message and usage totals must match what the proxy saw on the wire."""
    ok = [r for r in records if r['status'] == 200 and not r['error']]
    assistant = events['assistant']
    if len(records) != len(ok) or len(ok) != len(assistant):
        return False
    if any(not isinstance(r['prompt_tokens'], int) or not isinstance(r['completion_tokens'], int) for r in ok):
        return False
    cached = sum(r['cached_tokens'] or 0 for r in ok)
    return (sum(r['prompt_tokens'] for r in ok) == sum(m['input'] + m['cache_read'] for m in assistant)
            and cached == sum(m['cache_read'] for m in assistant)
            and sum(r['completion_tokens'] for r in ok) == sum(m['output'] for m in assistant))


def run_task(ctx, phase, repetition, task_id):
    nonce = sha256_bytes(('%s|%s|%d|%s' % (ctx.salt, phase, repetition, task_id)).encode())[:16]
    prompt = make_prompt(ctx.prompts[task_id], nonce)
    label = (phase, repetition, task_id)
    with tempfile.TemporaryDirectory(prefix='humaneval-pi-') as temporary:
        root = Path(temporary)
        workspace, agent = root / 'workspace', root / 'agent'
        workspace.mkdir()
        agent.mkdir()
        pi_run.write_agent_config(agent, ctx.model, ctx.proxy.origin + '/v1', ctx.context_window, ctx.max_tokens)
        env = pi_run.environment(root, agent, ctx.extra_env)
        ctx.proxy.label = label
        try:
            ran = pi_run.run_pi(pi_run.pi_command(ctx.pi_prefix, ctx.model, prompt), workspace, env, ctx.timeout)
        finally:
            ctx.proxy.label = None
        events = pi_run.read_events(ran['lines'])
        solution_path, solution, syntax = workspace / 'solution.py', None, 'missing'
        if solution_path.is_file() and not solution_path.is_symlink() and solution_path.stat().st_size <= MAX_SOLUTION_BYTES:
            solution = solution_path.read_text(encoding='utf-8', errors='replace')
            try:
                ast.parse(solution)
                syntax = 'ok'
            except (SyntaxError, ValueError):
                syntax = 'invalid'
        if ctx.artifacts_dir:
            folder = Path(ctx.artifacts_dir) / ('%s-%d-%s' % (phase, repetition, task_id.replace('/', '-')))
            folder.mkdir(parents=True, exist_ok=True)
            (folder / 'events.jsonl').write_text(''.join(line for _, line in ran['lines']), encoding='utf-8')
            if solution is not None:
                (folder / 'solution.py').write_text(solution, encoding='utf-8')
    records = chat_records(ctx, label)
    mismatch = any(m['provider'] not in (None, pi_run.PROVIDER) or m['model'] not in (None, ctx.model) for m in events['assistant'])
    agent_ok = events['settled'] and not events['aborted'] and not events['malformed'] and events['final_stop'] == 'stop' and not mismatch
    completed = ran['returncode'] == 0 and not ran['timed_out'] and agent_ok
    problem = None
    if not completed:
        problem = ('timed out after %g seconds' % ctx.timeout if ran['timed_out'] else
                   'Pi exited with status %s' % ran['returncode'] if ran['returncode'] else 'Pi did not finish cleanly')
    return {'phase': phase, 'repetition': repetition, 'task_id': task_id, 'nonce': nonce, 'wall_seconds': ran['wall_seconds'],
            'returncode': ran['returncode'], 'timed_out': ran['timed_out'], 'completed': completed, 'problem': problem,
            'assistant_messages': len(events['assistant']), 'tool_calls': events['tool_calls'], 'final_stop': events['final_stop'],
            'solution_sha256': None if solution is None else sha256_bytes(solution.encode()), 'syntax': syntax,
            'proxy_requests': len(records), 'reconciled': reconcile(events, records), 'assertion': {'status': 'not_run'},
            'stderr_tail': ran['stderr_tail'] if not completed else '', '_solution': solution}


def assess(ctx, results):
    """Run the official assertions on every completed solution. They run after the cohort so they never share the machine with the engine."""
    for result in results:
        if result['completed'] and result['_solution'] is None:
            result['assertion'] = {'status': 'no_solution'}
        elif result['completed']:
            program = assertions.program(result['_solution'], ctx.held[result['task_id']])
            result['assertion'] = assertions.run_case(program, ctx.staging)


def swap_out_bytes():
    """Whole-machine cumulative swap-out, or None when the platform does not expose it."""
    try:
        if sys.platform == 'darwin':
            text = subprocess.run(['vm_stat'], capture_output=True, text=True, timeout=10).stdout
            page = int(text.split('page size of')[1].split('bytes')[0])
            return int(text.split('Swapouts:')[1].split()[0].rstrip('.')) * page
        if sys.platform.startswith('linux'):
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


def execute(ctx, task_ids, warmup, repetitions, observe_machine=False, memory_pid=None):
    """Warm-up passes over the first tasks, then formal passes over all of them. Returns every task result."""
    results, passes = [], []
    sampler = MemorySampler(memory_pid) if observe_machine and memory_pid else None
    swap_before = formal_start = None
    for index in range(warmup + repetitions):
        phase = 'warm-up' if index < warmup else 'formal'
        if index == warmup:
            swap_before = swap_out_bytes() if observe_machine else None
            if sampler:
                sampler.start()
            formal_start = time.monotonic()
        ids = task_ids[:WARMUP_TASKS] if phase == 'warm-up' else task_ids
        batch = [run_task(ctx, phase, index, task_id) for task_id in ids]
        if phase == 'formal':
            assess(ctx, batch)
        issues = ['%s: %s' % (r['task_id'], r['problem']) for r in batch if not r['completed']]
        outcome = 'timed-out' if any(r['timed_out'] for r in batch) else 'failed' if issues else 'succeeded'
        passes.append({'phase': phase, 'index': index, 'outcome': outcome, 'failure_description': '; '.join(issues)})
        results.extend(batch)
    formal_seconds = time.monotonic() - formal_start
    swap_after = swap_out_bytes() if observe_machine else None
    peak_gib = sampler.stop() if sampler else None
    swap_delta = swap_after - swap_before if swap_before is not None and swap_after is not None and swap_after >= swap_before else None
    rows = []
    for record in list(ctx.proxy.records):
        label = record['label']
        if label and label[0] == 'formal' and record['path'].endswith(CHAT_PATH):
            row = {key: value for key, value in record.items() if key != 'label'}
            row.update(phase=label[0], repetition=label[1], task_id=label[2])
            row['ttft_seconds'] = row['first']
            row['decode_seconds'] = row['last'] - row['first'] if row['first'] is not None else None
            rows.append(row)
    return {'results': results, 'rows': rows, 'passes': passes, 'task_ids': task_ids, 'formal_seconds': formal_seconds,
            'swap_out_delta_bytes': swap_delta, 'peak_memory_gib': peak_gib}


def throughput(basis, tokens, seconds):
    """Ratio of sums, computed from the stored rounded seconds so the document is self-consistent."""
    seconds = round(seconds, 6)
    if seconds <= 0:
        return NOT_OBTAINED
    return {'basis': basis, 'total_tokens': tokens, 'total_seconds': seconds, 'tokens_per_second': tokens / seconds}


def usable(row):
    return row['status'] == 200 and not row['error'] and isinstance(row['prompt_tokens'], int) \
        and isinstance(row['completion_tokens'], int)


def summarize(run):
    """Run-level metrics from the repetitions that completed cleanly; every task stays in the evidence either way."""
    notes = {}
    formal_passes = [p for p in run['passes'] if p['phase'] == 'formal']
    good_indices = {p['index'] for p in formal_passes if p['outcome'] == 'succeeded'}
    formal = [r for r in run['results'] if r['phase'] == 'formal']
    good = [r for r in formal if r['repetition'] in good_indices]
    rows = [r for r in run['rows'] if r['repetition'] in good_indices and usable(r)]
    timed = [r for r in rows if r['ttft_seconds'] is not None]
    prefill = throughput('processed-input-tokens', sum(r['prompt_tokens'] - (r['cached_tokens'] or 0) for r in timed),
                         sum(r['ttft_seconds'] for r in timed)) if timed else NOT_OBTAINED
    decode_rows = [r for r in timed if r['completion_tokens'] >= 2 and r['decode_seconds']]
    decode = NOT_OBTAINED
    if decode_rows:
        ratio = sum(r['chunks'] for r in decode_rows) / sum(r['completion_tokens'] for r in decode_rows)
        notes['decode_chunk_token_ratio'] = round(ratio, 4)
        if ratio >= MIN_CHUNK_TOKEN_RATIO:
            decode = throughput('n-minus-1-intervals', sum(r['completion_tokens'] - 1 for r in decode_rows),
                                sum(r['decode_seconds'] for r in decode_rows))
        else:
            notes['decode_not_obtained_reason'] = ('the engine sent %.2f output chunks per token, below %.2f, so the N-1 '
                                                   'interval definition does not apply' % (ratio, MIN_CHUNK_TOKEN_RATIO))
    per_repetition = [sum(r['wall_seconds'] for r in good if r['repetition'] == index) for index in sorted(good_indices)]
    reconciled = bool(good) and all(r['reconciled'] for r in good)
    passed = sum(1 for r in formal if r['assertion']['status'] == 'passed')
    notes['tasks_passed_per_repetition'] = ','.join(
        str(sum(1 for r in formal if r['repetition'] == p['index'] and r['assertion']['status'] == 'passed')) for p in formal_passes)
    notes['observed_requests_per_task'] = round(sum(r['proxy_requests'] for r in good) / len(good), 2) if good else NOT_OBTAINED
    notes['observed_tool_calls_per_task'] = round(sum(r['tool_calls'] for r in good) / len(good), 2) if good else NOT_OBTAINED
    notes['invalid_syntax_solutions'] = sum(1 for r in formal if r['syntax'] == 'invalid')
    return {
        'formal_repetitions': len(good_indices), 'preliminary': len(good_indices) <= 1, 'prefill': prefill, 'decode': decode,
        'client_ttft_median_seconds': statistics.median(r['ttft_seconds'] for r in timed) if timed else NOT_OBTAINED,
        'application_duration_seconds': round(statistics.mean(per_repetition), 3) if per_repetition else NOT_OBTAINED,
        'requests_reconciled': reconciled, 'passed': passed, 'total': len(formal), 'notes': notes,
        'cached_tokens_reported': bool(rows) and all(isinstance(r['cached_tokens'], int) for r in rows),
    }


SELF_TEST_RATES = {'prefill': 5000.0, 'decode': 800.0}
RATE_TOLERANCE = 0.35
HANG_TIMEOUT_SECONDS = 4.0


def synthetic_rows():
    """Three tiny tasks in HumanEval's shape for the negative control. They never leave this process."""
    filler = ' '.join('lorem%d' % i for i in range(480))
    comment = ' '.join('step%d' % i for i in range(40))
    specs = [('add', 'a, b', 'a + b', 'assert candidate(1, 2) == 3'), ('negate', 'a', '-a', 'assert candidate(4) == -4'),
             ('twice', 'a', '2 * a', 'assert candidate(5) == 10')]
    return {'Synthetic/%d' % n: {
        'task_id': 'Synthetic/%d' % n, 'entry_point': name,
        'prompt': 'def %s(%s):\n    """%s %d"""\n' % (name, args, filler, n),
        'canonical_solution': '    # %s\n    return %s\n' % (comment, body),
        'test': 'def check(candidate):\n    %s\n' % check} for n, (name, args, body, check) in enumerate(specs)}


def reference_run(rows, staging, fault=None, engine_faults=(), pi_timeout=60.0, warmup=0, repetitions=1, prefill_rate=None):
    from reference_engine import ReferenceEngine
    tasks = [{'entry_point': row['entry_point'], 'canonical_solution': row['canonical_solution']} for row in rows.values()]
    with ReferenceEngine(tasks, prefill_rate or SELF_TEST_RATES['prefill'], SELF_TEST_RATES['decode'], engine_faults) as engine, \
            MeasuringProxy(engine.origin, None, 60.0) as proxy:
        ctx = Context(proxy, engine.model, [sys.executable, str(HERE / 'fake_pi.py')], rows, pi_timeout, 'self-test', staging,
                      32768, 4096, extra_env={'FAKE_PI_FAULT': fault} if fault else None)
        return execute(ctx, list(rows), warmup, repetitions)


def formal_failures(run):
    return [p['failure_description'] for p in run['passes'] if p['phase'] == 'formal' and p['outcome'] != 'succeeded']


def self_test():
    """Negative control: a known engine and a scripted stand-in for Pi must be scored exactly, and each fault caught.

    Returns (ok, problems, control, the timing run, its summary).
    """
    from concurrent.futures import ThreadPoolExecutor
    rows = synthetic_rows()
    problem = assertions.environment_problem()
    if problem:
        return False, [problem], {'verified': False, 'restricted': False}, None, None
    problems = []
    with tempfile.TemporaryDirectory(prefix='humaneval-staging-') as staging:
        control = assertions.controls(next(iter(rows.values())), staging)
        for name, held in control['results'].items():
            if not held:
                problems.append('sandbox control %s failed' % name)
        timing = reference_run(rows, staging, repetitions=2)
        scenarios = {'wrong_solution': {'fault': 'wrong_solution'}, 'no_solution': {'fault': 'no_solution'},
                     'hang': {'fault': 'hang', 'pi_timeout': HANG_TIMEOUT_SECONDS}, 'usage_mismatch': {'fault': 'usage_mismatch'},
                     'http_error': {'engine_faults': ('http_error',)}}
        with ThreadPoolExecutor(max_workers=len(scenarios)) as pool:
            futures = {name: pool.submit(reference_run, dict(list(rows.items())[:2]), staging, **kwargs) for name, kwargs in scenarios.items()}
            faulty = {name: future.result() for name, future in futures.items()}
    summary = summarize(timing)
    if formal_failures(timing) or not summary['requests_reconciled']:
        problems.append('the scripted stand-in does not pass the reference scenario: %s'
                        % ('; '.join(formal_failures(timing)) or 'requests were not reconciled'))
    elif summary['passed'] != summary['total']:
        problems.append('the canonical solutions did not all pass the assertions (%d of %d)' % (summary['passed'], summary['total']))
    else:
        for label, aggregate, expected in (('prefill', summary['prefill'], SELF_TEST_RATES['prefill']),
                                           ('decode', summary['decode'], SELF_TEST_RATES['decode'])):
            if aggregate == NOT_OBTAINED:
                problems.append('%s was not obtained from the reference engine' % label)
            elif abs(aggregate['tokens_per_second'] - expected) > RATE_TOLERANCE * expected:
                problems.append('%s read %.0f tok/s for a known %.0f tok/s' % (label, aggregate['tokens_per_second'], expected))
        if summary['cached_tokens_reported'] is not True:
            problems.append('the reference engine\'s cached token counts were not recorded')

    def caught(name, run):
        results = [r for r in run['results'] if r['phase'] == 'formal']
        if name == 'wrong_solution':
            return all(r['assertion']['status'] == 'failed' for r in results) and not formal_failures(run)
        if name == 'no_solution':
            return all(r['assertion']['status'] == 'no_solution' for r in results) and not formal_failures(run)
        if name == 'hang':
            return all(r['timed_out'] for r in results) and run['passes'][-1]['outcome'] == 'timed-out'
        if name == 'usage_mismatch':
            return not any(r['reconciled'] for r in results) and not summarize(run)['requests_reconciled']
        return all(not r['completed'] for r in results) and bool(formal_failures(run))

    for name, run in faulty.items():
        if not caught(name, run):
            problems.append('fault %s was not detected' % name)
    return not problems, problems, control, timing, summary


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


def parse_tasks(value, definition):
    names = [name for name in value.split(',') if name] if value else list(definition['task_ids'])
    unknown = [name for name in names if name not in definition['task_ids']]
    if unknown or not names:
        raise SystemExit('Unknown task(s): %s. Known tasks: %s' % (', '.join(unknown) or '(none given)', ', '.join(definition['task_ids'])))
    return [name for name in definition['task_ids'] if name in names]


def build_result(info, run, summary, control, evidence_ref):
    definition = load_definition()
    limits = definition['limits']
    settings = {
        'api': 'pi-agent-via-measuring-proxy-to-openai-chat-completions',
        'harness': '%s %s' % (definition['harness']['name'], definition['harness']['version']),
        'thinking': 'off', 'temperature': 'harness default; Pi 1.4.0 has no sampling option',
        'tools': pi_run.TOOLS, 'compaction': 'disabled', 'retries': 'disabled',
        'tasks': ','.join(run['task_ids']), 'warmup_passes': info['warmup'], 'formal_passes': info['repetitions'],
        'context_window': limits['context_window'], 'max_output_tokens_per_request': limits['max_output_tokens_per_request'],
        'timeout_seconds_per_task': info['timeout'], 'request_concurrency': limits['request_concurrency'],
        'endpoint_scheme': info['scheme'], 'endpoint_host_class': info['host_class'],
        'prefill_seconds_definition': ('proxy time from dispatch to the first output chunk of each engine request; it includes '
                                       'the first sampled token'),
        'decode_definition': ('usage.completion_tokens minus 1 divided by the time from the first to the last output chunk; it '
                              'applies only while chunks are at least 0.9 per token'),
        'client_ttft_definition': 'median over all engine requests of the proxy time to the first output chunk',
        'application_duration_definition': ('mean over succeeded passes of the summed Pi wall time of all tasks, from launch to '
                                            'exit; assertions are excluded'),
        'cache_policy_applied': ('every task prompt begins with a unique session nonce; the second request of a task reuses '
                                 'the first one\'s prefix, and reported cached tokens are recorded, not required'),
        'assertion_sandbox': ('one offline container per solution: no network, read-only root and mount, no capabilities, '
                              'unprivileged user, bounded memory, processes, CPU, and 30 seconds'),
        'cached_tokens_reported': summary['cached_tokens_reported'],
    }
    settings.update(summary['notes'])
    if info.get('memory_definition'):
        settings['peak_memory_definition'] = info['memory_definition']
    repetitions = []
    for entry in run['passes']:
        item = {'phase': entry['phase'], 'outcome': entry['outcome']}
        if entry['outcome'] != 'succeeded':
            item['failure_description'] = entry['failure_description'] or entry['outcome']
        repetitions.append(item)
    return {
        'evaluation': {'evaluation_id': definition['evaluation_id'], 'revision': info['evaluation_revision'],
                       'sha256': sha256_file(DEFINITION)},
        'role': info['role'], 'engine_name': info['engine_name'], 'environment': info['environment'],
        'runtime_revision': info['runtime_revision'], 'artifacts': info['artifacts'], 'commands': info['commands'],
        'settings': settings, 'repetitions': repetitions,
        'metrics': {key: summary[key] for key in (
            'formal_repetitions', 'preliminary', 'prefill', 'decode', 'client_ttft_median_seconds',
            'application_duration_seconds', 'requests_reconciled')} | {'per_request_evidence': evidence_ref},
        'resources': {'peak_memory_gib': NOT_OBTAINED if run['peak_memory_gib'] is None else round(run['peak_memory_gib'], 3),
                      'swap_out_delta_bytes': NOT_OBTAINED if run['swap_out_delta_bytes'] is None else run['swap_out_delta_bytes']},
        'quality': {'application': {'passed': summary['passed'], 'total': summary['total'],
                                    'negative_control_verified': control['verified'],
                                    'restricted_environment': control['restricted']}},
    }


def write_evidence(path, run, salt):
    results = [{key: value for key, value in r.items() if key != '_solution'} for r in run['results']]
    rows = [{key: value for key, value in r.items() if not key.startswith('_')} for r in run['rows']]
    path.write_text(json.dumps({'salt': salt, 'tasks': results, 'requests': rows}, indent=2) + '\n')
    return {'description': ('Per-task outcomes, assertion statuses, and per-request timings and token counts; it holds no '
                            'prompts, solutions, or model output'),
            'access': 'local-only', 'sha256': sha256_file(path),
            'access_limitation': 'Kept next to the result document and not committed to the repository.'}


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--describe', action='store_true', help='Print the task ids and limits as JSON')
    parser.add_argument('--self-test', action='store_true', help='Run the negative control against a reference engine')
    parser.add_argument('--emit-result', type=Path, help='With --self-test, write the reference run as a result document')
    parser.add_argument('--endpoint', help='Origin of the engine, for example http://127.0.0.1:8080')
    parser.add_argument('--model', help='Model name Pi sends in requests')
    parser.add_argument('--role', choices=('baseline', 'candidate'))
    parser.add_argument('--engine-name')
    parser.add_argument('--tasks', help='Comma-separated task ids to run (default: all of them)')
    parser.add_argument('--warmup', type=int, help='Warm-up passes from the contract (0 or more)')
    parser.add_argument('--repetitions', type=int, help='Formal passes from the contract (1 or more)')
    parser.add_argument('--api-key-file', type=Path, help='Read privately; held by the proxy, never given to Pi')
    parser.add_argument('--pi', default='pi', help='Pi executable (default: pi on PATH)')
    parser.add_argument('--dataset-file', type=Path, help='Local copy of the pinned HumanEval file; its hash is checked')
    parser.add_argument('--artifacts-dir', type=Path, help='Keep each task\'s Pi events and solution here (local only)')
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
    definition = load_definition()
    pi = shutil.which(args.pi)
    if not pi:
        raise SystemExit('Pi was not found: %s' % args.pi)
    version = subprocess.run([pi, '--version'], capture_output=True, text=True, timeout=60)
    expected = definition['harness']['version']
    if version.returncode != 0 or version.stdout.strip() != expected:
        raise SystemExit('The evaluation pins Pi %s; found %r.' % (expected, (version.stdout or version.stderr).strip()))
    if args.artifacts_dir and args.artifacts_dir.exists() and any(args.artifacts_dir.iterdir()):
        raise SystemExit('--artifacts-dir must be empty or new.')
    key = args.api_key_file.read_text().strip() if args.api_key_file else None
    return {'origin': origin, 'scheme': scheme, 'host_class': host_class, 'artifacts': parse_artifacts(args.artifact),
            'tasks': parse_tasks(args.tasks, definition), 'key': key, 'pi': pi, 'evidence_path': evidence_path,
            'limits': definition['limits']}


def reference_info(args):
    return {
        'role': 'candidate', 'engine_name': 'reference-engine', 'warmup': 0, 'repetitions': 2, 'scheme': 'http',
        'host_class': 'loopback', 'timeout': 60.0, 'evaluation_revision': args.evaluation_revision,
        'runtime_revision': {'unavailable': True, 'reason': 'The reference engine is not versioned.'},
        'artifacts': [{'name': 'reference_engine.py', 'sha256': sha256_file(HERE / 'reference_engine.py')}],
        'commands': ['humaneval.py --self-test'],
        'environment': {'hardware_model': 'not applicable: reference engine', 'os_version': platform.platform(),
                        'toolchain': 'Python %s' % platform.python_version(), 'power_mode': 'not applicable',
                        'thermal_observations': 'not observed', 'exclusive_gpu': False,
                        'deviations_from_contract': ['Synthetic reference run with a scripted stand-in for Pi; not a measurement '
                                                     'of any engine or of Pi.']},
    }


def describe():
    definition = load_definition()
    return {'task_ids': definition['task_ids'], 'limits': definition['limits'], 'harness': definition['harness'],
            'dataset': definition['dataset']}


def main():
    args = parse_args()
    if args.describe:
        print(json.dumps(describe()))
        return 0
    prepared = None if args.self_test else prepare(args)
    ok, problems, control, reference, summary = self_test()
    if args.self_test:
        print('self-test: %s' % ('ok' if ok else 'FAILED'))
        for problem in problems:
            print('  ' + problem)
        if args.emit_result and ok:
            if not args.evaluation_revision:
                raise SystemExit('--emit-result needs --evaluation-revision.')
            evidence = write_evidence(args.emit_result.with_name(args.emit_result.stem + '.requests.evidence'), reference, 'self-test')
            args.emit_result.write_text(json.dumps(build_result(reference_info(args), reference, summary, control, evidence), indent=2) + '\n')
        return 0 if ok else 1
    if not ok:
        raise SystemExit('The self-test failed, so this evaluation is not trustworthy:\n  ' + '\n  '.join(problems))

    rows = load_dataset(args.dataset_file)
    missing = [t for t in prepared['tasks'] if t not in rows]
    if missing:
        raise SystemExit('Tasks missing from the pinned dataset: ' + ', '.join(missing))
    salt = hashlib.sha256((now() + str(time.monotonic())).encode()).hexdigest()[:16]
    limits = prepared['limits']
    with tempfile.TemporaryDirectory(prefix='humaneval-staging-') as staging, \
            MeasuringProxy(prepared['origin'], prepared['key'], limits['timeout_seconds_per_task']) as proxy:
        ctx = Context(proxy, args.model, [prepared['pi']], {t: rows[t] for t in prepared['tasks']}, limits['timeout_seconds_per_task'],
                      salt, staging, limits['context_window'], limits['max_output_tokens_per_request'],
                      artifacts_dir=args.artifacts_dir)
        run = execute(ctx, prepared['tasks'], args.warmup, args.repetitions,
                      observe_machine=prepared['host_class'] == 'loopback', memory_pid=args.memory_pid)
    summary = summarize(run)
    evidence = write_evidence(prepared['evidence_path'], run, salt)
    deviations = list(args.deviation)
    if prepared['host_class'] == 'remote':
        deviations.append('The endpoint is remote, so proxy timings include network transfer.')
    if len(prepared['tasks']) != len(load_definition()['task_ids']):
        deviations.append('Only %d of the %d fixed tasks were run.' % (len(prepared['tasks']), len(load_definition()['task_ids'])))
    info = {
        'role': args.role, 'engine_name': args.engine_name, 'warmup': args.warmup, 'repetitions': args.repetitions,
        'scheme': prepared['scheme'], 'host_class': prepared['host_class'], 'timeout': limits['timeout_seconds_per_task'],
        'evaluation_revision': args.evaluation_revision,
        'runtime_revision': args.runtime_revision or {'unavailable': True, 'reason': 'No runtime revision was supplied.'},
        'artifacts': prepared['artifacts'], 'commands': [' '.join(sys.argv)] + args.engine_command,
        'memory_definition': ('resident set size of PID %d sampled every %.1f seconds during the formal passes; it may not '
                              'include GPU memory' % (args.memory_pid, MemorySampler.INTERVAL_SECONDS)) if args.memory_pid else None,
        'environment': {'hardware_model': args.hardware_model, 'os_version': platform.platform(),
                        'toolchain': args.toolchain, 'power_mode': args.power_mode,
                        'thermal_observations': args.thermal_observations, 'exclusive_gpu': args.exclusive_gpu,
                        'deviations_from_contract': deviations},
    }
    args.output.write_text(json.dumps(build_result(info, run, summary, control, evidence), indent=2) + '\n')
    print('%d of %d solutions passed the official assertions' % (summary['passed'], summary['total']))
    print('%d of %d formal passes succeeded' % (summary['formal_repetitions'], args.repetitions))
    return 0 if not formal_failures(run) else 1


if __name__ == '__main__':
    raise SystemExit(main())

