"""Minimal standard-library HTTP and Server-Sent Events client."""
import http.client
import json
import time
from urllib.parse import urlsplit


class Event:
    def __init__(self, event, data, seconds):
        self.event = event
        self.data = data
        self.seconds = seconds


class Response:
    def __init__(self, status, headers, body, events=None, framing_errors=None):
        self.status = status
        self.headers = headers
        self.body = body
        self.events = events
        self.framing_errors = framing_errors or []

    def text(self):
        return self.body.decode('utf-8', errors='replace')

    def json(self):
        return json.loads(self.text())


def read_events(response, start):
    events, fields, errors = [], [], []

    def flush():
        if fields:
            name, data = None, []
            for key, value in fields:
                if key == 'event':
                    name = value
                elif key == 'data':
                    data.append(value)
            events.append(Event(name, '\n'.join(data), time.monotonic() - start))
            del fields[:]

    for raw in iter(response.readline, b''):
        line = raw.decode('utf-8', errors='replace').rstrip('\r\n')
        if line == '':
            flush()
            continue
        if line.startswith(':'):
            continue
        key, _, value = line.partition(':')
        if value.startswith(' '):
            value = value[1:]
        if key not in ('event', 'data', 'id', 'retry'):
            errors.append('unrecognized SSE line %r' % line[:80])
            continue
        fields.append((key, value))
    if fields:
        errors.append('stream ended inside an unterminated event')
        flush()
    return events, errors


def send(origin, method, path, payload=None, headers=None, timeout=60.0, stream=False):
    parts = urlsplit(origin)
    connect = http.client.HTTPSConnection if parts.scheme == 'https' else http.client.HTTPConnection
    connection = connect(parts.hostname, parts.port, timeout=timeout)
    data = None if payload is None else json.dumps(payload).encode('utf-8')
    request_headers = {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream' if stream else 'application/json',
    }
    request_headers.update(headers or {})
    start = time.monotonic()
    try:
        connection.request(method, path, body=data, headers=request_headers)
        response = connection.getresponse()
        response_headers = {key.lower(): value for key, value in response.getheaders()}
        if stream and response.status == 200:
            events, errors = read_events(response, start)
            return Response(response.status, response_headers, b'', events, errors)
        return Response(response.status, response_headers, response.read())
    finally:
        connection.close()
