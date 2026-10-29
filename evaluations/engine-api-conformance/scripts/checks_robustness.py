"""Text integrity and malformed-input checks across the three APIs.

Covers UTF-8 across streamed chunks, reasoning kept out of the answer text, and bad or hostile requests.
"""
import checks_anthropic as anthropic
import checks_chat as chat
import checks_responses as responses
from checks_core import (
    HELLO, MAX_OUTPUT_TOKENS, THINK_ASK, UTF8_ASK,
    Skip, check, error_body, expect, field, named_events, no_think_tags, ok_json,
)

BAD_JSON = b'{"model": '
SPECIALS = ' '.join(['<|im_end|>', '<|endoftext|>', '</s>', '<|eot_id|>', '<|end|>'] * 4)


def utf8_verdict(texts):
    for where, text in texts:
        expect('\ufffd' not in text, '%s contains U+FFFD replacement characters (a multi-byte character was split)' % where)
    if all(ord(char) < 128 for _, text in texts for char in text):
        raise Skip('the model did not produce non-ASCII text')


def chat_stream_text(chunks):
    return ''.join(c['choices'][0]['delta'].get('content') or '' for c in chat.carrying(chunks))


@check('chat.stream.utf8', chat.API, 'Non-ASCII text arrives intact: no replacement characters from split multi-byte characters.')
def chat_utf8(ctx):
    plain = chat.text_of(chat.completion(ok_json(chat.post(ctx, 'chat.utf8', UTF8_ASK, max_tokens=48))))
    chunks = chat.validated_chunks(chat.post(ctx, 'chat.utf8.stream', UTF8_ASK, max_tokens=48, stream=True))
    utf8_verdict([('non-streamed text', plain), ('streamed text', chat_stream_text(chunks))])


@check('responses.stream.utf8', responses.API, 'Non-ASCII text arrives intact: no replacement characters from split multi-byte characters.')
def responses_utf8(ctx):
    body = ok_json(responses.post(ctx, 'responses.utf8', UTF8_ASK, max_output_tokens=48))
    plain = responses.text_of(responses.message_item(responses.response_object(body)))
    events = named_events(responses.post(ctx, 'responses.utf8.stream', UTF8_ASK, max_output_tokens=48, stream=True))
    streamed = ''.join(e['delta'] for e in events if e['type'] == 'response.output_text.delta')
    utf8_verdict([('non-streamed text', plain), ('streamed text', streamed)])


@check('anthropic.stream.utf8', anthropic.API, 'Non-ASCII text arrives intact: no replacement characters from split multi-byte characters.')
def anthropic_utf8(ctx):
    plain = anthropic.text_of(anthropic.message(ok_json(anthropic.post(ctx, 'anthropic.utf8', UTF8_ASK, max_tokens=48))))
    events = named_events(anthropic.post(ctx, 'anthropic.utf8.stream', UTF8_ASK, max_tokens=48, stream=True))
    streamed = ''.join(e['delta'].get('text', '') for e in events if e['type'] == 'content_block_delta')
    utf8_verdict([('non-streamed text', plain), ('streamed text', streamed)])


def reasoning_fields(message, where):
    for key in ('reasoning_content', 'reasoning'):
        value = message.get(key)
        if value is not None:
            expect(isinstance(value, str), '%s.%s should be a string' % (where, key))
            no_think_tags(value, '%s.%s' % (where, key))


@check('chat.reasoning.no_tag_leak', chat.API, 'Reasoning is not left inside the answer text as think tags.')
def chat_reasoning(ctx):
    choice = chat.completion(ok_json(chat.post(ctx, 'chat.think', THINK_ASK, max_tokens=MAX_OUTPUT_TOKENS)))
    no_think_tags(chat.text_of(choice), 'message.content')
    reasoning_fields(choice['message'], 'message')


@check('chat.reasoning.stream_no_tag_leak', chat.API, 'Streamed answer text has no think tags and reasoning deltas are strings.')
def chat_reasoning_stream(ctx):
    chunks = chat.validated_chunks(chat.post(ctx, 'chat.think.stream', THINK_ASK, max_tokens=MAX_OUTPUT_TOKENS, stream=True))
    no_think_tags(chat_stream_text(chunks), 'streamed content')
    for chunk in chat.carrying(chunks):
        reasoning_fields(chunk['choices'][0]['delta'], 'delta')


