"""Engine-level behavior checks over the OpenAI chat API: concurrency, cancellation, prefix caching, and context limits."""
import checks_chat as chat
from checks_core import (
    ECHO, HELLO, LONG, MAX_OUTPUT_TOKENS, Skip, check, error_body, expect, ok_json,
)

API = chat.API
MARKERS = ('orchid-1', 'falcon-2', 'copper-3', 'velvet-4')
PREFIX = 'You are a careful assistant. ' + ' '.join('Rule %d: answer with a short phrase.' % n for n in range(1, 13))


def parallel(ctx, prefix, stream):
    items = [{'key': '%s.%d' % (prefix, i), 'method': 'POST', 'path': chat.CHAT,
              'payload': chat.payload(ctx, ECHO + marker, max_tokens=16, **({'stream': True} if stream else {})),
              'stream': stream} for i, marker in enumerate(MARKERS)]
    responses = ctx.request_many(items)
    if stream:
        return [''.join(c['choices'][0]['delta'].get('content') or '' for c in chat.carrying(chat.validated_chunks(r)))
                for r in responses]
    return [chat.text_of(chat.completion(ok_json(r))) for r in responses]


def isolation_verdict(texts):
    for index, text in enumerate(texts):
        foreign = [m for j, m in enumerate(MARKERS) if j != index and m in text]
        expect(not foreign, 'response %d contains the marker of another concurrent request (%s)' % (index, foreign[:1]))
    echoed = [MARKERS[i] in text for i, text in enumerate(texts)]
    if not any(echoed):
        raise Skip('the model did not echo the markers')
    if not all(echoed):
        expect(False, 'response %d lost its own marker while the others kept theirs' % echoed.index(False))


@check('chat.concurrent.isolation', API, 'Four simultaneous requests each get their own answer, with no cross-talk.')
def concurrent_isolation(ctx):
    isolation_verdict(parallel(ctx, 'chat.par', False))


@check('chat.concurrent.streams', API, 'Four simultaneous streamed requests each get their own answer, with no cross-talk.')
def concurrent_streams(ctx):
    isolation_verdict(parallel(ctx, 'chat.par.stream', True))


@check('chat.cancel.recovery', API, 'The engine keeps serving after clients disconnect in the middle of streams.')
def cancel_recovery(ctx):
    for index in range(3):
        ctx.abort_stream('chat.cancel.%d' % index, chat.CHAT,
                         chat.payload(ctx, LONG, stream=True, max_tokens=MAX_OUTPUT_TOKENS), events=2)
    chat.completion(ok_json(chat.post(ctx, 'chat.cancel.after', HELLO)))


def asked(ctx, key, system, question):
    messages = [{'role': 'system', 'content': system}, {'role': 'user', 'content': 'Question: ' + question}]
    return chat.text_of(chat.completion(ok_json(chat.post(ctx, key, messages, max_tokens=16))))


@check('chat.prefix_cache.consistency', API, 'Output does not change after unrelated requests that share the prompt prefix or run in between.')
def prefix_cache(ctx):
    first = asked(ctx, 'chat.pc.a1', PREFIX, 'What is the capital of France?')
    if asked(ctx, 'chat.pc.a2', PREFIX, 'What is the capital of France?') != first:
        raise Skip('the engine is not deterministic at temperature 0')
    asked(ctx, 'chat.pc.b', PREFIX, 'Name a primary colour.')
    again = asked(ctx, 'chat.pc.a3', PREFIX, 'What is the capital of France?')
    expect(again == first, 'the output changed after a request with the same prefix: %r then %r' % (first[:40], again[:40]))
    asked(ctx, 'chat.pc.c', 'You are brief.', 'How many days are in a week?')
    last = asked(ctx, 'chat.pc.a4', PREFIX, 'What is the capital of France?')
    expect(last == first, 'the output changed after an unrelated request: %r then %r' % (first[:40], last[:40]))


def overflow(ctx):
    if not ctx.context_window:
        raise Skip('--context-window was not provided')
    return ctx.request('chat.context.overflow', 'POST', chat.CHAT,
                       chat.payload(ctx, ' '.join(['word'] * (2 * ctx.context_window)), max_tokens=8))


@check('chat.context.overflow_rejected', API, 'A prompt longer than the context window is rejected with a 4xx error object.')
def overflow_rejected(ctx):
    response = overflow(ctx)
    expect(response.status != 200, 'the engine accepted a prompt about twice its context window; it should reject it')
    expect(response.status < 500, 'HTTP %d: the engine failed on an oversized prompt' % response.status)
    error_body(response, 'openai')


@check('chat.context.recovers', API, 'The engine answers normally right after an oversized prompt.')
def context_recovers(ctx):
    overflow(ctx)
    chat.completion(ok_json(chat.post(ctx, 'chat.context.after', HELLO)))
