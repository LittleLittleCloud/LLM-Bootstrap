"""Reference fake engine for the conformance self-test.

It implements the three APIs correctly. Each fault in FAULTS breaks one behavior in a known way, so the
self-test can prove the checks detect it (the evaluation's negative control). It is never a model.
"""
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Fault name -> checks that must fail when the fault is injected.
FAULTS = {
    'chat_wrong_object': ['chat.basic.schema'],
    'chat_usage_mismatch': ['chat.basic.schema'],
    'chat_empty_content': ['chat.basic.schema'],
    'chat_ignores_max_tokens': ['chat.max_tokens'],
    'chat_ignores_stop': ['chat.stop_sequence'],
    'chat_error_plain_text': ['chat.error.missing_messages'],
    'chat_stream_no_done': ['chat.stream.framing'],
    'chat_stream_no_role': ['chat.stream.chunks'],
    'chat_stream_no_usage': ['chat.stream.usage'],
    'chat_tool_bad_arguments': ['chat.tools.forced_call', 'chat.tools.stream'],
    'chat_tool_finish_stop': ['chat.tools.forced_call'],
    'responses_wrong_status': ['responses.basic.schema'],
    'responses_ignores_max_output': ['responses.max_output_tokens'],
    'responses_event_order': ['responses.stream.events'],
    'responses_delta_mismatch': ['responses.stream.events'],
    'responses_arguments_object': ['responses.tools.forced_call'],
    'anthropic_wrong_stop_reason': ['anthropic.basic.schema'],
    'anthropic_ignores_stop_sequences': ['anthropic.stop_sequences'],
    'anthropic_stream_no_message_stop': ['anthropic.stream.events'],
    'anthropic_tool_input_string': ['anthropic.tools.forced_call'],
    'anthropic_error_format': ['anthropic.error.missing_max_tokens'],
    'chat_utf8_split': ['chat.stream.utf8'],
    'responses_utf8_split': ['responses.stream.utf8'],
    'anthropic_utf8_split': ['anthropic.stream.utf8'],
    'chat_think_leak': ['chat.reasoning.no_tag_leak', 'chat.reasoning.stream_no_tag_leak'],
    'anthropic_think_leak': ['anthropic.reasoning.no_tag_leak'],
    'responses_reasoning_malformed': ['responses.reasoning.items'],
    'chat_invalid_json_500': ['chat.robust.invalid_json'],
    'responses_invalid_json_500': ['responses.robust.invalid_json'],
    'anthropic_invalid_json_500': ['anthropic.robust.invalid_json'],
    'chat_accepts_empty_messages': ['chat.robust.empty_messages'],
    'chat_accepts_invalid_role': ['chat.robust.invalid_role'],
    'chat_max_tokens_one_ignored': ['chat.robust.max_tokens_one'],
    'chat_special_token_injection': ['chat.robust.special_tokens'],
    'chat_concurrent_mixup': ['chat.concurrent.isolation', 'chat.concurrent.streams'],
    'chat_wedged_after_cancel': ['chat.cancel.recovery'],
    'chat_state_leak': ['chat.prefix_cache.consistency'],
    'chat_context_truncates': ['chat.context.overflow_rejected'],
    'chat_context_crash': ['chat.context.overflow_rejected', 'chat.context.recovers'],
}

SPECIAL_TOKENS = {'<|im_end|>', '<|endoftext|>', '</s>', '<|eot_id|>', '<|end|>'}
ECHO_MARK = 'Reply with exactly:'
CONTEXT_WINDOW = 1000

TOOL_ARGUMENTS = {'get_weather': {'city': 'Paris'}, 'get_time': {'timezone': 'UTC'}}
CREATED = 1700000000


def tool_name(tool):
    return (tool.get('function') or tool).get('name')


def forced_name(choice):
    if isinstance(choice, dict) and choice.get('type') in ('function', 'tool'):
        return (choice.get('function') or choice).get('name')
    return None


def tool_mode(choice):
    if isinstance(choice, str):
        return choice
    return choice.get('type') if isinstance(choice, dict) else None


def decide_tool(tools, choice, prompt, has_result):
    names = [tool_name(tool) for tool in tools or []]
    if not names or has_result or tool_mode(choice) == 'none':
        return None
    name = forced_name(choice)
    if name not in names:
        lowered = prompt.lower()
        name = 'get_weather' if 'weather' in lowered else 'get_time' if 'time' in lowered else None
    return (name, TOOL_ARGUMENTS[name]) if name in names else None


