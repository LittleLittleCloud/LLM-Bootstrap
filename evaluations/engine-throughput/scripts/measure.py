"""Streaming request timing, per-request judging, and system probes for the throughput evaluation.

Standard library only. All intervals come from one monotonic clock on the observer that dispatches the requests.
"""
import http.client
import json
import os
import socket
import subprocess
import sys
import threading
import time
from urllib.parse import urlsplit

import workload

# Request fields the driver fixes; --request-field cannot override them.
FIXED_FIELDS = ('model', 'messages', 'max_tokens', 'temperature', 'stream', 'stream_options')
OUTPUT_KEYS = ('content', 'reasoning_content', 'reasoning', 'tool_calls')


def observe(origin, model, prompt, max_tokens, api_key, timeout, fields):
    """Send one streaming chat completion and time it. Returns a dict; transport problems are recorded, not raised."""
    payload = dict(fields)
    payload.update({'model': model, 'messages': [{'role': 'user', 'content': prompt}], 'max_tokens': max_tokens,
                    'temperature': 0, 'stream': True, 'stream_options': {'include_usage': True}})
    obs = {'error': None, 'timed_out': False, 'status': None, 'started': None, 'ended': None, 'first': None, 'last': None,
           'chunks': 0, 'prompt_tokens': None, 'completion_tokens': None, 'cached_tokens': None, 'finish_reason': None}
    parts = urlsplit(origin)
    connect = http.client.HTTPSConnection if parts.scheme == 'https' else http.client.HTTPConnection
    connection = connect(parts.hostname, parts.port, timeout=timeout)
    headers = {'Content-Type': 'application/json', 'Accept': 'text/event-stream'}
    if api_key:
        headers['Authorization'] = 'Bearer ' + api_key
    body = json.dumps(payload).encode('utf-8')
    start = obs['started'] = time.monotonic()
    try:
        connection.request('POST', '/v1/chat/completions', body=body, headers=headers)
        response = connection.getresponse()
        obs['status'] = response.status
        if response.status != 200:
            obs['error'] = 'HTTP %d' % response.status
            return obs
        for raw in iter(response.readline, b''):
            now = time.monotonic() - start
            if now > timeout:
                obs.update(error='the request exceeded %g seconds' % timeout, timed_out=True)
                break
            line = raw.strip()
            if not line.startswith(b'data:'):
                continue
            data = line[5:].strip()
            if data == b'[DONE]':
                break
            try:
                chunk = json.loads(data)
            except ValueError:
                obs['error'] = 'the stream contains a chunk that is not JSON'
                break
            usage = chunk.get('usage')
            if isinstance(usage, dict):
                obs['prompt_tokens'] = usage.get('prompt_tokens')
                obs['completion_tokens'] = usage.get('completion_tokens')
                details = usage.get('prompt_tokens_details')
                obs['cached_tokens'] = details.get('cached_tokens') if isinstance(details, dict) else None
            for choice in chunk.get('choices') or []:
                delta = choice.get('delta') or {}
                if any(delta.get(key) for key in OUTPUT_KEYS):
                    obs['chunks'] += 1
                    if obs['first'] is None:
                        obs['first'] = now
                    obs['last'] = now
                if choice.get('finish_reason'):
                    obs['finish_reason'] = choice['finish_reason']
    except (socket.timeout, TimeoutError):
        obs.update(error='the request exceeded %g seconds' % timeout, timed_out=True)
    except (OSError, http.client.HTTPException) as exc:
        obs['error'] = type(exc).__name__
    finally:
        obs['ended'] = time.monotonic()
        connection.close()
    return obs


def judge(spec, obs, turn=1):
    """Reasons a request does not satisfy its workload. An empty list means it counts."""
    if obs['error']:
        return [obs['error']]
    problems = []
    prompt, completion = obs['prompt_tokens'], obs['completion_tokens']
    if not isinstance(prompt, int) or not isinstance(completion, int):
        return ['the engine reported no usage with integer prompt_tokens and completion_tokens']
    expected = workload.expected_input(spec, turn)
    if abs(prompt - expected) > workload.input_tolerance(spec['input_tokens']):
        problems.append('prompt had %d tokens instead of about %d' % (prompt, expected))
    cached = obs['cached_tokens']
    if spec['kind'] == 'agent' and turn > 1:
        floor = int(workload.CACHE_HIT_FLOOR * spec['input_tokens'])
        if isinstance(cached, int) and cached < floor:
            problems.append('the engine reported %d cached prompt tokens for a repeated prefix of %d; at least %d were expected'
                            % (cached, spec['input_tokens'], floor))
    elif cached:
        problems.append('the engine reported %d cached prompt tokens for a unique prompt' % cached)
    if completion != spec['output_tokens']:
        problems.append('produced %d output tokens instead of %d' % (completion, spec['output_tokens']))
    if obs['first'] is None:
        problems.append('no output text arrived')
    return problems


def swap_out_bytes():
    """Whole-machine cumulative swap-out, or None when the platform does not expose it."""
    try:
        if sys.platform == 'darwin':
            text = subprocess.run(['vm_stat'], capture_output=True, text=True, timeout=10).stdout
            page = int(text.split('page size of')[1].split('bytes')[0])
            pages = int(text.split('Swapouts:')[1].split()[0].rstrip('.'))
            return pages * page
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
            out = subprocess.run(['ps', '-o', 'rss=', '-p', str(self.pid)], capture_output=True, text=True, timeout=5).stdout
            kib = int(out.strip())
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
