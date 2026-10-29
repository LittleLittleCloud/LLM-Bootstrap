"""OpenAI Responses API checks: response object, streaming events, function calling, and errors."""
from checks_core import (
    HELLO, LONG, MAX_OUTPUT_TOKENS, WEATHER_ASK, WEATHER_SCHEMA,
    check, error_body, expect, field, in_order, loads_object, named_events, ok_json, tool_arguments,
)

API = 'openai-responses'
PATH = '/v1/responses'
STATUSES = ('completed', 'incomplete', 'failed', 'in_progress', 'cancelled', 'queued')
WEATHER = {'type': 'function', 'name': 'get_weather', 'description': 'Get the current weather for a city.',
           'parameters': WEATHER_SCHEMA}


def payload(ctx, content, **extra):
    body = {'model': ctx.model, 'input': content, 'temperature': 0, 'max_output_tokens': 32, 'store': False}
    body.update(extra)
    return body


def post(ctx, key, content, **extra):
    return ctx.request(key, 'POST', PATH, payload(ctx, content, **extra), stream=bool(extra.get('stream')))


def response_object(body, status='completed'):
    expect(isinstance(body, dict), 'body is not a JSON object')
    expect(field(body, 'object', str) == 'response', "object should be 'response', got %r" % body['object'])
    field(body, 'id', str)
    field(body, 'created_at', float)
    expect(field(body, 'status', str) in STATUSES, 'unknown status %r' % body['status'])
    expect(body['status'] == status, "status should be %r, got %r" % (status, body['status']))
    field(body, 'model', str)
    field(body, 'output', list)
    usage = field(body, 'usage', dict)
    prompt = field(usage, 'input_tokens', int, 'usage')
    done = field(usage, 'output_tokens', int, 'usage')
    expect(field(usage, 'total_tokens', int, 'usage') == prompt + done, 'usage.total_tokens is not input_tokens + output_tokens')
    return body


def message_item(body):
    items = [item for item in body['output'] if item.get('type') == 'message']
    expect(items, 'output has no message item')
    item = items[0]
    field(item, 'id', str, 'message item')
    expect(field(item, 'role', str, 'message item') == 'assistant', "message role should be 'assistant'")
    expect(field(item, 'status', str, 'message item') in STATUSES, 'unknown message status')
    parts = field(item, 'content', list, 'message item')
    expect(parts, 'message content is empty')
    part = parts[0]
    expect(field(part, 'type', str, 'content[0]') == 'output_text', "content[0].type should be 'output_text'")
    field(part, 'text', str, 'content[0]')
    if 'annotations' in part:
        field(part, 'annotations', list, 'content[0]')
    return item


def text_of(item):
    return item['content'][0]['text']


@check('responses.basic.schema', API, 'A non-streaming response has the exact Responses object shape.')
def basic_schema(ctx):
    body = response_object(ok_json(post(ctx, 'responses.basic', HELLO)))
    expect(text_of(message_item(body)).strip(), 'the output text is empty')


@check('responses.max_output_tokens', API, 'max_output_tokens ends the response as incomplete with a reason.')
def max_output_tokens(ctx):
    body = response_object(ok_json(post(ctx, 'responses.length', LONG, max_output_tokens=16)), 'incomplete')
    details = field(body, 'incomplete_details', dict)
    expect(field(details, 'reason', str, 'incomplete_details') == 'max_output_tokens', "incomplete_details.reason should be 'max_output_tokens'")
    expect(body['usage']['output_tokens'] <= 16, 'output_tokens %s exceeds max_output_tokens 16' % body['usage']['output_tokens'])


@check('responses.input_items', API, 'A list of input messages plus instructions is accepted.')
def input_items(ctx):
    items = [{'role': 'user', 'content': 'Hi.'}, {'role': 'assistant', 'content': 'Hello.'}, {'role': 'user', 'content': HELLO}]
    body = response_object(ok_json(post(ctx, 'responses.items', items, instructions='You are terse.')))
    message_item(body)


@check('responses.error.missing_input', API, 'A request without input gets a 4xx error object.')
def missing_input(ctx):
    error_body(ctx.request('responses.error', 'POST', PATH, {'model': ctx.model}), 'openai')


def stream_events(ctx):
    return named_events(post(ctx, 'responses.stream', HELLO, stream=True))


