"""Run `evalscope perf` for one workload level and read what it measured.

EvalScope does the measuring; this module fixes how it is invoked and checks that the measurement means what the evaluation
says it does. Every number returned comes from EvalScope's own output files.
"""
import json
import subprocess
import sys
from pathlib import Path

EVALSCOPE_ENTRY = 'from evalscope.cli.cli import run_cmd; run_cmd()'
LENGTH_TOLERANCE = 0.02
LENGTH_SLACK_TOKENS = 16


def evalscope_command(*args):
    return [sys.executable, '-c', EVALSCOPE_ENTRY, *args]


def perf_arguments(item, level, endpoint, model, tokenizer_path, outputs_dir, fields, seed, api_key=None):
    """The fixed `evalscope perf` arguments of one workload level. `fields` are extra request-body fields."""
    length, output = item['input_tokens'], item['output_tokens']
    multi_turn = item['kind'] == 'multi-turn'
    args = [
        'perf', '--model', model, '--url', endpoint.rstrip('/') + '/v1/chat/completions', '--api', 'openai',
        '--dataset', 'random_multi_turn' if multi_turn else 'random', '--tokenizer-path', tokenizer_path,
        '--min-prompt-length', str(length), '--max-prompt-length', str(length),
        '--max-tokens', str(output), '--min-tokens', str(output),
        '--parallel', str(level['parallel']), '--number', str(level['number']), '--warmup-num', str(level['warmup']),
        '--seed', str(seed), '--temperature', '0', '--stream', '--sleep-interval', '0',
        '--extra-args', json.dumps({**fields, 'ignore_eos': True}, sort_keys=True),
        '--outputs-dir', str(outputs_dir), '--no-timestamp', '--no-test-connection', '--total-timeout', str(item.get('timeout_seconds', 3600)),
    ]
    if multi_turn:
        args += ['--multi-turn', '--min-turns', str(item['turns']), '--max-turns', str(item['turns'])]
    if api_key:
        args += ['--api-key', api_key]
    return args


def run_level(args, log_path, timeout):
    """Run one level and return (exit status, level directory or None). The log stays local."""
    with open(log_path, 'w') as log:
        try:
            result = subprocess.run(evalscope_command(*args), stdout=log, stderr=subprocess.STDOUT, timeout=timeout)
            status = result.returncode
        except subprocess.TimeoutExpired:
            return 'timed-out', None
    outputs = Path(args[args.index('--outputs-dir') + 1])
    found = sorted(outputs.glob('*/parallel_*_number_*'))
    return status, (found[-1] if found else None)


def read_level(level_dir):
    folder = Path(level_dir)
    summary = json.loads((folder / 'benchmark_summary.json').read_text())
    percentile = {row['Percentiles']: row for row in json.loads((folder / 'benchmark_percentile.json').read_text())}
    return {'summary': summary, 'percentile': percentile}


def expected_input_tokens(item):
    return item['input_tokens']


def level_problems(item, level, measured):
    """Reasons this level's numbers cannot stand for the workload. An empty list means they count."""
    summary, percentile = measured['summary'], measured['percentile']
    problems = []
    if summary['Failed Requests']:
        problems.append('%d of %d requests failed' % (summary['Failed Requests'], summary['Total Requests']))
    if item['kind'] != 'multi-turn' and summary['Success Requests'] != level['number']:
        problems.append('%d requests succeeded instead of %d' % (summary['Success Requests'], level['number']))
    if not summary['Success Requests']:
        return problems or ['no request succeeded']
    expected = expected_input_tokens(item)
    if item['kind'] != 'multi-turn' and abs(summary['Avg Input Tokens'] - expected) > max(LENGTH_SLACK_TOKENS, LENGTH_TOLERANCE * expected):
        problems.append('prompts had %.0f tokens instead of about %d' % (summary['Avg Input Tokens'], expected))
    low, high = percentile['min']['Output tokens'], percentile['99%']['Output tokens']
    if low != high or abs(summary['Avg Output Tokens'] - item['output_tokens']) > 1e-6:
        problems.append('output length was %.2f tokens on average (min %g, p99 %g) instead of exactly %d'
                        % (summary['Avg Output Tokens'], low, high, item['output_tokens']))
    if item['kind'] != 'multi-turn' and summary.get('KV Cache Hit Rate (%)', 0) > 1:
        problems.append('the engine reported %.1f%% cached prompt tokens for unique prompts' % summary['KV Cache Hit Rate (%)'])
    return problems
