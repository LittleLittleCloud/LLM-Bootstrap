"""Reference engine for the throughput evaluation's negative control.

It serves streaming chat completions at exactly known prefill and decode rates, so the timing script must recover those
rates. Each fault in FAULTS breaks one behavior the driver is meant to catch. It is never a model.
"""
import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

FAULTS = ('reports_cached', 'stops_early', 'no_usage', 'coalesced_chunks', 'http_error')
TEMPLATE_TOKENS = 7
COALESCED_GROUP = 4


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
        prompt = body['messages'][-1]['content']
        prompt_tokens = len(prompt.split()) + TEMPLATE_TOKENS
        limit = body['max_tokens']
        total = min(limit, 10) if 'stops_early' in engine.faults else limit
        group = COALESCED_GROUP if 'coalesced_chunks' in engine.faults else 1
        start = time.monotonic()
        first_due = start + prompt_tokens / engine.prefill_rate
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Connection', 'close')
        self.end_headers()
        try:
            self.send_event({'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': ''}}]})
            emitted = 0
            while emitted < total:
                upto = min(emitted + group, total)
                wait = first_due + (upto - 1) / engine.decode_rate - time.monotonic()
                if wait > 0:
                    time.sleep(wait)
                text = ''.join('%d\n' % (i + 1) for i in range(emitted, upto))
                self.send_event({'choices': [{'index': 0, 'delta': {'content': text}}]})
                emitted = upto
            self.send_event({'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop' if total < limit else 'length'}]})
            if 'no_usage' not in engine.faults:
                usage = {'prompt_tokens': prompt_tokens, 'completion_tokens': total, 'total_tokens': prompt_tokens + total}
                if 'reports_cached' in engine.faults:
                    usage['prompt_tokens_details'] = {'cached_tokens': prompt_tokens // 2}
                self.send_event({'choices': [], 'usage': usage})
            self.send_event('[DONE]')
        except (BrokenPipeError, ConnectionResetError):
            pass


class ReferenceEngine:
    model = 'reference-model'

    def __init__(self, prefill_rate, decode_rate, faults=()):
        self.prefill_rate, self.decode_rate, self.faults = prefill_rate, decode_rate, set(faults)

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