def sequence_checked(events):
    last = -1
    for event in events:
        number = field(event, 'sequence_number', int, event['type'])
        expect(number > last, 'sequence_number does not increase at %s' % event['type'])
        last = number
    names = [event['type'] for event in events]
    expect(names[0] == 'response.created', "the first event should be response.created, got %s" % names[0])
    expect(names[-1] == 'response.completed', "the last event should be response.completed, got %s" % names[-1])
    return names


@check('responses.stream.events', API, 'Streaming emits the named lifecycle events in order and the deltas add up.')
def stream_text(ctx):
    events = stream_events(ctx)
    names = sequence_checked(events)
    in_order(names, [
        'response.created', 'response.output_item.added', 'response.content_part.added', 'response.output_text.delta',
        'response.output_text.done', 'response.content_part.done', 'response.output_item.done', 'response.completed',
    ], 'text stream')
    deltas = ''.join(e['delta'] for e in events if e['type'] == 'response.output_text.delta')
    done = [e for e in events if e['type'] == 'response.output_text.done'][0]
    final = text_of(message_item(response_object(events[-1]['response'])))
    expect(deltas == field(done, 'text', str, 'output_text.done'), 'the deltas do not add up to output_text.done.text')
    expect(deltas == final, 'the deltas do not add up to the final response text')


@check('responses.stream.matches_nonstream', API, 'Streamed text equals non-streamed text for the same request.', 'advisory')
def stream_matches(ctx):
    events = stream_events(ctx)
    streamed = ''.join(e['delta'] for e in events if e['type'] == 'response.output_text.delta')
    plain = text_of(message_item(response_object(ok_json(post(ctx, 'responses.basic', HELLO)))))
    expect(streamed == plain, 'streamed %r differs from non-streamed %r' % (streamed[:40], plain[:40]))


def tool_payload(**extra):
    return dict(tools=[WEATHER], max_output_tokens=MAX_OUTPUT_TOKENS, **extra)


def function_call(item, where):
    expect(field(item, 'call_id', str, where).strip(), '%s.call_id is empty' % where)
    expect(field(item, 'name', str, where) == 'get_weather', '%s calls %r' % (where, item['name']))
    field(item, 'id', str, where)
    tool_arguments('get_weather', loads_object(item.get('arguments'), where + '.arguments'), where)


@check('responses.tools.forced_call', API, 'A forced tool_choice returns a function_call item with JSON arguments.')
def tools_forced(ctx):
    body = response_object(ok_json(post(
        ctx, 'responses.tools', WEATHER_ASK, **tool_payload(tool_choice={'type': 'function', 'name': 'get_weather'}))))
    calls = [item for item in body['output'] if item.get('type') == 'function_call']
    expect(calls, 'output has no function_call item')
    function_call(calls[0], 'output function_call')


@check('responses.tools.result_roundtrip', API, 'A function_call_output input item is accepted and answered.')
def tools_roundtrip(ctx):
    items = [
        {'role': 'user', 'content': WEATHER_ASK},
        {'type': 'function_call', 'call_id': 'call_1', 'name': 'get_weather', 'arguments': '{"city": "Paris"}'},
        {'type': 'function_call_output', 'call_id': 'call_1', 'output': 'Sunny, 22 C'},
    ]
    body = response_object(ok_json(post(ctx, 'responses.roundtrip', items, **tool_payload())))
    message_item(body)


@check('responses.tools.stream', API, 'Streamed function calls emit argument deltas that join into the final arguments.')
def tools_stream(ctx):
    events = named_events(post(
        ctx, 'responses.tools.stream', WEATHER_ASK, stream=True,
        **tool_payload(tool_choice={'type': 'function', 'name': 'get_weather'})))
    names = sequence_checked(events)
    in_order(names, [
        'response.created', 'response.output_item.added', 'response.function_call_arguments.delta',
        'response.function_call_arguments.done', 'response.output_item.done', 'response.completed',
    ], 'function call stream')
    joined = ''.join(e['delta'] for e in events if e['type'] == 'response.function_call_arguments.delta')
    done = [e for e in events if e['type'] == 'response.function_call_arguments.done'][0]
    expect(joined == field(done, 'arguments', str, 'arguments.done'), 'the deltas do not add up to arguments.done')
    final = [i for i in response_object(events[-1]['response'])['output'] if i.get('type') == 'function_call']
    expect(final, 'the completed response has no function_call item')
    function_call(final[0], 'completed function_call')
    expect(final[0]['arguments'] == joined, 'the final arguments differ from the streamed deltas')
