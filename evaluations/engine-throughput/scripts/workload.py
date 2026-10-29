"""Fixed workloads and prompt construction for the throughput evaluation.

Every request starts with a unique nonce, so no two prompts share a prefix and no prefix cache can serve them. The rest of
the prompt is a fixed filler passage; only its length (in words) is calibrated against the engine's own token count.
"""
import hashlib
import random

# Task id -> workload. Prefill requests produce one token, so their first-token time is dominated by prefill. Decode
# requests have a short prompt and a long output, so their first-to-last interval is dominated by generation.
WORKLOADS = {
    'prefill.in2048.out1': {'kind': 'prefill', 'input_tokens': 2048, 'output_tokens': 1},
    'decode.in128.out256': {'kind': 'decode', 'input_tokens': 128, 'output_tokens': 256},
}

# Fraction of output chunks per output token below which the N-1 decode definition cannot be applied.
MIN_CHUNK_TOKEN_RATIO = 0.9

WORDS = (
    'time year people way day man thing woman life child world school state family student group country problem hand '
    'part place case week company system program question work government number night point home water room mother area '
    'money story fact month lot right study book eye job word business issue side kind head house service friend father '
    'power hour game line end member law car city community name president team minute idea kid body information back '
    'parent face others level office door health person art war history party result change morning reason research girl '
    'guy moment air teacher force education'
).split()


def input_tolerance(target):
    """Allowed distance, in tokens, between a request's reported prompt tokens and the workload's input length."""
    return max(8, round(target * 0.02))


def make_nonce(salt, seed, counter):
    return hashlib.sha256(('%s|%d|%d' % (salt, seed, counter)).encode()).hexdigest()[:16]


def build_prompt(workload_id, nonce, filler_words, seed):
    rnd = random.Random('%s|%d' % (workload_id, seed))
    filler = ' '.join(rnd.choice(WORDS) for _ in range(filler_words))
    if WORKLOADS[workload_id]['kind'] == 'prefill':
        return 'Request %s. Read the passage below, then reply with the single word ok.\n\n%s' % (nonce, filler)
    return ('Request %s. Notes: %s\n\nTask: count upward from 1, one number per line and nothing else. '
            'Do not stop.' % (nonce, filler))