@check('responses.reasoning.items', responses.API, 'Reasoning items are well formed and the message text has no think tags.', 'advisory')
def responses_reasoning(ctx):
    response = responses.post(ctx, 'responses.think', THINK_ASK, reasoning={'effort': 'low'}, max_output_tokens=MAX_OUTPUT_TOKENS)
    if 400 <= response.status < 500:
        raise Skip('the reasoning parameter is not supported (HTTP %d)' % response.status)
    body = ok_json(response)
    responses.response_object(body, body.get('status'))
    for index, item in enumerate(body['output']):
        where = 'output[%d]' % index
        kind = field(item, 'type', str, where)
        if kind == 'reasoning':
            field(item, 'id', str, where)
            field(item, 'summary', list, where)
        elif kind == 'message':
            for part in field(item, 'content', list, where):
                if part.get('type') == 'output_text':
                    no_think_tags(field(part, 'text', str, where), where + '.content text')


@check('anthropic.reasoning.no_tag_leak', anthropic.API, 'Text blocks have no think tags and thinking blocks carry thinking and signature.')
def anthropic_reasoning(ctx):
    body = anthropic.message(ok_json(anthropic.post(ctx, 'anthropic.think', THINK_ASK, max_tokens=MAX_OUTPUT_TOKENS)))
    for index, block in enumerate(body['content']):
        where = 'content[%d]' % index
        if block['type'] == 'text':
            no_think_tags(field(block, 'text', str, where), where)
        elif block['type'] == 'thinking':
            field(block, 'thinking', str, where)
            field(block, 'signature', str, where)


@check('chat.robust.invalid_json', chat.API, 'A body that is not JSON gets a 4xx OpenAI error object.')
def chat_invalid_json(ctx):
    error_body(ctx.request('chat.robust.json', 'POST', chat.CHAT, raw=BAD_JSON), 'openai')


@check('responses.robust.invalid_json', responses.API, 'A body that is not JSON gets a 4xx error object.')
def responses_invalid_json(ctx):
    error_body(ctx.request('responses.robust.json', 'POST', responses.PATH, raw=BAD_JSON), 'openai')


@check('anthropic.robust.invalid_json', anthropic.API, "A body that is not JSON gets a 4xx {'type': 'error'} body.")
def anthropic_invalid_json(ctx):
    error_body(ctx.request('anthropic.robust.json', 'POST', anthropic.PATH, raw=BAD_JSON), 'anthropic')


@check('chat.robust.empty_messages', chat.API, 'An empty messages array gets a 4xx OpenAI error object.')
def chat_empty_messages(ctx):
    error_body(ctx.request('chat.robust.empty', 'POST', chat.CHAT, chat.payload(ctx, [])), 'openai')


@check('chat.robust.invalid_role', chat.API, 'An unknown message role gets a 4xx OpenAI error object.')
def chat_invalid_role(ctx):
    messages = [{'role': 'wizard', 'content': 'Hi.'}]
    error_body(ctx.request('chat.robust.role', 'POST', chat.CHAT, chat.payload(ctx, messages)), 'openai')


@check('chat.robust.max_tokens_one', chat.API, 'max_tokens 1 yields at most one completion token.')
def chat_max_tokens_one(ctx):
    body = ok_json(chat.post(ctx, 'chat.robust.one', HELLO, max_tokens=1))
    choice = chat.completion(body)
    done = body['usage']['completion_tokens']
    expect(done <= 1, 'completion_tokens is %d with max_tokens 1' % done)
    expect(choice['finish_reason'] in ('length', 'stop'), "finish_reason should be 'length' or 'stop'")


@check('chat.robust.special_tokens', chat.API, 'Control-token strings in user text are tokenized as plain text, not parsed as special tokens.')
def chat_special_tokens(ctx):
    base = ok_json(chat.post(ctx, 'chat.special.base', 'x', max_tokens=1))
    injected = ok_json(chat.post(ctx, 'chat.special.text', SPECIALS, max_tokens=1))
    chat.completion(base)
    chat.completion(injected)
    grew = injected['usage']['prompt_tokens'] - base['usage']['prompt_tokens']
    expect(grew >= 40, 'prompt_tokens grew by only %d for 20 control-token strings, so they are probably parsed as special tokens' % grew)
