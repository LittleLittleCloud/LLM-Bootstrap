#!/usr/bin/env python3
"""Check an LLM inference engine endpoint for OpenAI chat, OpenAI Responses, and Anthropic Messages conformance.

Standard library only (Python 3.9+). Each check sends a few tiny requests and validates structure and
protocol invariants, not model quality. See docs/evaluation-protocol.md.
"""
import argparse
import datetime
import hashlib
import json
import sys
from pathlib import Path
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parent
DEFINITION = HERE.parent / 'evaluation.json'


def sha256_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def verify_scripts():
    """Check every script against its recorded hash before any of them is imported or run.

    This entry file cannot vouch for itself: run it from the pinned repository revision.
    """
    definition = json.loads(DEFINITION.read_text())
    if definition.get('status') != 'released':
        raise SystemExit('The evaluation definition is a draft; formal runs need a released one.')
    for script in definition['scripts']:
        path = (DEFINITION.parent / script['path']).resolve()
        if DEFINITION.parent.resolve() not in path.parents or not path.is_file() or sha256_file(path) != script['sha256']:
            raise SystemExit('Script %s does not match its recorded hash.' % script['path'])


# Development modes (--describe, --self-test) skip this so scripts can be edited before the hashes are updated.
if __name__ == '__main__' and not {'--describe', '--self-test'} & set(sys.argv):
    verify_scripts()

sys.path.insert(0, str(HERE))

import checks_chat  # noqa: E402,F401  (importing registers the checks)
import checks_responses  # noqa: E402,F401
import checks_anthropic  # noqa: E402,F401
import checks_robustness  # noqa: E402,F401
import checks_engine  # noqa: E402,F401
from checks_core import APIS, MAX_OUTPUT_TOKENS, REGISTRY, Context, Fail, Skip  # noqa: E402

NOT_OBTAINED = 'Not obtained'
SELECTED = lambda check, apis, only: check.api in apis and (not only or check.id in only)  # noqa: E731


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')


def run_checks(ctx, apis, only=None):
    results, evidence = [], {}
    for check in REGISTRY:
        if not SELECTED(check, apis, only):
            continue
        before, ctx.touched = ctx.requests, []
        outcome, detail = 'pass', ''
        try:
            check.run(ctx)
        except Fail as exc:
            outcome, detail = 'fail', str(exc)
        except Skip as exc:
            outcome, detail = 'skip', str(exc)
        except Exception as exc:  # transport errors, malformed bodies, and similar
            outcome, detail = 'error', '%s: %s' % (type(exc).__name__, exc)
        entry = {'check_id': check.id, 'api': check.api, 'level': check.level, 'outcome': outcome,
                 'requests': ctx.requests - before}
        if outcome != 'pass':
            entry['detail'] = redact(detail or outcome, ctx.api_key)
            evidence[check.id] = ctx.evidence_for(ctx.touched)
        results.append(entry)
    return results, evidence


def redact(text, secret):
    return text.replace(secret, '[REDACTED]') if secret else text


def summarize(results):
    count = lambda outcome: sum(1 for r in results if r['outcome'] == outcome)  # noqa: E731
    required_bad = sum(1 for r in results if r['level'] == 'required' and r['outcome'] in ('fail', 'error'))
    return {'total': len(results), 'passed': count('pass'), 'failed': count('fail'), 'skipped': count('skip'),
            'errored': count('error'), 'required_failed': required_bad, 'conformant': required_bad == 0}


def self_test():
    """Negative control: the reference engine must pass everything and every injected fault must be caught."""
    from concurrent.futures import ThreadPoolExecutor
    from fake_engine import FAULTS, FakeEngine

    def run(faults):
        with FakeEngine(faults=faults) as engine:
            return run_checks(Context(engine.origin, engine.model, None, 10, engine.context_window), APIS)[0]

    problems = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        reference_run = pool.submit(run, ())
        faulty_runs = {fault: pool.submit(run, (fault,)) for fault in sorted(FAULTS)}
        results = reference_run.result()
        bad = [r['check_id'] + ' (' + r['outcome'] + ': ' + r.get('detail', '') + ')' for r in results if r['outcome'] != 'pass']
        if bad:
            problems.append('the reference engine does not pass: ' + '; '.join(bad))
        for fault, future in faulty_runs.items():
            caught = {r['check_id'] for r in future.result() if r['outcome'] in ('fail', 'error')}
            missed = sorted(set(FAULTS[fault]) - caught)
            if missed:
                problems.append('fault %s was not detected by %s' % (fault, ', '.join(missed)))
    return not problems, problems, results


def validate_origin(value):
    parts = urlsplit(value)
    loopback = parts.hostname in ('127.0.0.1', 'localhost', '::1')
    if (parts.scheme not in ('http', 'https') or not parts.hostname or parts.username or parts.password
            or parts.query or parts.fragment or parts.path not in ('', '/')):
        raise SystemExit('--endpoint must be a credential-free origin such as https://host:port')
    if parts.scheme == 'http' and not loopback:
        raise SystemExit('Plain http is only allowed for a loopback endpoint.')
    return '%s://%s' % (parts.scheme, parts.netloc), parts.scheme, 'loopback' if loopback else 'remote'


