"""OpenAI Chat Completions checks: non-streaming, streaming, tool calling, and error format."""
from checks_core import (
    HELLO, JSON_ASK, LONG, MAX_OUTPUT_TOKENS, STOP, TIME_ASK, TIME_SCHEMA, WEATHER_ASK, WEATHER_SCHEMA,
    Skip, check, error_body, event_json, expect, field, loads_object, ok_json, sse_events, tool_arguments,
)

API = 'openai-chat'
CHAT = '/v1/chat/completions'
FINISH = ('stop', 'length', 'tool_calls', 'content_filter', 'function_call')
WEATHER = {'type': 'function', 'function': {
    'name': 'get_weather', 'description': 'Get the current weather for a city.', 'parameters': WEATHER_SCHEMA}}
TIME = {'type': 'function', 'function': {
    'name': 'get_time', 'description': 'Get the current time in a time zone.', 'parameters': TIME_SCHEMA}}


def forced(name):
    return {'type': 'function', 'function': {'name': name}}


def payload(ctx, content, **extra):
    messages = [{'role': 'user', 'content': content}] if isinstance(content, str) else content
    body = {'model': ctx.model, 'messages': messages, 'temperature': 0, 'max_tokens': 32}
    body.update(extra)
    return body


def post(ctx, key, content, **extra):
    return ctx.request(key, 'POST', CHAT, payload(ctx, content, **extra), stream=bool(extra.get('stream')))


def completion(body):
    expect(isinstance(body, dict), 'body is not a JSON object')
    expect(field(body, 'object', str) == 'chat.completion', "object should be 'chat.completion', got %r" % body['object'])
    field(body, 'id', str)
    field(body, 'created', int)
    field(body, 'model', str)
    choices = field(body, 'choices', list)
    expect(choices, 'choices is empty')
    choice = choices[0]
    expect(field(choice, 'index', int, 'choices[0]') == 0, 'choices[0].index should be 0')
    message = field(choice, 'message', dict, 'choices[0]')
    expect(field(message, 'role', str, 'message') == 'assistant', "message.role should be 'assistant'")
    expect('content' in message, 'message.content is missing')
    field(message, 'content', (str, None), 'message')
    expect(field(choice, 'finish_reason', str, 'choices[0]') in FINISH, 'unknown finish_reason %r' % choice['finish_reason'])
    usage = field(body, 'usage', dict)
    prompt = field(usage, 'prompt_tokens', int, 'usage')
    done = field(usage, 'completion_tokens', int, 'usage')
    expect(field(usage, 'total_tokens', int, 'usage') == prompt + done, 'usage.total_tokens is not prompt_tokens + completion_tokens')
    return choice


def text_of(choice):
    return choice['message'].get('content') or ''


def nonempty_when_stopped(choice):
    if choice['finish_reason'] == 'stop':
        expect(text_of(choice).strip(), 'finish_reason is stop but content is empty')


@check('chat.models.list', API, 'GET /v1/models returns an OpenAI model list.')
def models_list(ctx):
    body = ok_json(ctx.request('chat.models', 'GET', '/v1/models'))
    expect(field(body, 'object', str) == 'list', "object should be 'list'")
    data = field(body, 'data', list)
    expect(data, 'data is empty')
    for index, item in enumerate(data):
        field(item, 'id', str, 'data[%d]' % index)
        expect(field(item, 'object', str, 'data[%d]' % index) == 'model', "data[%d].object should be 'model'" % index)


@check('chat.models.contains_model', API, 'The configured model id appears in /v1/models.', 'advisory')
def models_contains(ctx):
    body = ok_json(ctx.request('chat.models', 'GET', '/v1/models'))
    ids = [item.get('id') for item in field(body, 'data', list)]
    expect(ctx.model in ids, 'model %r is not listed (saw %s)' % (ctx.model, ', '.join(map(str, ids[:5]))))


@check('chat.basic.schema', API, 'A non-streaming completion has the exact OpenAI response shape.')
def basic_schema(ctx):
    choice = completion(ok_json(post(ctx, 'chat.basic', HELLO)))
    nonempty_when_stopped(choice)


