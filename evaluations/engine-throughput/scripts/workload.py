"""Fixed workloads and prompt construction for the throughput evaluation.

Every session starts with a unique nonce, so no two sessions share a prefix and no prefix cache can serve one from another.
The rest of a prompt is a fixed filler passage; only its length in words is calibrated against the engine's own token count.
"""
import functools
import hashlib
import random

K = 1024

# Task id -> workload. k means 1024 tokens.
#  prefill: a long prompt and one output token, so the time to the first token is dominated by prefill.
#  decode:  a prompt of a given depth and a long output, so the first-to-last interval is dominated by generation.
#  agent:   one session of `turns` requests that share a large prefix and each append `increment_tokens` more.
#           Turn 1 is cold; the later turns should hit the prefix cache.
#  batch:   `concurrency` closed-loop workers, each sending `requests_per_worker` requests one after another.
WORKLOADS = {
    'prefill.in2k.out1': {'kind': 'prefill', 'input_tokens': 2 * K, 'output_tokens': 1},
    'prefill.in4k.out1': {'kind': 'prefill', 'input_tokens': 4 * K, 'output_tokens': 1},
    'prefill.in8k.out1': {'kind': 'prefill', 'input_tokens': 8 * K, 'output_tokens': 1},
    'prefill.in216k.out1': {'kind': 'prefill', 'input_tokens': 216 * K, 'output_tokens': 1},
    'decode.in128.out256': {'kind': 'decode', 'input_tokens': 128, 'output_tokens': 256},
    'decode.in8k.out256': {'kind': 'decode', 'input_tokens': 8 * K, 'output_tokens': 256},
    'decode.in32k.out256': {'kind': 'decode', 'input_tokens': 32 * K, 'output_tokens': 256},
    'agent.p32k.s256.t5': {'kind': 'agent', 'input_tokens': 32 * K, 'output_tokens': 1, 'increment_tokens': 256, 'turns': 5},
    'agent.p128k.s256.t5': {'kind': 'agent', 'input_tokens': 128 * K, 'output_tokens': 1, 'increment_tokens': 256, 'turns': 5},
    'batch.c1.in512.out64': {'kind': 'batch', 'input_tokens': 512, 'output_tokens': 64, 'concurrency': 1, 'requests_per_worker': 4},
    'batch.c2.in512.out64': {'kind': 'batch', 'input_tokens': 512, 'output_tokens': 64, 'concurrency': 2, 'requests_per_worker': 4},
    'batch.c4.in512.out64': {'kind': 'batch', 'input_tokens': 512, 'output_tokens': 64, 'concurrency': 4, 'requests_per_worker': 4},
    'batch.c8.in512.out64': {'kind': 'batch', 'input_tokens': 512, 'output_tokens': 64, 'concurrency': 8, 'requests_per_worker': 4},
}

# The run-level prefill, decode, and TTFT metrics come from these single-stream workloads.
HEADLINE_PREFILL = 'prefill.in2k.out1'
HEADLINE_DECODE = 'decode.in128.out256'

# Fraction of output chunks per output token below which the N-1 decode definition cannot be applied.
MIN_CHUNK_TOKEN_RATIO = 0.9
# A warm agent turn must reuse at least this fraction of the shared prefix when the engine reports cached tokens.
CACHE_HIT_FLOOR = 0.9
# When the engine reports no cached tokens, warm turns must reach the first token within this fraction of the cold turn's time.
UNREPORTED_CACHE_SPEEDUP = 0.5
# Prompts up to this many tokens are sized by probing; larger ones are extrapolated from a fit at FIT_TOKENS.
DIRECT_CALIBRATION_LIMIT = 8 * K
FIT_TOKENS = 2 * K
TEMPLATES = {'prefill': 'prefill', 'agent': 'prefill', 'decode': 'count', 'batch': 'count'}
FIT_WORKLOAD = {'prefill': 'prefill.in2k.out1', 'count': 'decode.in128.out256'}

WORDS = (
    'time year people way day man thing woman life child world school state family student group country problem hand '
    'part place case week company system program question work government number night point home water room mother area '
    'money story fact month lot right study book eye job word business issue side kind head house service friend father '
    'power hour game line end member law car city community name president team minute idea kid body information back '
    'parent face others level office door health person art war history party result change morning reason research girl '
    'guy moment air teacher force education'
).split()


def template_of(workload_id):
    return TEMPLATES[WORKLOADS[workload_id]['kind']]


def input_tolerance(target):
    """Allowed distance, in tokens, between a request's reported prompt tokens and its expected input length."""
    return max(8, round(target * 0.02))


def expected_input(spec, turn=1):
    return spec['input_tokens'] + (turn - 1) * spec.get('increment_tokens', 0)


def requests_per_instance(spec):
    kind = spec['kind']
    if kind == 'agent':
        return spec['turns']
    if kind == 'batch':
        return spec['concurrency'] * spec['requests_per_worker']
    return 1


def max_concurrency():
    return max(spec.get('concurrency', 1) for spec in WORKLOADS.values())


def make_nonce(salt, seed, counter):
    return hashlib.sha256(('%s|%d|%d' % (salt, seed, counter)).encode()).hexdigest()[:16]


@functools.lru_cache(maxsize=16)
def filler_text(key, seed, words):
    rnd = random.Random('%s|%d' % (key, seed))
    return ' '.join(rnd.choice(WORDS) for _ in range(words))


def build_prompt(workload_id, nonce, filler_words, seed, turn=1, increment_words=0):
    kind = WORKLOADS[workload_id]['kind']
    filler = filler_text(workload_id, seed, filler_words)
    if kind == 'prefill':
        return 'Request %s. Read the passage below, then reply with the single word ok.\n\n%s' % (nonce, filler)
    if kind in ('decode', 'batch'):
        return ('Request %s. Notes: %s\n\nTask: count upward from 1, one number per line and nothing else. '
                'Do not stop.' % (nonce, filler))
    parts = ['Request %s. You are a coding agent working in a large repository. The repository context follows.\n\n%s'
             % (nonce, filler)]
    for step in range(1, turn):
        parts.append('Tool output %d: %s' % (step, filler_text('%s|step%d' % (workload_id, step), seed, increment_words)))
    parts.append('Reply with the single word ok.')
    return '\n\n'.join(parts)
