"""Measuring reverse proxy between the agent harness and the engine under test.

It relays every request unchanged and records, on one monotonic clock, when each request was dispatched, when its first
output chunk arrived, when its last one did, and the usage the engine reported. It holds the engine's API key, so the
key never reaches the harness or the programs it runs. Standard library only.
"""
import http.client
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

HOP_BY_HOP = {'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers',
              'transfer-encoding', 'upgrade', 'host', 'content-length'}
OUTPUT_KEYS = ('content', 'reasoning_content', 'reasoning', 'tool_calls')
MAX_JSON_BODY = 16 * 1024 * 1024


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.relay()

    def do_POST(self):
        self.relay()

    def relay(self):
        proxy = self.server.proxy
        body = self.rfile.read(int(self.headers.get('Content-Length') or 0)) or None
        record = proxy.open_record(self.command, self.path)
        started = record['_started']
        headers = {key: value for key, value in self.headers.items() if key.lower() not in HOP_BY_HOP}
        if proxy.api_key:
            headers = {key: value for key, value in headers.items() if key.lower() != 'authorization'}
            headers['Authorization'] = 'Bearer ' + proxy.api_key
        connect = http.client.HTTPSConnection if proxy.scheme == 'https' else http.client.HTTPConnection
        connection = connect(proxy.host, proxy.port, timeout=proxy.timeout)
        try:
            connection.request(self.command, self.path, body=body, headers=headers)
            response = connection.getresponse()
            record['status'] = response.status
            self.send_response(response.status)
            for key, value in response.getheaders():
                if key.lower() not in HOP_BY_HOP:
                    self.send_header(key, value)
            self.send_header('Connection', 'close')
            self.end_headers()
            is_json = 'application/json' in (response.getheader('Content-Type') or '')
            kept = bytearray()
            for raw in iter(response.readline, b''):
                at = time.monotonic() - started
                self.wfile.write(raw)
                self.wfile.flush()
                if is_json and len(kept) < MAX_JSON_BODY:
                    kept += raw
                else:
                    proxy.observe_line(record, raw, at)
            if kept:
                proxy.observe_body(record, bytes(kept))
        except (OSError, http.client.HTTPException) as exc:
            record['error'] = type(exc).__name__
        finally:
            record['duration'] = time.monotonic() - started
            connection.close()
            proxy.close_record(record)


class MeasuringProxy:
    def __init__(self, upstream_origin, api_key=None, timeout=3600.0):
        parts = urlsplit(upstream_origin)
        self.scheme, self.host, self.port, self.api_key, self.timeout = parts.scheme, parts.hostname, parts.port, api_key, timeout
        self.records, self.lock, self.label, self.epoch = [], threading.Lock(), None, time.monotonic()

    def open_record(self, method, path):
        with self.lock:
            record = {'index': len(self.records), 'label': self.label, 'method': method, 'path': path, 'status': None,
                      'started': time.monotonic() - self.epoch, 'first': None, 'last': None, 'duration': None, 'chunks': 0,
                      'prompt_tokens': None, 'completion_tokens': None, 'cached_tokens': None, 'finish_reason': None,
                      'error': None, '_started': time.monotonic()}
            self.records.append(record)
        return record

    def close_record(self, record):
        record.pop('_started', None)

    def note_usage(self, record, usage):
        if isinstance(usage, dict):
            record['prompt_tokens'] = usage.get('prompt_tokens')
            record['completion_tokens'] = usage.get('completion_tokens')
            details = usage.get('prompt_tokens_details')
            record['cached_tokens'] = details.get('cached_tokens') if isinstance(details, dict) else None

    def observe_line(self, record, raw, at):
        line = raw.strip()
        if not line.startswith(b'data:'):
            return
        data = line[5:].strip()
        if data == b'[DONE]':
            return
        try:
            chunk = json.loads(data)
        except ValueError:
            return
        self.note_usage(record, chunk.get('usage'))
        for choice in chunk.get('choices') or []:
            delta = choice.get('delta') or {}
            if any(delta.get(key) for key in OUTPUT_KEYS):
                record['chunks'] += 1
                if record['first'] is None:
                    record['first'] = at
                record['last'] = at
            if choice.get('finish_reason'):
                record['finish_reason'] = choice['finish_reason']

    def observe_body(self, record, body):
        try:
            document = json.loads(body)
        except ValueError:
            return
        if isinstance(document, dict):
            self.note_usage(record, document.get('usage'))

    def start(self):
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.server.proxy = self
        self.origin = 'http://127.0.0.1:%d' % self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return self

    def stop(self):
        self.server.shutdown()
        self.server.server_close()

    def __enter__(self):
        return self.start()

    def __exit__(self, *exc):
        self.stop()
