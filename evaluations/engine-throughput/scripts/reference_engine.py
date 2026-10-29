"""Reference engine for the throughput evaluation's negative control.

It serves streaming chat completions at exactly known prefill and decode rates, caches shared prompt prefixes in blocks, and
slows each stream as more requests are in flight, so the timing script must recover those behaviors. Each fault in FAULTS
breaks one behavior the driver is meant to catch. It is never a model.
"""
import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FAULTS = ('reports_cached', 'stops_early', 'no_usage', 'coalesced_chunks', 'http_error', 'no_prefix_cache')
TEMPLATE_TOKENS = 7
CACHE_BLOCK = 16
COALESCED_GROUP = 4
REMEMBERED_PROMPTS = 32


def common_prefix(a, b):
    n, i, step = min(len(a), len(b)), 0, 256
    while i + step <= n and a[i:i + step] == b[i:i + step]:
        i += step
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
        if 'http_error' in engine.faults or self.path != '/v1/chat/completions':
            self.send_response(500 if 'http_error' in engine.faults else 404)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        words = body['messages'][-1]['content'].split()
        prompt_tokens = len(words) + TEMPLATE_TOKENS
        cached = engine.cached_tokens(words, prompt_tokens)
        limit = body['max_tokens']
        total = min(limit, 10) if 'stops_early' in engine.faults else limit
        group = COALESCED_GROUP if 'coalesced_chunks' in engine.faults else 1
        engine.enter()
        try:
            start = time.monotonic()
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Connection', 'close')
            self.end_headers()
            self.send_event({'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': ''}}]})
            due, due_index, emitted = start + (prompt_tokens - cached) / engine.prefill_rate, 0, 0
            while emitted < total:
                upto = min(emitted + group, total)
                while due_index < upto - 1:
                    due += 1.0 / engine.decode_rate_now()
                    due_index += 1
                wait = due - time.monotonic()
                if wait > 0:
                    time.sleep(wait)
                text = ''.join('%d\n' % (i + 1) for i in range(emitted, upto))
                self.send_event({'choices': [{'index': 0, 'delta': {'content': text}}]})
                emitted = upto
            self.send_event({'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop' if total < limit else 'length'}]})
            if 'no_usage' not in engine.faults:
                reported = prompt_tokens // 2 if 'reports_cached' in engine.faults else cached
                self.send_event({'choices': [], 'usage': {
                    'prompt_tokens': prompt_tokens, 'completion_tokens': total, 'total_tokens': prompt_tokens + total,
                    'prompt_tokens_details': {'cached_tokens': reported}}})
            self.send_event('[DONE]')
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            engine.leave()


class ReferenceEngine:
    model = 'reference-model'

    def __init__(self, prefill_rate, decode_rate, faults=(), slots=2):
        self.prefill_rate, self.decode_rate, self.faults, self.slots = prefill_rate, decode_rate, set(faults), slots
        self.active, self.remembered, self.lock = 0, [], threading.Lock()

    def enter(self):
        with self.lock:
            self.active += 1

    def leave(self):
        with self.lock:
            self.active -= 1

    def decode_rate_now(self):
        return self.decode_rate / max(1.0, self.active / self.slots)

    def cached_tokens(self, words, prompt_tokens):
        """Block-aligned prefix reuse across earlier prompts, as a prefix cache would serve it."""
        if 'no_prefix_cache' in self.faults:
            return 0
        with self.lock:
            common = max((common_prefix(words, earlier) for earlier in self.remembered), default=0)
            self.remembered = (self.remembered + [words])[-REMEMBERED_PROMPTS:]
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
