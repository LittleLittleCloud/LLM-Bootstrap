"""Run the official HumanEval assertions against solution files in offline, restricted containers.

One container per solution: no network, read-only root and mount, no capabilities, an unprivileged user, and bounded
memory, processes, CPU, and time. The controls show the sandbox does what is claimed: a correct solution passes, a stub
fails, a program that tries the network or the file system is stopped, and a runaway program times out.
"""
import os
import subprocess
import tempfile
import uuid
from pathlib import Path

IMAGE = 'python@sha256:5fb4bc53dd0180955e31e5245b648bbb24a4ac4ab03a1de81513642325220bcd'
CASE_TIMEOUT_SECONDS = 30
CONTROL_TIMEOUT_SECONDS = 5
BLOCKED_EXIT_CODE = 7

NETWORK_PROBE = (
    'import socket, sys\n'
    's = socket.socket()\n'
    's.settimeout(3)\n'
    'try:\n'
    '    s.connect(("1.1.1.1", 53))\n'
    'except OSError:\n'
    '    sys.exit(%d)\n' % BLOCKED_EXIT_CODE
)
FILESYSTEM_PROBE = (
    'import sys\n'
    'try:\n'
    '    open("/work/written", "w").write("x")\n'
    'except OSError:\n'
    '    sys.exit(%d)\n' % BLOCKED_EXIT_CODE
)
RUNAWAY = 'while True:\n    pass\n'


def environment_problem():
    """Why the sandbox cannot run, or None. The pinned image is pulled once if it is missing."""
    try:
        subprocess.run(['docker', 'info'], capture_output=True, timeout=30, check=True)
    except (OSError, subprocess.SubprocessError):
        return 'Docker is not available; the assertions need it to run generated programs in a restricted container.'
    if subprocess.run(['docker', 'image', 'inspect', IMAGE], capture_output=True).returncode != 0:
        pulled = subprocess.run(['docker', 'pull', IMAGE], capture_output=True, text=True, timeout=600)
        if pulled.returncode != 0:
            return 'The pinned image %s is not installed and could not be pulled.' % IMAGE
    return None


def run_case(code, staging, timeout=CASE_TIMEOUT_SECONDS):
    """Run one program in the sandbox and return its status, exit code, and the tail of its stderr."""
    with tempfile.TemporaryDirectory(dir=staging) as dirname:
        case_dir = Path(dirname)
        os.chmod(case_dir, 0o755)
        case = case_dir / 'case.py'
        case.write_text(code, encoding='utf-8')
        os.chmod(case, 0o644)
        name = 'bootstrap-humaneval-' + uuid.uuid4().hex
        command = [
            'docker', 'run', '--rm', '--name', name, '--network', 'none', '--read-only',
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
            '--pids-limit', '64', '--memory', '256m', '--cpus', '1',
            '--user', '65534:65534', '--ulimit', 'nofile=64:64',
            '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
            '--mount', 'type=bind,src=%s,dst=/work,readonly' % case_dir,
            '--workdir', '/work', IMAGE, 'python', '-I', '-B', '/work/case.py',
        ]
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
            return {'status': 'passed' if result.returncode == 0 else 'failed', 'exit_code': result.returncode,
                    'stderr': result.stderr[-2000:]}
        except subprocess.TimeoutExpired:
            return {'status': 'timeout', 'exit_code': None, 'stderr': '%d-second container timeout' % timeout}
        finally:
            subprocess.run(['docker', 'rm', '-f', name], capture_output=True, timeout=30, check=False)


def program(solution, task):
    return solution + '\n\n' + task['test'] + '\ncheck(%s)\n' % task['entry_point']


def controls(task, staging):
    """Prove the sandbox and the check behave. `verified` covers the checks; `restricted` covers the isolation."""
    stub = 'def %s(*args, **kwargs):\n    return None\n' % task['entry_point']
    results = {
        'correct_solution_passes': run_case(program(task['prompt'] + task['canonical_solution'], task), staging)['status'] == 'passed',
        'stub_fails': run_case(program(stub, task), staging)['status'] == 'failed',
        'network_blocked': run_case(NETWORK_PROBE, staging)['exit_code'] == BLOCKED_EXIT_CODE,
        'filesystem_read_only': run_case(FILESYSTEM_PROBE, staging)['exit_code'] == BLOCKED_EXIT_CODE,
        'runaway_times_out': run_case(RUNAWAY, staging, CONTROL_TIMEOUT_SECONDS)['status'] == 'timeout',
    }
    restricted = results['network_blocked'] and results['filesystem_read_only']
    return {'verified': all(results.values()), 'restricted': restricted, 'results': results}
