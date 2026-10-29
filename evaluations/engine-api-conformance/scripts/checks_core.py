"""Check registry, assertion helpers, and the request context shared by all checks."""
import json

import client

# Largest max_tokens any check sends. evaluation.json limits must match it.
MAX_OUTPUT_TOKENS = 64
APIS = ('openai-chat', 'openai-responses', 'anthropic-messages')

HELLO = 'Say hello in one short sentence.'
LONG = 'Write the numbers from 1 to 200 separated by spaces.'
STOP = 'Write the numbers 1 2 3 4 5 6 7 8 9 10 separated by spaces.'
WEATHER_ASK = 'What is the weather in Paris? Use the get_weather tool.'
TIME_ASK = 'What time is it in UTC? Use the get_time tool.'
JSON_ASK = 'Reply with a JSON object that has the key ok set to true.'

WEATHER_SCHEMA = {
    'type': 'object',
    'properties': {'city': {'type': 'string', 'description': 'City name'}},
    'required': ['city'],
}
TIME_SCHEMA = {
    'type': 'object',
    'properties': {'timezone': {'type': 'string', 'description': 'IANA time zone'}},
    'required': ['timezone'],
}
REQUIRED_ARGUMENT = {'get_weather': 'city', 'get_time': 'timezone'}


class Fail(Exception):
    """The endpoint violated the API contract."""


class Skip(Exception):
    """The check could not be decided, for example an optional feature is unsupported."""


class Check:
    def __init__(self, check_id, api, level, description, run):
        self.id = check_id
        self.api = api
        self.level = level
        self.description = description
        self.run = run


REGISTRY = []


def check(check_id, api, description, level='required'):
    def register(run):
        REGISTRY.append(Check(check_id, api, level, description, run))
        return run
    return register


def expect(condition, message):
    if not condition:
        raise Fail(message)


def short(value, limit=80):
    text = repr(value) if isinstance(value, str) else json.dumps(value)
    return text if len(text) <= limit else text[:limit] + '...'


def _is(value, kind):
    if kind is None:
        return value is None
    if kind is bool:
        return isinstance(value, bool)
    if kind is int:
        return isinstance(value, int) and not isinstance(value, bool)
    if kind is float:
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    return isinstance(value, kind)


def field(obj, key, kind, where='response'):
    expect(isinstance(obj, dict), '%s is not a JSON object' % where)
    expect(key in obj, '%s.%s is missing' % (where, key))
    value = obj[key]
    kinds = kind if isinstance(kind, tuple) else (kind,)
    expect(any(_is(value, k) for k in kinds), '%s.%s has unexpected value %s' % (where, key, short(value)))
    return value


def json_body(response):
    try:
        return response.json()
    except ValueError:
        raise Fail('body is not valid JSON: %s' % short(response.text()))


def ok_json(response):
    expect(response.status == 200, 'HTTP %s: %s' % (response.status, short(response.text(), 160)))
    return json_body(response)


def error_body(response, shape):
    expect(400 <= response.status < 500, 'expected a 4xx status, got %s' % response.status)
    body = json_body(response)
    if shape == 'anthropic':
        expect(field(body, 'type', str) == 'error', "body.type should be 'error'")
    error = field(body, 'error', dict, 'body')
    field(error, 'message', str, 'error')
    if shape == 'anthropic':
        field(error, 'type', str, 'error')
    return error


def loads_object(text, where):
    expect(isinstance(text, str), '%s should be a JSON string, got %s' % (where, short(text)))
    try:
        value = json.loads(text)
    except ValueError:
        raise Fail('%s is not valid JSON: %s' % (where, short(text)))
    expect(isinstance(value, dict), '%s should decode to an object' % where)
    return value


def tool_arguments(name, arguments, where):
    key = REQUIRED_ARGUMENT[name]
    value = arguments.get(key)
    expect(isinstance(value, str) and value.strip(), '%s: arguments.%s is missing' % (where, key))