@check('chat.max_tokens', API, 'max_tokens truncates output with finish_reason length.')
def max_tokens(ctx):
    body = ok_json(post(ctx, 'chat.length', LONG, max_tokens=8))
    choice = completion(body)
    expect(choice['finish_reason'] == 'length', "finish_reason should be 'length', got %r" % choice['finish_reason'])
    expect(1 <= body['usage']['completion_tokens'] <= 8, 'completion_tokens %s exceeds max_tokens 8' % body['usage']['completion_tokens'])


@check('chat.stop_sequence', API, 'A stop string is honored and never appears in the output.')
def stop_sequence(ctx):
    base = completion(ok_json(post(ctx, 'chat.stop.base', STOP, max_tokens=40)))
    if '5' not in text_of(base):
        raise Skip('the unstopped output does not contain the stop string')
    stopped = completion(ok_json(post(ctx, 'chat.stop.stopped', STOP, max_tokens=40, stop=['5'])))
    expect('5' not in text_of(stopped), 'the stop string appears in the output')
    expect(stopped['finish_reason'] == 'stop', "finish_reason should be 'stop', got %r" % stopped['finish_reason'])


@check('chat.roles.multiturn', API, 'System, user, and assistant roles are accepted in one conversation.')
def multiturn(ctx):
    messages = [
        {'role': 'system', 'content': 'You are terse.'},
        {'role': 'user', 'content': 'Hi.'},
        {'role': 'assistant', 'content': 'Hello.'},
        {'role': 'user', 'content': HELLO},
    ]
    nonempty_when_stopped(completion(ok_json(post(ctx, 'chat.multiturn', messages))))


@check('chat.determinism', API, 'Two identical temperature 0 requests return identical text.', 'advisory')
def determinism(ctx):
    first = completion(ok_json(post(ctx, 'chat.basic', HELLO)))
    second = completion(ok_json(post(ctx, 'chat.basic.repeat', HELLO)))
    expect(text_of(first) == text_of(second), 'outputs differ: %r vs %r' % (text_of(first)[:40], text_of(second)[:40]))


@check('chat.json_object', API, "response_format json_object yields a JSON object.", 'advisory')
def json_object(ctx):
    response = post(ctx, 'chat.json', JSON_ASK, response_format={'type': 'json_object'})
    if 400 <= response.status < 500:
        raise Skip('response_format is not supported (HTTP %d)' % response.status)
    choice = completion(ok_json(response))
    loads_object(text_of(choice), 'content')


@check('chat.error.missing_messages', API, 'A request without messages gets a 4xx OpenAI error object.')
def missing_messages(ctx):
    error_body(ctx.request('chat.error.messages', 'POST', CHAT, {'model': ctx.model}), 'openai')


@check('chat.error.unknown_model', API, 'An unknown model gets a 4xx OpenAI error object.')
def unknown_model(ctx):
    response = ctx.request('chat.error.model', 'POST', CHAT, payload(ctx, HELLO, model='conformance-no-such-model'))
    if response.status == 200:
        raise Skip('the engine serves any model name')
    error_body(response, 'openai')


def stream_response(ctx):
    return post(ctx, 'chat.stream', HELLO, stream=True, stream_options={'include_usage': True})


def chunks_of(response):
    events = sse_events(response)
    expect(events[-1].data == '[DONE]', 'the stream does not end with data: [DONE]')
    chunks = []
    for event in events[:-1]:
        expect(event.data != '[DONE]', '[DONE] appears before the end of the stream')
        chunks.append(event_json(event))
    expect(chunks, 'the stream has no chunks before [DONE]')
    return chunks


def validated_chunks(response):
    chunks = chunks_of(response)
    ids = set()
    for index, chunk in enumerate(chunks):
        where = 'chunk[%d]' % index
        expect(field(chunk, 'object', str, where) == 'chat.completion.chunk', "%s.object should be 'chat.completion.chunk'" % where)
        ids.add(field(chunk, 'id', str, where))
        field(chunk, 'created', int, where)
        field(chunk, 'model', str, where)
        field(chunk, 'choices', list, where)
    expect(len(ids) == 1, 'chunks carry different ids')
    return chunks


def carrying(chunks):
    return [chunk for chunk in chunks if chunk['choices']]


def finish_of(chunks):
    holders = carrying(chunks)
    expect(holders, 'no chunk carries a choice')
    finals = [c for c in holders if c['choices'][0].get('finish_reason') is not None]
    expect(len(finals) == 1, 'exactly one chunk should carry finish_reason, found %d' % len(finals))
    expect(finals[0] is holders[-1], 'finish_reason is not on the last chunk with choices')
    reason = finals[0]['choices'][0]['finish_reason']
    expect(reason in FINISH, 'unknown finish_reason %r' % reason)
    return reason


