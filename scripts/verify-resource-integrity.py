"""Exercise bundled helper imports and an observer callback without changing resource files."""
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import uuid
from release_helpers import copy_helpers


def inventory(resources):
    return {p.relative_to(resources): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in resources.rglob('*') if p.is_file()}


def until(condition):
    deadline = time.monotonic()+6
    while time.monotonic() < deadline:
        if condition():
            return
        time.sleep(.025)
    raise AssertionError('Timed out waiting for the isolated terminal service')


# POSIX /tmp keeps the Unix-domain socket below macOS's path-length limit and exists on CI Linux.
with tempfile.TemporaryDirectory(prefix='tasktap-resource-integrity-', dir='/tmp') as directory:
    base = Path(directory)
    resources = base/'Resources'
    copy_helpers(Path(__file__).resolve().parents[1], resources)
    original = inventory(resources)
    env = os.environ.copy()
    # Prove each entry point protects the signed resources without relying on the caller.
    for key in ('PYTHONDONTWRITEBYTECODE', 'PYTHONPYCACHEPREFIX', 'PYTHONPATH'):
        env.pop(key, None)
    for name, arguments in [('run-agent', []),
                            ('agent-tools', ['--agent', 'codex', '--session', str(uuid.uuid4()), '--workspace', str(base)])]:
        program = 'import runpy,sys;sys.path.insert(0,sys.argv[1]);path=sys.argv[2];sys.argv=sys.argv[2:];runpy.run_path(path,run_name="resource_inspection")'
        subprocess.run([sys.executable, '-c', program, str(resources), str(resources/name), *arguments],
                       env=env, input='', text=True, capture_output=True, timeout=8, check=True)
        assert inventory(resources) == original, f'{name} changed its helper resources'

    terminal_root = base/'Terminals'
    env['TASKTAP_TERMINAL_ROOT'] = str(terminal_root)
    daemon = subprocess.Popen([sys.executable, str(resources/'workspace_terminal.py'), 'serve'], env=env,
                              stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    key = str(uuid.uuid4())

    def request(payload):
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(5)
            client.connect(str(terminal_root/'session.sock'))
            client.sendall((json.dumps(payload)+'\n').encode())
            with client.makefile('rb') as stream:
                response = json.loads(stream.readline())
        assert 'error' not in response, response
        return response

    try:
        until(lambda: (terminal_root/'session.sock').exists())
        run = base/key
        run.mkdir()
        token = 'isolated-observer-token'
        (run/'observer-config.json').write_text(json.dumps(dict(token=token)))
        (run/'1.job').write_text(json.dumps(dict(observer=True, session=key, folder=str(base))))
        (run/'observer.json').write_text(json.dumps(dict(launch=token, state='working', agent='claude',
                                                       sequence=1, turn=1, isWorking=True)))
        request(dict(op='start', id=key, cwd=str(base), kind='agent', title='Resource integrity fixture',
                     argv=[sys.executable, '-c', 'import time;time.sleep(30)']))
        # This is the production lazy-import path that previously created Resources/__pycache__.
        request(dict(op='observe', id=key, runDir=str(run), token=token))
        observed = request(dict(op='list'))['sessions'][0]['observation']
        assert observed['state'] == 'working' and observed['sequence'] == 1
        assert inventory(resources) == original, 'Observer callback changed signed helper resources'
        assert not list(resources.rglob('*.pyc')), 'Observer callback wrote bytecode inside resources'
    finally:
        try:
            request(dict(op='stop', id=key))
        except OSError:
            pass
        finally:
            daemon.terminate()
            daemon.wait(timeout=5)

print('PASS: copied helper entry points and the real terminal observer path leave signed resources unchanged without environment bytecode suppression.')
