"""Anthropic Messages API checks: message object, streaming events, tool use, and errors."""
from checks_core import (
    HELLO, LONG, MAX_OUTPUT_TOKENS, STOP, WEATHER_ASK, WEATHER_SCHEMA,
    Skip, check, error_body, expect, field, in_order, loads_object, named_events, ok_json, tool_arguments,
)

API = 'anthropic-messages'
PATH = '/v1/messages'
STOP_REASONS = ('end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn', 'refusal')
WEATHER = {'name': 'get_weather', 'description': 'Get the current weather for a city.', 'input_schema': WEATHER_SCHEMA}
FORCED = {'type': 'tool', 'name': 'get_weather'}


def payload(ctx, content, **extra):
    messages = [{'role': 'user', 'content': content}] if isinstance(content, str) else content
    body = {'model': ctx.model, 'max_tokens': 32, 'temperature': 0, 'messages': messages}
    body.update(extra)
    return body


def post(ctx, key, content, **extra):
    return ctx.request(key, 'POST', PATH, payload(ctx, content, **extra), stream=bool(extra.get('stream')))


def message(body, stop_reason=None):
    expect(isinstance(body, dict), 'body is not a JSON object')
    expect(field(body, 'type', str) == 'message', "type should be 'message', got %r" % body['type'])
    expect(field(body, 'role', str) == 'assistant', "role should be 'assistant'")
    field(body, 'id', str)
    field(body, 'model', str)
    content = field(body, 'content', list)
    expect(content, 'content is empty')
    for index, block in enumerate(content):
        field(block, 'type', str, 'content[%d]' % index)
    reason = field(body, 'stop_reason', str)
    expect(reason in STOP_REASONS, 'unknown stop_reason %r' % reason)
    if stop_reason:
        expect(reason == stop_reason, 'stop_reason should be %r, got %r' % (stop_reason, reason))
    field(body, 'stop_sequence', (str, None))
    usage = field(body, 'usage', dict)
    field(usage, 'input_tokens', int, 'usage')
    field(usage, 'output_tokens', int, 'usage')
    return body


def text_of(body):
    texts = [b for b in body['content'] if b['type'] == 'text']
    expect(texts, 'content has no text block')
    return field(texts[0], 'text', str, 'text block')


@check('anthropic.basic.schema', API, 'A non-streaming message has the exact Messages response shape.')
def basic_schema(ctx):
    body = message(ok_json(post(ctx, 'anthropic.basic', HELLO)), 'end_turn')
    expect(text_of(body).strip(), 'the text block is empty')


@check('anthropic.max_tokens', API, "max_tokens ends the message with stop_reason 'max_tokens'.")
def max_tokens(ctx):
    body = message(ok_json(post(ctx, 'anthropic.length', LONG, max_tokens=8)), 'max_tokens')
    expect(body['usage']['output_tokens'] <= 8, 'output_tokens %s exceeds max_tokens 8' % body['usage']['output_tokens'])


@check('anthropic.stop_sequences', API, "stop_sequences end the message with stop_reason 'stop_sequence'.")
def stop_sequences(ctx):
    base = message(ok_json(post(ctx, 'anthropic.stop.base', STOP, max_tokens=40)))
    if '5' not in text_of(base):
        raise Skip('the unstopped output does not contain the stop sequence')
    stopped = message(ok_json(post(ctx, 'anthropic.stop.stopped', STOP, max_tokens=40, stop_sequences=['5'])), 'stop_sequence')
    expect(stopped['stop_sequence'] == '5', 'stop_sequence should be the matched string, got %r' % stopped['stop_sequence'])
    expect('5' not in text_of(stopped), 'the stop sequence appears in the text')


@check('anthropic.system_multiturn', API, 'A top-level system prompt and several turns are accepted.')
def system_multiturn(ctx):
    turns = [
        {'role': 'user', 'content': 'Hi.'},
        {'role': 'assistant', 'content': 'Hello.'},
        {'role': 'user', 'content': HELLO},
    ]
    message(ok_json(post(ctx, 'anthropic.multiturn', turns, system='You are terse.')))


@check('anthropic.error.missing_max_tokens', API, "A request without max_tokens gets a 4xx {'type': 'error'} body.")
def missing_max_tokens(ctx):
    body = {'model': ctx.model, 'messages': [{'role': 'user', 'content': HELLO}]}
    error_body(ctx.request('anthropic.error', 'POST', PATH, body), 'anthropic')


def stream_events(ctx):
    return named_events(post(ctx, 'anthropic.stream', HELLO, stream=True))