@check('chat.stream.framing', API, 'Streaming uses text/event-stream, data: lines, and ends with [DONE].')
def stream_framing(ctx):
    chunks_of(stream_response(ctx))


@check('chat.stream.chunks', API, 'Every chunk is a chat.completion.chunk; the first delta has the assistant role; one finish_reason.')
def stream_chunks(ctx):
    chunks = validated_chunks(stream_response(ctx))
    holders = carrying(chunks)
    expect(holders, 'no chunk carries a choice')
    first = field(holders[0]['choices'][0], 'delta', dict, 'first choice')
    expect(first.get('role') == 'assistant', "the first delta should have role 'assistant', got %r" % first.get('role'))
    for index, chunk in enumerate(holders):
        choice = chunk['choices'][0]
        expect(field(choice, 'index', int, 'chunk choice') == 0, 'choice index should be 0')
        delta = field(choice, 'delta', dict, 'chunk choice')
        if 'content' in delta:
            field(delta, 'content', (str, None), 'delta')
    finish_of(chunks)


@check('chat.stream.usage', API, 'stream_options.include_usage adds a final usage chunk with empty choices.')
def stream_usage(ctx):
    chunks = validated_chunks(stream_response(ctx))
    last = chunks[-1]
    expect(last['choices'] == [], 'the last chunk should have empty choices to carry usage')
    usage = field(last, 'usage', dict, 'last chunk')
    prompt = field(usage, 'prompt_tokens', int, 'usage')
    done = field(usage, 'completion_tokens', int, 'usage')
    expect(field(usage, 'total_tokens', int, 'usage') == prompt + done, 'usage.total_tokens is not prompt_tokens + completion_tokens')
    expect(done >= 1, 'completion_tokens should be at least 1')
    for chunk in chunks[:-1]:
        expect(chunk.get('usage') is None, 'only the last chunk should carry usage')


@check('chat.stream.incremental', API, 'Text arrives in more than one content chunk.', 'advisory')
def stream_incremental(ctx):
    chunks = validated_chunks(stream_response(ctx))
    usage = chunks[-1].get('usage')
    if not isinstance(usage, dict) or not isinstance(usage.get('completion_tokens'), int) or usage['completion_tokens'] < 4:
        raise Skip('too few completion tokens to judge incremental delivery')
    pieces = [c['choices'][0]['delta'].get('content') for c in carrying(chunks)]
    expect(len([p for p in pieces if p]) >= 2, 'the text arrived in a single content chunk')


@check('chat.stream.max_tokens', API, 'A streamed completion honors max_tokens with finish_reason length.')
def stream_max_tokens(ctx):
    chunks = validated_chunks(post(ctx, 'chat.stream.length', LONG, stream=True, max_tokens=8))
    expect(finish_of(chunks) == 'length', "finish_reason should be 'length'")


@check('chat.stream.matches_nonstream', API, 'Streamed text equals non-streamed text for the same request.', 'advisory')
def stream_matches(ctx):
    chunks = validated_chunks(stream_response(ctx))
    streamed = ''.join(c['choices'][0]['delta'].get('content') or '' for c in carrying(chunks))
    plain = text_of(completion(ok_json(post(ctx, 'chat.basic', HELLO))))
    expect(streamed == plain, 'streamed %r differs from non-streamed %r' % (streamed[:40], plain[:40]))


def tool_request(ctx, key, content, tools, choice, **extra):
    return post(ctx, key, content, max_tokens=MAX_OUTPUT_TOKENS, tools=tools, tool_choice=choice, **extra)


def validate_call(call, name, where):
    expect(field(call, 'id', str, where).strip(), '%s.id is empty' % where)
    expect(field(call, 'type', str, where) == 'function', "%s.type should be 'function'" % where)
    function = field(call, 'function', dict, where)
    expect(field(function, 'name', str, where + '.function') == name, '%s calls %r, expected %r' % (where, function['name'], name))
    tool_arguments(name, loads_object(function.get('arguments'), where + '.function.arguments'), where)