def generate(prompt, max_tokens, stops, want_json, ignore_max=False, ignore_stop=False):
    if want_json:
        full = '{"ok": true}'
    elif ECHO_MARK in prompt:
        full = prompt.rsplit(ECHO_MARK, 1)[1].strip()
    elif 'Think step by step' in prompt:
        full = '391'
    elif 'Question:' in prompt:
        full = 'Answer %d' % (sum(map(ord, prompt.rsplit('Question:', 1)[1])) % 997)
    elif 'numbers from 1 to 200' in prompt:
        full = ' '.join(str(n) for n in range(1, 201))
    elif 'numbers 1 2 3 4 5' in prompt:
        full = '1 2 3 4 5 6 7 8 9 10'
    else:
        full = 'Hello there, this is a fake engine reply.'
    matched, finish = None, 'stop'
    cuts = [(full.find(stop), stop) for stop in stops or [] if full.find(stop) >= 0]
    if cuts and not ignore_stop:
        index, matched = min(cuts)
        full = full[:index].rstrip()
    tokens = full.split()
    if len(tokens) > max_tokens and not ignore_max:
        tokens, finish, matched = tokens[:max_tokens], 'length', None
    return tokens, finish, matched


def texts(value):
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [text for item in value for text in texts(item)]
    if isinstance(value, dict):
        found = [value[key] for key in ('text', 'content', 'output') if key in value]
        return [text for item in found for text in texts(item)]
    return []


def read_prompt(body):
    parts, has_result = [], False
    for key in ('system', 'instructions'):
        parts += texts(body.get(key))
    items = body.get('messages', body.get('input'))
    for item in items if isinstance(items, list) else [items]:
        parts += texts(item)
        if isinstance(item, dict):
            blocks = item.get('content') if isinstance(item.get('content'), list) else []
            has_result = has_result or item.get('role') == 'tool' or item.get('type') == 'function_call_output'
            has_result = has_result or any(isinstance(b, dict) and b.get('type') == 'tool_result' for b in blocks)
    return ' '.join(parts), has_result