def lifecycle(events):
    names = [e['type'] for e in events if e['type'] != 'ping']
    expect('error' not in names, 'the stream contains an error event')
    in_order(names, ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'], 'stream')
    expect(names[0] == 'message_start', 'the first event should be message_start, got %s' % names[0])
    expect(names[-1] == 'message_stop', 'the last event should be message_stop, got %s' % names[-1])
    start = field(events[0], 'message', dict, 'message_start')
    expect(field(start, 'role', str, 'message_start.message') == 'assistant', "message_start.message.role should be 'assistant'")
    field(start, 'id', str, 'message_start.message')
    field(field(start, 'usage', dict, 'message_start.message'), 'input_tokens', int, 'message_start.message.usage')
    delta = [e for e in events if e['type'] == 'message_delta'][0]
    field(field(delta, 'usage', dict, 'message_delta'), 'output_tokens', int, 'message_delta.usage')
    return field(field(delta, 'delta', dict, 'message_delta'), 'stop_reason', str, 'message_delta.delta')


@check('anthropic.stream.events', API, 'Streaming emits message_start through message_stop in order with text_delta blocks.')
def stream_text(ctx):
    events = stream_events(ctx)
    expect(lifecycle(events) == 'end_turn', "stop_reason should be 'end_turn'")
    starts = [e for e in events if e['type'] == 'content_block_start']
    block = field(starts[0], 'content_block', dict, 'content_block_start')
    expect(field(block, 'type', str, 'content_block_start.content_block') == 'text', "the first block should be 'text'")
    for event in events:
        if event['type'] == 'content_block_delta':
            expect(field(field(event, 'delta', dict, 'content_block_delta'), 'type', str, 'delta') == 'text_delta', "delta.type should be 'text_delta'")
    expect(''.join(e['delta']['text'] for e in events if e['type'] == 'content_block_delta').strip(), 'the streamed text is empty')


@check('anthropic.stream.matches_nonstream', API, 'Streamed text equals non-streamed text for the same request.', 'advisory')
def stream_matches(ctx):
    streamed = ''.join(e['delta']['text'] for e in stream_events(ctx) if e['type'] == 'content_block_delta')
    plain = text_of(message(ok_json(post(ctx, 'anthropic.basic', HELLO))))
    expect(streamed == plain, 'streamed %r differs from non-streamed %r' % (streamed[:40], plain[:40]))


def tool_request(ctx, key, content, **extra):
    return post(ctx, key, content, max_tokens=MAX_OUTPUT_TOKENS, tools=[WEATHER], tool_choice=FORCED, **extra)


@check('anthropic.tools.forced_call', API, 'A forced tool_choice returns a tool_use block with an input object.')
def tools_forced(ctx):
    body = message(ok_json(tool_request(ctx, 'anthropic.tools', WEATHER_ASK)), 'tool_use')
    blocks = [b for b in body['content'] if b['type'] == 'tool_use']
    expect(blocks, 'content has no tool_use block')
    block = blocks[0]
    expect(field(block, 'id', str, 'tool_use').strip(), 'tool_use.id is empty')
    expect(field(block, 'name', str, 'tool_use') == 'get_weather', 'tool_use calls %r' % block['name'])
    tool_arguments('get_weather', field(block, 'input', dict, 'tool_use'), 'tool_use.input')


@check('anthropic.tools.result_roundtrip', API, 'A tool_result block is accepted and answered.')
def tools_roundtrip(ctx):
    turns = [
        {'role': 'user', 'content': WEATHER_ASK},
        {'role': 'assistant', 'content': [{'type': 'tool_use', 'id': 'toolu_1', 'name': 'get_weather', 'input': {'city': 'Paris'}}]},
        {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': 'toolu_1', 'content': 'Sunny, 22 C'}]},
    ]
    body = ok_json(post(ctx, 'anthropic.roundtrip', turns, max_tokens=MAX_OUTPUT_TOKENS, tools=[WEATHER]))
    text_of(message(body))


@check('anthropic.tools.stream', API, 'Streamed tool use sends a tool_use block, input_json_delta fragments, and stop_reason tool_use.')
def tools_stream(ctx):
    events = named_events(tool_request(ctx, 'anthropic.tools.stream', WEATHER_ASK, stream=True))
    expect(lifecycle(events) == 'tool_use', "stop_reason should be 'tool_use'")
    starts = [e for e in events if e['type'] == 'content_block_start']
    block = field(starts[0], 'content_block', dict, 'content_block_start')
    expect(field(block, 'type', str, 'content_block') == 'tool_use', "the block should be 'tool_use'")
    expect(field(block, 'id', str, 'content_block').strip(), 'tool_use block has no id')
    expect(field(block, 'name', str, 'content_block') == 'get_weather', 'tool_use calls %r' % block['name'])
    pieces = []
    for event in events:
        if event['type'] == 'content_block_delta':
            delta = field(event, 'delta', dict, 'content_block_delta')
            expect(field(delta, 'type', str, 'delta') == 'input_json_delta', "delta.type should be 'input_json_delta'")
            pieces.append(field(delta, 'partial_json', str, 'delta'))
    tool_arguments('get_weather', loads_object(''.join(pieces), 'joined partial_json'), 'streamed tool_use')