def forced_tool_call(ctx, key, content, tools, name):
    choice = completion(ok_json(tool_request(ctx, key, content, tools, forced(name))))
    calls = field(choice['message'], 'tool_calls', list, 'message')
    expect(calls, 'tool_calls is empty')
    validate_call(calls[0], name, 'tool_calls[0]')
    expect(choice['finish_reason'] == 'tool_calls', "finish_reason should be 'tool_calls', got %r" % choice['finish_reason'])


@check('chat.tools.forced_call', API, 'A forced tool_choice returns a tool_calls entry with valid JSON arguments.')
def tools_forced(ctx):
    forced_tool_call(ctx, 'chat.tools.forced', WEATHER_ASK, [WEATHER], 'get_weather')


@check('chat.tools.choice_among_two', API, 'tool_choice selects the named tool when two are offered.')
def tools_two(ctx):
    forced_tool_call(ctx, 'chat.tools.two', TIME_ASK, [WEATHER, TIME], 'get_time')


@check('chat.tools.none', API, "tool_choice 'none' returns text and no tool call.")
def tools_none(ctx):
    choice = completion(ok_json(tool_request(ctx, 'chat.tools.none', WEATHER_ASK, [WEATHER], 'none')))
    expect(not choice['message'].get('tool_calls'), "tool_calls present although tool_choice is 'none'")
    expect(choice['finish_reason'] != 'tool_calls', "finish_reason is 'tool_calls' although tool_choice is 'none'")


@check('chat.tools.auto', API, 'With tool_choice auto, a tool call is parsed rather than leaked into the text.', 'advisory')
def tools_auto(ctx):
    choice = completion(ok_json(tool_request(ctx, 'chat.tools.auto', WEATHER_ASK, [WEATHER], 'auto')))
    calls = choice['message'].get('tool_calls')
    if calls:
        validate_call(calls[0], 'get_weather', 'tool_calls[0]')
        expect(choice['finish_reason'] == 'tool_calls', "finish_reason should be 'tool_calls'")
        return
    text = text_of(choice)
    expect('<tool_call' not in text and '"arguments"' not in text, 'tool call text leaked into content')
    raise Skip('the model chose not to call the tool')


@check('chat.tools.result_roundtrip', API, 'A tool result message is accepted and answered.')
def tools_roundtrip(ctx):
    messages = [
        {'role': 'user', 'content': WEATHER_ASK},
        {'role': 'assistant', 'content': None, 'tool_calls': [{
            'id': 'call_1', 'type': 'function', 'function': {'name': 'get_weather', 'arguments': '{"city": "Paris"}'}}]},
        {'role': 'tool', 'tool_call_id': 'call_1', 'content': 'Sunny, 22 C'},
    ]
    choice = completion(ok_json(tool_request(ctx, 'chat.tools.roundtrip', messages, [WEATHER], 'auto')))
    nonempty_when_stopped(choice)


@check('chat.tools.stream', API, 'Streamed tool calls carry id, type, and name first, then JSON argument fragments.')
def tools_stream(ctx):
    response = tool_request(ctx, 'chat.tools.stream', WEATHER_ASK, [WEATHER], forced('get_weather'), stream=True)
    chunks = validated_chunks(response)
    calls = {}
    for chunk in carrying(chunks):
        for fragment in chunk['choices'][0]['delta'].get('tool_calls') or []:
            index = field(fragment, 'index', int, 'tool_calls fragment')
            entry = calls.setdefault(index, {'id': None, 'name': None, 'arguments': '', 'type': None})
            entry['id'] = entry['id'] or fragment.get('id')
            entry['type'] = entry['type'] or fragment.get('type')
            function = fragment.get('function') or {}
            entry['name'] = entry['name'] or function.get('name')
            if isinstance(function.get('arguments'), str):
                entry['arguments'] += function['arguments']
    expect(0 in calls, 'no tool call fragment with index 0')
    call = calls[0]
    expect(isinstance(call['id'], str) and call['id'], 'the first fragment has no id')
    expect(call['type'] == 'function', "the first fragment should have type 'function'")
    expect(call['name'] == 'get_weather', 'the streamed tool name is %r' % call['name'])
    tool_arguments('get_weather', loads_object(call['arguments'], 'joined arguments'), 'streamed call')
    expect(finish_of(chunks) == 'tool_calls', "finish_reason should be 'tool_calls'")