def build_result(args, results, ctx, scheme, host_class, started, control, revision, evidence_ref=None):
    artifacts = []
    for item in args.artifact or []:
        name, _, digest = item.partition('=')
        artifacts.append({'name': name, 'sha256': digest})
    result = {
        'evaluation': {'evaluation_id': json.loads(DEFINITION.read_text())['evaluation_id'],
                       'revision': revision, 'sha256': sha256_file(DEFINITION)},
        'engine_name': args.engine_name,
        'endpoint': {'scheme': scheme, 'host_class': host_class, 'model': ctx.model},
        'started_at': started,
        'ended_at': now(),
        'runtime_revision': args.runtime_revision or {'unavailable': True, 'reason': 'No runtime revision was supplied.'},
        'artifacts': artifacts,
        'identity_verification': args.identity_verification or 'Not verified: only the HTTP endpoint was observed.',
        'checks': results,
        'summary': summarize(results),
        'complete': len(results) == len(REGISTRY),
        'cost': {'requests': ctx.requests,
                 'prompt_tokens': ctx.prompt_tokens if ctx.tokens_seen else NOT_OBTAINED,
                 'completion_tokens': ctx.completion_tokens if ctx.tokens_seen else NOT_OBTAINED},
        'negative_control': control,
    }
    if evidence_ref:
        result['evidence'] = evidence_ref
    return result


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--describe', action='store_true', help='Print the check ids and limits as JSON')
    parser.add_argument('--self-test', action='store_true', help='Run the negative control against a fake engine')
    parser.add_argument('--emit-result', type=Path, help='With --self-test, write the reference run as a result document')
    parser.add_argument('--endpoint', help='Origin of the engine, for example http://127.0.0.1:8080')
    parser.add_argument('--model', help='Model name sent in requests')
    parser.add_argument('--engine-name', default='unnamed-engine')
    parser.add_argument('--api-key-file', type=Path, help='Read privately; never logged')
    parser.add_argument('--apis', default=','.join(APIS), help='Comma-separated subset of ' + ', '.join(APIS))
    parser.add_argument('--only', help='Comma-separated check ids (debugging; the result is marked incomplete)')
    parser.add_argument('--timeout', type=float, default=60.0, help='Seconds per request')
    parser.add_argument('--context-window', type=int, help='Served context window in tokens; enables the overflow checks')
    parser.add_argument('--evaluation-revision', help='Full commit of this repository that holds the pinned definition')
    parser.add_argument('--runtime-revision', help='Engine commit, if known')
    parser.add_argument('--artifact', action='append', help='NAME=SHA256 of a deployed engine artifact (repeatable)')
    parser.add_argument('--identity-verification', help='How the running engine build was confirmed')
    parser.add_argument('--output', type=Path, help='New file for the result document')
    return parser.parse_args()


def main():
    args = parse_args()
    if args.describe:
        print(json.dumps({'check_ids': [c.id for c in REGISTRY], 'limits': {'max_output_tokens_per_request': MAX_OUTPUT_TOKENS}}))
        return 0
    ok, problems, reference = self_test()
    control = {'verified': ok, 'method': 'Ran every check against a reference engine and against each injected fault'}
    if args.self_test:
        from fake_engine import FAULTS, FakeEngine
        print('self-test: %s (%d checks, %d faults)' % ('ok' if ok else 'FAILED', len(reference), len(FAULTS)))
        for problem in problems:
            print('  ' + problem)
        if args.emit_result and ok:
            with FakeEngine() as engine:
                ctx = Context(engine.origin, engine.model, None, 10, engine.context_window)
                started = now()
                results, _ = run_checks(ctx, APIS)
            args.engine_name = 'fake-reference-engine'
            args.emit_result.write_text(json.dumps(build_result(
                args, results, ctx, 'http', 'loopback', started, control, args.evaluation_revision), indent=2) + '\n')
        return 0 if ok else 1
    if not ok:
        raise SystemExit('The self-test failed, so this evaluation is not trustworthy:\n  ' + '\n  '.join(problems))
    if not (args.endpoint and args.model and args.output and args.evaluation_revision):
        raise SystemExit('--endpoint, --model, --output, and --evaluation-revision are required.')
    if args.output.exists():
        raise SystemExit('--output must be a new file.')
    apis = [name for name in args.apis.split(',') if name]
    if any(name not in APIS for name in apis):
        raise SystemExit('Unknown API in --apis.')
    origin, scheme, host_class = validate_origin(args.endpoint)
    key = args.api_key_file.read_text().strip() if args.api_key_file else None
    if args.context_window is not None and args.context_window < 1:
        raise SystemExit('--context-window must be a positive integer.')
    ctx = Context(origin, args.model, key, args.timeout, args.context_window)
    started = now()
    results, evidence = run_checks(ctx, apis, set(args.only.split(',')) if args.only else None)
    evidence_ref = None
    if evidence:
        text = redact(json.dumps(evidence, indent=2), key)
        path = args.output.with_suffix('.evidence.json')
        path.write_text(text + '\n')
        evidence_ref = {'description': 'Requests and responses for checks that did not pass', 'access': 'local-only',
                        'sha256': sha256_file(path), 'access_limitation': 'Kept next to the result; may contain model output.'}
    result = build_result(args, results, ctx, scheme, host_class, started, control, args.evaluation_revision, evidence_ref)
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    summary = result['summary']
    print('%(passed)d passed, %(failed)d failed, %(skipped)d skipped, %(errored)d errored; '
          'required failures: %(required_failed)d' % summary)
    return 0 if summary['conformant'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