def prompt_tokens(text, parse_special=False):
    total = 0
    for word in text.split():
        total += 1 if parse_special and word in SPECIAL_TOKENS else max(1, -(-len(word) // 3))
    return max(1, total)


def text_parts(tokens, split_bytes=False):
    """Streamed text pieces. With split_bytes, a multi-byte character is cut in the middle (and so lost)."""
    parts = [word if index == 0 else ' ' + word for index, word in enumerate(tokens)]
    if not split_bytes:
        return parts
    out = []
    for part in parts:
        data = part.encode('utf-8')
        cut = max(1, len(data) // 2)
        out += [data[:cut].decode('utf-8', errors='replace'), data[cut:].decode('utf-8', errors='replace')]
    return out


def pieces(text, count=3):
    size = max(1, -(-len(text) // count))
    return [text[i:i + size] for i in range(0, len(text), size)]


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'
    slow = False

    def log_message(self, *args):
        pass

    @property
    def engine(self):
        return self.server.engine

    def reply(self, status, body, content_type='application/json'):
        data = body if isinstance(body, bytes) else json.dumps(body).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def start_stream(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()

    def emit(self, data, event=None):
        if self.slow:
            time.sleep(0.01)
        head = 'event: %s\n' % event if event else ''
        payload = data if isinstance(data, str) else json.dumps(data)
        self.wfile.write(('%sdata: %s\n\n' % (head, payload)).encode('utf-8'))
        self.wfile.flush()

    def do_GET(self):
        if self.path == '/v1/models':
            self.reply(200, {'object': 'list', 'data': [
                {'id': self.engine.model, 'object': 'model', 'created': CREATED, 'owned_by': 'fake'}]})
        else:
            self.reply(404, {'error': {'message': 'not found', 'type': 'invalid_request_error'}})

    def do_POST(self):
        length = int(self.headers.get('Content-Length') or 0)
        try:
            body = json.loads(self.rfile.read(length) or b'{}')
        except ValueError:
            body = None
        route = {'/v1/chat/completions': self.handle_chat, '/v1/responses': self.handle_responses,
                 '/v1/messages': self.handle_messages}.get(self.path)
        name = {'/v1/chat/completions': 'chat', '/v1/responses': 'responses', '/v1/messages': 'anthropic'}.get(self.path)
        try:
            if route is None:
                self.reply(404, {'error': {'message': 'not found', 'type': 'invalid_request_error'}})
            elif not isinstance(body, dict):
                if '%s_invalid_json_500' % name in self.engine.faults:
                    self.reply(500, b'internal error', 'text/plain')
                else:
                    self.fail('anthropic' if name == 'anthropic' else 'openai', 400, 'The request body is not valid JSON.')
            else:
                route(body)
        except ConnectionError:
            if 'chat_wedged_after_cancel' in self.engine.faults and name == 'chat':
                self.engine.dead = True

    def fail(self, style, status, message):
        faults = self.engine.faults
        if style == 'anthropic':
            kind = 'invalid_request_error' if status == 400 else 'not_found_error'
            error = {'message': message} if 'anthropic_error_format' in faults else {'type': kind, 'message': message}
            body = {'error': error} if 'anthropic_error_format' in faults else {'type': 'error', 'error': error}
            return self.reply(status, body)
        if 'chat_error_plain_text' in faults and style == 'chat':
            return self.reply(status, message.encode('utf-8'), 'text/plain')
        self.reply(status, {'error': {'message': message, 'type': 'invalid_request_error', 'param': None, 'code': None}})

    # --- OpenAI Chat Completions ---
    def handle_chat(self, body):
        faults, engine = self.engine.faults, self.engine
        if engine.dead:
            return self.reply(503, b'engine unavailable', 'text/plain')
        if body.get('model') != engine.model:
            return self.fail('openai', 404, 'The model does not exist.')
        if 'messages' not in body:
            return self.fail('chat', 400, 'messages is required')
        messages = body['messages']
        if not isinstance(messages, list) or (not messages and 'chat_accepts_empty_messages' not in faults):
            return self.fail('openai', 400, 'messages must be a non-empty array')
        roles = ('system', 'user', 'assistant', 'tool', 'developer')
        if 'chat_accepts_invalid_role' not in faults and any(
                not isinstance(m, dict) or m.get('role') not in roles for m in messages):
            return self.fail('openai', 400, 'messages contain an invalid role')
        prompt, has_result = read_prompt(body)
        size = prompt_tokens(prompt, 'chat_special_token_injection' in faults)
        if size > CONTEXT_WINDOW and 'chat_context_truncates' not in faults:
            if 'chat_context_crash' in faults:
                engine.dead = True
                return self.reply(500, b'internal error', 'text/plain')
            return self.fail('openai', 400, 'This model maximum context length is exceeded.')
        want_json = (body.get('response_format') or {}).get('type') == 'json_object'
        ignore_max = 'chat_ignores_max_tokens' in faults or (
            'chat_max_tokens_one_ignored' in faults and body.get('max_tokens') == 1)
        tokens, finish, _ = generate(
            prompt, body.get('max_tokens', 64), body.get('stop'), want_json, ignore_max, 'chat_ignores_stop' in faults)
        if ECHO_MARK in prompt and 'chat_concurrent_mixup' in faults:
            previous, engine.last_echo = engine.last_echo, tokens
            tokens = previous or tokens
        if 'chat_state_leak' in faults and 'Question:' in prompt:
            seen, engine.cache[prompt[:60]] = engine.cache.get(prompt[:60]), (prompt, tokens)
            tokens = seen[1] if seen and seen[0] != prompt else tokens
        reasoning = 'Multiply 17 by 23.' if 'Think step by step' in prompt else None
        if reasoning and 'chat_think_leak' in faults:
            tokens, reasoning = ['<think>Multiply 17 by 23.</think>' + ' '.join(tokens)], None
        call = decide_tool(body.get('tools'), body.get('tool_choice'), prompt, has_result)
        arguments = json.dumps(call[1]) if call else ''
        if 'chat_tool_bad_arguments' in faults:
            arguments = arguments[:-4]
        count = 8 if call else len(tokens)
        usage = {'prompt_tokens': size, 'completion_tokens': count}
        usage['total_tokens'] = usage['prompt_tokens'] + count + (1 if 'chat_usage_mismatch' in faults else 0)
        if call:
            finish = 'stop' if 'chat_tool_finish_stop' in faults else 'tool_calls'
        if body.get('stream'):
            return self.chat_stream(body, tokens, finish, call, arguments, usage, reasoning)
        if call:
            message = {'role': 'assistant', 'content': None, 'tool_calls': [{
                'id': 'call_fake1', 'type': 'function', 'function': {'name': call[0], 'arguments': arguments}}]}
        else:
            message = {'role': 'assistant', 'content': '' if 'chat_empty_content' in faults else ' '.join(tokens)}
            if reasoning:
                message['reasoning_content'] = reasoning
        self.reply(200, {
            'id': 'chatcmpl-fake1', 'object': 'text_completion' if 'chat_wrong_object' in faults else 'chat.completion',
            'created': CREATED, 'model': self.engine.model,
            'choices': [{'index': 0, 'message': message, 'finish_reason': finish}], 'usage': usage})

    def chat_stream(self, body, tokens, finish, call, arguments, usage, reasoning=None):
        faults = self.engine.faults
        self.slow = 'numbers from 1 to 200' in json.dumps(body)

        def chunk(delta, reason=None, **extra):
            data = {'id': 'chatcmpl-fake1', 'object': 'chat.completion.chunk', 'created': CREATED, 'model': self.engine.model,
                    'choices': [{'index': 0, 'delta': delta, 'finish_reason': reason}]}
            data.update(extra)
            self.emit(data)

        self.start_stream()
        role = {} if 'chat_stream_no_role' in faults else {'role': 'assistant'}
        if call:
            chunk(dict(role, tool_calls=[{'index': 0, 'id': 'call_fake1', 'type': 'function',
                                           'function': {'name': call[0], 'arguments': ''}}]))
            for part in pieces(arguments):
                chunk({'tool_calls': [{'index': 0, 'function': {'arguments': part}}]})
        else:
            chunk(dict(role, content=''))
            if reasoning:
                chunk({'reasoning_content': reasoning})
            for part in text_parts(tokens, 'chat_utf8_split' in faults):
                chunk({'content': part})
        chunk({}, finish)
        if (body.get('stream_options') or {}).get('include_usage') and 'chat_stream_no_usage' not in faults:
            data = {'id': 'chatcmpl-fake1', 'object': 'chat.completion.chunk', 'created': CREATED,
                    'model': self.engine.model, 'choices': [], 'usage': usage}
            self.emit(data)
        if 'chat_stream_no_done' not in faults:
            self.emit('[DONE]')

    # --- OpenAI Responses ---
    def handle_responses(self, body):
        faults = self.engine.faults
        if body.get('model') != self.engine.model:
            return self.fail('openai', 404, 'The model does not exist.')
        if 'input' not in body:
            return self.fail('openai', 400, 'input is required')
        prompt, has_result = read_prompt(body)
        tokens, finish, _ = generate(
            prompt, body.get('max_output_tokens', 64), None, False, 'responses_ignores_max_output' in faults)
        call = decide_tool(body.get('tools'), body.get('tool_choice'), prompt, has_result)
        text = ' '.join(tokens)
        arguments = json.dumps(call[1]) if call else ''
        count = 8 if call else len(tokens)
        usage = {'input_tokens': max(1, len(prompt.split())), 'output_tokens': count}
        usage['total_tokens'] = usage['input_tokens'] + count
        thinking = []
        if 'Think step by step' in prompt and body.get('reasoning') and not call:
            thinking = [{'type': 'reasoning', 'id': 'rs_fake1', 'summary': []}]
            if 'responses_reasoning_malformed' in faults:
                thinking[0].pop('summary')
        status = 'incomplete' if finish == 'length' and not call else 'completed'
        incomplete = {'reason': 'max_output_tokens'} if status == 'incomplete' else None
        message = {'type': 'message', 'id': 'msg_fake1', 'status': 'completed', 'role': 'assistant',
                   'content': [{'type': 'output_text', 'text': text, 'annotations': []}]}
        item = {'type': 'function_call', 'id': 'fc_fake1', 'call_id': 'call_fake1', 'name': call[0] if call else '',
                'arguments': call[1] if call and 'responses_arguments_object' in faults else arguments,
                'status': 'completed'}

        def response(state, output):
            return {'id': 'resp_fake1', 'object': 'response', 'created_at': CREATED,
                    'status': 'done' if 'responses_wrong_status' in faults else state, 'error': None,
                    'incomplete_details': incomplete if state == 'incomplete' else None,
                    'model': self.engine.model, 'output': output, 'usage': usage}

        if not body.get('stream'):
            return self.reply(200, response(status, [item] if call else thinking + [message]))
        sequence = [0]

        def send(kind, **data):
            data.update(type=kind, sequence_number=sequence[0])
            sequence[0] += 1
            self.emit(data, kind)

        self.start_stream()
        send('response.created', response=dict(response('in_progress', []), usage=None))
        send('response.in_progress', response=dict(response('in_progress', []), usage=None))
        if call:
            send('response.output_item.added', output_index=0, item=dict(item, arguments='', status='in_progress'))
            for part in pieces(arguments):
                send('response.function_call_arguments.delta', item_id='fc_fake1', output_index=0, delta=part)
            send('response.function_call_arguments.done', item_id='fc_fake1', output_index=0, arguments=arguments)
            send('response.output_item.done', output_index=0, item=item)
            return send('response.completed', response=response('completed', [item]))
        part = {'type': 'output_text', 'text': '', 'annotations': []}
        send('response.output_item.added', output_index=0,
             item={'type': 'message', 'id': 'msg_fake1', 'status': 'in_progress', 'role': 'assistant', 'content': []})
        send('response.content_part.added', item_id='msg_fake1', output_index=0, content_index=0, part=part)
        done = text + '!' if 'responses_delta_mismatch' in faults else text
        if 'responses_event_order' in faults:
            send('response.output_text.done', item_id='msg_fake1', output_index=0, content_index=0, text=done)
        for delta in text_parts(tokens, 'responses_utf8_split' in faults):
            send('response.output_text.delta', item_id='msg_fake1', output_index=0, content_index=0, delta=delta)
        if 'responses_event_order' not in faults:
            send('response.output_text.done', item_id='msg_fake1', output_index=0, content_index=0, text=done)
        send('response.content_part.done', item_id='msg_fake1', output_index=0, content_index=0, part=dict(part, text=text))
        send('response.output_item.done', output_index=0, item=message)
        send('response.completed', response=response('completed', [message]))

    # --- Anthropic Messages ---
    def handle_messages(self, body):
        faults = self.engine.faults
        if body.get('model') != self.engine.model:
            return self.fail('anthropic', 404, 'model: not found')
        if 'max_tokens' not in body:
            return self.fail('anthropic', 400, 'max_tokens: Field required')
        prompt, has_result = read_prompt(body)
        tokens, finish, matched = generate(
            prompt, body['max_tokens'], body.get('stop_sequences'), False, False, 'anthropic_ignores_stop_sequences' in faults)
        call = decide_tool(body.get('tools'), body.get('tool_choice'), prompt, has_result)
        reason = {'length': 'max_tokens'}.get(finish, 'stop_sequence' if matched else 'end_turn')
        if reason == 'end_turn' and 'anthropic_wrong_stop_reason' in faults:
            reason = 'stop'
        if call:
            reason = 'tool_use'
        count = 8 if call else len(tokens)
        usage = {'input_tokens': max(1, len(prompt.split())), 'output_tokens': count}
        message = {'id': 'msg_fake1', 'type': 'message', 'role': 'assistant', 'model': self.engine.model}
        if not body.get('stream'):
            if call:
                shown = json.dumps(call[1]) if 'anthropic_tool_input_string' in faults else call[1]
                content = [{'type': 'tool_use', 'id': 'toolu_fake1', 'name': call[0], 'input': shown}]
            else:
                content = [{'type': 'text', 'text': ' '.join(tokens)}]
                if 'Think step by step' in prompt:
                    thought = [{'type': 'thinking', 'thinking': 'Multiply 17 by 23.', 'signature': 'fake-signature'}]
                    if 'anthropic_think_leak' in faults:
                        content[0]['text'] = '<think>Multiply 17 by 23.</think>' + content[0]['text']
                    else:
                        content = thought + content
            return self.reply(200, dict(message, content=content, stop_reason=reason,
                                        stop_sequence=matched if reason == 'stop_sequence' else None, usage=usage))
        self.start_stream()
        self.emit(dict(type='message_start', message=dict(
            message, content=[], stop_reason=None, stop_sequence=None, usage=dict(usage, output_tokens=1))), 'message_start')
        if call:
            block = {'type': 'tool_use', 'id': 'toolu_fake1', 'name': call[0], 'input': {}}
            deltas = [{'type': 'input_json_delta', 'partial_json': part} for part in pieces(json.dumps(call[1]))]
        else:
            block = {'type': 'text', 'text': ''}
            deltas = [{'type': 'text_delta', 'text': part} for part in text_parts(tokens, 'anthropic_utf8_split' in faults)]
        self.emit({'type': 'content_block_start', 'index': 0, 'content_block': block}, 'content_block_start')
        self.emit({'type': 'ping'}, 'ping')
        for delta in deltas:
            self.emit({'type': 'content_block_delta', 'index': 0, 'delta': delta}, 'content_block_delta')
        self.emit({'type': 'content_block_stop', 'index': 0}, 'content_block_stop')
        self.emit({'type': 'message_delta', 'delta': {'stop_reason': reason, 'stop_sequence': matched},
                   'usage': {'output_tokens': count}}, 'message_delta')
        if 'anthropic_stream_no_message_stop' not in faults:
            self.emit({'type': 'message_stop'}, 'message_stop')


class FakeEngine:
    model = 'fake-model'
    context_window = CONTEXT_WINDOW

    def __init__(self, faults=()):
        self.faults = set(faults)
        self.dead = False
        self.last_echo = None
        self.cache = {}
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.engine = self
        self.server.daemon_threads = True
        self.origin = 'http://127.0.0.1:%d' % self.server.server_address[1]

    def __enter__(self):
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()
