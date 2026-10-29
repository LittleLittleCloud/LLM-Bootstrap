#!/usr/bin/env python3
"""A stand-in for Pi in the HumanEval evaluation's negative control.

It reads the endpoint from the agent directory the driver wrote, asks the engine for a solution in two requests, writes
solution.py, and prints Pi-style JSON events. The FAKE_PI_FAULT variable makes it misbehave in one known way. It is never
a real agent.
"""
import json
import os
import re
import sys
import time
import urllib.request
from pathlib import Path


def option(name):
    return sys.argv[sys.argv.index(name) + 1]


def ask(base_url, model, messages):
    request = urllib.request.Request(
        base_url.rstrip('/') + '/chat/completions',
        data=json.dumps({'model': model, 'messages': messages, 'max_tokens': 4096, 'stream': True,
                         'stream_options': {'include_usage': True}}).encode(),
        headers={'Content-Type': 'application/json', 'Authorization': 'Bearer none'})
    text, usage = '', {}
    with urllib.request.urlopen(request, timeout=60) as response:
        for raw in response:
            line = raw.decode().strip()
            if line.startswith('data:') and line[5:].strip() != '[DONE]':
                chunk = json.loads(line[5:])
                usage = chunk.get('usage') or usage
                for choice in chunk.get('choices') or []:
                    text += (choice.get('delta') or {}).get('content') or ''
    return text, usage


def message_end(model, usage, fault):
    cached = (usage.get('prompt_tokens_details') or {}).get('cached_tokens') or 0
    output = usage['completion_tokens'] + (1 if fault == 'usage_mismatch' else 0)
    return {'type': 'message_end', 'message': {
        'role': 'assistant', 'provider': option('--provider'), 'model': model, 'stopReason': 'stop',
        'usage': {'input': usage['prompt_tokens'] - cached, 'output': output, 'cacheRead': cached, 'cacheWrite': 0}}}


def main():
    fault = os.environ.get('FAKE_PI_FAULT', '')
    model, prompt = option('--model'), option('-p')
    config = json.loads((Path(os.environ['PI_CODING_AGENT_DIR']) / 'models.json').read_text())
    provider = config['providers'][option('--provider')]
    assert any(m['id'] == model and m['contextWindow'] and m['maxTokens'] for m in provider['models'])
    print(json.dumps({'type': 'agent_start'}), flush=True)
    if fault == 'hang':
        time.sleep(3600)
    messages = [{'role': 'user', 'content': prompt}]
    try:
        text, usage = ask(provider['baseUrl'], model, messages)
        print(json.dumps(message_end(model, usage, fault)), flush=True)
        entry = re.search(r'^def (\w+)\(', prompt, re.MULTILINE).group(1)
        code = text if fault != 'wrong_solution' else 'def %s(*args, **kwargs):\n    return None\n' % entry
        if fault != 'no_solution':
            Path('solution.py').write_text(code, encoding='utf-8')
        messages += [{'role': 'assistant', 'content': text}, {'role': 'user', 'content': 'Is the file complete?'}]
        text, usage = ask(provider['baseUrl'], model, messages)
        print(json.dumps(message_end(model, usage, fault)), flush=True)
    except OSError as exc:
        print(json.dumps({'type': 'error', 'message': type(exc).__name__}), flush=True)
        return 1
    print(json.dumps({'type': 'agent_settled', 'aborted': False}), flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
