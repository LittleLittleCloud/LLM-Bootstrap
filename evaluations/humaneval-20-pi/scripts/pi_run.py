"""Launch the Pi coding agent on one task and read what it reports.

Pi gets a fresh workspace, a fresh agent directory, and a minimal environment: no credentials, no extensions, no project
files. Its endpoint is the measuring proxy. Standard library only.
"""
import json
import os
import signal
import subprocess
import threading
import time

PROVIDER = 'bootstrap'
TOOLS = 'read,write,bash,edit'
ENVIRONMENT_KEYS = ('PATH', 'LANG', 'LC_ALL')


def write_agent_config(agent_dir, model, base_url, context_window, max_tokens):
    config = {'providers': {PROVIDER: {
        'baseUrl': base_url, 'api': 'openai-completions', 'apiKey': 'proxy-holds-the-key', 'authHeader': True,
        'models': [{
            'id': model, 'reasoning': False, 'input': ['text'], 'contextWindow': context_window, 'maxTokens': max_tokens,
            'compat': {'maxTokensField': 'max_tokens', 'supportsDeveloperRole': False, 'supportsReasoningEffort': False,
                       'supportsStore': False},
        }],
    }}}
    (agent_dir / 'models.json').write_text(json.dumps(config), encoding='utf-8')
    (agent_dir / 'settings.json').write_text(json.dumps({'compaction': {'enabled': False}, 'retry': {'enabled': False}}),
                                             encoding='utf-8')


def pi_command(prefix, model, prompt):
    return [*prefix, '--provider', PROVIDER, '--model', model, '--mode', 'json', '--no-session', '--tools', TOOLS,
            '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files',
            '--no-approve', '--thinking', 'off', '-p', prompt]


def environment(root, agent_dir, extra=None):
    env = {key: os.environ[key] for key in ENVIRONMENT_KEYS if key in os.environ}
    env.update({'HOME': str(root), 'TMPDIR': str(root), 'TMP': str(root), 'TEMP': str(root), 'PI_CODING_AGENT_DIR': str(agent_dir)})
    env.update(extra or {})
    return env


def run_pi(command, cwd, env, timeout):
    """Run Pi to completion or to the timeout. Returns its event lines, timings, and how it ended."""
    lines, errors = [], []
    started = time.monotonic()
    process = subprocess.Popen(command, cwd=str(cwd), env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, errors='replace', start_new_session=True)

    def read(stream, sink, stamp):
        for line in iter(stream.readline, ''):
            sink.append((time.monotonic() - started, line) if stamp else line)

    readers = [threading.Thread(target=read, args=(process.stdout, lines, True), daemon=True),
               threading.Thread(target=read, args=(process.stderr, errors, False), daemon=True)]
    for reader in readers:
        reader.start()
    timed_out = False
    try:
        process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
    for reader in readers:
        reader.join(timeout=5)
    return {'returncode': process.returncode, 'timed_out': timed_out, 'wall_seconds': time.monotonic() - started,
            'lines': lines, 'stderr_tail': ''.join(errors)[-1000:]}


def read_events(lines):
    """Pi's assistant messages with their usage, how the agent ended, and the tool calls it made."""
    assistant, tool_calls, malformed, settled, aborted = [], 0, 0, False, False
    for _, line in lines:
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except ValueError:
            malformed += 1
            continue
        kind = event.get('type')
        message = event.get('message') if isinstance(event.get('message'), dict) else {}
        if kind == 'message_end' and message.get('role') == 'assistant':
            usage = message.get('usage') or {}
            assistant.append({'input': usage.get('input') or 0, 'output': usage.get('output') or 0,
                              'cache_read': usage.get('cacheRead') or 0, 'stop_reason': message.get('stopReason'),
                              'model': message.get('model'), 'provider': message.get('provider')})
        elif kind == 'tool_execution_start':
            tool_calls += 1
        elif kind == 'agent_settled':
            settled, aborted = True, bool(event.get('aborted'))
    return {'assistant': assistant, 'tool_calls': tool_calls, 'malformed': malformed, 'settled': settled, 'aborted': aborted,
            'final_stop': assistant[-1]['stop_reason'] if assistant else None}