def sse_events(response):
    expect(response.status == 200, 'HTTP %s: %s' % (response.status, short(response.text(), 160)))
    content_type = response.headers.get('content-type', '')
    expect(content_type.startswith('text/event-stream'), 'content-type is %r, expected text/event-stream' % content_type)
    expect(not response.framing_errors, 'SSE framing: %s' % '; '.join(response.framing_errors[:3]))
    expect(response.events, 'stream contained no events')
    return response.events


def event_json(event):
    try:
        data = json.loads(event.data)
    except ValueError:
        raise Fail('event data is not JSON: %s' % short(event.data))
    expect(isinstance(data, dict), 'event data is not a JSON object')
    return data


def named_events(response):
    """Parse a stream whose event: name must equal data.type (Responses and Messages APIs)."""
    out = []
    for event in sse_events(response):
        expect(event.event, 'event has no event: line: %s' % short(event.data))
        data = event_json(event)
        expect(data.get('type') == event.event, 'event %r carries data.type %r' % (event.event, data.get('type')))
        out.append(data)
    return out


def in_order(names, expected, where):
    position = -1
    for wanted in expected:
        try:
            position = names.index(wanted, position + 1)
        except ValueError:
            raise Fail('%s: %s is missing or out of order (saw %s)' % (where, wanted, ', '.join(names[:12])))


class Context:
    def __init__(self, origin, model, api_key=None, timeout=60.0):
        self.origin = origin
        self.model = model
        self.api_key = api_key
        self.timeout = timeout
        self.cache = {}
        self.log = {}
        self.touched = []
        self.requests = 0
        self.prompt_tokens = 0
        self.completion_tokens = 0
        self.tokens_seen = False

    def request(self, key, method, path, payload=None, stream=False):
        """Send a request once per key; checks that share a key share the response."""
        if key not in self.cache:
            for limit in ('max_tokens', 'max_output_tokens'):
                if payload and payload.get(limit, 0) > MAX_OUTPUT_TOKENS:
                    raise AssertionError('%s exceeds the evaluation limit' % limit)
            headers = {}
            if self.api_key:
                headers['Authorization'] = 'Bearer ' + self.api_key
                headers['x-api-key'] = self.api_key
            if path == '/v1/messages':
                headers['anthropic-version'] = '2023-06-01'
            self.requests += 1
            response = client.send(self.origin, method, path, payload, headers, self.timeout, stream)
            self.cache[key] = response
            self.log[key] = self._entry(method, path, payload, response)
            self._count_tokens(response)
        if key not in self.touched:
            self.touched.append(key)
        return self.cache[key]

    def _entry(self, method, path, payload, response):
        if response.events is not None:
            body = '\n'.join('event: %s | data: %s' % (e.event, e.data) for e in response.events)
        else:
            body = response.text()
        return {
            'request': {'method': method, 'path': path, 'payload': payload},
            'status': response.status,
            'content_type': response.headers.get('content-type'),
            'response': body[:2000],
        }

    def _count_tokens(self, response):
        objects = []
        if response.events is not None:
            for event in response.events:
                try:
                    objects.append(json.loads(event.data))
                except ValueError:
                    pass
        elif response.status == 200:
            try:
                objects.append(response.json())
            except ValueError:
                pass
        prompt = completion = None
        for obj in objects:
            if not isinstance(obj, dict):
                continue
            usage = obj.get('usage')
            for nested in ('message', 'response'):
                if not isinstance(usage, dict) and isinstance(obj.get(nested), dict):
                    usage = obj[nested].get('usage')
            if not isinstance(usage, dict):
                continue
            first = usage.get('prompt_tokens', usage.get('input_tokens'))
            last = usage.get('completion_tokens', usage.get('output_tokens'))
            if _is(first, int) and prompt is None:
                prompt = first
            if _is(last, int):
                completion = last
        if prompt is not None or completion is not None:
            self.tokens_seen = True
            self.prompt_tokens += prompt or 0
            self.completion_tokens += completion or 0

    def evidence_for(self, keys):
        return {key: self.log[key] for key in keys if key in self.log}
