"""Reference engine for the negative control of engine-evalscope.

It speaks the OpenAI chat completions API (streaming and not) at exactly known prefill and decode rates, caches shared
prompt prefixes in blocks, and slows each stream as more requests are in flight. With `answers` it also behaves as an oracle
for the intelligence benchmarks: it replies with the right answer, a wrong one, or a right one that also probes the network.
Each fault in FAULTS breaks one behavior the driver is meant to catch. It is never a model.
"""
import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FAULTS = ('stops_early', 'http_error', 'no_prefix_cache')
TEMPLATE_TOKENS = 7
CACHE_BLOCK = 16
CHARS_PER_TOKEN = 4
REMEMBERED_PROMPTS = 32


def text_of(messages):
    parts = []
    for message in messages:
        content = message.get('content') or ''
        parts.append(content if isinstance(content, str) else ' '.join(str(p.get('text', '')) for p in content))
    return '\n'.join(parts)


def count_tokens(text):
    return max(1, (len(text) + CHARS_PER_TOKEN - 1) // CHARS_PER_TOKEN) + TEMPLATE_TOKENS


def common_prefix(a, b):
    n, i, step = min(len(a), len(b)), 0, 1024
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

    def do_GET(self):
        self.send_response(404)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_POST(self):
        engine = self.server.engine
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
        if 'http_error' in engine.faults or not self.path.endswith('/chat/completions'):
            self.send_response(500 if 'http_error' in engine.faults else 404)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        text = text_of(body['messages'])
        prompt_tokens = engine.count(text)
        cached = engine.cached_tokens(text, prompt_tokens)
        reply = engine.answer(text)
        limit = body.get('max_tokens') or body.get('max_completion_tokens') or 256
        if reply is None:
            total = min(limit, 10) if 'stops_early' in engine.faults else limit
            pieces = ['%d\n' % (i + 1) for i in range(total)]
        else:
            pieces = engine.split(reply)[:limit]
            total = len(pieces)
        finish = 'stop' if total < limit else 'length'
        usage = {'prompt_tokens': prompt_tokens, 'completion_tokens': total, 'total_tokens': prompt_tokens + total,
                 'prompt_tokens_details': {'cached_tokens': cached}}
        engine.enter()
        try:
            start = time.monotonic()
            due = start + (prompt_tokens - cached) / engine.prefill_rate
            if not body.get('stream'):
                for _ in range(max(0, total - 1)):
                    due += 1.0 / engine.decode_rate_now()
                time.sleep(max(0.0, due - time.monotonic()))
                payload = json.dumps({
                    'id': 'ref', 'object': 'chat.completion', 'created': int(time.time()), 'model': engine.model,
                    'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': ''.join(pieces)}, 'finish_reason': finish}],
                    'usage': usage}).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Connection', 'close')
            self.end_headers()
            self.send_event({'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': ''}}]})
            for index, piece in enumerate(pieces):
                if index:
                    due += 1.0 / engine.decode_rate_now()
                wait = due - time.monotonic()
                if wait > 0:
                    time.sleep(wait)
                self.send_event({'choices': [{'index': 0, 'delta': {'content': piece}}]})
            self.send_event({'choices': [{'index': 0, 'delta': {}, 'finish_reason': finish}]})
            self.send_event({'choices': [], 'usage': usage})
            self.send_event('[DONE]')
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            engine.leave()


class ReferenceEngine:
    model = 'reference-model'

    def __init__(self, prefill_rate, decode_rate, faults=(), slots=2, answers=None, answer_mode='right', count=count_tokens):
        self.prefill_rate, self.decode_rate, self.faults, self.slots = prefill_rate, decode_rate, set(faults), slots
        self.answers, self.answer_mode, self.count = answers or [], answer_mode, count
        self.active, self.remembered, self.lock = 0, [], threading.Lock()

    def enter(self):
        with self.lock:
            self.active += 1

    def leave(self):
        with self.lock:
            self.active -= 1

    def decode_rate_now(self):
        return self.decode_rate / max(1.0, self.active / self.slots)

    def answer(self, text):
        """The oracle reply for a benchmark prompt, or None for the generic fixed-length reply."""
        for item in self.answers:
            if item['match'] in text:
                return item[self.answer_mode]
        return None

    @staticmethod
    def split(reply):
        pieces, word = [], ''
        for char in reply:
            word += char
            if char.isspace():
                pieces.append(word)
                word = ''
        return pieces + ([word] if word else [])

    def cached_tokens(self, text, prompt_tokens):
        """Block-aligned prefix reuse across earlier prompts, as a prefix cache would serve it."""
        if 'no_prefix_cache' in self.faults:
            return 0
        with self.lock:
            common = max((common_prefix(text, earlier) for earlier in self.remembered), default=0)
            self.remembered = (self.remembered + [text])[-REMEMBERED_PROMPTS:]
        shared = int(prompt_tokens * common / max(1, len(text)))
        return min((TEMPLATE_TOKENS + shared) // CACHE_BLOCK * CACHE_BLOCK, prompt_tokens - 1)

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
