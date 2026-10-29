"""Reference engine for the HumanEval evaluation's negative control.

It answers streaming chat completions at exactly known prefill and decode rates, replies with a task's canonical
solution, and reuses cached prompt prefixes in blocks. The `http_error` fault makes every request fail. It is never a model.
"""
import json
import re
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FAULTS = ('http_error',)
TEMPLATE_TOKENS = 7
CACHE_BLOCK = 16
SIGNATURE = re.compile(r'^def (\w+)\(.*\):\s*$', re.MULTILINE)


def common_prefix(a, b):
    n, i = min(len(a), len(b)), 0
    while i < n and a[i] == b[i]:
        i += 1
    return i


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.request.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)

    def log_message(self, *args):
        pass

    def send_event(self, payload):
        data = payload if isinstance(payload, str) else json.dumps(payload)
        self.wfile.write(('data: %s\n\n' % data).encode('utf-8'))
        self.wfile.flush()

    def do_POST(self):
        engine = self.server.engine
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
        if 'http_error' in engine.faults or not self.path.endswith('/chat/completions'):
            self.send_response(500 if 'http_error' in engine.faults else 404)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        messages = body['messages']
        text = ' '.join(str(m.get('content') or '') for m in messages)
        words = text.split()
        prompt_tokens = len(words) + TEMPLATE_TOKENS
        cached = engine.cached_tokens(words, prompt_tokens)
        tokens = re.findall(r'\S+\s*', engine.reply(messages))
        start = time.monotonic()
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Connection', 'close')
        self.end_headers()
        try:
            self.send_event({'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': ''}}]})
            due = start + (prompt_tokens - cached) / engine.prefill_rate
            for token in tokens:
                wait = due - time.monotonic()
                if wait > 0:
                    time.sleep(wait)
                self.send_event({'choices': [{'index': 0, 'delta': {'content': token}}]})
                due += 1.0 / engine.decode_rate
            self.send_event({'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]})
            self.send_event({'choices': [], 'usage': {
                'prompt_tokens': prompt_tokens, 'completion_tokens': len(tokens), 'total_tokens': prompt_tokens + len(tokens),
                'prompt_tokens_details': {'cached_tokens': cached}}})
            self.send_event('[DONE]')
        except (BrokenPipeError, ConnectionResetError):
            pass


class ReferenceEngine:
    model = 'reference-model'

    def __init__(self, tasks, prefill_rate, decode_rate, faults=()):
        self.by_entry = {task['entry_point']: task for task in tasks}
        self.prefill_rate, self.decode_rate, self.faults = prefill_rate, decode_rate, set(faults)
        self.remembered, self.lock = [], threading.Lock()

    def reply(self, messages):
        if any(m.get('role') == 'assistant' for m in messages):
            return 'ok.'
        match = SIGNATURE.search(str(messages[0].get('content') or ''))
        task = self.by_entry.get(match.group(1)) if match else None
        return 'ok.' if task is None else '%s\n%s' % (match.group(0).strip(), task['canonical_solution'])

    def cached_tokens(self, words, prompt_tokens):
        with self.lock:
            common = max((common_prefix(words, earlier) for earlier in self.remembered), default=0)
            self.remembered = (self.remembered + [words])[-32:]
        return min((TEMPLATE_TOKENS + common) // CACHE_BLOCK * CACHE_BLOCK, prompt_tokens - 1)

    def __enter__(self):
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.server.engine = self
        self.origin = 'http://127.0.0.1:%d' % self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()
